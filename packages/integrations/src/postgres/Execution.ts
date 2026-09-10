import type { PostgresDeclaration, PostgresParameter } from "@patchy/api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Pg from "pg";
import * as ConnectionStore from "../ConnectionStore.js";
import * as Source from "./Source.js";
import * as SourceClient from "./SourceClient.js";
import * as SourceNetwork from "./SourceNetwork.js";

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });
export class InvalidQuery extends Schema.TaggedError<InvalidQuery>()("PostgresInvalidQuery", {
  details: Schema.Struct({
    sqlstate: Schema.String,
    message: Schema.String,
    position: Schema.optionalKey(Schema.String)
  }),
  cause: SecretCause
}) {
  readonly code = "invalid_query";
  readonly status = 400;
  override get message() {
    return "The database rejected the query.";
  }
}
export class Timeout extends Schema.TaggedError<Timeout>()("PostgresTimeout", {
  milliseconds: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(SecretCause)
}) {
  readonly code = "timeout";
  readonly status = 504;
  override get message() {
    return `The database call exceeded its ${this.milliseconds ?? 15_000} ms deadline.`;
  }
}
export class TooLarge extends Schema.TaggedError<TooLarge>()("PostgresTooLarge", {
  bound: Schema.Literals(["rows", "bytes"]),
  limit: Schema.Int
}) {
  readonly code = "too_large";
  readonly status = 413;
  override get message() {
    return `A database call is limited to ${this.limit} ${this.bound}.`;
  }
}
export class AccessDenied extends Schema.TaggedError<AccessDenied>()("PostgresAccessDenied", {}) {
  readonly code = "access_denied";
  readonly status = 403;
  override get message() {
    return "This connection is no longer available. Ask a company administrator to reconnect it.";
  }
}
export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
  "PostgresSourceUnavailable",
  {
    stage: Schema.Literals(["access", "credentials", "connect", "query", "reset"]),
    cause: Schema.optionalKey(SecretCause)
  }
) {
  readonly code = "source_unavailable";
  readonly status = 503;
  override get message() {
    return "The database could not be reached. Check the connection and the role's access.";
  }
}
export const Errors = Schema.Union([
  InvalidQuery,
  Timeout,
  TooLarge,
  AccessDenied,
  SourceUnavailable
]);
export type ExecutionError = typeof Errors.Type;
export interface QueryInput {
  readonly companyId: string;
  readonly declaration: typeof PostgresDeclaration.Type;
  readonly text: string;
  readonly parameters: ReadonlyArray<typeof PostgresParameter.Type>;
}
export interface QueryResult {
  readonly fields: ReadonlyArray<{ readonly name: string; readonly dataTypeID: number }>;
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
}

export class Execution extends Context.Service<
  Execution,
  {
    readonly query: (input: QueryInput) => Effect.Effect<QueryResult, ExecutionError>;
  }
>()("@patchy/integrations/postgres/Execution") {}

export interface Limits {
  readonly maxPerConnection: number;
  readonly maxBackends: number;
  readonly idleMs: number;
  readonly statementMs: number;
  readonly deadlineMs: number;
  readonly maxRows: number;
  readonly maxBytes: number;
}
export const specLimits: Limits = {
  maxPerConnection: 4,
  maxBackends: 64,
  idleMs: 60_000,
  statementMs: 10_000,
  deadlineMs: 15_000,
  maxRows: 1_000,
  maxBytes: 8 * 1024 * 1024
};

/** One leased backend. A refused row stops execution without retaining the remaining rows. */
export interface StatementTransport {
  readonly execute: <E>(
    text: string,
    parameters: QueryInput["parameters"],
    onRow: (row: ReadonlyArray<unknown>, fields: QueryResult["fields"]) => E | undefined
  ) => Effect.Effect<QueryResult["fields"], ExecutionError | E>;
  readonly destroy: Effect.Effect<void>;
}

/** Per-query parsers: never mutate pg's process-wide parser registry. */
export const textTypeOids: ReadonlyArray<number> = [20, 1700, 1082, 1083, 1114, 1184, 1266];
const textArrayOid: number = 1009;
const preserveText = (value: string): string => value;
const parseTextArray: (value: string) => unknown = Pg.types.getTypeParser(textArrayOid, "text");
export const types: Pg.CustomTypesConfig = {
  getTypeParser: (oid: number, format) =>
    format !== "binary" && textTypeOids.includes(oid)
      ? preserveText
      : format !== "binary" &&
          (oid === 1016 ||
            oid === 1231 ||
            oid === 1182 ||
            oid === 1183 ||
            oid === 1115 ||
            oid === 1185 ||
            oid === 1270)
        ? parseTextArray
        : Pg.types.getTypeParser(oid, format)
};
const isDatabaseError = Schema.is(
  Schema.Struct({
    code: Schema.String.check(Schema.isPattern(/^[0-9A-Z]{5}$/u)),
    message: Schema.String,
    position: Schema.optional(Schema.String)
  })
);
/** Only query diagnostics cross the wire; connection and credential diagnostics stay redacted. */
export const queryError = (
  cause: unknown,
  statementMs = specLimits.statementMs
): ExecutionError => {
  if (isDatabaseError(cause)) {
    if (cause.code === "57014")
      return new Timeout({ milliseconds: statementMs, cause: Redacted.make(cause) });
    if (!/^(?:08|28|57P)/u.test(cause.code))
      return new InvalidQuery({
        details: {
          sqlstate: cause.code,
          message: cause.message,
          ...(cause.position === undefined ? {} : { position: cause.position })
        },
        cause: Redacted.make(cause)
      });
  }
  return new SourceUnavailable({ stage: "query", cause: Redacted.make(cause) });
};

/** Destruction is synchronous, including when connect, collection or the calling fiber is interrupted. */
export const destroy = (client: Pg.Client): void => {
  client.connection.stream.destroy();
  void client.end().catch(() => {});
};

const nativeTransport = (client: Pg.Client): StatementTransport => ({
  execute: <E>(
    text: string,
    parameters: QueryInput["parameters"],
    onRow: (row: ReadonlyArray<unknown>, fields: QueryResult["fields"]) => E | undefined
  ) =>
    Effect.callback<QueryResult["fields"], ExecutionError | E>((resume) => {
      let settled = false;
      let fields: QueryResult["fields"] | undefined;
      const describe = (result: Pg.QueryResult) =>
        (fields ??= result.fields.map(({ name, dataTypeID }) => ({ name, dataTypeID })));
      const finish = (
        effect: Effect.Effect<QueryResult["fields"], ExecutionError | E>,
        discard = false
      ) => {
        if (settled) return;
        settled = true;
        if (discard) destroy(client);
        resume(effect);
      };
      const query = new Pg.Query({
        text,
        values: [...parameters],
        rowMode: "array",
        queryMode: "extended",
        types
      } as Pg.QueryArrayConfig);
      query.on("row", (row: ReadonlyArray<unknown>, result?: Pg.QueryResult) => {
        if (settled) return;
        try {
          const refused = onRow(row, describe(result!));
          if (refused !== undefined) finish(Effect.fail(refused), true);
        } catch (cause) {
          finish(Effect.fail(queryError(cause)), true);
        }
      });
      query.on("error", (cause) => finish(Effect.fail(queryError(cause))));
      query.on("end", (result: Pg.QueryResult) => finish(Effect.succeed(describe(result))));
      try {
        client.query(query);
      } catch (cause) {
        finish(Effect.fail(queryError(cause)), true);
      }
      return Effect.sync(() => {
        if (!settled) {
          settled = true;
          destroy(client);
        }
      });
    }),
  destroy: Effect.sync(() => destroy(client))
});

/** Native and fixture backends share all statement policy; adapters only carry protocol rows. */
export const runStatement = Effect.fn("Postgres.runStatement")(
  (
    transport: StatementTransport,
    text: string,
    parameters: QueryInput["parameters"],
    limits: Limits = specLimits
  ): Effect.Effect<QueryResult, ExecutionError> =>
    Effect.gen(function* () {
      const ignoreRow = () => undefined;
      yield* transport.execute<never>("BEGIN READ ONLY", [], ignoreRow);
      yield* transport.execute<never>(
        `SET LOCAL statement_timeout = ${limits.statementMs}`,
        [],
        ignoreRow
      );
      yield* transport.execute<never>("SET LOCAL TIME ZONE 'UTC'", [], ignoreRow);
      yield* transport.execute<never>("SET LOCAL DateStyle = 'ISO, YMD'", [], ignoreRow);
      const rows: Array<ReadonlyArray<unknown>> = [];
      let bytes = 2;
      let namesBytes: number | undefined;
      const fields = yield* transport
        .execute<ExecutionError>(text, parameters, (row, fields) => {
          if (rows.length >= limits.maxRows)
            return new TooLarge({ bound: "rows", limit: limits.maxRows });
          try {
            // Account for the eventual object keys as well as the array-mode values.
            namesBytes ??= fields.reduce(
              (sum, field) => sum + Buffer.byteLength(JSON.stringify(field.name)) + 1,
              0
            );
            bytes += Buffer.byteLength(JSON.stringify(row)) + namesBytes + 1;
          } catch (cause) {
            return queryError(cause, limits.statementMs);
          }
          if (bytes > limits.maxBytes)
            return new TooLarge({ bound: "bytes", limit: limits.maxBytes });
          rows.push(row);
          return undefined;
        })
        .pipe(
          Effect.catchTags({
            PostgresTimeout: (cause) =>
              Effect.fail(
                new Timeout({ milliseconds: limits.statementMs, cause: Redacted.make(cause) })
              )
          }),
          // This host timer also stops a WASM backend that cannot service PostgreSQL's timer.
          Effect.timeoutOrElse({
            duration: limits.statementMs,
            orElse: () => Effect.fail(new Timeout({ milliseconds: limits.statementMs }))
          })
        );
      yield* transport.execute<never>("ROLLBACK", [], ignoreRow);
      yield* transport
        .execute<never>("DISCARD ALL", [], ignoreRow)
        .pipe(
          Effect.mapError(
            (cause) => new SourceUnavailable({ stage: "reset", cause: Redacted.make(cause) })
          )
        );
      return { fields, rows };
    }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? transport.destroy : Effect.void)))
);

interface Entry {
  readonly companyId: string;
  readonly id: string;
  readonly revision: number;
  readonly scope: Scope.Closeable;
  readonly credentials: Effect.Effect<
    typeof SourceClient.Settings.Type,
    ExecutionError | ConnectionStore.ConnectionChanged
  >;
  settings: typeof SourceClient.Settings.Type | undefined;
  client: Pg.Client | undefined;
  idle: boolean;
  timer: Fiber.Fiber<void> | undefined;
}

/** A real isolated-client seam for transport tests; production always uses SourceClient.open. */
export const makeWithClient = Effect.fn("Postgres.makeWithClient")(function* <R>(
  open: (
    settings: typeof SourceClient.Settings.Type
  ) => Effect.Effect<Pg.Client, SourceClient.SourceError, R | Scope.Scope>,
  cancel: (
    settings: typeof SourceClient.Settings.Type,
    client: Pg.Client
  ) => Effect.Effect<void, SourceClient.SourceError, R>,
  limits: Limits = specLimits
) {
  const dependencies = yield* Effect.context<R>();
  const store = yield* ConnectionStore.ConnectionStore;
  const poolScope = yield* Scope.Scope;
  const entries = new Set<Entry>();
  const waiters = new Set<() => void>();
  let changed = 0;
  const notify = () => {
    changed++;
    for (const resume of waiters) resume();
    waiters.clear();
  };
  const wait = (version: number) =>
    Effect.callback<void>((resume) => {
      const wake = () => resume(Effect.void);
      if (changed !== version) wake();
      else waiters.add(wake);
      return Effect.sync(() => {
        waiters.delete(wake);
      });
    });
  const stopTimer = Effect.fn("Postgres.stopIdleTimer")(function* (entry: Entry) {
    const timer = entry.timer;
    entry.timer = undefined;
    if (timer !== undefined) yield* Fiber.interrupt(timer);
  });
  const close = Effect.fn("Postgres.closeBackend")(function* (entry: Entry, idleOnly = false) {
    if (idleOnly && !entry.idle) return;
    if (!entries.delete(entry)) return;
    if (entry.client !== undefined) {
      destroy(entry.client);
      // Never extend the caller's deadline for a cancellation handshake. The original
      // socket is already destroyed; the pool scope owns the bounded best-effort request.
      if (!entry.idle && entry.settings !== undefined)
        yield* cancel(entry.settings, entry.client).pipe(
          Effect.provideContext(dependencies),
          Effect.ignore,
          Effect.forkIn(poolScope)
        );
    }
    notify();
    yield* stopTimer(entry);
    yield* Scope.close(entry.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach(entries, (entry) => close(entry), { discard: true })
  );
  const live = Effect.fn("Postgres.liveConnection")(function* (input: QueryInput) {
    const connection = yield* store
      .get(input.companyId, input.declaration.id)
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ConnectionNotFound"
            ? new AccessDenied({})
            : new SourceUnavailable({ stage: "access", cause: Redacted.make(cause) })
        )
      );
    if (connection.handle !== input.declaration.handle || connection.status !== "connected")
      return yield* new AccessDenied({});
    return connection;
  });
  const acquire = Effect.fn("Postgres.checkout")((input: QueryInput) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        while (true) {
          const version = changed;
          const current = yield* restore(live(input));
          for (const entry of entries) {
            if (
              entry.companyId === input.companyId &&
              entry.id === current.id &&
              entry.idle &&
              (entry.revision !== current.credentialRevision ||
                entry.client?.connection.stream.destroyed)
            )
              yield* close(entry);
          }
          let entry: Entry | undefined;
          for (const item of entries) {
            if (
              item.companyId === input.companyId &&
              item.id === current.id &&
              item.revision === current.credentialRevision &&
              item.idle
            ) {
              entry = item;
              break;
            }
          }
          if (entry !== undefined) {
            entry.idle = false;
            yield* stopTimer(entry);
          } else {
            let count = 0;
            let credentials: Entry["credentials"] | undefined;
            for (const item of entries)
              if (item.companyId === input.companyId && item.id === current.id) {
                count++;
                if (item.revision === current.credentialRevision) credentials = item.credentials;
              }
            if (count >= limits.maxPerConnection) {
              yield* restore(wait(version));
              continue;
            }
            if (entries.size >= limits.maxBackends) {
              let unused: Entry | undefined;
              for (const item of entries)
                if (item.idle) {
                  unused = item;
                  break;
                }
              if (unused === undefined) {
                yield* restore(wait(version));
                continue;
              }
              yield* close(unused);
              continue;
            }
            const { companyId, declaration } = input;
            const revision = current.credentialRevision;
            if (credentials === undefined) {
              const gate = yield* Semaphore.make(1);
              let settings: typeof SourceClient.Settings.Type | undefined;
              credentials = gate.withPermits(1)(
                Effect.gen(function* () {
                  if (settings !== undefined) return settings;
                  const secret = yield* store
                    .poolCredentials(companyId, declaration, revision)
                    .pipe(
                      Effect.mapError((cause) =>
                        cause._tag === "ConnectionNotConnected" ||
                        cause._tag === "ConnectionNotFound"
                          ? new AccessDenied({})
                          : cause._tag === "ConnectionChanged"
                            ? cause
                            : new SourceUnavailable({
                                stage: "credentials",
                                cause: Redacted.make(cause)
                              })
                      )
                    );
                  settings = yield* Source.parseCredentials(secret).pipe(
                    Effect.mapError(
                      (cause) =>
                        new SourceUnavailable({
                          stage: "credentials",
                          cause: Redacted.make(cause)
                        })
                    )
                  );
                  return settings;
                })
              );
            }
            // Share successful decryption, not a caller's cached interruption, across the revision pool.
            // Recheck capacity after constructing the gate so reservation remains atomic.
            count = 0;
            for (const item of entries)
              if (item.companyId === input.companyId && item.id === current.id) {
                count++;
                if (item.revision === current.credentialRevision) credentials = item.credentials;
              }
            if (count >= limits.maxPerConnection || entries.size >= limits.maxBackends) continue;
            entry = {
              companyId: input.companyId,
              id: current.id,
              revision: current.credentialRevision,
              scope: Scope.makeUnsafe(),
              client: undefined,
              idle: false,
              timer: undefined,
              credentials,
              settings: undefined
            };
            entries.add(entry);
          }
          const reserved = entry;
          const ready = yield* restore(
            Effect.gen(function* () {
              if (reserved.client === undefined) {
                const settings = yield* reserved.credentials;
                reserved.settings = settings;
                // Override the captured context's Scope nearest acquisition, including a hung connect.
                reserved.client = yield* open(settings).pipe(
                  Scope.provide(reserved.scope),
                  Effect.provideContext(dependencies),
                  Effect.mapError(
                    (cause) =>
                      new SourceUnavailable({ stage: "connect", cause: Redacted.make(cause) })
                  )
                );
              }
              // Connection creation and queueing can race a rotation, retarget or disconnect.
              const latest = yield* live(input);
              if (latest.credentialRevision !== reserved.revision)
                return yield* new ConnectionStore.ConnectionChanged({});
              return reserved;
            })
          ).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? close(reserved) : Effect.void)),
            Effect.catchTags({ ConnectionChanged: () => Effect.void })
          );
          if (ready !== undefined) return ready;
        }
      })
    )
  );
  const query = Effect.fn("Postgres.execute")((input: QueryInput) =>
    Effect.acquireUseRelease(
      Effect.interruptible(acquire(input)),
      (entry) => runStatement(nativeTransport(entry.client!), input.text, input.parameters, limits),
      (entry, exit) =>
        Exit.isFailure(exit)
          ? close(entry)
          : Effect.gen(function* () {
              entry.idle = true;
              entry.timer = yield* Effect.sleep(limits.idleMs).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    entry.timer = undefined;
                    return close(entry, true);
                  })
                ),
                Effect.forkIn(poolScope)
              );
              notify();
            })
    ).pipe(
      Effect.timeoutOrElse({
        duration: limits.deadlineMs,
        orElse: () => Effect.fail(new Timeout({ milliseconds: limits.deadlineMs }))
      })
    )
  );
  return Execution.of({ query });
});

export const make = Effect.fn("Postgres.make")(function* (limits: Limits = specLimits) {
  const network = yield* SourceNetwork.SourceNetwork;
  return yield* makeWithClient(
    (settings) =>
      SourceClient.open(settings, "patchy-runtime").pipe(
        Effect.provideService(SourceNetwork.SourceNetwork, network)
      ),
    (settings, client) =>
      SourceClient.cancel(settings, client).pipe(
        Effect.provideService(SourceNetwork.SourceNetwork, network)
      ),
    limits
  );
});
export const layer = Layer.effect(Execution, make()).pipe(Layer.provide(SourceNetwork.layer));
