/**
 * Pidgeon: one company inbox, read and answered through operations Patchy writes. Patch code names
 * an operation and its input, never a path, an inbox id or a key: Patchy fills in the connection's
 * inbox on every call, and anything it can't show is on that inbox answers `not_found`. Reads
 * travel as `pidgeon.read`; replies, sends and triage as `pidgeon.write`, which a `read` connection
 * refuses before Pidgeon sees anything.
 */
import * as Schema from "effect/Schema";
import { PidgeonLabel } from "./pidgeonSnapshot.js";
import { DefinitionName } from "./schemas.js";

/** An id Pidgeon gave a thread, message or label. */
export const PidgeonId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/));
/** Pidgeon's opaque `next_cursor`, passed back as it came. */
const Cursor = Schema.String.check(Schema.isBetweenLength(1, 1024));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
/** An address as a person types it; Pidgeon decides whether it can be delivered to. */
export const PidgeonEmail = Schema.String.check(
  Schema.isMaxLength(320),
  Schema.isPattern(/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/)
);
const Recipients = Schema.Array(PidgeonEmail).check(Schema.isMaxLength(50));
/** A plain-text body, up to 100,000 characters however they encode. */
const Body = Schema.String.check(Schema.isBetweenLength(1, 100_000));
/** Pidgeon's search words: plain words, `"phrases"`, `or` and `-word`. */
const Search = Schema.String.check(Schema.isBetweenLength(1, 200));
export const pidgeonThreadStatuses = ["open", "waiting", "resolved", "human_review"] as const;
/** Pidgeon's triage state for a conversation, shared by everyone who reads the inbox. */
export const PidgeonThreadStatus = Schema.Literals(pidgeonThreadStatuses);
export const pidgeonFolders = ["inbox", "archive", "spam", "trash"] as const;
/** The one folder a conversation is in. */
export const PidgeonFolder = Schema.Literals(pidgeonFolders);
/**
 * Names one email a person is writing. Patchy sends each draft key's email at most once, and
 * answers the same draft sent again with what became of it.
 */
export const PidgeonDraftKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,128}$/));

// ---------- what a patch gets back: every field that leaves the host ----------

export const PidgeonParty = Schema.Struct({
  email: Schema.String,
  name: Schema.NullOr(Schema.String)
});
/** A conversation as a list shows it. */
export const PidgeonThread = Schema.Struct({
  id: Schema.String,
  /** Null while every message in it is held for a person. */
  subject: Schema.NullOr(Schema.String),
  status: PidgeonThreadStatus,
  folder: PidgeonFolder,
  labels: Schema.Array(PidgeonLabel),
  messageCount: Schema.Int,
  unreadCount: Schema.Int,
  lastMessageAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String
});
/**
 * Pidgeon Firewall's reading of mail that arrived: `suspicious` when it tries to steer an AI,
 * imitates a sender or asks for secrets out, with the kinds of what it found. Never what it quoted.
 */
export const PidgeonFirewall = Schema.Struct({
  verdict: Schema.Literals(["clean", "suspicious"]),
  kinds: Schema.Array(Schema.String)
});
/** A file a message carried: its metadata only. */
export const PidgeonAttachment = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  contentType: Schema.String,
  /** Bytes. */
  size: Schema.Int
});
/**
 * One message: plain text cleaned by the firewall, never headers, HTML or its source. A message
 * the firewall `held` for a person has no subject, text or attachments until someone releases it
 * in Pidgeon.
 */
export const PidgeonMessage = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  from: PidgeonParty,
  to: Schema.Array(PidgeonParty),
  cc: Schema.Array(PidgeonParty),
  subject: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** Pidgeon's test mode: it never left Pidgeon. */
  test: Schema.Boolean,
  held: Schema.Boolean,
  text: Schema.String,
  /** Null on mail this inbox sent. */
  firewall: Schema.NullOr(PidgeonFirewall),
  attachments: Schema.Array(PidgeonAttachment)
});
export const PidgeonSearchHit = Schema.Struct({
  messageId: Schema.String,
  threadId: Schema.String,
  from: PidgeonParty,
  to: Schema.Array(Schema.String),
  subject: Schema.NullOr(Schema.String),
  /** The first 200 characters of the firewall's clean text. */
  preview: Schema.NullOr(Schema.String),
  hasAttachments: Schema.Boolean,
  held: Schema.Boolean,
  createdAt: Schema.String
});
/**
 * What became of one email. `sent`: Pidgeon handed it to the mail service. `held`: when Patchy
 * last looked, Pidgeon was keeping it for a member of the account to approve; sending the same
 * draft again looks again. `replayed` marks an answer to a draft key that was sent before: nothing
 * went out again.
 */
export const PidgeonSent = Schema.Struct({
  status: Schema.Literals(["sent", "held"]),
  messageId: Schema.String,
  threadId: Schema.String,
  replayed: Schema.Boolean
});
const Labels = Schema.Struct({ labels: Schema.Array(PidgeonLabel) });

/** Each read's input and result, by the name patch code calls it. */
export const pidgeonReads = {
  "threads.list": {
    input: Schema.Struct({
      status: Schema.optionalKey(PidgeonThreadStatus),
      folder: Schema.optionalKey(PidgeonFolder),
      labelId: Schema.optionalKey(PidgeonId),
      limit: Schema.optionalKey(Limit),
      cursor: Schema.optionalKey(Cursor)
    }),
    output: Schema.Struct({
      threads: Schema.Array(PidgeonThread),
      nextCursor: Schema.NullOr(Schema.String)
    })
  },
  "threads.get": {
    input: Schema.Struct({ id: PidgeonId, cursor: Schema.optionalKey(Cursor) }),
    output: Schema.Struct({
      thread: PidgeonThread,
      labels: Schema.Array(PidgeonLabel),
      /** Oldest first; pass `nextCursor` back as `cursor` for the next page. */
      messages: Schema.Array(PidgeonMessage),
      nextCursor: Schema.NullOr(Schema.String)
    })
  },
  "messages.get": { input: Schema.Struct({ id: PidgeonId }), output: PidgeonMessage },
  "messages.search": {
    input: Schema.Struct({
      text: Search,
      limit: Schema.optionalKey(Limit),
      cursor: Schema.optionalKey(Cursor)
    }),
    output: Schema.Struct({
      hits: Schema.Array(PidgeonSearchHit),
      nextCursor: Schema.NullOr(Schema.String)
    })
  },
  // No arguments: an empty Struct would let any key through, so this one refuses every key.
  "labels.list": { input: Schema.Record(Schema.String, Schema.Never), output: Labels }
} as const;
/** Each reply, send and triage's input and result. */
export const pidgeonWrites = {
  "messages.reply": {
    input: Schema.Struct({
      id: PidgeonId,
      text: Body,
      cc: Schema.optionalKey(Recipients),
      idempotencyKey: PidgeonDraftKey
    }),
    output: PidgeonSent
  },
  "messages.send": {
    input: Schema.Struct({
      to: Recipients.check(Schema.isMinLength(1)),
      cc: Schema.optionalKey(Recipients),
      subject: Schema.String.check(Schema.isBetweenLength(1, 500)),
      text: Body,
      idempotencyKey: PidgeonDraftKey
    }),
    output: PidgeonSent
  },
  "threads.update": {
    input: Schema.Struct({ id: PidgeonId, status: PidgeonThreadStatus }),
    output: PidgeonThread
  },
  /** The thread's labels after the change. */
  "threads.label": { input: Schema.Struct({ id: PidgeonId, labelId: PidgeonId }), output: Labels },
  "threads.unlabel": { input: Schema.Struct({ id: PidgeonId, labelId: PidgeonId }), output: Labels }
} as const;
export type PidgeonReadOperation = keyof typeof pidgeonReads;
export type PidgeonWriteOperation = keyof typeof pidgeonWrites;

const call = <const Operation extends string, Input extends Schema.Top>(
  operation: Operation,
  input: Input
) => Schema.Struct({ connection: DefinitionName, operation: Schema.Literal(operation), input });

/** One read on a declared connection: its alias, the operation and that operation's input. */
export const PidgeonRead = Schema.Union([
  call("threads.list", pidgeonReads["threads.list"].input),
  call("threads.get", pidgeonReads["threads.get"].input),
  call("messages.get", pidgeonReads["messages.get"].input),
  call("messages.search", pidgeonReads["messages.search"].input),
  call("labels.list", pidgeonReads["labels.list"].input)
]);
export type PidgeonRead = typeof PidgeonRead.Type;

const devCall = <const Operation extends PidgeonReadOperation, Input extends Schema.Top>(
  operation: Operation,
  input: Input
) => Schema.Struct({ operation: Schema.Literal(operation), input });
/**
 * A `patchy dev` read's arguments, which the instance's dev door reads live: the operation and its
 * input. The repo's alias routed it locally and stays there. Writes never go to the door.
 */
export const PidgeonDevRead = Schema.Union([
  devCall("threads.list", pidgeonReads["threads.list"].input),
  devCall("threads.get", pidgeonReads["threads.get"].input),
  devCall("messages.get", pidgeonReads["messages.get"].input),
  devCall("messages.search", pidgeonReads["messages.search"].input),
  devCall("labels.list", pidgeonReads["labels.list"].input)
]);
export type PidgeonDevRead = typeof PidgeonDevRead.Type;
/** One reply, send or triage on a declared connection that may send. */
export const PidgeonWrite = Schema.Union([
  call("messages.reply", pidgeonWrites["messages.reply"].input),
  call("messages.send", pidgeonWrites["messages.send"].input),
  call("threads.update", pidgeonWrites["threads.update"].input),
  call("threads.label", pidgeonWrites["threads.label"].input),
  call("threads.unlabel", pidgeonWrites["threads.unlabel"].input)
]);
export type PidgeonWrite = typeof PidgeonWrite.Type;

/**
 * The runtime operations. A response lists every result its operations can give; the host encodes
 * each operation's result with that operation's own schema, so a field outside it never leaves.
 */
export const pidgeonOperations = {
  "pidgeon.read": {
    request: Schema.Struct({ op: Schema.Literal("pidgeon.read"), args: PidgeonRead }),
    response: Schema.Union([
      pidgeonReads["threads.list"].output,
      pidgeonReads["threads.get"].output,
      PidgeonMessage,
      pidgeonReads["messages.search"].output,
      Labels
    ]),
    kind: "integration"
  },
  "pidgeon.write": {
    request: Schema.Struct({ op: Schema.Literal("pidgeon.write"), args: PidgeonWrite }),
    response: Schema.Union([PidgeonSent, PidgeonThread, Labels]),
    kind: "integration"
  }
} as const;
