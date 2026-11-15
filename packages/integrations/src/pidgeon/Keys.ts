import type { PidgeonSnapshot } from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Source from "./Source.js";

/**
 * Connecting a Pidgeon inbox with a key an admin made in Pidgeon's dashboard. Such a key reaches
 * the whole Pidgeon account, and Pidgeon makes no narrower one, so Patchy checks what the key may
 * do, lists the inboxes it reaches for the admin to pick one, and keeps the key with that inbox's
 * id. What keeps every later call to that one inbox is Patchy's own checks in the operations.
 * Nothing here makes, changes or sends anything in Pidgeon.
 */

/** What patches may do with a connection: Patchy's own setting, enforced before Pidgeon sees it. */
export type Access = "read" | "send";
const Access = Schema.Literals(["read", "send"]);
/** What a key may do in Pidgeon, as far as Patchy asks: `draft` keys read here. */
export type Level = "read" | "send" | "admin";

// ---------- refusals ----------

export class InvalidKey extends Schema.TaggedError<InvalidKey>()("PidgeonInvalidKey", {}) {
  readonly code = "invalid_credentials" as const;
  readonly status = 422;
  override get message() {
    return "Paste a Pidgeon API key: it starts with pgn_.";
  }
}
/** Read and send needs a key that can send; this one only reads. */
export class CantSend extends Schema.TaggedError<CantSend>()("PidgeonCantSend", {}) {
  readonly code = "pidgeon_key_cant_send" as const;
  readonly status = 422;
  override get message() {
    return "This key can only read. For Read and send, make a Send key in Pidgeon and paste it, or choose Read.";
  }
}
export class InboxNotFound extends Schema.TaggedError<InboxNotFound>()("PidgeonInboxNotFound", {}) {
  readonly code = "pidgeon_inbox_not_found" as const;
  readonly status = 422;
  override get message() {
    return "This key reaches no such inbox. List the inboxes again.";
  }
}
/** An `events` inbox keeps no mail and never sends. */
export class NoInbox extends Schema.TaggedError<NoInbox>()("PidgeonNoInbox", {
  email: Schema.String
}) {
  readonly code = "pidgeon_no_inbox" as const;
  readonly status = 422;
  override get message() {
    return `${this.email} only receives events and keeps no mail, so there's nothing for patches to read. Pick another inbox.`;
  }
}
/** Replace key: the new key doesn't reach the connection's inbox. */
export class OtherAccount extends Schema.TaggedError<OtherAccount>()("PidgeonOtherAccount", {
  email: Schema.String
}) {
  readonly code = "pidgeon_other_account" as const;
  readonly status = 422;
  override get message() {
    return `This key doesn't reach ${this.email}. Paste a key of the Pidgeon account it's in.`;
  }
}
/** The stored key no longer works: revoked in Pidgeon. */
export class StoredKeyRejected extends Schema.TaggedError<StoredKeyRejected>()(
  "PidgeonStoredKeyRejected",
  {}
) {
  readonly code = "pidgeon_key_stopped" as const;
  readonly status = 409;
  override get message() {
    return "Pidgeon refused the stored key, so it was probably revoked in Pidgeon. Patches can't read or send until it's replaced.";
  }
}
/** The inbox was removed in Pidgeon, or the stored key no longer reaches it. */
export class InboxGone extends Schema.TaggedError<InboxGone>()("PidgeonInboxGone", {
  email: Schema.String
}) {
  readonly code = "pidgeon_inbox_gone" as const;
  readonly status = 409;
  override get message() {
    return `${this.email} is gone from Pidgeon, or the stored key no longer reaches it. If it's still there, replace the key with one of its account; otherwise connect another inbox as a new connection.`;
  }
}
/** Patches may send, and the stored key can't: Change access or Test found it read-only. */
export class StoredCantSend extends Schema.TaggedError<StoredCantSend>()(
  "PidgeonStoredCantSend",
  {}
) {
  readonly code = "pidgeon_stored_key_cant_send" as const;
  readonly status = 409;
  override get message() {
    return "The stored key can only read, so patches can't send through it. Replace it with a Send key first.";
  }
}

/** What checking a pasted key and its inbox can refuse. */
export type ConnectError = InvalidKey | CantSend | InboxNotFound | NoInbox | OtherAccount;
/** What the stored key's checks can refuse. */
export type StoredKeyError = StoredKeyRejected | InboxGone | StoredCantSend;
export type KeysError = ConnectError | StoredKeyError | Source.InvalidCredentials;

// ---------- Pidgeon's shapes ----------

const Inbox = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  kind: Schema.String,
  display_name: Schema.optionalKey(Schema.NullOr(Schema.String))
});
type Inbox = typeof Inbox.Type;
const Label = Schema.Struct({
  id: Schema.String,
  inbox_id: Schema.String,
  name: Schema.String,
  colour: Schema.String
});
const InboxPage = Schema.Struct({
  data: Schema.Array(Inbox),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String)
});
const decodeInbox = Schema.decodeUnknownEffect(Inbox);
const decodeInboxPage = Schema.decodeUnknownEffect(InboxPage);
const decodeLabels = Schema.decodeUnknownEffect(Schema.Struct({ data: Schema.Array(Label) }));

/** An answer Patchy can't read is Pidgeon answering unexpectedly. */
const unreadable = (cause: Schema.SchemaError) =>
  new Source.Unavailable({ stage: "response", cause: Redacted.make(cause) });

// ---------- the key ----------

/** One admin request's deadline: every call from checking the key to reading the snapshot. */
export const deadline = Effect.map(
  Clock.currentTimeMillis,
  (now) => now + registry["pidgeon.connect.deadline"].default
);

/** No Pidgeon id is the nil UUID, so the level checks below name nothing that exists. */
const NOTHING = "00000000-0000-0000-0000-000000000000";

/**
 * Whether a key may send, asked without changing anything: sending a draft that doesn't exist
 * answers 403 below `send`, and 404 from `send` up.
 */
const canSend = Effect.fn("PidgeonKeys.canSend")(function* (
  token: Redacted.Redacted<string>,
  until: number
) {
  const source = yield* Source.Source;
  return yield* source
    .call(token, { method: "POST", path: `/email/drafts/${NOTHING}/send` }, until)
    .pipe(
      Effect.flatMap(() => Effect.fail(new Source.Unavailable({ stage: "response" }))),
      Effect.catchTags({
        PidgeonNotFound: () => Effect.succeed(true),
        PidgeonForbidden: () => Effect.succeed(false)
      })
    );
});
/**
 * Whether a key is an admin key, asked without changing anything: making an inbox with an empty
 * name answers 403 below `admin`, and 400 for `admin`, whose access is checked first.
 */
const isAdmin = Effect.fn("PidgeonKeys.isAdmin")(function* (
  token: Redacted.Redacted<string>,
  until: number
) {
  const source = yield* Source.Source;
  return yield* source
    .call(token, { method: "POST", path: "/email/inboxes", body: { name: "", kind: "" } }, until)
    .pipe(
      Effect.flatMap(() => Effect.fail(new Source.Unavailable({ stage: "response" }))),
      Effect.catchTags({
        PidgeonInvalid: () => Effect.succeed(true),
        PidgeonForbidden: () => Effect.succeed(false)
      })
    );
});

/** An inbox as the connect form lists it. */
export interface Listed {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  /** An `events` inbox, which keeps no mail and can't be connected. */
  readonly eventsOnly: boolean;
}
const listed = (inbox: Inbox): Listed => ({
  id: inbox.id,
  email: inbox.address,
  displayName: inbox.display_name ?? null,
  eventsOnly: inbox.kind === "events"
});

const pasted = (key: Redacted.Redacted<string>) =>
  Source.isToken(Redacted.value(key)) ? Effect.succeed(key) : Effect.fail(new InvalidKey({}));

/**
 * What the connect form offers once a key is pasted: its mode, what it may do, and the inboxes it
 * reaches, up to the registry's count.
 */
export const inboxes = Effect.fn("PidgeonKeys.inboxes")(function* (key: Redacted.Redacted<string>) {
  const token = yield* pasted(key);
  const until = yield* deadline;
  const source = yield* Source.Source;
  const max = registry["pidgeon.addresses.listed"].default;
  const found: Inbox[] = [];
  let cursor: string | null = null;
  let more = false;
  do {
    const answer: Source.Answer = yield* source.call(
      token,
      {
        method: "GET",
        path: "/email/inboxes",
        query: { limit: 100, ...(cursor === null ? {} : { cursor }) }
      },
      until
    );
    const page: typeof InboxPage.Type = yield* decodeInboxPage(answer.body).pipe(
      Effect.mapError(unreadable)
    );
    found.push(...page.data);
    // A cursor that repeats would never end the list.
    cursor = page.next_cursor === cursor ? null : page.next_cursor;
    if (found.length > max) {
      more = true;
      break;
    }
  } while (cursor !== null);
  const sends = yield* canSend(token, until);
  const level: Level = !sends ? "read" : (yield* isAdmin(token, until)) ? "admin" : "send";
  return {
    test: Source.isTestToken(Redacted.value(token)),
    level,
    inboxes: found.slice(0, max).map(listed),
    more
  };
});

/** The inbox by id as `token` reaches it; a 404 is `missing`'s refusal. */
const inboxOf = Effect.fn("PidgeonKeys.inboxOf")(function* <E>(
  token: Redacted.Redacted<string>,
  inboxId: string,
  until: number,
  missing: () => E
) {
  const source = yield* Source.Source;
  const answer = yield* source
    .call(token, { method: "GET", path: `/email/inboxes/${encodeURIComponent(inboxId)}` }, until)
    .pipe(Effect.catchTags({ PidgeonNotFound: () => Effect.fail(missing()) }));
  const inbox = yield* decodeInbox(answer.body).pipe(Effect.mapError(unreadable));
  if (inbox.id !== inboxId) return yield* new Source.Unavailable({ stage: "response" });
  return inbox;
});

/** The inbox's labels and what patches may do, as an immutable snapshot. */
const snapshotOf = Effect.fn("PidgeonKeys.snapshotOf")(function* (
  token: Redacted.Redacted<string>,
  inbox: Inbox,
  access: Access,
  until: number
) {
  const source = yield* Source.Source;
  const answer = yield* source.call(
    token,
    { method: "GET", path: `/email/inboxes/${encodeURIComponent(inbox.id)}/labels` },
    until
  );
  const labels = (yield* decodeLabels(answer.body).pipe(Effect.mapError(unreadable))).data;
  // A label of another inbox never reaches a snapshot: the answer is refused whole.
  if (labels.some((label) => label.inbox_id !== inbox.id))
    return yield* new Source.Unavailable({ stage: "response" });
  const snapshot: PidgeonSnapshot = {
    version: 2,
    address: {
      email: inbox.address.slice(0, 320),
      displayName: inbox.display_name?.slice(0, 200) ?? null
    },
    access,
    test: Source.isTestToken(Redacted.value(token)),
    // The snapshot's bounds: the first labels Pidgeon lists, each cut to what a snapshot keeps.
    labels: labels.slice(0, registry["pidgeon.snapshot.labels"].default).map((label) => ({
      id: label.id.slice(0, 128),
      name: label.name.slice(0, 200),
      colour: label.colour.slice(0, 32)
    }))
  };
  return snapshot;
});

/** A checked key, the inbox it serves and the snapshot it read, ready for the store to save. */
export interface Checked {
  readonly credentials: Source.Credentials;
  readonly display: Source.Display;
  readonly snapshot: PidgeonSnapshot;
}
const checked = (
  token: Redacted.Redacted<string>,
  inbox: Inbox,
  snapshot: PidgeonSnapshot
): Checked => ({
  credentials: { inboxId: inbox.id, key: Redacted.value(token) },
  display: {
    email: inbox.address,
    inboxId: inbox.id,
    access: snapshot.access,
    test: snapshot.test
  },
  snapshot
});

// ---------- what an admin submits ----------

/** Connect's secret: the pasted key, the inbox picked and what patches may do. */
export const ConnectRequest = Schema.Struct({
  key: Schema.String,
  inboxId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  access: Access
});
export type ConnectRequest = typeof ConnectRequest.Type;
/** Replace key's secret: a new key for the same inbox, at the connection's access. */
export const ReplaceRequest = Schema.Struct({ key: Schema.String });
/** Change access's: no key, only what patches may do now. */
export const AccessRequest = Schema.Struct({ access: Access });
const ChangeRequest = Schema.Union([ReplaceRequest, AccessRequest]);
export type ChangeRequest = typeof ChangeRequest.Type;

const connectJson = Schema.fromJsonString(ConnectRequest);
const changeJson = Schema.fromJsonString(ChangeRequest);
const encodeConnect = Schema.encodeSync(connectJson);
const encodeChange = Schema.encodeSync(changeJson);
const decodeConnect = Schema.decodeUnknownEffect(connectJson);
const decodeChange = Schema.decodeUnknownEffect(changeJson);
export const connectSecret = (value: ConnectRequest) => Redacted.make(encodeConnect(value));
export const changeSecret = (value: ChangeRequest) => Redacted.make(encodeChange(value));
export const parseConnect = Effect.fn("PidgeonKeys.parseConnect")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* decodeConnect(Redacted.value(secret)).pipe(
    Effect.mapError(() => new InvalidKey({}))
  );
});
export const parseChange = Effect.fn("PidgeonKeys.parseChange")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* decodeChange(Redacted.value(secret)).pipe(
    Effect.mapError(() => new InvalidKey({}))
  );
});

/**
 * Connect's checks, in order: the key reaches the inbox picked, which keeps mail, and can send
 * when patches may; then the snapshot, read with it.
 */
export const connect = Effect.fn("PidgeonKeys.connect")(function* (request: ConnectRequest) {
  const token = yield* pasted(Redacted.make(request.key));
  const until = yield* deadline;
  const inbox = yield* inboxOf(token, request.inboxId, until, () => new InboxNotFound({}));
  if (inbox.kind === "events") return yield* new NoInbox({ email: inbox.address });
  if (request.access === "send" && !(yield* canSend(token, until))) return yield* new CantSend({});
  return checked(token, inbox, yield* snapshotOf(token, inbox, request.access, until));
});

/**
 * Replace key's checks: the new key reaches the connection's inbox and can do what patches may,
 * with a fresh snapshot read with it. Another inbox is another connection.
 */
export const replace = Effect.fn("PidgeonKeys.replace")(function* (
  key: string,
  current: Source.Display
) {
  const token = yield* pasted(Redacted.make(key));
  const until = yield* deadline;
  const inbox = yield* inboxOf(
    token,
    current.inboxId,
    until,
    () => new OtherAccount({ email: current.email })
  );
  if (current.access === "send" && !(yield* canSend(token, until))) return yield* new CantSend({});
  return checked(token, inbox, yield* snapshotOf(token, inbox, current.access, until));
});

// ---------- the stored key ----------

/** The stored key still works, reaches its inbox and, when patches may send, can send. */
const reach = Effect.fn("PidgeonKeys.reach")(function* (
  credentials: Source.Credentials,
  display: Source.Display,
  access: Access,
  until: number
) {
  const token = Redacted.make(credentials.key);
  const inbox = yield* inboxOf(
    token,
    credentials.inboxId,
    until,
    () => new InboxGone({ email: display.email })
  ).pipe(Effect.catchTags({ PidgeonKeyRejected: () => Effect.fail(new StoredKeyRejected({})) }));
  if (access === "send") {
    const sends = yield* canSend(token, until).pipe(
      Effect.catchTags({ PidgeonKeyRejected: () => Effect.fail(new StoredKeyRejected({})) })
    );
    if (!sends) return yield* new StoredCantSend({});
  }
  return { token, inbox };
});

/** Test connection and Resume: the stored key's checks at the connection's own access. */
export const test = Effect.fn("PidgeonKeys.test")(function* (
  credentials: Source.Credentials,
  display: Source.Display
) {
  const until = (yield* Clock.currentTimeMillis) + registry["integration.deadline"].default;
  return (yield* reach(credentials, display, display.access, until)).inbox;
});

/**
 * Refresh labels and Change access: the stored key's checks at `access`, and a fresh snapshot
 * read with it. Raising access to send is refused when the stored key can't send.
 */
export const inspect = Effect.fn("PidgeonKeys.inspect")(function* (
  credentials: Source.Credentials,
  display: Source.Display,
  access: Access
) {
  const until = yield* deadline;
  const { token, inbox } = yield* reach(credentials, display, access, until);
  return checked(token, inbox, yield* snapshotOf(token, inbox, access, until));
});
