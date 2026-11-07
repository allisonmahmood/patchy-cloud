/**
 * The bounds IMAP reads plan with, read from the limits registry so they're tuned there (and in
 * `docs/limits.md`), from wide events. None has been measured against a real host.
 */
import { registry } from "@patchy/limits/registry";
import * as Schema from "effect/Schema";

/** MIME nesting a message's structure may have, counting the root as depth 1. */
export const MIME_DEPTH = registry["imap.message.depth"].default;
/** Nodes a message's structure may hold, containers and leaves together. */
export const MIME_PARTS = registry["imap.message.parts"].default;
/** UTF-8 bytes of a message's text, after cleaning. */
export const TEXT_BYTES = registry["imap.message.text"].default;
/**
 * Raw bytes of a message's text parts a read fetches together, with partial `BODY.PEEK[part]<0.n>`
 * fetches. Base64 runs a third larger than its text and HTML several times larger, so this reads
 * well past `TEXT_BYTES`.
 */
export const TEXT_FETCH_BYTES = registry["imap.message.textFetch"].default;
/** Characters kept of a filename, content type, content id or display name. */
export const NAME_CHARACTERS = registry["imap.text.name"].default;
/** Characters of a folder path in a ref or call. */
export const FOLDER_CHARACTERS = registry["imap.text.folder"].default;

/** Addresses kept of one From, To, Cc or Reply-To list. */
export const ADDRESSES = registry["imap.summary.addresses"].default;
/** Encoded bytes of one address list together; addresses past it are left off. */
export const ADDRESS_LIST_BYTES = registry["imap.summary.addressBytes"].default;
/** Characters of one address. A longer one is left out, never cut into another address. */
export const ADDRESS_CHARACTERS = registry["imap.text.address"].default;
/** Characters kept of a subject. */
export const SUBJECT_CHARACTERS = registry["imap.text.subject"].default;
/** Characters of a Message-ID with its angle brackets. A longer one is left out. */
export const MESSAGE_ID_CHARACTERS = registry["imap.text.messageId"].default;
/** Message-IDs kept of `References`: the first, which starts the thread, and the latest. */
export const REFERENCES = registry["imap.summary.references"].default;
/** Bytes of the `References` header read. */
export const REFERENCES_HEADER_BYTES = registry["imap.summary.referencesBytes"].default;
/** Flags kept of a message, and characters of each. */
export const FLAGS = registry["imap.summary.flags"].default;
export const FLAG_CHARACTERS = registry["imap.text.flag"].default;

/** Summaries per page of a scan, list or search. */
export const PAGE_MESSAGES = registry["imap.page.messages"].default;
/** Refs one `getMessages` call takes. */
export const GET_REFS = registry["imap.getMessages.refs"].default;

/**
 * The first UID window a page searches. A window that comes up short doubles, up to
 * `WINDOW_MAX_UIDS`, so a sparse folder is crossed in few commands; one that overflows the page
 * starts again at this width. Either way a window's answer holds at most its width in numbers.
 */
export const WINDOW_UIDS = registry["imap.window.uids"].default;
export const WINDOW_MAX_UIDS = registry["imap.window.maxUids"].default;
/** UID windows one call searches before it answers what it has, with a cursor to go on. */
export const CALL_WINDOWS = registry["imap.scan.windows"].default;
/**
 * Milliseconds after which a call starts no further window, inside the 15 s integration deadline
 * so the page's fetch still fits. The first window always runs, so every call advances.
 */
export const CALL_SCAN_MILLIS = registry["imap.scan.milliseconds"].default;

/** A `getMessages` answer, encoded, as every operation result. */
export const RESULT_BYTES = registry["runtime.result.bytes"].default;
/** One message, encoded, so a patch can store it as one row. */
export const ROW_BYTES = registry["runtime.row.bytes"].default;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
/** A value's size as the bounds measure it: its JSON encoding in UTF-8. */
export const encodedBytes = (value: Schema.Json): number =>
  Buffer.byteLength(encodeJson(value), "utf8");
