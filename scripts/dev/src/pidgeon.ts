/**
 * An environment's Pidgeon: the developer's test admin key, checked to be a test key before
 * anything is made with it, and the keys the environment's connections stored, revoked by their
 * ids before `down` or `reset` wipes the database that says which they are. The Pidgeon account
 * is shared, with ten active keys between everyone, so a key left behind takes a slot until
 * someone revokes it by hand.
 */
import { PidgeonSource } from "@patchy/integrations";
import * as Sql from "@patchy/sql";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { readPidgeonTestKey } from "./developerEnv.js";

export class PidgeonKeyNotTest extends Schema.TaggedError<PidgeonKeyNotTest>()(
  "PidgeonKeyNotTest",
  {}
) {
  override get message() {
    return "PIDGEON_TEST_ADMIN_KEY isn't a Pidgeon test key. Dev environments only use a test admin key, so nothing was made or revoked with it.";
  }
}

/** The environment's database is down, and its scenario connected Pidgeon. */
export class PidgeonKeysUnknown extends Schema.TaggedError<PidgeonKeysUnknown>()(
  "PidgeonKeysUnknown",
  {}
) {
  override get message() {
    return "This environment's instance isn't running, so its Pidgeon keys can't be read from its database, and nothing was removed. Start it with `pnpm dev`, then run this again.";
  }
}

/** Keys the environment holds that it couldn't revoke; nothing was removed, so they stay findable. */
export class PidgeonKeysLeft extends Schema.TaggedError<PidgeonKeysLeft>()("PidgeonKeysLeft", {
  ids: Schema.Array(Schema.String),
  why: Schema.String
}) {
  override get message() {
    return `This environment holds Pidgeon keys it couldn't revoke (${this.why}): ${this.ids.join(", ")}. Nothing was removed. Run this again, or revoke them in Pidgeon under Developers › API keys first.`;
  }
}

const Me = Schema.Struct({
  data: Schema.Struct({ key: Schema.NullOr(Schema.Struct({ test: Schema.Boolean })) })
});
const decodeMe = Schema.decodeUnknownOption(Me);
const Key = Schema.Struct({
  data: Schema.Struct({
    name: Schema.String,
    access: Schema.String,
    test: Schema.Boolean,
    revoked_at: Schema.NullOr(Schema.String)
  })
});
const decodeKey = Schema.decodeUnknownOption(Key);
const Display = Schema.Struct({
  key: Schema.Struct({ id: Schema.String }),
  retired: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String })))
});
const decodeDisplay = Schema.decodeUnknownOption(Display);

const soon = Effect.map(Clock.currentTimeMillis, (now) => now + 15_000);

/** Whether `adminKey` is a test key, by its own `/me`. Never says the key. */
export const isTestKey = Effect.fn("isTestKey")(function* (adminKey: Redacted.Redacted<string>) {
  const source = yield* PidgeonSource.Source;
  const answer = yield* source.call(adminKey, { method: "GET", path: "/me" }, yield* soon);
  return Option.match(decodeMe(answer.body), {
    onNone: () => false,
    onSome: (me) => me.data.key?.test === true
  });
});

/**
 * Revokes the keys `ids` with the test admin key: only one that's a test key Patchy named below
 * admin, whatever stored its id. A key gone or already revoked counts as done; one Pidgeon
 * wouldn't answer for, or revoke, is left.
 */
export const revokeKeys = Effect.fn("revokeKeys")(function* (
  adminKey: Redacted.Redacted<string>,
  ids: ReadonlyArray<string>
) {
  const source = yield* PidgeonSource.Source;
  const left: string[] = [];
  const skipped: string[] = [];
  let revoked = 0;
  for (const id of ids) {
    const path = `/api-keys/${encodeURIComponent(id)}`;
    const found = yield* source.call(adminKey, { method: "GET", path }, yield* soon).pipe(
      Effect.map((answer) => decodeKey(answer.body)),
      Effect.catchTag("PidgeonNotFound", () => Effect.succeed(Option.none())),
      Effect.option
    );
    if (Option.isNone(found)) {
      left.push(id);
      continue;
    }
    // Gone, or already revoked: nothing to do.
    if (Option.isNone(found.value) || found.value.value.data.revoked_at !== null) continue;
    const key = found.value.value.data;
    if (
      !key.name.startsWith("Patchy ") ||
      !key.test ||
      !(key.access === "read" || key.access === "draft" || key.access === "send")
    ) {
      skipped.push(id);
      continue;
    }
    const done = yield* source
      .call(
        adminKey,
        { method: "DELETE", path, idempotencyKey: `patchy-dev-down-${id}` },
        yield* soon
      )
      .pipe(
        Effect.asVoid,
        // Gone between the read and the revoke: done all the same.
        Effect.catchTag("PidgeonNotFound", () => Effect.void),
        Effect.option
      );
    if (Option.isSome(done)) revoked++;
    else left.push(id);
  }
  return { revoked, left, skipped };
});

/** Every Pidgeon key id the environment's connections store, current and retired. */
const storedKeyIds = (databaseUrl: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly display: unknown;
    }>`SELECT display FROM connections WHERE integration = 'pidgeon'`;
    return rows.flatMap((row) =>
      Option.match(decodeDisplay(row.display), {
        onNone: () => [],
        onSome: (display) => [display.key.id, ...(display.retired ?? []).map((item) => item.id)]
      })
    );
  }).pipe(Effect.provide(Sql.layerFromUrl(Redacted.make(databaseUrl))), Effect.scoped);

/**
 * Revokes the Pidgeon keys the environment's database stores, by their ids, with the developer's
 * test admin key. Only a test key Patchy named below admin is ever revoked. A key already gone
 * counts as done. Fails, so the caller removes nothing, when the keys can't be read and the
 * scenario connected Pidgeon, or when any can't be revoked.
 */
export const revokeEnvironmentKeys = Effect.fn("revokeEnvironmentKeys")(function* (
  databaseUrl: string,
  devEnvFile: string,
  connected: boolean
) {
  const ids = yield* storedKeyIds(databaseUrl).pipe(
    Effect.timeoutOption("10 seconds"),
    Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>())
  );
  if (Option.isNone(ids)) {
    if (connected) return yield* new PidgeonKeysUnknown({});
    return;
  }
  if (ids.value.length === 0) return;
  const adminKey = yield* readPidgeonTestKey(devEnvFile);
  if (Option.isNone(adminKey))
    return yield* new PidgeonKeysLeft({ ids: ids.value, why: "no PIDGEON_TEST_ADMIN_KEY" });
  const pidgeon = PidgeonSource.layer;
  const test = yield* isTestKey(adminKey.value).pipe(
    Effect.provide(pidgeon),
    Effect.orElseSucceed(() => undefined)
  );
  if (test === undefined)
    return yield* new PidgeonKeysLeft({ ids: ids.value, why: "Pidgeon didn't answer" });
  if (!test) return yield* new PidgeonKeyNotTest({});
  const { revoked, left, skipped } = yield* revokeKeys(adminKey.value, ids.value).pipe(
    Effect.provide(pidgeon)
  );
  for (const id of skipped)
    yield* Console.error(`  Left Pidgeon key ${id} alone: it isn't a test key Patchy made.`);
  if (left.length > 0) return yield* new PidgeonKeysLeft({ ids: left, why: "Pidgeon refused" });
  if (revoked > 0)
    yield* Console.error(
      `  Revoked ${revoked === 1 ? "the Pidgeon key" : `${revoked} Pidgeon keys`} this environment held.`
    );
});
