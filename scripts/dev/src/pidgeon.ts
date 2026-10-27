/**
 * An environment's Pidgeon: the developer's test admin key, checked to be a test key before
 * anything is made with it, and the test addresses `up` made, recorded in the environment folder.
 * `down` and `reset` revoke the keys that reach only those addresses and delete the addresses
 * before the folder that names them goes. The Pidgeon account is shared, with ten active keys
 * between everyone, so a key left behind takes a slot until someone revokes it.
 */
import { PidgeonSource } from "@patchy/integrations";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { readPidgeonTestKey } from "./developerEnv.js";

/** What the environment made in Pidgeon isn't all gone, so nothing was removed and its record stays. */
export class PidgeonLeft extends Schema.TaggedError<PidgeonLeft>()("PidgeonLeft", {
  addresses: Schema.Array(Schema.String),
  why: Schema.String
}) {
  override get message() {
    const named = this.addresses.length > 0 ? ` (${this.addresses.join(", ")})` : "";
    return `Nothing was removed: this environment's Pidgeon test addresses${named} and their keys aren't all taken down, because ${this.why}. Fix that and run this again; the environment keeps its record of them until then.`;
  }
}

const Me = Schema.Struct({
  data: Schema.Struct({ key: Schema.NullOr(Schema.Struct({ test: Schema.Boolean })) })
});
const decodeMe = Schema.decodeUnknownOption(Me);
const Page = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  next_cursor: Schema.optionalKey(Schema.NullOr(Schema.String))
});
const decodePage = Schema.decodeUnknownOption(Page);
const Identity = Schema.Struct({
  id: Schema.String,
  local_part: Schema.String,
  test: Schema.Boolean
});
const decodeIdentity = Schema.decodeUnknownOption(Identity);
const Key = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  access: Schema.String,
  test: Schema.Boolean,
  revoked_at: Schema.NullOr(Schema.String),
  identity_ids: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
});
const decodeKey = Schema.decodeUnknownOption(Key);
const Recorded = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeRecorded = Schema.decodeUnknownOption(Recorded);
const encodeRecorded = Schema.encodeSync(Recorded);

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

/** Every item of one of Pidgeon's lists that `decode` reads; one it can't read is left out. */
const listed = Effect.fn("listed")(function* <A>(
  adminKey: Redacted.Redacted<string>,
  path: string,
  decode: (item: unknown) => Option.Option<A>
) {
  const source = yield* PidgeonSource.Source;
  const items: A[] = [];
  let cursor: string | null = null;
  do {
    const answer = yield* source.call(
      adminKey,
      { method: "GET", path, ...(cursor === null ? {} : { query: { cursor } }) },
      yield* soon
    );
    const page = decodePage(answer.body);
    if (Option.isNone(page)) return yield* new PidgeonSource.Unavailable({ stage: "response" });
    for (const item of page.value.data) {
      const value = decode(item);
      if (Option.isSome(value)) items.push(value.value);
    }
    const next: string | null = page.value.next_cursor ?? null;
    // A cursor that repeats would never end the list.
    cursor = next === cursor ? null : next;
  } while (cursor !== null);
  return items;
});

/**
 * Takes down what an environment made in Pidgeon, with the test admin key: the test addresses
 * whose local parts are exactly `localParts`, and first each key that reaches nothing else. It
 * only ever revokes a test key Patchy named below admin, and only deletes a test address; it
 * refuses an admin key that isn't a test key before anything else. A key or address already gone
 * counts as done; a recorded address Pidgeon no longer has comes back as `missing`. Fails, naming
 * the addresses, when any of it doesn't happen.
 */
export const takeDown = Effect.fn("takeDownPidgeonAddresses")(function* (
  adminKey: Redacted.Redacted<string>,
  localParts: ReadonlyArray<string>
) {
  const left = (why: string) => new PidgeonLeft({ addresses: localParts, why });
  const answered = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(effect, (error) => left(`Pidgeon didn't answer (${error.message})`));
  const source = yield* PidgeonSource.Source;
  if (!(yield* answered(isTestKey(adminKey))))
    return yield* left("PIDGEON_TEST_ADMIN_KEY isn't a Pidgeon test key");
  const wanted = new Set(localParts);
  const addresses = (yield* answered(listed(adminKey, "/identities", decodeIdentity))).filter(
    (identity) => identity.test && wanted.has(identity.local_part)
  );
  const ids = new Set(addresses.map((identity) => identity.id));
  const keys = (yield* answered(listed(adminKey, "/api-keys", decodeKey))).filter(
    (key) =>
      key.revoked_at === null &&
      key.name.startsWith("Patchy ") &&
      key.test &&
      (key.access === "read" || key.access === "draft" || key.access === "send") &&
      (key.identity_ids ?? []).length > 0 &&
      (key.identity_ids ?? []).every((id) => ids.has(id))
  );
  const gone = (path: string) =>
    Effect.flatMap(soon, (deadline) =>
      source.call(adminKey, { method: "DELETE", path }, deadline)
    ).pipe(
      Effect.asVoid,
      // Gone already: done all the same.
      Effect.catchTag("PidgeonNotFound", () => Effect.void)
    );
  // Keys first: once its address is gone, a key reaches nothing and this can't tell it's ours.
  for (const key of keys)
    yield* gone(`/api-keys/${encodeURIComponent(key.id)}`).pipe(
      Effect.mapError((error) => left(`Pidgeon didn't revoke key ${key.id} (${error.message})`))
    );
  for (const identity of addresses)
    yield* gone(`/identities/${encodeURIComponent(identity.id)}`).pipe(
      Effect.mapError((error) =>
        left(`Pidgeon didn't delete ${identity.local_part} (${error.message})`)
      )
    );
  const found = new Set(addresses.map((identity) => identity.local_part));
  return {
    revoked: keys.length,
    deleted: addresses.length,
    missing: localParts.filter((localPart) => !found.has(localPart))
  };
});

/**
 * What `down` says it did in Pidgeon. A recorded address Pidgeon no longer has, deleted a day
 * after it was made or never made, can't say which key was its: one it had reaches nothing, and
 * the guarded stale sweep revokes that.
 */
export const told = (done: {
  readonly revoked: number;
  readonly deleted: number;
  readonly missing: ReadonlyArray<string>;
}) => [
  ...done.missing.map(
    (localPart) =>
      `  Pidgeon: ${localPart} isn't in Pidgeon any more, or never was. Any key it had reaches nothing, and the stale sweep, \`pnpm test:pidgeon:sweep\`, revokes it.`
  ),
  `  Pidgeon: revoked ${done.revoked} key${done.revoked === 1 ? "" : "s"} and deleted ${done.deleted} test address${done.deleted === 1 ? "" : "es"} this environment made.`
];

/** The local parts recorded in `file`: none when there is no file. */
const recorded = Effect.fn("recordedPidgeon")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return Option.none<ReadonlyArray<string>>();
  const read = decodeRecorded(yield* fs.readFileString(file));
  if (Option.isNone(read))
    return yield* new PidgeonLeft({ addresses: [], why: `${file} couldn't be read` });
  return read;
});

/**
 * Records a test address's local part in `file` before `up` asks Pidgeon to make it, so `down`
 * finds it even when the connect failed after Pidgeon made it. The new record is written beside
 * the old and renamed over it, so a write cut short never loses what was recorded before.
 */
export const recordAddress = Effect.fn("recordPidgeonAddress")(function* (
  file: string,
  localPart: string
) {
  const fs = yield* FileSystem.FileSystem;
  const before = Option.getOrElse(yield* recorded(file), () => []);
  const next = `${file}.next`;
  yield* fs.writeFileString(next, encodeRecorded([...before, localPart]));
  yield* fs.rename(next, file);
});

/**
 * For `down` and `reset`: takes down the test addresses recorded in `file`, and their keys, with
 * the developer's test admin key, then drops the record. Nothing recorded, nothing to do, and no
 * call to Pidgeon.
 */
export const takeDownRecorded = Effect.fn("takeDownRecordedPidgeon")(function* (
  file: string,
  devEnvFile: string
) {
  const localParts = yield* recorded(file);
  if (Option.isNone(localParts) || localParts.value.length === 0) return;
  const adminKey = yield* readPidgeonTestKey(devEnvFile);
  if (Option.isNone(adminKey))
    return yield* new PidgeonLeft({
      addresses: localParts.value,
      why: `there's no PIDGEON_TEST_ADMIN_KEY in the environment or ${devEnvFile}`
    });
  const done = yield* takeDown(adminKey.value, localParts.value).pipe(
    Effect.provide(PidgeonSource.layer)
  );
  for (const line of told(done)) yield* Console.error(line);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(file);
});
