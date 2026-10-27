/**
 * Pidgeon: one company email address, read and answered through operations Patchy writes. Patch
 * code names an operation and its input, never a path, an address id or a key: Patchy fills in
 * the connection's address on every call, and anything that isn't on it answers `not_found`.
 * Reads travel as `pidgeon.read`; replies, sends and triage as `pidgeon.write`, which a `read`
 * connection refuses before Pidgeon sees anything.
 */
import * as Schema from "effect/Schema";
import { PidgeonLabel } from "./pidgeonSnapshot.js";
import { DefinitionName } from "./schemas.js";

/** An id Pidgeon gave a thread, message, label or attachment. */
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
const Search = Schema.String.check(Schema.isBetweenLength(1, 320));
export const pidgeonThreadStatuses = ["open", "waiting", "resolved", "human_review"] as const;
/** Pidgeon's triage state for a conversation, shared by everyone who reads the address. */
export const PidgeonThreadStatus = Schema.Literals(pidgeonThreadStatuses);
export const pidgeonFolders = ["inbox", "sent", "archive", "spam"] as const;
/**
 * Names one email a person is writing: the same draft sent again within Pidgeon's 24 hours is one
 * email. Patchy sends Pidgeon a hash of it with the connection and the patch, never the key itself.
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
  subject: Schema.NullOr(Schema.String),
  status: PidgeonThreadStatus,
  /** Who sent the newest message. */
  from: Schema.NullOr(PidgeonParty),
  /** The first line of the newest message. */
  preview: Schema.NullOr(Schema.String),
  messageCount: Schema.Int,
  hasAttachments: Schema.Boolean,
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
/** A file a message carried: its metadata, and its text through `attachments.text` if it's text. */
export const PidgeonAttachment = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  contentType: Schema.String,
  /** Bytes. */
  size: Schema.Int
});
/** What happened to mail the address sent: the worst any recipient reached, such as `bounced`. */
export const PidgeonDelivery = Schema.Struct({
  state: Schema.String,
  deliveredAt: Schema.NullOr(Schema.String)
});
/**
 * One message: plain text cleaned by the firewall, never headers, HTML or its source. A message the
 * firewall `held` for a person has no subject, text or attachments until someone releases it in
 * Pidgeon.
 */
export const PidgeonMessage = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  from: PidgeonParty,
  to: Schema.Array(PidgeonParty),
  cc: Schema.Array(PidgeonParty),
  subject: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** Written in Pidgeon's test mode: it never left Pidgeon. */
  test: Schema.Boolean,
  held: Schema.Boolean,
  text: Schema.String,
  /** Null on mail this address sent. */
  firewall: Schema.NullOr(PidgeonFirewall),
  attachments: Schema.Array(PidgeonAttachment),
  /** Null on mail that arrived, and on a send nobody has reported on yet. */
  delivery: Schema.NullOr(PidgeonDelivery)
});
export const PidgeonSearchHit = Schema.Struct({
  messageId: Schema.String,
  threadId: Schema.String,
  from: PidgeonParty,
  to: Schema.Array(Schema.String),
  subject: Schema.NullOr(Schema.String),
  preview: Schema.NullOr(Schema.String),
  hasAttachments: Schema.Boolean,
  held: Schema.Boolean,
  createdAt: Schema.String
});
export const PidgeonAttachmentText = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  contentType: Schema.String,
  size: Schema.Int,
  /** Cleaned by the firewall. */
  text: Schema.String,
  /** The file ran past 200,000 characters and the rest was cut. */
  truncated: Schema.Boolean,
  /** Null on a file this address sent. */
  firewall: Schema.NullOr(PidgeonFirewall)
});
/**
 * What Pidgeon did with one email. `sent`: handed on, to everyone but the `rejected` recipients.
 * `pending_approval`: nothing was sent; it waits as a draft for a person to approve in Pidgeon,
 * for `approval.reason`, until `approval.expiresAt`. `replayed` marks the first send's answer to
 * the same draft sent again; `test`, a test-mode send, which never left Pidgeon.
 */
export const PidgeonSent = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("sent"),
    messageId: Schema.String,
    threadId: Schema.String,
    /** Recipients the mail provider refused at hand-off; the rest were sent to. */
    rejected: Schema.Array(Schema.Struct({ address: Schema.String, reason: Schema.String })),
    replayed: Schema.Boolean,
    test: Schema.Boolean
  }),
  Schema.Struct({
    status: Schema.Literal("pending_approval"),
    draftId: Schema.String,
    threadId: Schema.String,
    approval: Schema.Struct({
      /**
       * `first_contact`: the address asks a person before writing to someone new.
       * `risky_thread`: mail in the conversation tried to give the agent instructions.
       */
      reason: Schema.Literals(["first_contact", "risky_thread"]),
      expiresAt: Schema.String
    }),
    replayed: Schema.Boolean,
    test: Schema.Boolean
  })
]);
const Labels = Schema.Struct({ labels: Schema.Array(PidgeonLabel) });

/** Each read's input and result, by the name patch code calls it. */
export const pidgeonReads = {
  "threads.list": {
    input: Schema.Struct({
      status: Schema.optionalKey(PidgeonThreadStatus),
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
      text: Schema.optionalKey(Search),
      from: Schema.optionalKey(Search),
      to: Schema.optionalKey(Search),
      labelId: Schema.optionalKey(PidgeonId),
      hasAttachment: Schema.optionalKey(Schema.Boolean),
      folder: Schema.optionalKey(Schema.Literals(pidgeonFolders)),
      limit: Schema.optionalKey(Limit),
      cursor: Schema.optionalKey(Cursor)
    }),
    output: Schema.Struct({
      hits: Schema.Array(PidgeonSearchHit),
      nextCursor: Schema.NullOr(Schema.String)
    })
  },
  // No arguments: an empty Struct would let any key through, so this one refuses every key.
  "labels.list": { input: Schema.Record(Schema.String, Schema.Never), output: Labels },
  "attachments.text": { input: Schema.Struct({ id: PidgeonId }), output: PidgeonAttachmentText }
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
  call("labels.list", pidgeonReads["labels.list"].input),
  call("attachments.text", pidgeonReads["attachments.text"].input)
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
  devCall("labels.list", pidgeonReads["labels.list"].input),
  devCall("attachments.text", pidgeonReads["attachments.text"].input)
]);
export type PidgeonDevRead = typeof PidgeonDevRead.Type;
/** One reply, send or triage on a declared connection whose key can send. */
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
      Labels,
      PidgeonAttachmentText
    ]),
    kind: "integration"
  },
  "pidgeon.write": {
    request: Schema.Struct({ op: Schema.Literal("pidgeon.write"), args: PidgeonWrite }),
    response: Schema.Union([PidgeonSent, PidgeonThread, Labels]),
    kind: "integration"
  }
} as const;
