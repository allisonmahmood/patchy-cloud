// @effect-diagnostics nodeBuiltinImport:off — node:crypto hashes a connect attempt into Pidgeon's Idempotency-Key.
import { createHash, randomInt } from "node:crypto";
import type { PidgeonSnapshot } from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Source from "./Source.js";

/**
 * The keys Patchy makes in Pidgeon. An admin pastes an admin key over the whole account; Patchy
 * uses it for that one request to find or create the address and mint a key for it alone, checks
 * that key reaches exactly the address at the chosen access, and keeps only it. Anything minted
 * before a failure is revoked again, by the key itself or, when the mint's answer was lost, by its
 * name with the admin key.
 */

export type Access = "read" | "send";
const Access = Schema.Literals(["read", "send"]);

// ---------- refusals ----------

const Instant = Schema.String;
/** "14:47 UTC", from an ISO instant. */
const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;

export class InvalidAdminKey extends Schema.TaggedError<InvalidAdminKey>()(
  "PidgeonInvalidAdminKey",
  {}
) {
  readonly code = "invalid_credentials" as const;
  readonly status = 422;
  override get message() {
    return "Paste a Pidgeon admin key: it starts with pgn_live_.";
  }
}
export class TestModeKey extends Schema.TaggedError<TestModeKey>()("PidgeonTestModeKey", {}) {
  readonly code = "pidgeon_test_key" as const;
  readonly status = 422;
  override get message() {
    return "Mail from a test-mode key never leaves Pidgeon, so patches couldn't really send. Paste a live admin key.";
  }
}
export class AdminKeyRejected extends Schema.TaggedError<AdminKeyRejected>()(
  "PidgeonAdminKeyRejected",
  {}
) {
  readonly code = "pidgeon_admin_key_rejected" as const;
  readonly status = 422;
  override get message() {
    return "Pidgeon didn't accept this admin key. Check it's current: a revoked key stops working at once.";
  }
}
export class NotAdminKey extends Schema.TaggedError<NotAdminKey>()("PidgeonNotAdminKey", {}) {
  readonly code = "pidgeon_not_admin" as const;
  readonly status = 422;
  override get message() {
    return "Patchy needs an admin key to find addresses and make a key for one. In Pidgeon, make a new key with Admin access.";
  }
}
export class PartialAdminKey extends Schema.TaggedError<PartialAdminKey>()(
  "PidgeonPartialAdminKey",
  {}
) {
  readonly code = "pidgeon_partial_admin" as const;
  readonly status = 422;
  override get message() {
    return "Patchy needs an admin key over the whole account, so it can always find the keys it makes. In Pidgeon, make an Admin key that reaches every address.";
  }
}
export class AddressNotFound extends Schema.TaggedError<AddressNotFound>()(
  "PidgeonAddressNotFound",
  {}
) {
  readonly code = "pidgeon_address_not_found" as const;
  readonly status = 422;
  override get message() {
    return "Pidgeon has no such address that this key reaches. Find addresses again.";
  }
}
export class NoInbox extends Schema.TaggedError<NoInbox>()("PidgeonNoInbox", {
  email: Schema.String
}) {
  readonly code = "pidgeon_no_inbox" as const;
  readonly status = 422;
  override get message() {
    return `${this.email} keeps no inbox in Pidgeon, so there's nothing for patches to read. Pick an address with an inbox, or create one.`;
  }
}
export class AddressTaken extends Schema.TaggedError<AddressTaken>()("PidgeonAddressTaken", {
  email: Schema.String
}) {
  readonly code = "pidgeon_address_taken" as const;
  readonly status = 422;
  override get message() {
    return `${this.email} is taken. Choose another name, or pick it from the list if it's yours.`;
  }
}
/** Pidgeon refused the new address's fields, naming the one at fault when it's one. */
export class InvalidAddress extends Schema.TaggedError<InvalidAddress>()("PidgeonInvalidAddress", {
  cause: Source.Invalid
}) {
  readonly code = "pidgeon_invalid_address" as const;
  readonly status = 422;
  override get message() {
    return `Pidgeon refused this address: ${this.cause.details.message}`;
  }
}
/** The workspace has no such domain to create an address on. */
export class UnknownDomain extends Schema.TaggedError<UnknownDomain>()("PidgeonUnknownDomain", {
  domain: Schema.String
}) {
  readonly code = "pidgeon_unknown_domain" as const;
  readonly status = 422;
  override get message() {
    return `This Pidgeon workspace has no domain ${this.domain}. Pick ${SHARED_DOMAIN} or one of your own.`;
  }
}
/** The key Pidgeon minted could do more, or other, than Patchy asked; it was revoked. */
export class MintedKeyUnexpected extends Schema.TaggedError<MintedKeyUnexpected>()(
  "PidgeonMintedKeyUnexpected",
  {
    /** What was off, for diagnostics: a test key, the wrong access, or the wrong reach. */
    found: Schema.Literals(["test", "access", "reach"])
  }
) {
  readonly code = "pidgeon_key_unexpected" as const;
  readonly status = 502;
  override get message() {
    return "The key Pidgeon made for this address could do more, or other, than Patchy asked, so Patchy revoked it and saved nothing. Try again.";
  }
}
/** The mint's answer never came; Patchy revoked every key it might have made. */
export class MintUnknown extends Schema.TaggedError<MintUnknown>()("PidgeonMintUnknown", {
  cause: Schema.Union([Source.Unavailable, Source.Timeout, Source.TooLarge])
}) {
  readonly code = "pidgeon_mint_unknown" as const;
  readonly status = 503;
  override get message() {
    return "Pidgeon didn't answer while making the key, so Patchy revoked any key it might have made and saved nothing. Try again.";
  }
}
/** Patchy stopped before saving and couldn't revoke what it minted; an admin can. */
export class StrayKey extends Schema.TaggedError<StrayKey>()("PidgeonStrayKey", {
  key: Schema.String
}) {
  readonly code = "pidgeon_key_left" as const;
  readonly status = 503;
  override get message() {
    return `Patchy stopped before saving anything, and couldn't revoke the key it made in Pidgeon, named ${this.key}. Revoke it in Pidgeon under Developers › API keys.`;
  }
}
/** The save's own outcome is unknown, so nothing was revoked. */
export class SaveUnknown extends Schema.TaggedError<SaveUnknown>()("PidgeonSaveUnknown", {
  key: Schema.String,
  name: Schema.String
}) {
  readonly code = "pidgeon_save_unknown" as const;
  readonly status = 503;
  override get message() {
    return `Patchy couldn't tell whether ${this.name} was saved. Check the connections list: if it isn't there, revoke the key named ${this.key} in Pidgeon under Developers › API keys.`;
  }
}
/** The stored key no longer works: revoked, for example because its admin key was. */
export class StoredKeyRejected extends Schema.TaggedError<StoredKeyRejected>()(
  "PidgeonStoredKeyRejected",
  {}
) {
  readonly code = "pidgeon_key_stopped" as const;
  readonly status = 409;
  override get message() {
    return "Pidgeon refused Patchy's key for this address, perhaps because the admin key it was made with was revoked. Patches can't read or send until it's replaced.";
  }
}
/** The address was deleted in Pidgeon, or the key no longer reaches it. */
export class AddressGone extends Schema.TaggedError<AddressGone>()("PidgeonAddressGone", {
  email: Schema.String
}) {
  readonly code = "pidgeon_address_gone" as const;
  readonly status = 409;
  override get message() {
    return `${this.email} is gone from Pidgeon, or Patchy's key no longer reaches it. Replacing the key can't bring it back; connect a different address as a new connection.`;
  }
}
/** Rotate waits until a saved rotation's old secret stops, as the page said it would. */
export class RotationRunning extends Schema.TaggedError<RotationRunning>()(
  "PidgeonRotationRunning",
  { oldStopsAt: Instant }
) {
  readonly code = "pidgeon_rotation_running" as const;
  readonly status = 409;
  override get message() {
    return `The key was just rotated, and its old secret stops at ${clock(this.oldStopsAt)}. Rotate again after that.`;
  }
}
/** A rotation's answer never came; the stored secret may stop when its grace period ends. */
export class RotationUnknown extends Schema.TaggedError<RotationUnknown>()(
  "PidgeonRotationUnknown",
  { stopsBy: Instant }
) {
  readonly code = "pidgeon_rotation_unknown" as const;
  readonly status = 409;
  override get message() {
    return `Patchy's key may stop working when Pidgeon's grace period ends, by ${clock(this.stopsBy)}. Replace the key to be sure. Rotate stays off until then.`;
  }
}
/** Pidgeon rotated the key, but its new secret couldn't be saved. */
export class RotationNotSaved extends Schema.TaggedError<RotationNotSaved>()(
  "PidgeonRotationNotSaved",
  { oldStopsAt: Instant }
) {
  readonly code = "pidgeon_rotation_not_saved" as const;
  readonly status = 503;
  override get message() {
    return `Pidgeon gave Patchy's key a new secret, but Patchy couldn't save it. The secret Patchy holds stops at ${clock(this.oldStopsAt)}: replace the key before then.`;
  }
}

/** What checking an admin key can refuse. */
export type AdminKeyError =
  | InvalidAdminKey
  | TestModeKey
  | AdminKeyRejected
  | NotAdminKey
  | PartialAdminKey
  | Source.CallError;
/** What finding or creating the address can refuse. */
export type AddressError =
  AddressNotFound | NoInbox | AddressTaken | InvalidAddress | UnknownDomain;
/** What minting and checking the address key can refuse. */
export type MintError = MintedKeyUnexpected | MintUnknown | StrayKey;
/** What the stored key's calls can refuse. */
export type StoredKeyError = StoredKeyRejected | AddressGone;
export type KeysError =
  | AdminKeyError
  | AddressError
  | MintError
  | StoredKeyError
  | SaveUnknown
  | RotationRunning
  | RotationUnknown
  | RotationNotSaved
  | Source.InvalidCredentials;

// ---------- Pidgeon's shapes ----------

const Me = Schema.Struct({
  key: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      access: Schema.String,
      reaches_all_addresses: Schema.Boolean
    })
  ),
  workspace: Schema.Struct({ plan: Schema.String }),
  reaches: Schema.Int
});
const Identity = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  display_name: Schema.NullOr(Schema.String),
  has_inbox: Schema.Boolean,
  send_policy: Schema.String
});
type Identity = typeof Identity.Type;
const Domain = Schema.Struct({ id: Schema.String, domain: Schema.String });
const Minted = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  token: Schema.String,
  test: Schema.Boolean,
  created_at: Schema.String
});
const Rotated = Schema.Struct({
  token: Schema.String,
  previous_token_expires_at: Schema.NullOr(Schema.String)
});
const Key = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  revoked_at: Schema.NullOr(Schema.String)
});
const Label = Schema.Struct({ id: Schema.String, name: Schema.String, colour: Schema.String });
const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    data: Schema.Array(item),
    has_more: Schema.Boolean,
    next_cursor: Schema.NullOr(Schema.String)
  });
const IdentityPage = Page(Identity);
const DomainPage = Page(Domain);
const KeyPage = Page(Key);
const LabelPage = Page(Label);
const decodeMe = Schema.decodeUnknownEffect(Me);
const decodeIdentity = Schema.decodeUnknownEffect(Identity);
const decodeMinted = Schema.decodeUnknownEffect(Minted);
const decodeRotated = Schema.decodeUnknownEffect(Rotated);
const decodeIdentityPage = Schema.decodeUnknownEffect(IdentityPage);
const decodeDomainPage = Schema.decodeUnknownEffect(DomainPage);
const decodeKeyPage = Schema.decodeUnknownEffect(KeyPage);
const decodeLabelPage = Schema.decodeUnknownEffect(LabelPage);

/** An answer Patchy can't read is Pidgeon answering unexpectedly. */
const unreadable = (cause: Schema.SchemaError) =>
  new Source.Unavailable({ stage: "response", cause: Redacted.make(cause) });

/** The pages of one list, following Pidgeon's cursor up to `max` items. */
const listed = Effect.fn("PidgeonKeys.listed")(function* <A>(
  source: Source.Source["Service"],
  token: Redacted.Redacted<string>,
  request: Source.Request,
  deadline: number,
  decode: (
    body: unknown
  ) => Effect.Effect<
    { readonly data: ReadonlyArray<A>; readonly next_cursor: string | null },
    Schema.SchemaError
  >,
  max: number
) {
  const found: A[] = [];
  let cursor: string | null = null;
  do {
    const answer: Source.Answer = yield* source.call(
      token,
      { ...request, query: { ...request.query, ...(cursor === null ? {} : { cursor }) } },
      deadline
    );
    const page: { readonly data: ReadonlyArray<A>; readonly next_cursor: string | null } =
      yield* decode(answer.body).pipe(Effect.mapError(unreadable));
    found.push(...page.data);
    if (found.length > max) return { items: found.slice(0, max), more: true };
    // A cursor that repeats would never end the list.
    cursor = page.next_cursor === cursor ? null : page.next_cursor;
  } while (cursor !== null);
  return { items: found, more: false };
});

// ---------- the admin key ----------

/** One admin request's deadline: every call from checking the key to reading the snapshot. */
export const deadline = Effect.map(
  Clock.currentTimeMillis,
  (now) => now + registry["pidgeon.connect.deadline"].default
);

/**
 * The admin key as Pidgeon describes it, refused unless it's a live admin key over the whole
 * account. `/me` doesn't say test mode, so the key's own `pgn_test_` prefix does, before any call.
 */
export const checkAdmin = Effect.fn("PidgeonKeys.checkAdmin")(function* (
  adminKey: Redacted.Redacted<string>,
  until: number
) {
  const key = Redacted.value(adminKey);
  if (!Source.isToken(key)) return yield* new InvalidAdminKey({});
  if (Source.isTestToken(key)) return yield* new TestModeKey({});
  const source = yield* Source.Source;
  const answer = yield* source
    .call(adminKey, { method: "GET", path: "/me" }, until)
    .pipe(Effect.catchTags({ PidgeonKeyRejected: () => Effect.fail(new AdminKeyRejected({})) }));
  const me = yield* decodeMe(Source.data(answer.body)).pipe(Effect.mapError(unreadable));
  if (me.key === null) return yield* new AdminKeyRejected({});
  if (me.key.access !== "admin") return yield* new NotAdminKey({});
  if (!me.key.reaches_all_addresses) return yield* new PartialAdminKey({});
  return { reaches: me.reaches, plan: me.workspace.plan };
});

/** An address as the connect form lists it. */
export interface Address {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly sendPolicy: string;
  readonly hasInbox: boolean;
}
const address = (identity: Identity): Address => ({
  id: identity.id,
  email: identity.email,
  displayName: identity.display_name,
  sendPolicy: identity.send_policy,
  hasInbox: identity.has_inbox
});

/** Pidgeon's shared domain, which `GET /domains` doesn't list but every workspace may use. */
export const SHARED_DOMAIN = "pidgeon.email";

/**
 * What the connect form offers after the admin key is checked: the addresses it reaches, and the
 * domains a new address can use, the shared one first.
 */
export const addresses = Effect.fn("PidgeonKeys.addresses")(function* (
  adminKey: Redacted.Redacted<string>
) {
  const until = yield* deadline;
  const me = yield* checkAdmin(adminKey, until);
  const source = yield* Source.Source;
  const found = yield* listed(
    source,
    adminKey,
    { method: "GET", path: "/identities", query: { limit: 200 } },
    until,
    decodeIdentityPage,
    registry["pidgeon.addresses.listed"].default
  );
  const domains = yield* listed(
    source,
    adminKey,
    { method: "GET", path: "/domains", query: { limit: 200 } },
    until,
    decodeDomainPage,
    registry["pidgeon.addresses.listed"].default
  );
  return {
    reaches: me.reaches,
    addresses: found.items.map(address),
    more: found.more,
    domains: [
      SHARED_DOMAIN,
      ...domains.items.map((item) => item.domain).filter((domain) => domain !== SHARED_DOMAIN)
    ]
  };
});

// ---------- what an admin submits ----------

/** One connect page or form's attempt, kept across a refused submit so a retry repeats it. */
export const Attempt = Schema.String.check(Schema.isPattern(/^[a-z0-9]{12}$/));
export const isAttempt = Schema.is(Attempt);
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const code = (length: number) =>
  Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
export const newAttempt = () => code(12);

export const LocalPart = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/)
);
export const SendPolicy = Schema.Literals(["reply_only", "open"]);
/** The address the admin picked, or the one Patchy creates with an inbox. */
export const Choice = Schema.Union([
  Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)) }),
  Schema.Struct({
    create: Schema.Struct({
      localPart: LocalPart,
      domain: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
      displayName: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
      sendPolicy: SendPolicy
    })
  })
]);
export type Choice = typeof Choice.Type;

/** Connect's secret: the admin key travels only inside it, and is never stored. */
export const ConnectRequest = Schema.Struct({
  adminKey: Schema.String,
  attempt: Attempt,
  address: Choice,
  access: Access
});
export type ConnectRequest = typeof ConnectRequest.Type;
/** Change access and Replace key: the same address, a new key at `access`. */
export const ReplaceRequest = Schema.Struct({
  adminKey: Schema.String,
  attempt: Attempt,
  access: Access
});
export type ReplaceRequest = typeof ReplaceRequest.Type;

const connectJson = Schema.fromJsonString(ConnectRequest);
const replaceJson = Schema.fromJsonString(ReplaceRequest);
const encodeConnect = Schema.encodeSync(connectJson);
const encodeReplace = Schema.encodeSync(replaceJson);
export const connectSecret = (value: ConnectRequest) => Redacted.make(encodeConnect(value));
export const replaceSecret = (value: ReplaceRequest) => Redacted.make(encodeReplace(value));
export const parseConnect = Effect.fn("PidgeonKeys.parseConnect")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* Schema.decodeUnknownEffect(connectJson)(Redacted.value(secret)).pipe(
    Effect.mapError(() => new InvalidAdminKey({}))
  );
});
export const parseReplace = Effect.fn("PidgeonKeys.parseReplace")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* Schema.decodeUnknownEffect(replaceJson)(Redacted.value(secret)).pipe(
    Effect.mapError(() => new InvalidAdminKey({}))
  );
});

/**
 * Patchy's key for one connection, as Pidgeon lists it, under its 60-character limit: the page's
 * attempt, then a code of this submission's own. Two submissions of one attempt can overlap, so a
 * lost mint's cleanup finds keys by the whole name and never takes the other's.
 */
export const keyName = (handle: string, attempt: string) =>
  `Patchy ${handle} ${attempt} ${code(6)}`;

// ---------- the address ----------

const idempotencyKey = (scope: string, attempt: string, body: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([scope, attempt, body]))
    .digest("hex");

/**
 * The chosen address, refused without an inbox, or the new one, created with an inbox. Creation's
 * Idempotency-Key comes from the attempt and the address asked for, so a retried connect never
 * makes two addresses.
 */
const findOrCreate = Effect.fn("PidgeonKeys.findOrCreate")(function* (
  adminKey: Redacted.Redacted<string>,
  scope: string,
  attempt: string,
  choice: Choice,
  until: number
) {
  const source = yield* Source.Source;
  if ("id" in choice) {
    const answer = yield* source
      .call(
        adminKey,
        { method: "GET", path: `/identities/${encodeURIComponent(choice.id)}` },
        until
      )
      .pipe(Effect.catchTags({ PidgeonNotFound: () => Effect.fail(new AddressNotFound({})) }));
    const identity = yield* decodeIdentity(Source.data(answer.body)).pipe(
      Effect.mapError(unreadable)
    );
    if (!identity.has_inbox) return yield* new NoInbox({ email: identity.email });
    return identity;
  }
  const body = {
    local_part: choice.create.localPart,
    domain: choice.create.domain,
    display_name: choice.create.displayName,
    inbox: true,
    send_policy: choice.create.sendPolicy
  };
  const email = `${choice.create.localPart}@${choice.create.domain}`;
  const answer = yield* source
    .call(
      adminKey,
      {
        method: "POST",
        path: "/identities",
        body,
        idempotencyKey: idempotencyKey(scope, attempt, body)
      },
      until
    )
    .pipe(
      Effect.catchTags({
        PidgeonConflict: (cause) =>
          cause.details.field === "localPart"
            ? Effect.fail(new AddressTaken({ email }))
            : Effect.fail(cause),
        PidgeonInvalid: (cause) => Effect.fail(new InvalidAddress({ cause })),
        PidgeonNotFound: () => Effect.fail(new UnknownDomain({ domain: choice.create.domain }))
      })
    );
  const identity = yield* decodeIdentity(Source.data(answer.body)).pipe(
    Effect.mapError(unreadable)
  );
  if (!identity.has_inbox) return yield* new NoInbox({ email: identity.email });
  return identity;
});

// ---------- the address key ----------

/** A key Patchy minted and keeps: its id and name, and its secret. */
export interface Made {
  readonly id: string;
  readonly name: string;
  readonly token: Redacted.Redacted<string>;
  readonly madeAt: string;
}

/**
 * Revokes a key with its own secret. One already revoked answers 401, which counts as done, as
 * does the 404 of a key gone some other way.
 */
export const revoke = Effect.fn("PidgeonKeys.revoke")(function* (
  token: Redacted.Redacted<string>,
  id: string
) {
  const source = yield* Source.Source;
  const until = (yield* Clock.currentTimeMillis) + registry["integration.deadline"].default;
  yield* source
    .call(token, { method: "DELETE", path: `/api-keys/${encodeURIComponent(id)}` }, until)
    .pipe(
      Effect.asVoid,
      Effect.catchTags({
        PidgeonKeyRejected: () => Effect.void,
        PidgeonNotFound: () => Effect.void
      })
    );
});

/**
 * Revokes, with the admin key, every live key named `name`: what one submission's mint made,
 * which only that submission could have saved.
 */
const revokeByName = Effect.fn("PidgeonKeys.revokeByName")(function* (
  adminKey: Redacted.Redacted<string>,
  name: string
) {
  const source = yield* Source.Source;
  const until = (yield* Clock.currentTimeMillis) + registry["integration.deadline"].default;
  const keys = yield* listed(
    source,
    adminKey,
    { method: "GET", path: "/api-keys" },
    until,
    decodeKeyPage,
    10_000
  );
  for (const key of keys.items) {
    if (key.name !== name || key.revoked_at !== null) continue;
    yield* source
      .call(adminKey, { method: "DELETE", path: `/api-keys/${encodeURIComponent(key.id)}` }, until)
      .pipe(Effect.catchTags({ PidgeonNotFound: () => Effect.void }));
  }
});

/** What a key reaches and may do, by its own `/me` and `/identities`. */
const reachOf = Effect.fn("PidgeonKeys.reachOf")(function* (
  token: Redacted.Redacted<string>,
  until: number
) {
  const source = yield* Source.Source;
  const me = yield* source
    .call(token, { method: "GET", path: "/me" }, until)
    .pipe(
      Effect.flatMap((answer) =>
        decodeMe(Source.data(answer.body)).pipe(Effect.mapError(unreadable))
      )
    );
  const identities = yield* listed(
    source,
    token,
    { method: "GET", path: "/identities", query: { limit: 2 } },
    until,
    decodeIdentityPage,
    2
  );
  return { me, identities: identities.items };
});

/** The address's labels and what the key may do, as an immutable snapshot. */
const snapshotOf = Effect.fn("PidgeonKeys.snapshotOf")(function* (
  token: Redacted.Redacted<string>,
  identity: Identity,
  access: Access,
  plan: string,
  until: number
) {
  const source = yield* Source.Source;
  const labels = yield* listed(
    source,
    token,
    { method: "GET", path: "/labels", query: { identity_id: identity.id } },
    until,
    decodeLabelPage,
    registry["pidgeon.snapshot.labels"].default
  );
  const snapshot: PidgeonSnapshot = {
    version: 1,
    address: {
      email: identity.email.slice(0, 320),
      displayName: identity.display_name?.slice(0, 200) ?? null,
      sendPolicy: identity.send_policy.slice(0, 32)
    },
    access,
    // The snapshot's bounds: the first labels Pidgeon lists, each cut to what a snapshot keeps.
    labels: labels.items.map(({ id, name, colour }) => ({
      id: id.slice(0, 128),
      name: name.slice(0, 200),
      colour: colour.slice(0, 32)
    })),
    plan: plan.slice(0, 64)
  };
  return snapshot;
});

/**
 * Mints a key for `identity` alone at `access`, then checks it before anything uses it: the mint
 * must say it's live, and the key's own `/me` and `/identities` must show the chosen access and
 * exactly this address. A key that fails, or anything after it, is revoked with its own secret; a
 * mint whose answer was lost is cleaned up by its name with the admin key.
 */
const mint = Effect.fn("PidgeonKeys.mint")(function* (
  adminKey: Redacted.Redacted<string>,
  name: string,
  identity: Identity,
  access: Access,
  until: number
) {
  const source = yield* Source.Source;
  const minted = yield* source
    .call(
      adminKey,
      {
        method: "POST",
        path: "/api-keys",
        body: { name, identity_ids: [identity.id], access }
      },
      until
    )
    .pipe(
      Effect.flatMap((answer) =>
        decodeMinted(Source.data(answer.body)).pipe(Effect.mapError(unreadable))
      ),
      Effect.catchTags({
        PidgeonUnavailable: (cause) => lost(adminKey, name, cause),
        PidgeonTimeout: (cause) => lost(adminKey, name, cause),
        PidgeonTooLarge: (cause) => lost(adminKey, name, cause)
      })
    );
  const made: Made = {
    id: minted.id,
    name: minted.name,
    token: Redacted.make(minted.token),
    madeAt: minted.created_at
  };
  return { made, checked: check(made, minted.test, identity, access, until) };
});

/** A mint whose answer never came: any key it made is revoked by its name, or named. */
const lost = (
  adminKey: Redacted.Redacted<string>,
  name: string,
  cause: Source.Unavailable | Source.Timeout | Source.TooLarge
) =>
  revokeByName(adminKey, name).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.fail(new StrayKey({ key: name })),
      onSuccess: () => Effect.fail(new MintUnknown({ cause }))
    })
  );

const check = (made: Made, test: boolean, identity: Identity, access: Access, until: number) =>
  Effect.gen(function* () {
    if (test || Source.isTestToken(Redacted.value(made.token)))
      return yield* new MintedKeyUnexpected({ found: "test" });
    const reach = yield* reachOf(made.token, until);
    if (reach.me.key === null || reach.me.key.access !== access)
      return yield* new MintedKeyUnexpected({ found: "access" });
    if (
      reach.me.key.reaches_all_addresses ||
      reach.identities.length !== 1 ||
      reach.identities[0]?.id !== identity.id
    )
      return yield* new MintedKeyUnexpected({ found: "reach" });
    return reach.me.workspace.plan;
  });

/** Revokes `made` after a failure, or names it when that fails too. */
export const undo = <E>(made: Made, error: E) =>
  revoke(made.token, made.id).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.fail(new StrayKey({ key: made.name })),
      onSuccess: () => Effect.fail(error)
    })
  );

/** A minted, checked key and the snapshot it read, ready for the store to save. */
export interface Provisioned {
  readonly made: Made;
  readonly identity: Address;
  readonly snapshot: PidgeonSnapshot;
}

/**
 * Connect's work in Pidgeon, in order: check the admin key, find or create the address, mint its
 * key, check the key, read the snapshot with it. Nothing is saved here; on any failure after the
 * mint the key is revoked again.
 */
export const provision = Effect.fn("PidgeonKeys.provision")(function* (input: {
  readonly request: ConnectRequest;
  readonly handle: string;
  /** Scopes the address's Idempotency-Key, such as the company. */
  readonly scope: string;
}) {
  const until = yield* deadline;
  const adminKey = Redacted.make(input.request.adminKey);
  yield* checkAdmin(adminKey, until);
  const identity = yield* findOrCreate(
    adminKey,
    input.scope,
    input.request.attempt,
    input.request.address,
    until
  );
  return yield* minted(
    adminKey,
    keyName(input.handle, input.request.attempt),
    identity,
    input.request.access,
    until
  );
});

/**
 * Change access and Replace key in Pidgeon: a new key for the same address, checked, with a fresh
 * snapshot. A different address is a new connection, so the admin key must reach this one.
 */
export const replace = Effect.fn("PidgeonKeys.replace")(function* (input: {
  readonly request: ReplaceRequest;
  readonly handle: string;
  readonly identityId: string;
}) {
  const until = yield* deadline;
  const adminKey = Redacted.make(input.request.adminKey);
  yield* checkAdmin(adminKey, until);
  const identity = yield* findOrCreate(
    adminKey,
    "",
    input.request.attempt,
    { id: input.identityId },
    until
  );
  return yield* minted(
    adminKey,
    keyName(input.handle, input.request.attempt),
    identity,
    input.request.access,
    until
  );
});

const minted = Effect.fn("PidgeonKeys.minted")(function* (
  adminKey: Redacted.Redacted<string>,
  name: string,
  identity: Identity,
  access: Access,
  until: number
) {
  const { made, checked } = yield* mint(adminKey, name, identity, access, until);
  return yield* Effect.gen(function* () {
    const plan = yield* checked;
    const snapshot = yield* snapshotOf(made.token, identity, access, plan, until);
    return { made, identity: address(identity), snapshot } satisfies Provisioned;
  }).pipe(Effect.catch((error) => undo(made, error)));
});

// ---------- the stored key ----------

/**
 * The stored key still works and reaches its address: `/me` and `/identities` as the key sees
 * them. A key whose address was deleted still signs in, reaching nothing.
 */
export const test = Effect.fn("PidgeonKeys.test")(function* (
  credentials: Source.Credentials,
  email: string
) {
  const until = (yield* Clock.currentTimeMillis) + registry["integration.deadline"].default;
  const token = Redacted.make(credentials.key.token);
  const reach = yield* reachOf(token, until).pipe(
    Effect.catchTags({ PidgeonKeyRejected: () => Effect.fail(new StoredKeyRejected({})) })
  );
  if (reach.me.key === null) return yield* new StoredKeyRejected({});
  if (!reach.identities.some((identity) => identity.id === credentials.identityId))
    return yield* new AddressGone({ email });
  return reach;
});

/** A fresh snapshot with the stored key, for Refresh labels. */
export const inspect = Effect.fn("PidgeonKeys.inspect")(function* (
  credentials: Source.Credentials,
  email: string,
  access: Access
) {
  const until = yield* deadline;
  const reach = yield* test(credentials, email);
  const identity = reach.identities.find((item) => item.id === credentials.identityId);
  if (identity === undefined) return yield* new AddressGone({ email });
  return {
    identity: address(identity),
    snapshot: yield* snapshotOf(
      Redacted.make(credentials.key.token),
      identity,
      access,
      reach.me.workspace.plan,
      until
    )
  };
});

/** How a rotation ended: a new secret, or an answer that never came. */
export type Rotation =
  | {
      readonly outcome: "rotated";
      readonly token: Redacted.Redacted<string>;
      readonly oldStopsAt: string;
    }
  | { readonly outcome: "unknown" };

/**
 * Gives the stored key a new secret, its old one working for the grace period. A refusal changed
 * nothing; an answer that never came may still have rotated it, so the caller records it.
 */
export const rotate = Effect.fn("PidgeonKeys.rotate")(function* (credentials: Source.Credentials) {
  const source = yield* Source.Source;
  const now = yield* Clock.currentTimeMillis;
  const grace = registry["pidgeon.rotation.grace"].default;
  return yield* source
    .call(
      Redacted.make(credentials.key.token),
      {
        method: "POST",
        path: `/api-keys/${encodeURIComponent(credentials.key.id)}/rotate`,
        body: { grace_period_seconds: grace }
      },
      now + registry["integration.deadline"].default
    )
    .pipe(
      Effect.flatMap((answer) =>
        decodeRotated(Source.data(answer.body)).pipe(Effect.mapError(unreadable))
      ),
      Effect.map((rotated): Rotation => ({
        outcome: "rotated",
        token: Redacted.make(rotated.token),
        oldStopsAt:
          rotated.previous_token_expires_at ??
          DateTime.formatIso(DateTime.makeUnsafe(now + grace * 1_000))
      })),
      Effect.catchTags({
        PidgeonKeyRejected: () => Effect.fail(new StoredKeyRejected({})),
        PidgeonUnavailable: () => Effect.succeed<Rotation>({ outcome: "unknown" }),
        PidgeonTimeout: () => Effect.succeed<Rotation>({ outcome: "unknown" }),
        PidgeonTooLarge: () => Effect.succeed<Rotation>({ outcome: "unknown" })
      })
    );
});
