/**
 * The operations patch code calls on one Pidgeon inbox. Each is a request Patchy builds, with the
 * connection's inbox filled in, and a result decoded from Pidgeon's answer into the wire's fields
 * and nothing else. Reads travel as `pidgeon.read`; replies, sends and triage as `pidgeon.write`,
 * which needs a connection that may send, whatever the key could. Message text comes cleaned by
 * Pidgeon's firewall, with its verdict beside it.
 *
 * The boundary. The stored key reaches every inbox of the Pidgeon account, so nothing is returned
 * or changed unless Patchy has established that it is the connection's inbox's, and anything it
 * can't establish answers `not_found`, as an id that doesn't exist does. Lists and search name the
 * inbox and refuse an answer carrying a row of another; a thread or message read by id is shown
 * only when it says it's the inbox's; a held message read by id says nothing about its inbox, so
 * it answers `not_found`; triage reads the thread first, and checks a label against the inbox's own
 * list; replies and sends are drafts in the inbox, sent only by Patchy and only once.
 *
 * Sending once. Pidgeon doesn't dedupe sends, so Patchy's ledger (`Ledger.ts`) remembers which
 * draft is which draft key's email and how far it got, and Patchy sends a draft at most once. When
 * Pidgeon hasn't said whether an email left, the answer says so, rather than send it again.
 */
import {
  PidgeonDevRead,
  PidgeonRead,
  PidgeonWrite,
  pidgeonFolders,
  pidgeonReads,
  pidgeonThreadStatuses,
  pidgeonWrites,
  type PidgeonLabel,
  type PidgeonMessage,
  type PidgeonReadOperation,
  type PidgeonSent,
  type PidgeonThread,
  type PidgeonWriteOperation
} from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../ConnectionStore.js";
import {
  operation,
  connectionRecheck,
  ownerCheck,
  ViewerRefusal,
  type DevRead
} from "../definition.js";
import * as Calls from "./Calls.js";
import type * as Ledger from "./Ledger.js";
import * as Source from "./Source.js";

export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "PidgeonConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  override get message() {
    return "This Pidgeon connection is not declared by this version.";
  }
}
/** The connection's key stopped working after connect; only an admin can replace it. */
export class ConnectionRefused extends Schema.TaggedError<ConnectionRefused>()(
  "PidgeonConnectionRefused",
  { cause: Source.KeyRejected }
) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "Pidgeon didn't accept this connection's key: it was revoked. Ask a company administrator to replace it at /settings/integrations.";
  }
}
/** A reply, send or triage through a connection that only reads; nothing reached Pidgeon. */
export class ReadOnly extends Schema.TaggedError<ReadOnly>()("PidgeonReadOnly", {}) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return "This Pidgeon connection only reads: it can't reply, send or change threads. An administrator can change its access at /settings/integrations.";
  }
}
/**
 * Pidgeon's own limits said no: the key's request rate or the account's sending limit, or its
 * plan. Nothing was done, and Patchy never retries. `details.message` is Pidgeon's explanation.
 */
export class RateLimited extends Schema.TaggedError<RateLimited>()("PidgeonOperationRateLimited", {
  limit: Source.RateLimited.fields.limit,
  retryAfterSeconds: Schema.optionalKey(Schema.Int),
  cause: Source.RateLimited
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  get details() {
    return { limit: this.limit, message: this.cause.details.message };
  }
  override get message() {
    const again =
      this.retryAfterSeconds === undefined ? "" : ` in ${this.retryAfterSeconds} seconds`;
    switch (this.limit) {
      case "plan":
        return "Pidgeon's plan for this account doesn't allow that right now, so nothing was done.";
      case "requests":
        return `Pidgeon is limiting this account for now, so nothing was done.${again === "" ? "" : ` Try again${again}.`}`;
    }
  }
}
/** The connection wrote its emails for the UTC day; nothing reached Pidgeon. */
export class BudgetSpent extends Schema.TaggedError<BudgetSpent>()("PidgeonBudgetSpent", {
  budget: Schema.Int,
  /** Until the UTC day ends, when the budget starts again. */
  retryAfterSeconds: Schema.Int
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  readonly limitId = "pidgeon.sends.daily" as const;
  readonly scope = registry["pidgeon.sends.daily"].scope;
  readonly details = { limit: "budget" } as const;
  get value() {
    return this.budget;
  }
  override get message() {
    return `This connection has written its ${this.budget} emails for today, so nothing was sent. The budget starts again at 00:00 UTC.`;
  }
}
/** The draft key already went with a different email; this attempt did nothing. */
export class DraftMismatch extends Schema.TaggedError<DraftMismatch>()("PidgeonDraftMismatch", {}) {
  readonly code = "idempotency_conflict" as const;
  readonly status = 409;
  readonly details = { reason: "mismatch" } as const;
  override get message() {
    return "This draft key already went with a different email, so this attempt did nothing. Send the draft as it was, or start a new email with a new key.";
  }
}
/**
 * Another call is still working on this draft key's email; this attempt did nothing. The same
 * draft sent again after `retryAfterSeconds` answers what became of it.
 */
export class DraftInProgress extends Schema.TaggedError<DraftInProgress>()(
  "PidgeonDraftInProgress",
  { retryAfterSeconds: Schema.Int }
) {
  readonly code = "idempotency_conflict" as const;
  readonly status = 409;
  readonly details = { reason: "in_progress" } as const;
  override get message() {
    return `Another call is still sending this draft, so this attempt did nothing. Send the same draft again in ${this.retryAfterSeconds} ${this.retryAfterSeconds === 1 ? "second" : "seconds"} for its answer.`;
  }
}
/**
 * Pidgeon hasn't said whether this email left: Patchy issued its one send and never heard back,
 * or found it neither sent nor held. Patchy never sends it again. The same draft key asks again;
 * a new one writes a new email, which may mean two.
 */
export class Unconfirmed extends Schema.TaggedError<Unconfirmed>()("PidgeonUnconfirmed", {}) {
  readonly code = "idempotency_conflict" as const;
  readonly status = 409;
  readonly details = { reason: "unconfirmed" } as const;
  override get message() {
    return "Pidgeon hasn't said whether this email left, and Patchy never sends it twice. Send the same draft again later to ask again; a new draft key writes a new email, which may mean two.";
  }
}

export const Errors = Schema.Union([
  ConnectionNotDeclared,
  ConnectionRefused,
  ReadOnly,
  RateLimited,
  BudgetSpent,
  DraftMismatch,
  DraftInProgress,
  Unconfirmed,
  Source.Forbidden,
  Source.ExfiltrationBlocked,
  Source.NotFound,
  Source.Invalid,
  Source.MailRefused,
  Source.Unavailable,
  Source.Timeout,
  Source.Busy,
  Runtime.InvalidRequest,
  ...ViewerRefusal.members,
  Runtime.TooLarge
]);
const isError = Schema.is(Errors);
/** The connection is gone or disconnected: each door says which, its own way. */
const isAbsent = Schema.is(
  Schema.Union([ConnectionStore.ConnectionNotFound, ConnectionStore.ConnectionNotConnected])
);

const DEADLINE_MS = registry["integration.deadline"].default;
const MAX_LABELS = registry["pidgeon.snapshot.labels"].default;
/** How long a send's claim outlives its call's deadline, after which no call of it can send. */
const CLAIM_MARGIN_MS = 30_000;
type Json = typeof Schema.Json.Type;

// ---------- Pidgeon's answers, as far as Patchy reads them ----------

const LabelRef = Schema.Struct({ id: Schema.String, name: Schema.String, colour: Schema.String });
const LabelRow = Schema.Struct({ ...LabelRef.fields, inbox_id: Schema.String });
const ThreadRow = Schema.Struct({
  id: Schema.String,
  inbox_id: Schema.String,
  subject: Schema.NullOr(Schema.String),
  folder: Schema.Literals(pidgeonFolders),
  status: Schema.Literals(pidgeonThreadStatuses),
  labels: Schema.Array(LabelRef),
  message_count: Schema.Int,
  unread_count: Schema.Int,
  last_message_at: Schema.NullOr(Schema.String),
  created_at: Schema.String
});
const MessageRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  inbox_id: Schema.String,
  direction: Schema.Literals(["in", "out"]),
  status: Schema.String,
  from: Schema.Struct({
    address: Schema.String,
    name: Schema.optionalKey(Schema.NullOr(Schema.String))
  }),
  to: Schema.Array(Schema.String),
  cc: Schema.optionalKey(Schema.Array(Schema.String)),
  subject: Schema.NullOr(Schema.String),
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  test: Schema.Boolean,
  is_held: Schema.Boolean,
  created_at: Schema.String,
  attachments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        filename: Schema.String,
        content_type: Schema.String,
        size: Schema.Int
      })
    )
  ),
  firewall: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        verdict: Schema.optionalKey(Schema.Literals(["clean", "suspicious"])),
        signals: Schema.Array(Schema.Struct({ kind: Schema.String }))
      })
    )
  )
});
type MessageRow = typeof MessageRow.Type;
const page = <Row extends Schema.Top>(row: Row) =>
  Schema.Struct({
    data: Schema.Array(row),
    has_more: Schema.Boolean,
    next_cursor: Schema.NullOr(Schema.String)
  });
const ThreadWithMessages = Schema.Struct({ ...ThreadRow.fields, messages: page(MessageRow) });
const DraftRow = Schema.Struct({
  id: Schema.String,
  inbox_id: Schema.String,
  thread_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.String
});
const SentRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  status: Schema.String
});

/** Pidgeon's answer read through `schema`, its other fields dropped; unreadable is unavailable. */
const reader = <A>(schema: Schema.Decoder<A>) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (answer: Source.Answer) =>
    decode(answer.body).pipe(Effect.mapError(() => new Source.Unavailable({ stage: "response" })));
};
const read = {
  thread: reader(ThreadRow),
  threads: reader(page(ThreadRow)),
  conversation: reader(ThreadWithMessages),
  message: reader(MessageRow),
  messages: reader(page(MessageRow)),
  labels: reader(Schema.Struct({ data: Schema.Array(LabelRow) })),
  draft: reader(DraftRow),
  sent: reader(SentRow)
};

// ---------- what a patch sees ----------

const label = (row: typeof LabelRef.Type): typeof PidgeonLabel.Type => ({
  id: row.id,
  name: row.name,
  colour: row.colour
});
const thread = (row: typeof ThreadRow.Type): typeof PidgeonThread.Type => ({
  id: row.id,
  subject: row.subject,
  status: row.status,
  folder: row.folder,
  labels: row.labels.map(label),
  messageCount: row.message_count,
  unreadCount: row.unread_count,
  lastMessageAt: row.last_message_at,
  createdAt: row.created_at
});
const firewall = (value: MessageRow["firewall"]) =>
  value === undefined || value === null
    ? null
    : {
        verdict: value.verdict ?? (value.signals.length === 0 ? "clean" : "suspicious"),
        // The kinds it found, once each; never a signal's detail, which quotes the hidden text.
        kinds: [...new Set(value.signals.map((signal) => signal.kind))]
      };
const party = (email: string, name: string | null = null) => ({ email, name });
/** A message as a patch sees it; a held one keeps only who sent it, when, and the verdict. */
const message = (row: MessageRow): typeof PidgeonMessage.Type => ({
  id: row.id,
  threadId: row.thread_id,
  from: party(row.from.address, row.from.name ?? null),
  to: row.to.map((email) => party(email)),
  cc: (row.cc ?? []).map((email) => party(email)),
  subject: row.is_held ? null : row.subject,
  createdAt: row.created_at,
  test: row.test,
  held: row.is_held,
  text: row.is_held ? "" : (row.text ?? ""),
  firewall: firewall(row.firewall),
  attachments: row.is_held
    ? []
    : (row.attachments ?? []).map((file) => ({
        id: file.id,
        filename: file.filename,
        contentType: file.content_type,
        size: file.size
      }))
});

// ---------- the boundary ----------

/** What one operation knows beyond its input: the connection's inbox as the call found it. */
interface Context {
  readonly inbox: Calls.Inbox;
}
/** A write knows the patch too, whose draft keys are its own, and its call's deadline. */
interface Drafting extends Context {
  readonly patchId: string;
  readonly deadline: number;
}
const inboxId = ({ inbox }: Context) => inbox.credentials.inboxId;
const segment = (value: string) => encodeURIComponent(value);

/**
 * Refuses a whole answer that carries anything of another inbox: Pidgeon answered more than it
 * was asked, so none of it is shown.
 */
const ours = (context: Context, rows: ReadonlyArray<{ readonly inbox_id: string }>) =>
  rows.every((row) => row.inbox_id === inboxId(context))
    ? Effect.void
    : Effect.fail(new Source.Unavailable({ stage: "response" }));

/** The inbox's own labels, up to what a snapshot keeps; one of another inbox fails the call. */
const labelsOf = Effect.fn("PidgeonOperations.labelsOf")(function* (context: Context) {
  const listed = yield* context.inbox
    .call({ method: "GET", path: `/email/inboxes/${segment(inboxId(context))}/labels` })
    .pipe(Effect.flatMap(read.labels));
  yield* ours(context, listed.data);
  return listed.data.slice(0, MAX_LABELS).map(label);
});
/** A label id the inbox has; any other answers `not_found`, as an unknown one does. */
const ownLabel = Effect.fn("PidgeonOperations.ownLabel")(function* (
  context: Context,
  labelId: string
) {
  if (!(yield* labelsOf(context)).some((item) => item.id === labelId))
    return yield* new Source.NotFound({});
});
/** The conversation, when it says it's the inbox's; any other answers `not_found`. */
const ownThread = Effect.fn("PidgeonOperations.ownThread")(function* (
  context: Context,
  id: string,
  query: Source.Request["query"] = { limit: 1 }
) {
  const found = yield* context.inbox
    .call({ method: "GET", path: `/email/threads/${segment(id)}`, query })
    .pipe(Effect.flatMap(read.conversation));
  if (found.inbox_id !== inboxId(context) || found.id !== id) return yield* new Source.NotFound({});
  return found;
});
/**
 * A message read by id, when it says it's the inbox's. A held one's 403 says nothing about where
 * it is, so it answers `not_found` like any message Patchy can't show is the inbox's.
 */
const ownMessage = Effect.fn("PidgeonOperations.ownMessage")(function* (
  context: Context,
  id: string
) {
  const found = yield* context.inbox
    .call({ method: "GET", path: `/email/messages/${segment(id)}`, query: { body: "clean" } })
    .pipe(
      Effect.catchTags({ PidgeonHeld: () => Effect.fail(new Source.NotFound({})) }),
      Effect.flatMap(read.message)
    );
  if (found.inbox_id !== inboxId(context) || found.id !== id) return yield* new Source.NotFound({});
  return found;
});

/** What an operation can fail with before its refusal is put as the wire says. */
type Failure =
  | Source.CallError
  | BudgetSpent
  | DraftMismatch
  | DraftInProgress
  | Unconfirmed
  | ConnectionStore.ConnectionStorageFailed
  | ConnectionStore.ConnectionMutationUnavailable
  | ConnectionStore.ConnectionNotFound
  | Schema.SchemaError;
type Needs = ConnectionStore.ConnectionStore | Cryptography.Cryptography;
type Step<In, C extends Context = Context> = (
  context: C,
  input: In
) => Effect.Effect<Json, Failure, Needs>;
/** One operation and its result, encoded through its own wire schema: nothing else leaves. */
const step = <In, A, I extends Json, C extends Context = Context>(
  output: Schema.Codec<A, I>,
  run: (context: C, input: In) => Effect.Effect<A, Failure, Needs>
): Step<In, C> => {
  const encode = Schema.encodeEffect(output);
  return (context, input) => run(context, input).pipe(Effect.flatMap(encode));
};

type Reads = typeof pidgeonReads;
type ReadInputs = { readonly [K in PidgeonReadOperation]: Reads[K]["input"]["Type"] };
const reads: { readonly [K in PidgeonReadOperation]: Step<ReadInputs[K]> } = {
  "threads.list": step(
    pidgeonReads["threads.list"].output,
    Effect.fnUntraced(function* (context: Context, input: ReadInputs["threads.list"]) {
      if (input.labelId !== undefined) yield* ownLabel(context, input.labelId);
      const listed = yield* context.inbox
        .call({
          method: "GET",
          path: "/email/threads",
          query: {
            inbox_id: inboxId(context),
            status: input.status,
            folder: input.folder,
            label_id: input.labelId,
            limit: input.limit,
            cursor: input.cursor
          }
        })
        .pipe(Effect.flatMap(read.threads));
      yield* ours(context, listed.data);
      return { threads: listed.data.map(thread), nextCursor: listed.next_cursor };
    })
  ),
  "threads.get": step(
    pidgeonReads["threads.get"].output,
    Effect.fnUntraced(function* (context: Context, input: ReadInputs["threads.get"]) {
      const limit = yield* ContractLimits.get("pidgeon.thread.messages");
      const found = yield* ownThread(context, input.id, {
        body: "clean",
        limit,
        cursor: input.cursor
      });
      // Every message must be this conversation's, on the inbox: anything else fails it whole.
      yield* ours(context, found.messages.data);
      if (found.messages.data.some((row) => row.thread_id !== found.id))
        return yield* new Source.Unavailable({ stage: "response" });
      const shown = thread(found);
      return {
        thread: shown,
        labels: shown.labels,
        messages: found.messages.data.map(message),
        nextCursor: found.messages.next_cursor
      };
    })
  ),
  "messages.get": step(
    pidgeonReads["messages.get"].output,
    Effect.fnUntraced(function* (context: Context, input: ReadInputs["messages.get"]) {
      return message(yield* ownMessage(context, input.id));
    })
  ),
  "messages.search": step(
    pidgeonReads["messages.search"].output,
    Effect.fnUntraced(function* (context: Context, input: ReadInputs["messages.search"]) {
      const listed = yield* context.inbox
        .call({
          method: "GET",
          path: "/email/search",
          query: {
            q: input.text,
            inbox_id: inboxId(context),
            body: "clean",
            limit: input.limit,
            cursor: input.cursor
          }
        })
        .pipe(Effect.flatMap(read.messages));
      yield* ours(context, listed.data);
      return {
        hits: listed.data.map((row) => ({
          messageId: row.id,
          threadId: row.thread_id,
          from: party(row.from.address, row.from.name ?? null),
          to: row.to,
          subject: row.is_held ? null : row.subject,
          preview:
            row.is_held || row.text === undefined || row.text === null
              ? null
              : row.text.slice(0, 200),
          hasAttachments: !row.is_held && (row.attachments ?? []).length > 0,
          held: row.is_held,
          createdAt: row.created_at
        })),
        nextCursor: listed.next_cursor
      };
    })
  ),
  "labels.list": step(pidgeonReads["labels.list"].output, (context) =>
    labelsOf(context).pipe(Effect.map((labels) => ({ labels })))
  )
};

// ---------- sending once ----------

/**
 * The ledger's name for a draft: the connection, the patch and the draft key, hashed, so two
 * patches' drafts never collide and the draft key itself never leaves Patchy. Not the key's
 * revision, so Replace key between attempts changes nothing.
 */
export const draftKey = (connectionId: string, patchId: string, draft: string) =>
  Cryptography.Cryptography.use((cryptography) =>
    cryptography.sha256(JSON.stringify(["pidgeon.send", connectionId, patchId, draft]))
  );

const DAY_MS = 86_400_000;
/** Pidgeon's refusals of a send that say nothing left, so the draft key is free again. */
const nothingLeft = (error: Source.CallError) =>
  error._tag === "PidgeonInvalid" ||
  error._tag === "PidgeonRateLimited" ||
  error._tag === "PidgeonForbidden" ||
  error._tag === "PidgeonExfiltrationBlocked" ||
  error._tag === "PidgeonMailRefused";

/** One email as a patch asked for it: the operation and its validated input, never its key. */
type Email =
  | { readonly operation: "messages.reply"; readonly input: WriteInputs["messages.reply"] }
  | { readonly operation: "messages.send"; readonly input: WriteInputs["messages.send"] };

/** The email's digest: what was asked, never anything read back from Pidgeon. */
const digestOf = (email: Email) =>
  Cryptography.Cryptography.use((cryptography) =>
    cryptography.sha256(
      JSON.stringify(
        email.operation === "messages.reply"
          ? [email.operation, email.input.id, email.input.text, email.input.cc ?? []]
          : [
              email.operation,
              email.input.to,
              email.input.cc ?? [],
              email.input.subject,
              email.input.text
            ]
      )
    )
  );

/** `Re: <subject>`, once. */
const reply = (subject: string | null) =>
  subject === null || subject.trim() === ""
    ? undefined
    : /^re:/i.test(subject.trim())
      ? subject
      : `Re: ${subject}`;

/**
 * The draft Pidgeon is to write for this email, in the connection's inbox. A reply reads its
 * target first: the new API needs `to`, so it comes from the target, a received message's sender
 * or the recipients of one the inbox sent, with its subject and `reply_to` naming it. A held
 * target or another inbox's answers `not_found`, as Pidgeon itself does for a foreign one.
 */
const draftBody = Effect.fn("PidgeonOperations.draftBody")(function* (
  context: Context,
  email: Email
) {
  if (email.operation === "messages.send")
    return {
      to: email.input.to,
      ...(email.input.cc === undefined ? {} : { cc: email.input.cc }),
      subject: email.input.subject,
      text: email.input.text
    };
  const target = yield* ownMessage(context, email.input.id);
  const subject = reply(target.subject);
  return {
    to: target.direction === "in" ? [target.from.address] : target.to,
    ...(email.input.cc === undefined ? {} : { cc: email.input.cc }),
    ...(subject === undefined ? {} : { subject }),
    text: email.input.text,
    reply_to: target.id
  };
});

/**
 * One attempt at one email, by the state its draft key's row is in. A worker claims the row
 * before it talks to Pidgeon and changes it only while the claim is its own; it issues a draft's
 * one send only after recording `sending`, and never sends a draft found `sending` or `held`. It
 * looks instead: a held email Pidgeon still keeps, or the sent message, both in the inbox.
 * Anything else is `Unconfirmed`, and the row is left as it is.
 */
const sendOnce = Effect.fn("PidgeonOperations.sendOnce")(function* (
  context: Drafting,
  email: Email
) {
  const { connection } = context.inbox;
  const store = yield* ConnectionStore.ConnectionStore;
  const cryptography = yield* Cryptography.Cryptography;
  const now = yield* Clock.currentTimeMillis;
  const key: Ledger.Key = {
    companyId: connection.companyId,
    connectionId: connection.id,
    draft: yield* draftKey(connection.id, context.patchId, email.input.idempotencyKey),
    now
  };
  const owner = yield* cryptography.randomUUID;
  const budget = yield* ContractLimits.get("pidgeon.sends.daily");
  const digest = yield* digestOf(email);
  const claim = yield* store
    .claimDraft({
      ...key,
      digest,
      owner,
      until: context.deadline + CLAIM_MARGIN_MS,
      day: DateTime.formatIsoDateUtc(DateTime.makeUnsafe(now)),
      budget
    })
    .pipe(
      // A claim whose answer was lost is read back: the row with this attempt's token and email
      // is this attempt's to carry on with. Anything else is the storage's failure.
      Effect.catchTags({
        ConnectionStorageFailed: (failed) =>
          store.readDraft(key).pipe(
            Effect.catch(() => Effect.fail(failed)),
            Effect.flatMap((found) =>
              found !== undefined && found.owner === owner && found.digest === digest
                ? Effect.succeed<Ledger.Claim>({ _tag: "Claimed", row: found, discard: null })
                : Effect.fail(failed)
            )
          )
      })
    );
  switch (claim._tag) {
    case "Gone":
      return yield* new ConnectionStore.ConnectionNotFound({
        companyId: connection.companyId,
        lookup: { id: connection.id }
      });
    case "Spent":
      return yield* new BudgetSpent({
        budget,
        retryAfterSeconds: Math.ceil((DAY_MS - (now % DAY_MS)) / 1_000)
      });
    case "Busy":
      return yield* new DraftInProgress({ retryAfterSeconds: claim.retryAfterSeconds });
    case "Mismatch":
      return yield* new DraftMismatch({});
    case "Sent":
      return {
        status: "sent",
        messageId: claim.messageId,
        threadId: claim.threadId,
        replayed: true
      } satisfies typeof PidgeonSent.Type;
    case "Claimed":
      break;
  }

  /**
   * Records `change` while the claim is this worker's: whether it still was. A change whose answer
   * was lost is read back: done if the row shows it with this worker's claim (or, released, with
   * its state), lost if another worker holds it, and otherwise the storage's failure.
   */
  const commit = Effect.fnUntraced(function* (
    change: Omit<Ledger.Change, keyof Ledger.Key | "owner">
  ): Effect.fn.Return<
    boolean,
    ConnectionStore.ConnectionStorageFailed | ConnectionStore.ConnectionMutationUnavailable
  > {
    const at = yield* Clock.currentTimeMillis;
    const done = yield* store
      .recordDraft({ ...key, now: at, owner, ...change })
      .pipe(Effect.result);
    if (done._tag === "Success") return done.success;
    const failed = done.failure;
    if (failed._tag !== "ConnectionStorageFailed") return yield* failed;
    const found = yield* store.readDraft(key).pipe(Effect.catch(() => Effect.fail(failed)));
    if (
      found !== undefined &&
      found.state === change.state &&
      (found.owner === owner || (change.release === true && found.owner === null))
    )
      return true;
    if (found !== undefined && found.owner !== null && found.owner !== owner) return false;
    return yield* failed;
  });
  /** A claim this worker lost: it stops, sending nothing more. */
  const lost = new DraftInProgress({ retryAfterSeconds: 1 });
  /** Throws away a draft Patchy won't send; one already gone is fine, and so is a failure. */
  const discard = (id: string) =>
    context.inbox
      .call({ method: "DELETE", path: `/email/drafts/${segment(id)}` })
      .pipe(Effect.ignore);
  const sent = (
    status: "sent" | "held",
    answer: { readonly id: string; readonly thread_id: string },
    replayed: boolean
  ): typeof PidgeonSent.Type => ({
    status,
    messageId: answer.id,
    threadId: answer.thread_id,
    replayed
  });

  /** `sending` or `held`: never send; look at what Pidgeon kept of the draft. */
  const look = Effect.fnUntraced(function* (draftId: string) {
    const draft = yield* context.inbox
      .call({ method: "GET", path: `/email/drafts/${segment(draftId)}` })
      .pipe(Effect.flatMap(read.draft), Effect.option);
    if (Option.isSome(draft)) {
      const threadId = draft.value.thread_id ?? null;
      if (
        draft.value.id !== draftId ||
        draft.value.inbox_id !== inboxId(context) ||
        draft.value.status !== "held" ||
        threadId === null
      )
        return yield* new Unconfirmed({});
      yield* commit({ state: "held", messageId: draftId, threadId, release: true });
      return sent("held", { id: draftId, thread_id: threadId }, true);
    }
    const message = yield* context.inbox
      .call({ method: "GET", path: `/email/messages/${segment(draftId)}` })
      .pipe(Effect.flatMap(read.message), Effect.option);
    if (
      Option.isNone(message) ||
      message.value.id !== draftId ||
      message.value.inbox_id !== inboxId(context) ||
      message.value.direction !== "out" ||
      message.value.status !== "sent"
    )
      return yield* new Unconfirmed({});
    yield* commit({
      state: "sent",
      messageId: draftId,
      threadId: message.value.thread_id,
      release: true
    });
    return sent("sent", { id: draftId, thread_id: message.value.thread_id }, true);
  });

  /** `drafted`: record `sending`, then issue the draft's one send. */
  const issue = Effect.fnUntraced(function* (draftId: string) {
    if (!(yield* commit({ state: "sending" }))) return yield* lost;
    const answer = yield* context.inbox
      .call({ method: "POST", path: `/email/drafts/${segment(draftId)}/send` })
      .pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // Pidgeon said no in its own words, and nothing left: the key is free again.
            if (nothingLeft(error)) {
              yield* commit({ state: "refused", release: true });
              yield* discard(draftId);
              return yield* error;
            }
            // A 401 is refused before anything runs, so nothing left and the key is free; this
            // draft is never sent again. The next attempt, once the key is replaced, takes the row
            // over and writes a new draft, and the takeover deletes this one, which the row keeps.
            if (error._tag === "PidgeonKeyRejected") {
              yield* commit({ state: "refused", release: true });
              return yield* error;
            }
            return yield* new Unconfirmed({});
          })
        )
      );
    const row = yield* read.sent(answer).pipe(Effect.option);
    if (
      Option.isNone(row) ||
      row.value.id !== draftId ||
      (answer.status !== 201 && answer.status !== 202)
    )
      return yield* new Unconfirmed({});
    const status =
      answer.status === 201 && row.value.status === "sent"
        ? "sent"
        : answer.status === 202 && row.value.status === "held"
          ? "held"
          : undefined;
    if (status === undefined) return yield* new Unconfirmed({});
    // Pidgeon has answered: what it said is the answer, recorded or not.
    yield* commit({
      state: status,
      messageId: draftId,
      threadId: row.value.thread_id,
      release: true
    }).pipe(Effect.ignore);
    return sent(status, row.value, false);
  });

  /** `writing`: write the draft in the inbox and record it, then issue its send. */
  const write = Effect.fnUntraced(function* () {
    // Refused in Pidgeon's own words, or a reply target Patchy can't show is the inbox's:
    // nothing was written, and the key is free again. A 401 waits for a key that works.
    const refused = (error: Source.CallError) =>
      Source.isDecided(error) && error._tag !== "PidgeonKeyRejected"
        ? commit({ state: "refused", release: true }).pipe(Effect.ignore)
        : Effect.void;
    const body = yield* draftBody(context, email).pipe(Effect.tapError(refused));
    const answer = yield* context.inbox
      .call({
        method: "POST",
        path: `/email/inboxes/${segment(inboxId(context))}/drafts`,
        body
      })
      .pipe(Effect.tapError(refused));
    const draft = yield* read.draft(answer);
    // A draft Patchy hasn't shown is the inbox's is never touched, not even to delete it.
    if (draft.inbox_id !== inboxId(context))
      return yield* new Source.Unavailable({ stage: "response" });
    if (!(yield* commit({ state: "drafted", draftId: draft.id }))) {
      yield* discard(draft.id);
      return yield* lost;
    }
    return yield* issue(draft.id);
  });

  const row = claim.row;
  if (claim.discard !== null) yield* discard(claim.discard);
  return yield* Effect.gen(function* () {
    switch (row.state) {
      case "writing":
      case "refused":
        return yield* write();
      case "drafted":
        return row.draftId === null ? yield* write() : yield* issue(row.draftId);
      case "sending":
      case "held":
        return row.draftId === null ? yield* new Unconfirmed({}) : yield* look(row.draftId);
      case "sent":
        return row.messageId === null || row.threadId === null
          ? yield* new Unconfirmed({})
          : sent("sent", { id: row.messageId, thread_id: row.threadId }, true);
    }
  }).pipe(
    // However the attempt ends, a claim it still holds ends with it; the row stays as it is.
    Effect.ensuring(store.releaseDraft({ ...key, owner }).pipe(Effect.ignore))
  );
});

type Writes = typeof pidgeonWrites;
type WriteInputs = { readonly [K in PidgeonWriteOperation]: Writes[K]["input"]["Type"] };
const writes: { readonly [K in PidgeonWriteOperation]: Step<WriteInputs[K], Drafting> } = {
  "messages.reply": step(
    pidgeonWrites["messages.reply"].output,
    (context: Drafting, input: WriteInputs["messages.reply"]) =>
      sendOnce(context, { operation: "messages.reply", input })
  ),
  "messages.send": step(
    pidgeonWrites["messages.send"].output,
    (context: Drafting, input: WriteInputs["messages.send"]) =>
      sendOnce(context, { operation: "messages.send", input })
  ),
  "threads.update": step(
    pidgeonWrites["threads.update"].output,
    Effect.fnUntraced(function* (context: Drafting, input: WriteInputs["threads.update"]) {
      yield* ownThread(context, input.id);
      const changed = yield* context.inbox
        .call({
          method: "PATCH",
          path: `/email/threads/${segment(input.id)}`,
          body: { status: input.status }
        })
        .pipe(Effect.flatMap(read.thread));
      yield* ours(context, [changed]);
      return thread(changed);
    })
  ),
  "threads.label": step(
    pidgeonWrites["threads.label"].output,
    Effect.fnUntraced(function* (context: Drafting, input: WriteInputs["threads.label"]) {
      yield* ownThread(context, input.id);
      yield* ownLabel(context, input.labelId);
      const changed = yield* context.inbox
        .call({
          method: "POST",
          path: `/email/threads/${segment(input.id)}/labels`,
          body: { label_id: input.labelId }
        })
        .pipe(Effect.flatMap(read.thread));
      yield* ours(context, [changed]);
      return { labels: changed.labels.map(label) };
    })
  ),
  "threads.unlabel": step(
    pidgeonWrites["threads.unlabel"].output,
    Effect.fnUntraced(function* (context: Drafting, input: WriteInputs["threads.unlabel"]) {
      yield* ownThread(context, input.id);
      yield* ownLabel(context, input.labelId);
      const changed = yield* context.inbox
        .call({
          method: "DELETE",
          path: `/email/threads/${segment(input.id)}/labels/${segment(input.labelId)}`
        })
        .pipe(Effect.flatMap(read.thread));
      yield* ours(context, [changed]);
      return { labels: changed.labels.map(label) };
    })
  )
};

const readOne = <K extends PidgeonReadOperation>(context: Context, name: K, input: ReadInputs[K]) =>
  reads[name](context, input);
const writeOne = <K extends PidgeonWriteOperation>(
  context: Drafting,
  name: K,
  input: WriteInputs[K]
) => writes[name](context, input);

/** The door refused its caller once the call held a slot; `atInbox` hands on what it said. */
class CallerRefused extends Schema.TaggedError<CallerRefused>()("PidgeonCallerRefused", {}) {
  override get message() {
    return "The caller was refused once the call held a slot; nothing was sent.";
  }
}

/**
 * A call on the inbox its door admitted, once it holds one of the inbox's slots, with the caller,
 * the connection and its key as they stand then; a write through a connection that only reads
 * sends nothing. Pidgeon's refusals come back as the wire says them, and the door's refusal of
 * its caller and the connection's absence as they are, for the door to say. Anything else, such
 * as a stored key that can't be read, is Patchy's side being unavailable.
 */
const atInbox = Effect.fnUntraced(function* <E>(
  target: Calls.Target<E>,
  kind: "read" | "write",
  run: (inbox: Calls.Inbox) => Effect.Effect<Json, Failure, Needs>
) {
  // The caller's refusal after the wait is its door's to say, so it waits here, apart from
  // everything the call itself can fail with.
  const caller = yield* Ref.make(Option.none<E>());
  return yield* Calls.withInbox(
    {
      ...target,
      recheck: target.recheck.pipe(
        Effect.tapError((error) => Ref.set(caller, Option.some(error))),
        Effect.mapError(() => new CallerRefused({}))
      )
    },
    Effect.fnUntraced(function* (inbox: Calls.Inbox) {
      if (kind === "write" && inbox.connection.display.access !== "send")
        return yield* new ReadOnly({});
      return yield* run(inbox);
    })
  ).pipe(
    Effect.catchTags({
      PidgeonKeyRejected: (cause) => Effect.fail(new ConnectionRefused({ cause })),
      PidgeonRateLimited: (cause) =>
        Effect.fail(
          new RateLimited({
            limit: cause.limit,
            ...(cause.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: cause.retryAfterSeconds }),
            cause
          })
        ),
      // Held mail is never shown by id: it can't be shown to be the inbox's.
      PidgeonHeld: () => Effect.fail(new Source.NotFound({})),
      // A conflict with what's there, such as a draft no longer a draft, is the request's.
      PidgeonConflict: (cause) => Effect.fail(new Source.Invalid({ details: cause.details })),
      PidgeonTooLarge: (cause) =>
        Effect.fail(
          new Runtime.TooLarge({ maxBytes: cause.maxBytes, limitId: "runtime.result.bytes" })
        )
    }),
    Effect.catch((error) =>
      Effect.flatMap(Ref.get(caller), (refused) =>
        Effect.fail(
          Option.isSome(refused)
            ? refused.value
            : isError(error) || isAbsent(error)
              ? error
              : new Runtime.SourceUnavailable({ cause: error })
        )
      )
    )
  );
});

/**
 * One operation as a loaded version's door admitted it: the declared connection and its viewer,
 * then the call on the inbox. A viewer or connection that stopped working is refused.
 */
const perform = Effect.fn("PidgeonOperations.perform")(function* (
  connection: string,
  kind: "read" | "write",
  run: (context: Drafting) => Effect.Effect<Json, Failure, Needs>
) {
  const binding = yield* Binding.Binding;
  const declaration = binding.manifest.uses[connection];
  if (!Object.hasOwn(binding.manifest.uses, connection) || declaration?.kind !== "pidgeon")
    return yield* new ConnectionNotDeclared({});
  const { identity, principal, companyId } = binding;
  if (
    binding.scope === "public" ||
    identity === null ||
    principal === null ||
    identity.company.id !== companyId ||
    identity.user.id !== principal.userId
  )
    return yield* new Runtime.AccessDenied({});
  // The caller's own deadline bounds the wait for a slot, so a refused wait is never a timeout.
  const deadline = binding.deadline ?? (yield* Clock.currentTimeMillis) + DEADLINE_MS;
  // The patch's owner must be able to build with the connection now, and again once the call
  // holds its slot.
  yield* ownerCheck(binding, declaration.id);
  const recheck = connectionRecheck(binding, declaration.id).pipe(
    Effect.provideService(ConnectionStore.ConnectionStore, yield* ConnectionStore.ConnectionStore)
  );
  return yield* atInbox({ companyId, connection: declaration, deadline, recheck }, kind, (inbox) =>
    run({ inbox, patchId: binding.patchId, deadline })
  ).pipe(
    Effect.catchTags({
      ConnectionNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
      ConnectionNotConnected: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
    })
  );
});

const readOperation = operation({
  input: PidgeonRead,
  output: Schema.Json,
  errors: Errors,
  run: (args: PidgeonRead) =>
    perform(args.connection, "read", (context) => readOne(context, args.operation, args.input))
});
const writeOperation = operation({
  input: PidgeonWrite,
  output: Schema.Json,
  errors: Errors,
  run: (args: PidgeonWrite) =>
    perform(args.connection, "write", (context) => writeOne(context, args.operation, args.input))
});

export const operations = { read: readOperation, write: writeOperation };

const connectionId = (args: unknown, binding: Binding.Binding["Service"]): string | null => {
  if (
    !Predicate.isObject(args) ||
    typeof args.connection !== "string" ||
    !Object.hasOwn(binding.manifest.uses, args.connection)
  )
    return null;
  const declaration = binding.manifest.uses[args.connection];
  return declaration?.kind === "pidgeon" ? declaration.id : null;
};

const MAX_RECORD = 500;
const text = (value: unknown, max = 128): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const addresses = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter(Predicate.isString).map((item) => item.slice(0, 320)) : [];
/** `head to a, b cc c`, cut to 500 characters with "+N more" for the recipients left out. */
const withRecipients = (
  head: string,
  to: ReadonlyArray<string>,
  cc: ReadonlyArray<string>
): string => {
  const parts = [
    ...to.map((address, index) => `${index === 0 ? " to " : ", "}${address}`),
    ...cc.map((address, index) => `${index === 0 ? " cc " : ", "}${address}`)
  ];
  let record = head.slice(0, MAX_RECORD);
  for (const [index, part] of parts.entries()) {
    const left = parts.length - index - 1;
    if ((record + part + (left === 0 ? "" : ` +${left} more`)).length > MAX_RECORD)
      return `${record} +${parts.length - index} more`;
    record += part;
  }
  return record;
};

/**
 * How a call reads in recent calls: its operation and the ids it named; a send's subject and
 * recipients, a reply's message and CC, a triage's status or label. Never a body or search text.
 * It runs on arguments not yet checked, so it reads them defensively.
 */
export const recorded = {
  resource: (args: unknown): string | null => {
    if (!Predicate.isObject(args) || !Predicate.isString(args.operation)) return null;
    const input = Predicate.isObject(args.input) ? args.input : {};
    const name = args.operation.slice(0, 40);
    const id = text(input.id);
    switch (name) {
      case "messages.send": {
        const subject = text(input.subject, 500);
        return withRecipients(
          `${name} “${subject.length > 150 ? `${subject.slice(0, 149)}…` : subject}”`,
          addresses(input.to),
          addresses(input.cc)
        );
      }
      case "messages.reply":
        return withRecipients(`${name} ${id}`, [], addresses(input.cc));
      case "threads.update":
        return `${name} ${id} ${text(input.status, 32)}`;
      case "threads.label":
      case "threads.unlabel":
        return `${name} ${id} ${text(input.labelId)}`;
      case "threads.list":
        return Predicate.isString(input.labelId) ? `${name} label ${text(input.labelId)}` : name;
      case "threads.get":
      case "messages.get":
        return `${name} ${id}`;
      default:
        return name;
    }
  },
  rowCount: (value: unknown): number | null => {
    if (!Predicate.isObject(value)) return null;
    for (const key of ["threads", "messages", "hits", "labels"] as const) {
      const items = value[key];
      if (Array.isArray(items)) return items.length;
    }
    return null;
  }
};

const decodeDevRead = Schema.decodeUnknownEffect(PidgeonDevRead, { onExcessProperty: "error" });

/**
 * The read the definition's `live` names, for `patchy dev` through the instance's dev door
 * (ADR-0013): the caller is the door's, never a loaded version's, and the alias stays in the
 * repo. It reads as a published read does, with the inbox's checks and slots, and held mail stays
 * empty. Writes never come here: dev simulates them without reaching the instance.
 */
export const devReads: {
  readonly "pidgeon.read": DevRead<Source.Source | Cryptography.Cryptography>;
} = {
  "pidgeon.read": {
    ...recorded,
    run: (target, args) =>
      decodeDevRead(args).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
        Effect.flatMap((devRead) =>
          atInbox(target, "read", (inbox) => readOne({ inbox }, devRead.operation, devRead.input))
        )
      )
  }
};

/**
 * Published patches, the dev door and connection administration share one Source, so an inbox's
 * slots span them all.
 */
export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const connections = yield* ConnectionStore.ConnectionStore;
  const cryptography = yield* Cryptography.Cryptography;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Source.Source, source),
      Effect.provideService(ConnectionStore.ConnectionStore, connections),
      Effect.provideService(Cryptography.Cryptography, cryptography)
    );
  return {
    "pidgeon.read": Runtime.handler(
      { kind: "integration", ...readOperation, ...recorded, connectionId },
      (args) => provide(readOperation.run(args))
    ),
    "pidgeon.write": Runtime.handler(
      { kind: "integration", ...writeOperation, ...recorded, connectionId },
      (args) => provide(writeOperation.run(args))
    )
  };
});
