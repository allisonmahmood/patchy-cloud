/**
 * Change keys: the record that makes a worker agent's retry of a change apply it once
 * (docs/product.md › The door › Change keys). Each key belongs to one agent connection and
 * patch for 24 hours, the lifetime of a page's mutation keys, and keeps its first try's
 * version, tool and arguments. A mutation's first try is given a fresh mutation key from
 * Patchy, which every retry reuses, so Runtime commits it once; once Patchy has seen it commit,
 * the record answers its result to any replica without running anything. An action's key runs
 * once and never again.
 *
 * Every time here is the database's clock, read in the statement that uses it, so replicas
 * whose clocks disagree answer a retry alike. The key itself is never stored, only its hash,
 * and the arguments only as the hash of their canonical JSON, so key order and how a number
 * is written don't make two changes of one.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { canonicalArgs } from "@patchy/api";
import { newInternalId, sha256 } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { MutationTransaction } from "@patchy/runtime";

/**
 * How long past its deadline and cleanup a try may still hold its key, which only matters when
 * its host died: a live host settles the key when the try ends. It covers the wait for the
 * company's server to start and the request around the call.
 */
const START_ALLOWANCE_MS = 60_000;

/** One intended change, as `change_patch` names it on the version it runs on. */
export interface Change {
  readonly connectionId: string;
  readonly patchId: string;
  readonly key: string;
  readonly versionId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly kind: "mutation" | "action";
}

/**
 * What a key's record says of a try: run it, with the mutation key every try of a mutation
 * shares, and settle the key when it ends; answer a committed mutation's result again; or refuse
 * it, because a try is still running, the key named another change or version, or an action
 * already took it.
 */
export type Claim =
  | {
      readonly _tag: "Run";
      readonly mutationKey: string | undefined;
      /** Ends the try's hold on the key, keeping a committed mutation's result as JSON text. */
      readonly settle: (result: string | undefined) => Effect.Effect<void, SqlError>;
    }
  | { readonly _tag: "Replay"; readonly result: string }
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "VersionChanged" }
  | { readonly _tag: "Used" };

export class ChangeKeys extends Context.Service<
  ChangeKeys,
  {
    /** Claims a change's key for this try, or says why the try must not run. */
    readonly claim: (change: Change) => Effect.Effect<Claim, SqlError>;
    /** Drops every key past its 24 hours. A key past them is new again, swept or not. */
    readonly sweep: Effect.Effect<void, SqlError>;
  }
>()("@patchy/mcp/ChangeKeys") {}

/** A key's record: its connection, its patch and the key's hash. */
const Keyed = Schema.Struct({
  connectionId: Schema.String,
  patchId: Schema.String,
  keyHash: Schema.String
});
type Keyed = typeof Keyed.Type;

const Stored = Schema.Struct({
  versionId: Schema.String,
  tool: Schema.String,
  argsHash: Schema.String,
  kind: Schema.Literals(["mutation", "action"]),
  result: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  expired: Schema.Boolean
});

/** A claim that found the record changing under it gives up after this many reads, as busy. */
const ROUNDS = 3;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lifetime = (yield* ContractLimits.get("tier2.mutation.keyLifetime")) / 1000;
  const cleanup = yield* ContractLimits.get("tier2.settlement.cleanup");
  const leases = {
    mutation:
      ((yield* ContractLimits.get("tier2.mutation.deadline")) + cleanup + START_ALLOWANCE_MS) /
      1000,
    action:
      ((yield* ContractLimits.get("tier2.action.deadline")) + cleanup + START_ALLOWANCE_MS) / 1000
  };
  const live = sql`created_at > clock_timestamp() - make_interval(secs => ${lifetime})`;

  const where = (keyed: Keyed) =>
    sql`connection_id = ${keyed.connectionId} AND patch_id = ${keyed.patchId} AND key_hash = ${keyed.keyHash}`;

  /** The try's hold ends; a committed mutation's result stays, whichever try settles first. */
  const settle = (keyed: Keyed, attempt: string) => (result: string | undefined) =>
    Effect.asVoid(
      sql`
      UPDATE change_keys SET running_until = NULL, result = COALESCE(${result ?? null}, result)
      WHERE ${where(keyed)} AND attempt = ${attempt}`
    ).pipe(Effect.withSpan("ChangeKeys.settle"));

  const read = SqlSchema.findOneOption({
    Request: Keyed,
    Result: Stored,
    execute: (keyed) => sql`
      SELECT version_id AS "versionId", tool, args_hash AS "argsHash", kind, result,
        COALESCE(running_until > clock_timestamp(), false) AS running, NOT ${live} AS expired
      FROM change_keys WHERE ${where(keyed)}`
  });

  const claim = Effect.fn("ChangeKeys.claim")(function* (change: Change) {
    const keyed: Keyed = {
      connectionId: change.connectionId,
      patchId: change.patchId,
      keyHash: sha256(change.key)
    };
    const argsHash = sha256(canonicalArgs(change.args));
    const lease = leases[change.kind];
    const run = (attempt: string, mutationKey: string | null): Claim => ({
      _tag: "Run",
      mutationKey: mutationKey ?? undefined,
      settle: settle(keyed, attempt)
    });

    for (let round = 0; round < ROUNDS; round++) {
      // The first try, or the first since the key's 24 hours ran out.
      const attempt = newInternalId("try");
      const minted = change.kind === "mutation" ? yield* MutationTransaction.mint : null;
      const [first] = yield* sql<{ readonly mutationKey: string | null }>`
        INSERT INTO change_keys AS k (connection_id, patch_id, key_hash, version_id, tool,
          args_hash, kind, mutation_key, attempt, running_until, created_at)
        VALUES (${keyed.connectionId}, ${keyed.patchId}, ${keyed.keyHash}, ${change.versionId},
          ${change.tool}, ${argsHash}, ${change.kind}, ${minted}, ${attempt},
          clock_timestamp() + make_interval(secs => ${lease}), clock_timestamp())
        ON CONFLICT (connection_id, patch_id, key_hash) DO UPDATE SET
          version_id = EXCLUDED.version_id, tool = EXCLUDED.tool, args_hash = EXCLUDED.args_hash,
          kind = EXCLUDED.kind, mutation_key = EXCLUDED.mutation_key, result = NULL,
          attempt = EXCLUDED.attempt, running_until = EXCLUDED.running_until,
          created_at = EXCLUDED.created_at
        WHERE k.created_at <= clock_timestamp() - make_interval(secs => ${lifetime})
        RETURNING k.mutation_key AS "mutationKey"`;
      if (first !== undefined) return run(attempt, first.mutationKey);

      // A retry of the same mutation on the same version, which nothing holds and Patchy hasn't
      // seen commit: it runs again under the first try's mutation key, so Runtime commits it once.
      const [retry] = yield* sql<{ readonly mutationKey: string | null }>`
        UPDATE change_keys SET attempt = ${attempt},
          running_until = clock_timestamp() + make_interval(secs => ${lease})
        WHERE ${where(keyed)} AND kind = 'mutation' AND result IS NULL
          AND (running_until IS NULL OR running_until <= clock_timestamp())
          AND version_id = ${change.versionId} AND tool = ${change.tool}
          AND args_hash = ${argsHash} AND ${live}
        RETURNING mutation_key AS "mutationKey"`;
      if (retry !== undefined) return run(attempt, retry.mutationKey);

      const stored = yield* read(keyed).pipe(Effect.catchTags({ SchemaError: Effect.die }));
      // Gone or run out since the insert: claim it afresh.
      if (Option.isNone(stored) || stored.value.expired) continue;
      const found = stored.value;
      if (found.tool !== change.tool || found.argsHash !== argsHash)
        return { _tag: "Conflict" } as const;
      if (found.versionId !== change.versionId) return { _tag: "VersionChanged" } as const;
      if (found.running) return { _tag: "Busy" } as const;
      if (found.kind === "action") return { _tag: "Used" } as const;
      if (found.result !== null) return { _tag: "Replay", result: found.result } as const;
      // Its try settled without a result since the update: try the retry again.
    }
    return { _tag: "Busy" } as const;
  });

  const sweep = Effect.asVoid(sql`DELETE FROM change_keys WHERE NOT ${live}`).pipe(
    Effect.withSpan("ChangeKeys.sweep")
  );

  return ChangeKeys.of({ claim, sweep });
});

export const layer = Layer.effect(ChangeKeys, make);
