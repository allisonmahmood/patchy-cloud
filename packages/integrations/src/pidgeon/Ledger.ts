/**
 * Patchy's record of each email a Pidgeon connection sends, one row per draft key: which Pidgeon
 * draft is that email and how far it got. Pidgeon has no idempotency of its own, so this is what
 * makes a draft key one email. Patchy sends each draft at most once, and a worker changes a row
 * only while it holds the row's claim, a random owner token with an expiry: every change after
 * the claim is conditional on that token, so a worker that lost it changes nothing.
 *
 * The connection store runs these over its own database; the operations decide what each state
 * means (`Operations.ts`).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * `writing`: no draft yet. `drafted`: the draft's id is recorded and no send was issued.
 * `sending`: recorded before the send is issued, so from here a send may have started. `sent` and
 * `held`: Pidgeon's answer. `refused`: Pidgeon said no and nothing left, so the key is free again.
 */
export const states = ["writing", "drafted", "sending", "sent", "held", "refused"] as const;
export type State = (typeof states)[number];

/** One draft key's row, as a worker holding or reading it sees it. */
export interface Row {
  readonly state: State;
  readonly digest: string;
  readonly draftId: string | null;
  readonly messageId: string | null;
  readonly threadId: string | null;
  /** The worker holding the claim, or none. */
  readonly owner: string | null;
}

/** What a claim found. Only `Claimed` lets a worker talk to Pidgeon. */
export type Claim =
  | {
      readonly _tag: "Claimed";
      readonly row: Row;
      /** A refused attempt's draft, to throw away now its key is taken over. */
      readonly discard: string | null;
    }
  | { readonly _tag: "Sent"; readonly messageId: string; readonly threadId: string }
  /** Another worker's claim is live: nothing was done. */
  | { readonly _tag: "Busy"; readonly retryAfterSeconds: number }
  /** The key went with a different email, and it isn't refused: nothing was done. */
  | { readonly _tag: "Mismatch" }
  /** The day's budget is spent: nothing was recorded or charged. */
  | { readonly _tag: "Spent" }
  /** No Pidgeon connection by that id is the company's. */
  | { readonly _tag: "Gone" };

/** Which draft key's row, and when it is asked. */
export interface Key {
  readonly companyId: string;
  readonly connectionId: string;
  /** The hashed draft key: connection, patch and the patch's key. */
  readonly draft: string;
  /** Epoch milliseconds, from the caller's clock. */
  readonly now: number;
}
export interface ClaimInput extends Key {
  /** The validated operation and input's digest. */
  readonly digest: string;
  readonly owner: string;
  /** When the claim expires, in epoch milliseconds. */
  readonly until: number;
  /** The UTC day a new email is charged to, `YYYY-MM-DD`, and its budget. */
  readonly day: string;
  readonly budget: number;
}
/** A change by the claim's holder. `release` ends the claim with it. */
export interface Change extends Key {
  readonly owner: string;
  readonly state: State;
  readonly draftId?: string | null;
  readonly messageId?: string;
  readonly threadId?: string;
  readonly release?: boolean;
}

const settled: ReadonlySet<State> = new Set(["sent", "held", "refused"]);

/** The budget refused inside the claim's transaction, so the claim rolls back. */
class Spent extends Schema.TaggedError<Spent>()("PidgeonLedgerSpent", {}) {}

interface Found {
  readonly state: State;
  readonly digest: string;
  readonly draftId: string | null;
  readonly messageId: string | null;
  readonly threadId: string | null;
  readonly owner: string | null;
  readonly live: boolean;
  readonly waitSeconds: number;
}
const row = (found: Found): Row => ({
  state: found.state,
  digest: found.digest,
  draftId: found.draftId,
  messageId: found.messageId,
  threadId: found.threadId,
  owner: found.owner
});

const at = (now: number) => now / 1_000;

/**
 * Claims a draft key's row before a worker talks to Pidgeon, in one transaction. A new key is
 * inserted as `writing` and charged one email against the day's budget; a `refused` one is taken
 * over the same way, with the new digest. A row whose claim expired is claimed as it stands. Rows
 * that can no longer matter are forgotten first: `sent` a day after it resolved, and `refused` or
 * an unheld `writing` or `drafted` a day after it was made. `sending` and `held` stay until they
 * resolve or their connection goes.
 */
export const claim = Effect.fn("PidgeonLedger.claim")(function* (input: ClaimInput) {
  const sql = yield* SqlClient.SqlClient;
  const now = at(input.now);
  const charge = Effect.gen(function* () {
    const counted = yield* sql`INSERT INTO pidgeon_sends (connection_id, day, sends)
      SELECT id, ${input.day}::date, 1 FROM connections
        WHERE id = ${input.connectionId} AND company_id = ${input.companyId}
          AND integration = 'pidgeon' AND ${input.budget} > 0
      ON CONFLICT (connection_id, day) DO UPDATE SET sends = pidgeon_sends.sends + 1
        WHERE pidgeon_sends.sends < ${input.budget}
      RETURNING sends`;
    if (counted.length !== 1) return yield* new Spent({});
  });
  const claimed = sql.withTransaction(
    Effect.gen(function* (): Effect.fn.Return<Claim, Spent | SqlError> {
      yield* sql`DELETE FROM pidgeon_drafts WHERE connection_id = ${input.connectionId} AND (
          (state = 'sent' AND resolved_at < to_timestamp(${now}) - interval '24 hours')
          OR (state = 'refused' AND created_at < to_timestamp(${now}) - interval '24 hours')
          OR (state IN ('writing', 'drafted')
            AND (claimed_until IS NULL OR claimed_until < to_timestamp(${now}))
            AND created_at < to_timestamp(${now}) - interval '24 hours'))`;
      const inserted = yield* sql`INSERT INTO pidgeon_drafts
          (connection_id, draft, digest, state, owner, claimed_until, created_at)
        SELECT id, ${input.draft}, ${input.digest}, 'writing', ${input.owner},
          to_timestamp(${at(input.until)}), to_timestamp(${now}) FROM connections
          WHERE id = ${input.connectionId} AND company_id = ${input.companyId}
            AND integration = 'pidgeon'
        ON CONFLICT (connection_id, draft) DO NOTHING RETURNING draft`;
      if (inserted.length === 1) {
        yield* charge;
        return {
          _tag: "Claimed",
          row: {
            state: "writing",
            digest: input.digest,
            draftId: null,
            messageId: null,
            threadId: null,
            owner: input.owner
          },
          discard: null
        };
      }
      const rows = yield* sql<Found>`SELECT d.state, d.digest, d.draft_id AS "draftId",
          d.message_id AS "messageId", d.thread_id AS "threadId", d.owner,
          COALESCE(d.claimed_until > to_timestamp(${now}), false) AS live,
          GREATEST(1, ceil(extract(epoch FROM (d.claimed_until - to_timestamp(${now})))))::int
            AS "waitSeconds"
        FROM pidgeon_drafts d JOIN connections c ON c.id = d.connection_id
        WHERE d.connection_id = ${input.connectionId} AND d.draft = ${input.draft}
          AND c.company_id = ${input.companyId}
        FOR UPDATE OF d`;
      const found = rows[0];
      if (found === undefined) return { _tag: "Gone" };
      if (found.state !== "refused" && found.digest !== input.digest) return { _tag: "Mismatch" };
      if (found.state === "sent" && found.messageId !== null && found.threadId !== null)
        return { _tag: "Sent", messageId: found.messageId, threadId: found.threadId };
      if (found.owner !== null && found.live)
        return { _tag: "Busy", retryAfterSeconds: found.waitSeconds };
      if (found.state === "refused") {
        yield* charge;
        yield* sql`UPDATE pidgeon_drafts SET digest = ${input.digest}, state = 'writing',
            draft_id = NULL, message_id = NULL, thread_id = NULL, owner = ${input.owner},
            claimed_until = to_timestamp(${at(input.until)}), created_at = to_timestamp(${now}),
            resolved_at = NULL
          WHERE connection_id = ${input.connectionId} AND draft = ${input.draft}`;
        return {
          _tag: "Claimed",
          row: {
            state: "writing",
            digest: input.digest,
            draftId: null,
            messageId: null,
            threadId: null,
            owner: input.owner
          },
          discard: found.draftId
        };
      }
      yield* sql`UPDATE pidgeon_drafts SET owner = ${input.owner},
          claimed_until = to_timestamp(${at(input.until)})
        WHERE connection_id = ${input.connectionId} AND draft = ${input.draft}`;
      return { _tag: "Claimed", row: { ...row(found), owner: input.owner }, discard: null };
    })
  );
  return yield* claimed.pipe(
    Effect.catchTags({ PidgeonLedgerSpent: () => Effect.succeed<Claim>({ _tag: "Spent" }) })
  );
});

/**
 * One change by the claim's holder, only while it still holds it: whether it did. A settled state
 * records when it resolved.
 */
export const record = Effect.fn("PidgeonLedger.record")(function* (change: Change) {
  const sql = yield* SqlClient.SqlClient;
  const now = at(change.now);
  const changed = yield* sql`UPDATE pidgeon_drafts SET state = ${change.state}
      ${change.draftId === undefined ? sql`` : sql`, draft_id = ${change.draftId}`}
      ${change.messageId === undefined ? sql`` : sql`, message_id = ${change.messageId}`}
      ${change.threadId === undefined ? sql`` : sql`, thread_id = ${change.threadId}`}
      ${settled.has(change.state) ? sql`, resolved_at = to_timestamp(${now})` : sql``}
      ${change.release === true ? sql`, owner = NULL, claimed_until = NULL` : sql``}
    WHERE connection_id = ${change.connectionId} AND draft = ${change.draft}
      AND owner = ${change.owner}
      AND EXISTS (SELECT 1 FROM connections c
        WHERE c.id = ${change.connectionId} AND c.company_id = ${change.companyId})
    RETURNING draft`;
  return changed.length === 1;
});

/** Ends a claim its holder still has, changing nothing else. */
export const release = Effect.fn("PidgeonLedger.release")(function* (
  key: Key & { readonly owner: string }
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE pidgeon_drafts SET owner = NULL, claimed_until = NULL
    WHERE connection_id = ${key.connectionId} AND draft = ${key.draft} AND owner = ${key.owner}`;
});

/** The row as it stands, for a worker whose change's answer was lost. */
export const read = Effect.fn("PidgeonLedger.read")(function* (key: Key) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<Found>`SELECT d.state, d.digest, d.draft_id AS "draftId",
      d.message_id AS "messageId", d.thread_id AS "threadId", d.owner, false AS live,
      0 AS "waitSeconds"
    FROM pidgeon_drafts d JOIN connections c ON c.id = d.connection_id
    WHERE d.connection_id = ${key.connectionId} AND d.draft = ${key.draft}
      AND c.company_id = ${key.companyId}`;
  const found = rows[0];
  return found === undefined ? undefined : row(found);
});

/**
 * How many of a connection's emails may still leave without Patchy: issued and not known sent, or
 * held for a member. Deleting the connection forgets them, and a member can still approve one.
 */
export const unsettled = Effect.fn("PidgeonLedger.unsettled")(function* (
  companyId: string,
  connectionId: string
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`SELECT count(*)::int AS count
    FROM pidgeon_drafts d JOIN connections c ON c.id = d.connection_id
    WHERE d.connection_id = ${connectionId} AND c.company_id = ${companyId}
      AND d.state IN ('sending', 'held')`;
  return rows[0]?.count ?? 0;
});
