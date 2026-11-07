/**
 * The refusals IMAP reads plan with. None carries a subject, address, search value or anything
 * else the mailbox holds; the folder named is the one the call or ref gave.
 */
import { registry } from "@patchy/limits/registry";
import * as Schema from "effect/Schema";
import { RESULT_BYTES } from "./Bounds.js";

/** A page cursor that isn't from this call: another connection, operation, folder or filters. */
export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("ImapInvalidCursor", {}) {
  readonly code = "invalid_cursor" as const;
  readonly status = 400;
  override get message() {
    return "This cursor isn't from this call: pass back the cursor the same operation answered, with the same folder and filters.";
  }
}

/** A checkpoint that isn't for this connection and folder. */
export class InvalidCheckpoint extends Schema.TaggedError<InvalidCheckpoint>()(
  "ImapInvalidCheckpoint",
  {}
) {
  readonly code = "invalid_cursor" as const;
  readonly status = 400;
  override get message() {
    return "This checkpoint isn't for this connection and folder: pass the checkpoint a scan of the same folder answered.";
  }
}

/**
 * The folder's UIDVALIDITY isn't the one a ref, cursor or checkpoint was made under, so its UIDs
 * may name other messages now. Nothing made under the old value is good again.
 */
export class MailboxReset extends Schema.TaggedError<MailboxReset>()("ImapMailboxReset", {
  folder: Schema.String
}) {
  readonly code = "mailbox_reset" as const;
  readonly status = 409;
  override get message() {
    return `The folder ${this.folder} was reset by the mail server (its UIDVALIDITY changed), so refs, cursors and checkpoints from before no longer name the same messages. Scan the folder again from the start.`;
  }
  get details() {
    return { folder: this.folder };
  }
}

/** A ref from another connection than the one the call is on. */
export class ForeignRef extends Schema.TaggedError<ForeignRef>()("ImapForeignRef", {}) {
  readonly code = "invalid_request" as const;
  readonly status = 400;
  override get message() {
    return "A ref names another connection: a ref works only on the connection that answered it.";
  }
}

/** A `getMessages` answer past the result bound. Nothing is dropped to fit. */
export class ResultTooLarge extends Schema.TaggedError<ResultTooLarge>()("ImapResultTooLarge", {
  refs: Schema.Int,
  bytes: Schema.Int
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  readonly limitId = "runtime.result.bytes" as const;
  readonly maxBytes = RESULT_BYTES;
  get scope() {
    return registry[this.limitId].scope;
  }
  get value() {
    return this.maxBytes;
  }
  override get message() {
    return `The ${this.refs} messages asked for come to ${this.bytes} bytes, past the ${this.maxBytes}-byte result bound. Ask for fewer refs at a time.`;
  }
}

/**
 * A `BODYSTRUCTURE` Patchy doesn't read. A message with one answers `malformed`; the reason is
 * for wide events.
 *
 * - `shape`: a node isn't one ImapFlow's parser makes.
 * - `depth`: nesting past `MIME_DEPTH`.
 * - `parts`: more than `MIME_PARTS` nodes.
 */
export class MalformedStructure extends Schema.TaggedError<MalformedStructure>()(
  "ImapMalformedStructure",
  { reason: Schema.Literals(["shape", "depth", "parts"]) }
) {
  override get message() {
    return `The message's MIME structure can't be read (${this.reason}).`;
  }
}
