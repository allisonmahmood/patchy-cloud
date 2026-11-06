/**
 * The bounds IMAP reads plan with. The two result bounds are the registry's own; the rest are
 * starting values that move into the limits registry (and `docs/limits.md`) when the reads are
 * wired, so they can be tuned from wide events. None has been measured against a real host.
 */
import { registry } from "@patchy/limits/registry";
import * as Schema from "effect/Schema";

/** MIME nesting a message's structure may have, counting the root as depth 1. */
export const MIME_DEPTH = 10;
/** Nodes a message's structure may hold, containers and leaves together. */
export const MIME_PARTS = 500;
/** UTF-8 bytes of a message's text, after cleaning. */
export const TEXT_BYTES = 256 * 1024;
/**
 * Raw bytes of the text part a read fetches, with a partial `BODY.PEEK[part]<0.n>`. Base64 runs a
 * third larger than its text and HTML several times larger, so this reads well past `TEXT_BYTES`.
 */
export const TEXT_FETCH_BYTES = 1024 * 1024;
/** Characters kept of a filename, content type or content id. */
export const NAME_CHARACTERS = 255;
/** Characters of a folder path in a ref or call. */
export const FOLDER_CHARACTERS = 1024;
/** Characters of one search value: `from`, `to`, `subject` or `text`. */
export const SEARCH_VALUE_CHARACTERS = 256;

/** Addresses kept of one From, To, Cc or Reply-To list. */
export const ADDRESSES = 100;
/** Encoded bytes of one address list together; addresses past it are left off. */
export const ADDRESS_LIST_BYTES = 16 * 1024;
/** Characters of one address. A longer one is left out, never cut into another address. */
export const ADDRESS_CHARACTERS = 320;
/** Characters kept of a subject. */
export const SUBJECT_CHARACTERS = 1000;
/** Characters of a Message-ID with its angle brackets. A longer one is left out. */
export const MESSAGE_ID_CHARACTERS = 255;
/** Message-IDs kept of `References`: the first, which starts the thread, and the latest. */
export const REFERENCES = 32;
/** Bytes of the `References` header read. */
export const REFERENCES_HEADER_BYTES = 16 * 1024;
/** Flags kept of a message, and characters of each. */
export const FLAGS = 50;
export const FLAG_CHARACTERS = 64;

/** Summaries per page of a scan, list or search. */
export const PAGE_MESSAGES = 100;
/** Refs one `getMessages` call takes. */
export const GET_REFS = 25;

/**
 * The first UID window a page searches. A window that comes up short doubles, up to
 * `WINDOW_MAX_UIDS`, so a sparse folder is crossed in few commands; one that overflows the page
 * starts again at this width. Either way a window's answer holds at most its width in numbers.
 */
export const WINDOW_UIDS = 1024;
export const WINDOW_MAX_UIDS = 16_384;
/** UID windows one call searches before it answers what it has, with a cursor to go on. */
export const CALL_WINDOWS = 32;
/**
 * Milliseconds after which a call starts no further window, inside the 15 s integration deadline
 * so the page's fetch still fits. The first window always runs, so every call advances.
 */
export const CALL_SCAN_MILLIS = 8_000;

/** A `getMessages` answer, encoded, as every operation result. */
export const RESULT_BYTES = registry["runtime.result.bytes"].default;
/** One message, encoded, so a patch can store it as one row. */
export const ROW_BYTES = registry["runtime.row.bytes"].default;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
/** A value's size as the bounds measure it: its JSON encoding in UTF-8. */
export const encodedBytes = (value: Schema.Json): number =>
  Buffer.byteLength(encodeJson(value), "utf8");
