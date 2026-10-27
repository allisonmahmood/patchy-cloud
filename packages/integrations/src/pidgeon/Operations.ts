/**
 * The operations patch code calls on one Pidgeon address. Each is a request Patchy builds, with
 * the connection's address filled in, and a result decoded from Pidgeon's answer into the wire's
 * fields and nothing else. Reads travel as `pidgeon.read`; replies, sends and triage as
 * `pidgeon.write`, which needs a connection whose key can send, whatever Pidgeon would allow.
 * Message and attachment text comes cleaned by Pidgeon's firewall, with its verdict beside it.
 *
 * The connection's key reaches its one address and nothing else, which connect checked, so
 * Pidgeon itself answers 404 for anything on another address. Reads check what comes back
 * against the address too, and drop or refuse anything that isn't on it.
 */
import {
  PidgeonDevRead,
  PidgeonRead,
  PidgeonWrite,
  pidgeonReads,
  pidgeonWrites,
  type PidgeonLabel,
  type PidgeonMessage,
  type PidgeonReadOperation,
  type PidgeonThread,
  type PidgeonWriteOperation
} from "@patchy/api";
import { Directory } from "@patchy/companies";
import { sha256 } from "@patchy/core";
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
import { operation, type DevRead } from "../definition.js";
import * as Calls from "./Calls.js";
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
    return "Pidgeon didn't accept this connection's key: it was revoked. Ask a company administrator to replace it at /company/connections.";
  }
}
/** A reply, send or triage through a connection whose key only reads; nothing reached Pidgeon. */
export class ReadOnly extends Schema.TaggedError<ReadOnly>()("PidgeonReadOnly", {}) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return "This Pidgeon connection only reads: it can't reply, send or change threads. An administrator can change its access at /company/connections.";
  }
}
/** Pidgeon's own request rate or plan said no; nothing was done, and Patchy never retries. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("PidgeonOperationRateLimited", {
  limit: Schema.Literals(["requests", "plan"]),
  retryAfterSeconds: Schema.optionalKey(Schema.Int),
  cause: Source.RateLimited
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  get details() {
    return { limit: this.limit };
  }
  override get message() {
    return this.limit === "plan"
      ? "Pidgeon's plan for this account doesn't allow that right now, so nothing was done."
      : `Pidgeon is limiting this account for now, so nothing was done.${this.retryAfterSeconds === undefined ? "" : ` Try again in ${this.retryAfterSeconds} seconds.`}`;
  }
}
/** The connection made its sends and replies for the UTC day; nothing reached Pidgeon. */
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
    return `This connection has made its ${this.budget} sends and replies for today, so nothing was sent. The budget starts again at 00:00 UTC.`;
  }
}

export const Errors = Schema.Union([
  ConnectionNotDeclared,
  ConnectionRefused,
  ReadOnly,
  RateLimited,
  BudgetSpent,
  Source.Forbidden,
  Source.Refused,
  Source.Held,
  Source.NotFound,
  Source.Invalid,
  Source.IdempotencyMismatch,
  Source.IdempotencyInProgress,
  Source.Unavailable,
  Source.Timeout,
  Source.Busy,
  Runtime.InvalidRequest,
  Runtime.AccessDenied,
  Runtime.SourceUnavailable,
  Runtime.TooLarge
]);
const isError = Schema.is(Errors);

const DEADLINE_MS = registry["integration.deadline"].default;
const MAX_LABELS = registry["pidgeon.snapshot.labels"].default;
type Json = typeof Schema.Json.Type;

// ---------- Pidgeon's answers, as far as Patchy reads them ----------

const Party = Schema.Struct({
  email: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String))
});
const Firewall = Schema.optionalKey(
  Schema.NullOr(
    Schema.Struct({
      verdict: Schema.Literals(["clean", "suspicious"]),
      signals: Schema.Array(Schema.Struct({ kind: Schema.String }))
    })
  )
);
const ThreadRow = Schema.Struct({
  id: Schema.String,
  /** The address the thread is on, as text. */
  identity: Schema.String,
  subject: Schema.NullOr(Schema.String),
  status: Schema.Literals(["open", "waiting", "resolved", "human_review"]),
  message_count: Schema.Int,
  from: Schema.NullOr(Schema.String),
  from_name: Schema.NullOr(Schema.String),
  preview: Schema.NullOr(Schema.String),
  has_attachments: Schema.Boolean,
  last_message_at: Schema.NullOr(Schema.String),
  created_at: Schema.String
});
const MessageRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  identity_id: Schema.NullOr(Schema.String),
  from: Party,
  to: Schema.Array(Party),
  cc: Schema.Array(Party),
  subject: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  test: Schema.Boolean,
  is_held: Schema.optionalKey(Schema.Boolean),
  firewall: Firewall,
  attachments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      filename: Schema.String,
      content_type: Schema.String,
      size: Schema.Int
    })
  ),
  delivery: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ state: Schema.String, delivered_at: Schema.NullOr(Schema.String) })
    )
  ),
  created_at: Schema.String
});
const HitRow = Schema.Struct({
  id: Schema.String,
  identity_id: Schema.NullOr(Schema.String),
  thread_id: Schema.String,
  from: Schema.String,
  from_name: Schema.NullOr(Schema.String),
  to: Schema.Array(Schema.String),
  subject: Schema.NullOr(Schema.String),
  preview: Schema.NullOr(Schema.String),
  has_attachments: Schema.Boolean,
  is_held: Schema.optionalKey(Schema.Boolean),
  timestamp: Schema.String
});
const LabelRow = Schema.Struct({ id: Schema.String, name: Schema.String, colour: Schema.String });
const TextRow = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  content_type: Schema.String,
  size: Schema.Int,
  text: Schema.String,
  truncated: Schema.Boolean,
  firewall: Firewall
});
const SentRow = Schema.Struct({
  status: Schema.Literals(["sent", "pending_approval"]),
  id: Schema.String,
  draft_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  thread_id: Schema.String,
  rejected: Schema.Array(Schema.Struct({ address: Schema.String, reason: Schema.String })),
  test: Schema.Boolean,
  approval: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        reason: Schema.Literals(["first_contact", "risky_thread"]),
        expires_at: Schema.String
      })
    )
  )
});
const page = <Row extends Schema.Top>(row: Row) =>
  Schema.Struct({ data: Schema.Array(row), next_cursor: Schema.NullOr(Schema.String) });
const one = <Row extends Schema.Top>(row: Row) => Schema.Struct({ data: row });
const LabelPage = page(LabelRow);

/** Pidgeon's answer read through `schema`, its other fields dropped; unreadable is unavailable. */
const reader = <A>(schema: Schema.Decoder<A>) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (answer: Source.Answer) =>
    decode(answer.body).pipe(Effect.mapError(() => new Source.Unavailable({ stage: "response" })));
};
const read = {
  thread: reader(one(ThreadRow)),
  threads: reader(page(ThreadRow)),
  message: reader(one(MessageRow)),
  messages: reader(page(MessageRow)),
  hits: reader(page(HitRow)),
  labels: reader(LabelPage),
  text: reader(one(TextRow)),
  sent: reader(one(SentRow))
};

// ---------- what a patch sees ----------

const firewall = (value: (typeof TextRow.Type)["firewall"]) =>
  value === undefined || value === null
    ? null
    : {
        verdict: value.verdict,
        // The kinds it found, once each; never a signal's detail, which quotes the hidden text.
        kinds: [...new Set(value.signals.map((signal) => signal.kind))]
      };
const thread = (row: typeof ThreadRow.Type): typeof PidgeonThread.Type => ({
  id: row.id,
  subject: row.subject,
  status: row.status,
  from: row.from === null ? null : { email: row.from, name: row.from_name },
  preview: row.preview,
  messageCount: row.message_count,
  hasAttachments: row.has_attachments,
  lastMessageAt: row.last_message_at,
  createdAt: row.created_at
});
const party = (value: typeof Party.Type) => ({ email: value.email, name: value.name ?? null });
const message = (row: typeof MessageRow.Type): typeof PidgeonMessage.Type => ({
  id: row.id,
  threadId: row.thread_id,
  from: party(row.from),
  to: row.to.map(party),
  cc: row.cc.map(party),
  subject: row.subject,
  createdAt: row.created_at,
  test: row.test,
  held: row.is_held === true,
  text: row.text ?? "",
  firewall: firewall(row.firewall),
  attachments: row.attachments.map((file) => ({
    id: file.id,
    filename: file.filename,
    contentType: file.content_type,
    size: file.size
  })),
  delivery:
    row.delivery === undefined || row.delivery === null
      ? null
      : { state: row.delivery.state, deliveredAt: row.delivery.delivered_at }
});
const label = (row: typeof LabelRow.Type): typeof PidgeonLabel.Type => ({
  id: row.id,
  name: row.name,
  colour: row.colour
});

// ---------- the operations ----------

/** What one operation knows beyond its input: the address as the call found it. */
interface Context {
  readonly address: Calls.Address;
}
/** A write knows the patch too, whose draft keys are its own. */
interface Drafting extends Context {
  readonly patchId: string;
}
const email = ({ address }: Context) => address.connection.display.email;
const identityId = ({ address }: Context) => address.credentials.identityId;
/** Whether a row Pidgeon answered is on the connection's address. */
const onThread = (context: Context, row: typeof ThreadRow.Type) =>
  row.identity.toLowerCase() === email(context).toLowerCase() ||
  row.identity === identityId(context);
const onAddress = (context: Context, row: { readonly identity_id: string | null }) =>
  row.identity_id === null || row.identity_id === identityId(context);
const segment = (value: string) => encodeURIComponent(value);

/** What an operation can fail with before its refusal is put as the wire says. */
type Failure =
  Source.CallError | BudgetSpent | ConnectionStore.ConnectionStorageFailed | Schema.SchemaError;
type Step<In, C extends Context = Context> = (
  context: C,
  input: In
) => Effect.Effect<Json, Failure, ConnectionStore.ConnectionStore>;
/** One operation and its result, encoded through its own wire schema: nothing else leaves. */
const step = <In, A, I extends Json, C extends Context = Context>(
  output: Schema.Codec<A, I>,
  run: (context: C, input: In) => Effect.Effect<A, Failure, ConnectionStore.ConnectionStore>
): Step<In, C> => {
  const encode = Schema.encodeEffect(output);
  return (context, input) => run(context, input).pipe(Effect.flatMap(encode));
};

/** Every label at `path`, page by page, up to what a snapshot keeps. */
const labelsAt = Effect.fn("PidgeonOperations.labelsAt")(function* (
  context: Context,
  path: string,
  query: Source.Request["query"] = {}
) {
  const found: Array<typeof PidgeonLabel.Type> = [];
  let cursor: string | null = null;
  do {
    const listed: typeof LabelPage.Type = yield* context.address
      .call({ method: "GET", path, query: { ...query, ...(cursor === null ? {} : { cursor }) } })
      .pipe(Effect.flatMap(read.labels));
    found.push(...listed.data.map(label));
    // A cursor that repeats would never end the list.
    cursor = listed.next_cursor === cursor ? null : listed.next_cursor;
  } while (cursor !== null && found.length < MAX_LABELS);
  return found.slice(0, MAX_LABELS);
});

type Reads = typeof pidgeonReads;
type ReadInputs = { readonly [K in PidgeonReadOperation]: Reads[K]["input"]["Type"] };
const reads: { readonly [K in PidgeonReadOperation]: Step<ReadInputs[K]> } = {
  "threads.list": step(
    pidgeonReads["threads.list"].output,
    (context, input: ReadInputs["threads.list"]) =>
      context.address
        .call({
          method: "GET",
          path: "/threads",
          query: {
            identity_id: identityId(context),
            status: input.status,
            limit: input.limit,
            cursor: input.cursor
          }
        })
        .pipe(
          Effect.flatMap(read.threads),
          Effect.map((listed) => ({
            threads: listed.data.filter((row) => onThread(context, row)).map(thread),
            nextCursor: listed.next_cursor
          }))
        )
  ),
  "threads.get": step(
    pidgeonReads["threads.get"].output,
    Effect.fnUntraced(function* (context: Context, input: ReadInputs["threads.get"]) {
      const path = `/threads/${segment(input.id)}`;
      const found = (yield* context.address
        .call({ method: "GET", path })
        .pipe(Effect.flatMap(read.thread))).data;
      if (!onThread(context, found)) return yield* new Source.NotFound({});
      const limit = yield* ContractLimits.get("pidgeon.thread.messages");
      const [messages, labels] = yield* Effect.all(
        [
          context.address
            .call({
              method: "GET",
              path: "/messages",
              query: { thread_id: input.id, body: "clean", limit, cursor: input.cursor }
            })
            .pipe(Effect.flatMap(read.messages)),
          labelsAt(context, `${path}/labels`)
        ],
        { concurrency: 2 }
      );
      return {
        thread: thread(found),
        labels,
        // Only this thread's messages on the address; anything else Pidgeon answered is dropped.
        messages: messages.data
          .filter((row) => row.thread_id === found.id && onAddress(context, row))
          .map(message),
        nextCursor: messages.next_cursor
      };
    })
  ),
  "messages.get": step(
    pidgeonReads["messages.get"].output,
    Effect.fnUntraced(function* (context: Context, input: ReadInputs["messages.get"]) {
      const found = (yield* context.address
        .call({ method: "GET", path: `/messages/${segment(input.id)}`, query: { body: "clean" } })
        .pipe(Effect.flatMap(read.message))).data;
      if (!onAddress(context, found)) return yield* new Source.NotFound({});
      return message(found);
    })
  ),
  "messages.search": step(
    pidgeonReads["messages.search"].output,
    (context, input: ReadInputs["messages.search"]) =>
      context.address
        .call({
          method: "GET",
          path: "/messages/search",
          query: {
            identity_id: identityId(context),
            q: input.text,
            from: input.from,
            to: input.to,
            label_id: input.labelId,
            has_attachment: input.hasAttachment,
            in: input.folder,
            limit: input.limit,
            cursor: input.cursor
          }
        })
        .pipe(
          Effect.flatMap(read.hits),
          Effect.map((listed) => ({
            hits: listed.data
              .filter((row) => onAddress(context, row))
              .map((row) => ({
                messageId: row.id,
                threadId: row.thread_id,
                from: { email: row.from, name: row.from_name },
                to: row.to,
                subject: row.subject,
                preview: row.preview,
                hasAttachments: row.has_attachments,
                held: row.is_held === true,
                createdAt: row.timestamp
              })),
            nextCursor: listed.next_cursor
          }))
        )
  ),
  "labels.list": step(pidgeonReads["labels.list"].output, (context) =>
    labelsAt(context, "/labels", { identity_id: identityId(context) }).pipe(
      Effect.map((labels) => ({ labels }))
    )
  ),
  // An attachment's answer doesn't say its address: the key, which reaches no other, is the guard.
  "attachments.text": step(
    pidgeonReads["attachments.text"].output,
    (context, input: ReadInputs["attachments.text"]) =>
      context.address
        .call({
          method: "GET",
          path: `/attachments/${segment(input.id)}/text`,
          query: { body: "clean" }
        })
        .pipe(
          Effect.flatMap(read.text),
          Effect.map(({ data }) => ({
            id: data.id,
            filename: data.filename,
            contentType: data.content_type,
            size: data.size,
            text: data.text,
            truncated: data.truncated,
            firewall: firewall(data.firewall)
          }))
        )
  )
};

/**
 * Pidgeon's Idempotency-Key for a draft: the connection, the patch and the draft key, hashed, so
 * two patches' drafts never collide and the draft key itself never leaves Patchy. Pidgeon also
 * counts the calling key, so after Replace key the same draft is a mismatch, never a second email.
 */
export const idempotencyKey = (connectionId: string, patchId: string, draft: string) =>
  sha256(JSON.stringify(["pidgeon.send", connectionId, patchId, draft]));

const DAY_MS = 86_400_000;

/**
 * Counts this send against the connection's budget before Pidgeon sees it, then sends it under
 * the draft's Idempotency-Key. Every attempt counts, a replay and one Pidgeon refuses included,
 * and one Pidgeon holds for a person's approval too.
 */
const sendDraft = Effect.fn("PidgeonOperations.sendDraft")(function* (
  context: Drafting,
  draft: string,
  request: Pick<Source.Request, "method" | "path" | "body">
) {
  const { connection } = context.address;
  const connections = yield* ConnectionStore.ConnectionStore;
  const now = yield* Clock.currentTimeMillis;
  const budget = yield* ContractLimits.get("pidgeon.sends.daily");
  const day = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(now));
  if (!(yield* connections.countSend(connection.companyId, connection.id, day, budget)))
    return yield* new BudgetSpent({
      budget,
      retryAfterSeconds: Math.ceil((DAY_MS - (now % DAY_MS)) / 1_000)
    });
  const answer = yield* context.address.call({
    ...request,
    idempotencyKey: idempotencyKey(connection.id, context.patchId, draft),
    // The first send is still running: say so, and let the patch send the same draft again.
    inProgress: "fail"
  });
  const { data } = yield* read.sent(answer);
  if (data.status === "sent")
    return {
      status: "sent" as const,
      messageId: data.id,
      threadId: data.thread_id,
      rejected: data.rejected,
      replayed: answer.replayed,
      test: data.test
    };
  if (typeof data.draft_id !== "string" || data.approval === undefined || data.approval === null)
    return yield* new Source.Unavailable({ stage: "response" });
  return {
    status: "pending_approval" as const,
    draftId: data.draft_id,
    threadId: data.thread_id,
    approval: { reason: data.approval.reason, expiresAt: data.approval.expires_at },
    replayed: answer.replayed,
    test: data.test
  };
});

type Writes = typeof pidgeonWrites;
type WriteInputs = { readonly [K in PidgeonWriteOperation]: Writes[K]["input"]["Type"] };
const writes: { readonly [K in PidgeonWriteOperation]: Step<WriteInputs[K], Drafting> } = {
  "messages.reply": step(
    pidgeonWrites["messages.reply"].output,
    (context: Drafting, input: WriteInputs["messages.reply"]) =>
      sendDraft(context, input.idempotencyKey, {
        method: "POST",
        path: `/messages/${segment(input.id)}/reply`,
        body: { text: input.text, ...(input.cc === undefined ? {} : { cc: input.cc }) }
      })
  ),
  "messages.send": step(
    pidgeonWrites["messages.send"].output,
    (context: Drafting, input: WriteInputs["messages.send"]) =>
      sendDraft(context, input.idempotencyKey, {
        method: "POST",
        path: "/messages",
        body: {
          from: email(context),
          to: input.to,
          ...(input.cc === undefined ? {} : { cc: input.cc }),
          subject: input.subject,
          text: input.text
        }
      })
  ),
  "threads.update": step(
    pidgeonWrites["threads.update"].output,
    (context, input: WriteInputs["threads.update"]) =>
      context.address
        .call({
          method: "PATCH",
          path: `/threads/${segment(input.id)}`,
          body: { status: input.status }
        })
        .pipe(
          Effect.flatMap(read.thread),
          Effect.map(({ data }) => thread(data))
        )
  ),
  "threads.label": step(
    pidgeonWrites["threads.label"].output,
    (context, input: WriteInputs["threads.label"]) =>
      context.address
        .call({
          method: "POST",
          path: `/threads/${segment(input.id)}/labels`,
          body: { label_id: input.labelId }
        })
        .pipe(
          Effect.flatMap(read.labels),
          Effect.map((applied) => ({ labels: applied.data.map(label) }))
        )
  ),
  // Removing answers only `{ removed }`, so the thread's labels are read after it.
  "threads.unlabel": step(
    pidgeonWrites["threads.unlabel"].output,
    Effect.fnUntraced(function* (context: Context, input: WriteInputs["threads.unlabel"]) {
      const path = `/threads/${segment(input.id)}/labels`;
      yield* context.address.call({ method: "DELETE", path, query: { label_id: input.labelId } });
      return { labels: yield* labelsAt(context, path) };
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

/** The door refused its caller once the call held a slot; `atAddress` hands on what it said. */
class CallerRefused extends Schema.TaggedError<CallerRefused>()("PidgeonCallerRefused", {}) {}

/**
 * A call on the address its door admitted, once it holds one of the address's slots, with the
 * caller, the connection and its key as they stand then; a write through a connection whose key
 * only reads sends nothing. Pidgeon's refusals come back as the wire says them, and the door's
 * refusal of its caller and the connection's absence as they are, for the door to say. Anything
 * else, such as a stored key that can't be read or an address that moved, is Patchy's side being
 * unavailable.
 */
const atAddress = Effect.fnUntraced(function* <E>(
  target: Calls.Target<E>,
  kind: "read" | "write",
  run: (address: Calls.Address) => Effect.Effect<Json, Failure, ConnectionStore.ConnectionStore>
) {
  // The caller's refusal after the wait is its door's to say, so it waits here, apart from
  // everything the call itself can fail with.
  const caller = yield* Ref.make(Option.none<E>());
  return yield* Calls.withAddress(
    {
      ...target,
      recheck: target.recheck.pipe(
        Effect.tapError((error) => Ref.set(caller, Option.some(error))),
        Effect.mapError(() => new CallerRefused({}))
      )
    },
    Effect.fnUntraced(function* (address: Calls.Address) {
      if (kind === "write" && address.connection.display.access !== "send")
        return yield* new ReadOnly({});
      return yield* run(address);
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
      // A conflict with what's there, such as a label the thread can't take, is the request's.
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
            : isError(error) ||
                error instanceof ConnectionStore.ConnectionNotFound ||
                error instanceof ConnectionStore.ConnectionNotConnected
              ? error
              : new Runtime.SourceUnavailable({ cause: error })
        )
      )
    )
  );
});

/**
 * One operation as a loaded version's door admitted it: the declared connection and its viewer,
 * then the call on the address. A viewer or connection that stopped working is refused.
 */
const perform = Effect.fn("PidgeonOperations.perform")(function* (
  connection: string,
  kind: "read" | "write",
  run: (context: Drafting) => Effect.Effect<Json, Failure, ConnectionStore.ConnectionStore>
) {
  const binding = yield* Binding.Binding;
  const declaration = binding.manifest.uses[connection];
  if (!Object.hasOwn(binding.manifest.uses, connection) || declaration?.kind !== "pidgeon")
    return yield* new ConnectionNotDeclared({});
  const { identity, principal, companyId } = binding;
  if (
    binding.scope !== "company" ||
    identity === null ||
    principal === null ||
    identity.company.id !== companyId ||
    identity.user.id !== principal.userId
  )
    return yield* new Runtime.AccessDenied({});
  // The caller's own deadline bounds the wait for a slot, so a refused wait is never a timeout.
  const deadline = binding.deadline ?? (yield* Clock.currentTimeMillis) + DEADLINE_MS;
  const directory = yield* Directory.Directory;
  // A viewer deactivated while the call waited sends nothing.
  const recheck = directory.get(companyId, identity.user.id).pipe(
    Effect.catchTags({
      SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
    }),
    Effect.flatMap((member) =>
      member?.active === true ? Effect.void : Effect.fail(new Runtime.AccessDenied({}))
    )
  );
  return yield* atAddress(
    { companyId, connection: declaration, deadline, recheck },
    kind,
    (address) => run({ address, patchId: binding.patchId })
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
      case "messages.search":
        return Predicate.isString(input.labelId) ? `${name} label ${text(input.labelId)}` : name;
      case "threads.get":
      case "messages.get":
      case "attachments.text":
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
 * repo. It reads as a published read does, with the address's checks and slots, and held mail
 * stays empty. Writes never come here: dev simulates them without reaching the instance.
 */
export const devReads: { readonly "pidgeon.read": DevRead<Source.Source> } = {
  "pidgeon.read": {
    ...recorded,
    run: (target, args) =>
      decodeDevRead(args).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
        Effect.flatMap((read) =>
          atAddress(target, "read", (address) => readOne({ address }, read.operation, read.input))
        )
      )
  }
};

/**
 * Published patches, the dev door and connection administration share one Source, so an
 * address's slots span them all.
 */
export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const connections = yield* ConnectionStore.ConnectionStore;
  const directory = yield* Directory.Directory;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Source.Source, source),
      Effect.provideService(ConnectionStore.ConnectionStore, connections),
      Effect.provideService(Directory.Directory, directory)
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
