import { ServerCallReply } from "@patchy/api";
import { CompanyDatabases } from "@patchy/company-database";
import { MutationTransaction, Runtime, Wakes } from "@patchy/runtime/core";
import { ContractLimits } from "@patchy/limits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as MutationWrites from "./MutationWrites.js";
import * as ReadSnapshot from "./ReadSnapshot.js";
import * as ResourceRevisions from "./ResourceRevisions.js";
import * as TableOperations from "./TableOperations.js";

class CommitRolledBack extends Schema.TaggedError<CommitRolledBack>()("CommitRolledBack", {}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "Runtime request refused: source_unavailable.";
  }
}

const KEY_CONSTRAINT = "mutation_keys_key";
const rejectedStatement = Schema.is(
  Schema.Struct({
    code: Schema.String,
    severity: Schema.optionalKey(Schema.String),
    severityUnlocalized: Schema.optionalKey(Schema.String)
  }).check(
    Schema.makeFilter(
      (cause) =>
        (cause.severityUnlocalized ?? cause.severity) === "ERROR" &&
        !cause.code.startsWith("08") &&
        cause.code !== "40003"
    )
  )
);
const command = Schema.is(Schema.Struct({ command: Schema.String }));
const missingInventory = Schema.is(
  Schema.Struct({
    reason: Schema.Struct({ cause: Schema.Struct({ code: Schema.Literal("42P01") }) })
  })
);
const translate = (cause: SqlError.SqlError): MutationTransaction.Failure => {
  if (MutationTransaction.isSerializationCause(cause))
    return new MutationTransaction.SerializationConflict({ cause });
  if (cause.reason._tag === "UniqueViolation" && cause.reason.constraint === KEY_CONSTRAINT)
    return new MutationTransaction.KeyRace({ cause });
  return new Runtime.SourceUnavailable({ cause });
};
const databaseFailures = {
  Busy: (cause: CompanyDatabases.Busy) =>
    Effect.fail(
      new TableOperations.Busy({
        cause,
        resource: cause.resource,
        scope: cause.scope,
        limitId: cause.limitId,
        value: cause.value,
        retryAfterSeconds: cause.retryAfterSeconds
      })
    ),
  CompanyDatabaseError: (cause: CompanyDatabases.CompanyDatabaseError) =>
    Effect.fail(new Runtime.SourceUnavailable({ cause })),
  CompanyDatabaseNotReady: (cause: CompanyDatabases.CompanyDatabaseNotReady) =>
    Effect.fail(new Runtime.SourceUnavailable({ cause })),
  CompanyIdentityMismatch: (cause: CompanyDatabases.CompanyIdentityMismatch) =>
    Effect.fail(new Runtime.SourceUnavailable({ cause }))
};
const Stored = Schema.Struct({
  patch_id: Schema.String,
  version_id: Schema.String,
  handler: Schema.String,
  viewer_id: Schema.String,
  fingerprint: Schema.String,
  invocation_id: Schema.String,
  reply: ServerCallReply
});
const encodeReply = Schema.encodeSync(Schema.fromJsonString(ServerCallReply));
const lookup = SqlSchema.findAll({
  Request: Schema.String,
  Result: Stored,
  execute: Effect.fnUntraced(function* (key) {
    const sql = yield* CompanyDatabases.CompanyConnection;
    return yield* sql`SELECT patch_id, version_id, handler, viewer_id, fingerprint, invocation_id, reply
      FROM patchy.mutation_keys WHERE key = ${key}`;
  })
});
const readKey = Effect.fnUntraced(function* (key: MutationTransaction.Key) {
  const rows = yield* lookup(key.key).pipe(
    Effect.catchTags({
      SchemaError: Effect.die,
      SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
    })
  );
  const stored = rows[0];
  if (stored === undefined) return undefined;
  if (
    stored.patch_id !== key.patchId ||
    stored.version_id !== key.versionId ||
    stored.handler !== key.handler ||
    stored.viewer_id !== key.viewerId ||
    stored.fingerprint !== key.fingerprint
  )
    return yield* new Runtime.InvalidRequest({});
  return { invocationId: stored.invocation_id, reply: stored.reply };
});
export const make: Effect.Effect<
  MutationTransaction.MutationTransaction["Service"],
  never,
  CompanyDatabases.CompanyDatabases | Wakes.Wakes
> = Effect.gen(function* () {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const wakes = yield* Wakes.Wakes;
  const cleanup = yield* ContractLimits.get("tier2.settlement.cleanup");
  return MutationTransaction.MutationTransaction.of({
    lookup: (binding, key) => {
      const read = databases.withCompany(binding.companyId)(readKey(key));
      return read.pipe(
        Effect.catchTags({
          CompanyDatabaseNotReady: () =>
            databases.ensureReady(binding.companyId).pipe(Effect.andThen(read)),
          SourceUnavailable: (cause) =>
            missingInventory(cause.cause)
              ? databases.ensureReady(binding.companyId).pipe(Effect.andThen(read))
              : Effect.fail(cause)
        }),
        Effect.catchTags(databaseFailures)
      );
    },
    open: Effect.fn("MutationTransaction.open")(function* (capability) {
      const held = yield* databases
        .lease(capability.binding.companyId, false)
        .pipe(Effect.catchTags(databaseFailures));
      const sql = held.sql;
      const connection = yield* sql.reserve.pipe(Effect.mapError(translate));
      let transaction: "active" | "committed" | "rolled_back" | "unknown" = "active";
      let savepoint = 0;
      const resources = new Set<string>();
      const rollback = Effect.suspend(() => {
        if (transaction === "committed" || transaction === "rolled_back") return Effect.void;
        if (transaction === "unknown") {
          held.destroy();
          return Effect.void;
        }
        return connection.executeRaw("ROLLBACK", []).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              transaction = "rolled_back";
            })
          ),
          Effect.catch(() =>
            Effect.sync(() => {
              transaction = "unknown";
              held.destroy();
            })
          ),
          Effect.asVoid
        );
      });
      yield* Effect.addFinalizer(() => rollback);
      yield* sql.unsafe("BEGIN").pipe(Effect.mapError(translate));
      yield* sql
        .unsafe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .pipe(Effect.mapError(translate));
      const remaining = Math.max(1, capability.attempt.deadline - (yield* Clock.currentTimeMillis));
      yield* sql`SELECT set_config('statement_timeout', ${String(remaining)}, true),
        set_config('transaction_timeout', ${String(remaining)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(remaining + cleanup)}, true)`.pipe(
        Effect.mapError(translate)
      );
      // This lease is private to the mutation. Its nested transactions are table savepoints.
      Object.assign(sql, {
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const name = `mutation_${++savepoint}`;
              yield* sql.unsafe(`SAVEPOINT ${name}`);
              const exit = yield* Effect.exit(restore(effect));
              if (Exit.isFailure(exit)) yield* sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
              yield* sql.unsafe(`RELEASE SAVEPOINT ${name}`);
              return yield* exit;
            })
          )
      });
      const context = Context.make(CompanyDatabases.CompanyConnection, sql).pipe(
        Context.add(SqlClient.SqlClient, sql),
        Context.add(ReadSnapshot.ReadSnapshot, { companyId: capability.binding.companyId, sql }),
        Context.add(MutationWrites.MutationWrites, { resources })
      );
      return {
        context,
        get uncertain() {
          return transaction === "unknown";
        },
        save: (key, reply) =>
          held
            .run(
              Effect.gen(function* () {
                const revisions = yield* ResourceRevisions.read([...resources]);
                const stored = reply.ok ? { ...reply, revisions } : reply;
                yield* sql`INSERT INTO patchy.mutation_keys
            (key, issued_at, patch_id, version_id, handler, viewer_id, fingerprint, invocation_id, reply)
            VALUES (${key.key}, to_timestamp(${key.issuedAt}::double precision / 1000), ${key.patchId},
              ${key.versionId}, ${key.handler}, ${key.viewerId}, ${key.fingerprint},
              ${capability.attempt.invocationId}, ${encodeReply(stored)}::jsonb)`;
                return stored;
              })
            )
            .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(translate(cause)) })),
        commit: Effect.gen(function* () {
          transaction = "unknown";
          const result = yield* connection.executeRaw("COMMIT", []).pipe(
            Effect.catchTags({
              SqlError: (cause) => {
                if (rejectedStatement(cause.reason.cause)) {
                  transaction = "rolled_back";
                  return Effect.fail(translate(cause));
                }
                return Effect.fail(new MutationTransaction.CommitUnknown({ cause }));
              }
            })
          );
          if (command(result) && result.command === "ROLLBACK") {
            transaction = "rolled_back";
            return yield* new CommitRolledBack({});
          }
          if (!command(result) || result.command !== "COMMIT")
            return yield* new MutationTransaction.CommitUnknown({ cause: result });
          transaction = "committed";
        }),
        rollback,
        publish: Effect.suspend(() =>
          resources.size === 0 ? Effect.void : wakes.publish([...resources])
        ),
        destroy: held.destroy
      } satisfies MutationTransaction.Session;
    })
  });
});
export const layer = Layer.effect(MutationTransaction.MutationTransaction, make);
