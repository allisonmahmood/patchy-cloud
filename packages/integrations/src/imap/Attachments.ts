/**
 * A message's part as the bytes an action adopts: found in the message's current structure,
 * downloaded through the call's session in chunks of `imap.download.chunk` (with BINARY where the
 * server offers it, so the server removes the transfer encoding), and buffered whole up to
 * `files.stage.bytes`. ImapFlow stops silently at its own byte bound, so it's set one past: a part
 * that reaches it is refused `too_large`, never staged cut.
 *
 * None of these refusals carries a filename or anything else the message holds; the part named
 * is the one the call gave.
 */
import { registry } from "@patchy/limits/registry";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DownloadObject } from "imapflow";
import * as Sessions from "./Sessions.js";

/** The message isn't in its folder under that UID any more. */
export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()(
  "ImapMessageNotFound",
  {}
) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return "The message isn't in its folder any more: it was deleted or moved.";
  }
}

/** The message has no such part now, or a structure Patchy doesn't read. */
export class PartNotFound extends Schema.TaggedError<PartNotFound>()("ImapPartNotFound", {
  part: Schema.String
}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return `The message has no part ${this.part}. getMessages lists the parts it has.`;
  }
  get details() {
    return { part: this.part };
  }
}

/** A forwarded message: a container whose own parts are the files. */
export class NotAFile extends Schema.TaggedError<NotAFile>()("ImapNotAFile", {
  part: Schema.String
}) {
  readonly code = "invalid_request" as const;
  readonly status = 400;
  override get message() {
    return `Part ${this.part} is a forwarded message, which holds other parts rather than being a file. Stage its parts, such as ${this.part}.1, instead.`;
  }
  get details() {
    return { part: this.part };
  }
}

/** The part is past what one staged file holds. Nothing was staged. */
export class AttachmentTooLarge extends Schema.TaggedError<AttachmentTooLarge>()(
  "ImapAttachmentTooLarge",
  { part: Schema.String, maxBytes: Schema.Int }
) {
  readonly code = "too_large" as const;
  readonly status = 413;
  readonly limitId = "files.stage.bytes" as const;
  get scope() {
    return registry[this.limitId].scope;
  }
  get value() {
    return this.maxBytes;
  }
  get details() {
    return { part: this.part };
  }
  override get message() {
    return `Part ${this.part} is past the ${this.maxBytes} bytes one staged file holds, so it wasn't staged. Keep its filename and size from getMessages' parts instead.`;
  }
}

/** The stream's bytes, reading no more than `max + 1`; `over` says it held more than `max`. */
const collect = async (content: DownloadObject["content"], max: number, signal: AbortSignal) => {
  const stop = () => content.destroy();
  signal.addEventListener("abort", stop, { once: true });
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of content as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total > max) {
        content.destroy();
        return { bytes: new Uint8Array(), over: true };
      }
    }
    return { bytes: new Uint8Array(Buffer.concat(chunks, total)), over: false };
  } finally {
    signal.removeEventListener("abort", stop);
  }
};

/**
 * `part` of message `uid` in the session's examined folder, decoded. A part past `maxBytes` is
 * `AttachmentTooLarge`, and the session is destroyed with the call: a chunk may still be on its
 * way. An answer with no content is a message expunged since its structure was read.
 */
export const download = Effect.fnUntraced(function* (
  session: Sessions.Session,
  uid: number,
  part: string,
  bounds: { readonly maxBytes: number; readonly chunkSize: number }
) {
  const found = yield* Effect.tryPromise({
    try: () =>
      session.client.download(String(uid), part, {
        uid: true,
        binary: true,
        decodeText: false,
        chunkSize: bounds.chunkSize,
        maxBytes: bounds.maxBytes + 1
      }),
    catch: (error) => Sessions.failure(session, error)
  });
  if (found.content === undefined) return yield* new MessageNotFound({});
  const content = found.content;
  const read = yield* Effect.tryPromise({
    try: (signal) => collect(content, bounds.maxBytes, signal),
    catch: (error) => Sessions.failure(session, error)
  });
  if (read.over) return yield* new AttachmentTooLarge({ part, maxBytes: bounds.maxBytes });
  return read.bytes;
});
