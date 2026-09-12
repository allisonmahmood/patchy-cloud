// @effect-diagnostics nodeBuiltinImport:off -- Local WASM queries need a killable worker for hard deadlines.
import { Worker } from "node:worker_threads";
import { sha256 } from "@patchy/core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Execution from "./Execution.js";
import { nativeType, quoteIdentifier, quoteLiteral, surface, typeMapping } from "./Mapping.js";
import type { Snapshot } from "@patchy/api/postgres-snapshot";

export class FixtureMissing extends Schema.TaggedError<FixtureMissing>()("FixtureMissing", {
  path: Schema.String
}) {
  override get message() {
    return `Write the required Postgres fixture at ${this.path}.`;
  }
}
export class FixtureConfiguration extends Schema.TaggedError<FixtureConfiguration>()(
  "FixtureConfiguration",
  { field: Schema.Literals(["connectionId", "handle"]) }
) {
  override get message() {
    return `The fixture ${this.field} must be a safe filesystem name.`;
  }
}
export class FixtureInitialization extends Schema.TaggedError<FixtureInitialization>()(
  "FixtureInitialization",
  {
    path: Schema.String,
    cause: Schema.Defect()
  }
) {
  override get message() {
    return `The local Postgres fixture could not be initialized from ${this.path}.`;
  }
}
export class FixtureInvalid extends Schema.TaggedError<FixtureInvalid>()("FixtureInvalid", {
  path: Schema.String,
  details: Schema.Struct({ sqlstate: Schema.String, message: Schema.String }),
  cause: Schema.Defect()
}) {
  override get message() {
    return `Invalid Postgres fixture ${this.path} (${this.details.sqlstate}).`;
  }
}
export class FixtureRowInvalid extends Schema.TaggedError<FixtureRowInvalid>()(
  "FixtureRowInvalid",
  {
    path: Schema.String,
    relation: Schema.String,
    column: Schema.String
  }
) {
  override get message() {
    return `The fixture ${this.path} has an invalid value for ${this.relation}.${this.column}.`;
  }
}
export type DevError =
  | FixtureMissing
  | FixtureConfiguration
  | FixtureInitialization
  | FixtureInvalid
  | FixtureRowInvalid;
export interface Fixture {
  readonly connectionId: string;
  readonly handle: string;
  readonly root: string;
  readonly stateDir?: string;
}

const Reply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({
    kind: Schema.Literal("chunk"),
    fields: Schema.Array(Schema.Struct({ name: Schema.String, dataTypeID: Schema.Int })),
    row: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    done: Schema.Boolean
  }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    code: Schema.String,
    message: Schema.String,
    position: Schema.optionalKey(Schema.String)
  })
]);
const decodeReply = Schema.decodeUnknownSync(Reply);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Only the wire transport lives off-thread. Transaction policy and bounded collection
// run in Execution.runStatement; acknowledgements prevent the worker from reading ahead.
const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const report = (error) => {
  const native = typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code);
  const message = typeof error.message === "string" ? error.message : "PGlite cannot execute this SQL.";
  parentPort.postMessage({ kind: "error", code: native ? error.code : "0A000",
    message: native ? message : "Local PGlite cannot execute this query: " + message,
    ...(typeof error.position === "string" ? { position: error.position } : {}) });
};
(async () => {
  // Module URLs are supplied by the parent; static imports cannot cross this eval-worker boundary.
  const { PGlite, protocol, types } = await import(workerData.module);
  const { citext } = await import(workerData.citextModule);
  const parsers = Object.fromEntries(workerData.textTypeOids.map((oid) => [oid, (value) => value]));
  const pg = await PGlite.create({ dataDir: workerData.dataDir, fsync: false, extensions: { citext }, parsers });
  const serialize = protocol.serialize;
  const batch = (...messages) => Buffer.concat(messages);
  if (workerData.initialize) {
    for (const sql of workerData.ddl) await pg.query(sql);
    await pg.exec(workerData.fixture);
  }
  let fields = [];
  parentPort.on("message", async (input) => {
    try {
      let messages;
      if (input.kind === "start") {
        fields = [];
        const description = await pg.describeQuery(input.text);
        const values = input.parameters.map((value, index) => value === null ? null : description.queryParams[index]?.serializer?.(value) ?? String(value));
        messages = (await pg.execProtocol(batch(serialize.parse({ text: input.text }),
          serialize.bind({ values }), serialize.describe({ type: "P" }),
          serialize.execute({ rows: 1 }), serialize.flush()))).messages;
      } else {
        messages = (await pg.execProtocol(batch(serialize.execute({ rows: 1 }), serialize.flush()))).messages;
      }
      let row;
      let suspended = false;
      for (const message of messages) {
        if (message.name === "rowDescription") {
          fields = message.fields.map(({ name, dataTypeID }) => ({ name, dataTypeID }));
        } else if (message.name === "dataRow") {
          row = message.fields.map((value, index) => value === null ? null : types.parseType(value, fields[index].dataTypeID, pg.parsers));
        } else if (message.name === "portalSuspended") {
          suspended = true;
        } else if (message.name === "copyOutResponse" || message.name === "copyInResponse" || message.name === "copyBothResponse") {
          throw { code: "0A000", message: "Local PGlite transport does not support COPY streams." };
        }
      }
      if (!suspended) await pg.execProtocol(serialize.sync());
      parentPort.postMessage({ kind: "chunk", fields, ...(row === undefined ? {} : { row }), done: !suspended });
    } catch (error) { report(error); }
  });
  parentPort.postMessage({ kind: "ready" });
})().catch(report);
`;

interface WorkerInput {
  readonly dataDir: string;
  readonly initialize: boolean;
  readonly ddl: ReadonlyArray<string>;
  readonly fixture: string;
}

const openWorker = Effect.fn("Postgres.Dev.openWorker")(function* (
  input: WorkerInput,
  limits: Execution.Limits
) {
  let alive = true;
  let termination: Promise<number> | undefined;
  const stop = (worker: Worker) =>
    Effect.suspend(() => {
      alive = false;
      return Effect.promise(() => (termination ??= worker.terminate())).pipe(Effect.asVoid);
    });
  const worker = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        new Worker(workerSource, {
          eval: true,
          workerData: {
            ...input,
            module: import.meta.resolve("@electric-sql/pglite"),
            citextModule: import.meta.resolve("@electric-sql/pglite/contrib/citext"),
            textTypeOids: Execution.textTypeOids
          }
        }),
      catch: (cause) =>
        new Execution.SourceUnavailable({ stage: "connect", cause: Redacted.make(cause) })
    }),
    stop
  );
  worker.on("error", () => {
    alive = false;
  });
  worker.on("exit", () => {
    alive = false;
  });
  const exchange = <E>(
    message?: {
      readonly kind: "start";
      readonly text: string;
      readonly parameters: Execution.QueryInput["parameters"];
    },
    onRow?: (row: ReadonlyArray<unknown>, fields: Execution.QueryResult["fields"]) => E | undefined
  ) =>
    Effect.callback<Execution.QueryResult["fields"], Execution.ExecutionError | E>((resume) => {
      if (!alive) {
        resume(Effect.fail(new Execution.SourceUnavailable({ stage: "query" })));
        return;
      }
      let settled = false;
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const finish = (
        effect: Effect.Effect<Execution.QueryResult["fields"], Execution.ExecutionError | E>
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(effect);
      };
      const onError = (cause: unknown) => {
        alive = false;
        finish(
          Effect.fail(
            new Execution.SourceUnavailable({ stage: "query", cause: Redacted.make(cause) })
          )
        );
      };
      const onExit = () => {
        alive = false;
        finish(Effect.fail(new Execution.SourceUnavailable({ stage: "query" })));
      };
      const onMessage = (value: unknown) => {
        try {
          const reply = decodeReply(value);
          if (reply.kind === "error") {
            finish(Effect.fail(Execution.queryError(reply, limits.statementMs)));
          } else if (reply.kind === "ready") {
            finish(Effect.succeed([]));
          } else {
            const failure = reply.row === undefined ? undefined : onRow?.(reply.row, reply.fields);
            if (failure !== undefined) finish(Effect.fail(failure));
            else if (reply.done) finish(Effect.succeed(reply.fields));
            else worker.postMessage({ kind: "next" });
          }
        } catch (cause) {
          onError(cause);
        }
      };
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      if (message) worker.postMessage(message);
      return Effect.suspend(() => {
        cleanup();
        return settled ? Effect.void : stop(worker);
      });
    });
  yield* exchange<never>().pipe(
    Effect.timeoutOrElse({
      duration: 30_000,
      orElse: () => Effect.fail(new Execution.Timeout({ milliseconds: 30_000 }))
    })
  );
  const transport: Execution.StatementTransport = {
    execute: (text, parameters, onRow) => exchange({ kind: "start", text, parameters }, onRow),
    destroy: stop(worker)
  };
  return {
    transport,
    get alive() {
      return alive;
    }
  };
});

export const dev = (
  input: typeof Snapshot.Type,
  fixture: Fixture,
  limits: Execution.Limits = Execution.specLimits
) =>
  Layer.effect(
    Execution.Execution,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const field of ["connectionId", "handle"] as const) {
        if (!/^[A-Za-z0-9_-]+$/.test(fixture[field]))
          return yield* new FixtureConfiguration({ field });
      }
      const fixturePath = path.resolve(fixture.root, "fixtures", `postgres-${fixture.handle}.sql`);
      if (!(yield* fs.exists(fixturePath))) return yield* new FixtureMissing({ path: fixturePath });
      const sql = yield* fs
        .readFileString(fixturePath)
        .pipe(Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause })));
      const snapshot = surface(input);
      const dataDir = path.resolve(
        fixture.stateDir ?? path.join(fixture.root, ".patchy", "dev"),
        `postgres-${fixture.connectionId}`
      );
      const stampPath = `${dataDir}.json`;
      const stamp = sha256(encodeJson({ version: 1, snapshot: input, fixture: sql }));
      const old = yield* fs.readFileString(stampPath).pipe(Effect.catch(() => Effect.succeed("")));
      const initialize = old !== stamp || !(yield* fs.exists(dataDir));
      if (initialize) {
        yield* fs
          .remove(dataDir, { recursive: true, force: true })
          .pipe(
            Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause }))
          );
        yield* fs
          .remove(stampPath, { force: true })
          .pipe(
            Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause }))
          );
      }
      yield* fs
        .makeDirectory(path.dirname(dataDir), { recursive: true })
        .pipe(Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause })));
      const ddl: string[] = [];
      const schemas = new Set(snapshot.relations.map((relation) => relation.schema));
      const usedEnums = snapshot.enums.filter((enumeration) =>
        snapshot.relations.some((relation) =>
          relation.columns.some((column) =>
            column.type.kind === "enum"
              ? column.type.baseSchema === enumeration.schema &&
                column.type.baseName === enumeration.name
              : column.type.element?.kind === "enum" &&
                column.type.element.baseSchema === enumeration.schema &&
                column.type.element.baseName === enumeration.name
          )
        )
      );
      for (const enumeration of usedEnums) schemas.add(enumeration.schema);
      const citextSchemas = new Set(
        snapshot.relations.flatMap((relation) =>
          relation.columns.flatMap((column) =>
            column.type.baseName === "citext"
              ? [column.type.baseSchema]
              : column.type.element?.baseName === "citext"
                ? [column.type.element.baseSchema]
                : []
          )
        )
      );
      for (const schema of citextSchemas) schemas.add(schema);
      for (const schema of schemas)
        ddl.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
      for (const schema of citextSchemas)
        ddl.push(`CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA ${quoteIdentifier(schema)}`);
      for (const enumeration of usedEnums)
        ddl.push(
          `CREATE TYPE ${quoteIdentifier(enumeration.schema)}.${quoteIdentifier(enumeration.name)} AS ENUM (${enumeration.labels.map(quoteLiteral).join(", ")})`
        );
      for (const relation of snapshot.relations) {
        const columns = relation.columns.map(
          (column) =>
            `${quoteIdentifier(column.name)} ${nativeType(column.type, snapshot)!}${column.nullable ? "" : " NOT NULL"}`
        );
        if (relation.primaryKey)
          columns.push(
            `PRIMARY KEY (${relation.primaryKey.columns.map(quoteIdentifier).join(", ")})`
          );
        ddl.push(
          `CREATE TABLE ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)} (${columns.join(", ")})`
        );
      }
      let workerScope = Scope.makeUnsafe();
      yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));
      const open = Effect.fn("Postgres.Dev.checkout")(function* (initialize: boolean) {
        yield* Scope.close(workerScope, Exit.void);
        workerScope = Scope.makeUnsafe();
        return yield* openWorker({ dataDir, initialize, ddl, fixture: sql }, limits).pipe(
          Scope.provide(workerScope),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(workerScope, exit) : Effect.void
          )
        );
      });
      let current = yield* open(initialize).pipe(
        Effect.mapError((cause) =>
          cause._tag === "PostgresInvalidQuery"
            ? new FixtureInvalid({ path: fixturePath, details: cause.details, cause })
            : new FixtureInitialization({ path: fixturePath, cause })
        )
      );
      // Initialization validates every authored row without retaining a second copy.
      // This is privileged setup, not an unbounded caller operation.
      for (const relation of snapshot.relations) {
        const projections = relation.columns.map(
          (column) =>
            `${typeMapping(column.type)!.project(quoteIdentifier(column.name))} AS ${quoteIdentifier(column.name)}`
        );
        yield* current.transport
          .execute(
            `SELECT ${projections.join(", ")} FROM ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`,
            [],
            (row) => {
              for (const [index, column] of relation.columns.entries()) {
                if (
                  !(row[index] === null && column.nullable) &&
                  !typeMapping(column.type)!.is(row[index])
                )
                  return new FixtureRowInvalid({
                    path: fixturePath,
                    relation: `${relation.schema}.${relation.name}`,
                    column: column.name
                  });
              }
            }
          )
          .pipe(
            Effect.timeoutOrElse({
              duration: limits.deadlineMs,
              orElse: () => Effect.fail(new Execution.Timeout({ milliseconds: limits.deadlineMs }))
            }),
            Effect.mapError((cause) =>
              cause._tag === "FixtureRowInvalid"
                ? cause
                : cause._tag === "PostgresInvalidQuery"
                  ? new FixtureInvalid({ path: fixturePath, details: cause.details, cause })
                  : new FixtureInitialization({ path: fixturePath, cause })
            )
          );
      }
      if (initialize)
        yield* fs
          .writeFileString(stampPath, stamp)
          .pipe(
            Effect.mapError((cause) => new FixtureInitialization({ path: fixturePath, cause }))
          );
      const semaphore = yield* Semaphore.make(1);
      const query = Effect.fn("Postgres.Dev.query")(
        function* (query: Execution.QueryInput) {
          if (
            query.declaration.id !== fixture.connectionId ||
            query.declaration.handle !== fixture.handle
          )
            return yield* new Execution.AccessDenied({});
          if (!current.alive) current = yield* open(false);
          return yield* Execution.runStatement(
            current.transport,
            query.text,
            query.parameters,
            limits
          );
        },
        semaphore.withPermits(1),
        Effect.timeoutOrElse({
          duration: limits.deadlineMs,
          orElse: () => Effect.fail(new Execution.Timeout({ milliseconds: limits.deadlineMs }))
        })
      );
      return Execution.Execution.of({ query });
    })
  );
