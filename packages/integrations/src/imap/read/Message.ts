/**
 * A message as `getMessages` answers it: its summary, `replyTo`, its parts, and its text read with
 * a second fetch of the body's text parts. Reading one takes two fetches:
 *
 * 1. The summary's fetch, `Summary.Fetched`, which carries the `BODYSTRUCTURE`.
 * 2. `BODY.PEEK[part]<0.maxLength>` of each of `textFetches(fetched)`, whose answer ImapFlow keys
 *    by part in `bodyParts`, with the ones that came back through `BINARY` in `binaryParts`.
 *
 * `readMessage` then shapes both, or answers `malformed` when the structure can't be read.
 */
import type { ImapMessage, ImapUnread } from "@patchy/api";
import * as Result from "effect/Result";
import { TEXT_FETCH_BYTES } from "./Bounds.js";
import { readStructure, type Body } from "./Structure.js";
import { addresses, summaryOf, type Fetched, type FolderRef } from "./Summary.js";
import { bodyText, type TextSource } from "./Text.js";

export type Message = ImapMessage;

/** One text part to fetch, and the bytes it may read. */
export interface TextFetch {
  readonly part: string;
  readonly maxLength: number;
}

/**
 * The body's text parts in order, sharing `TEXT_FETCH_BYTES` between them. Each asks one byte past
 * its `encodedSize`, so an answer shorter than `maxLength` is the whole part; a part whose size
 * the server didn't give may read what is left.
 */
const fetchesOf = (body: Body): ReadonlyArray<TextFetch> => {
  if (body.kind !== "text") return [];
  const fetches: TextFetch[] = [];
  let left = TEXT_FETCH_BYTES;
  for (const text of body.texts) {
    if (left <= 0) break;
    const maxLength = Math.min(left, text.encodedSize > 0 ? text.encodedSize + 1 : left);
    fetches.push({ part: text.part, maxLength });
    left -= maxLength;
  }
  return fetches;
};

/** What a message's text needs fetched. None for a structure that can't be read. */
export const textFetches = (fetched: Fetched): ReadonlyArray<TextFetch> => {
  const structure = readStructure(fetched.bodyStructure);
  return Result.isSuccess(structure) ? fetchesOf(structure.success.body) : [];
};

/** The text fetch's answer, as ImapFlow's `FetchMessageObject` carries it. */
export interface FetchedText {
  readonly bodyParts?: ReadonlyMap<string, Uint8Array> | undefined;
  readonly binaryParts?: ReadonlySet<string> | undefined;
}

/**
 * The message `fetched` is, with `answered` the text fetch for it. A text part the answer lacks,
 * or one the shared budget left out, reads as cut: `truncated` says so.
 */
export const readMessage = (
  fetched: Fetched,
  folder: FolderRef,
  answered: FetchedText
): Message | ImapUnread => {
  const read = readStructure(fetched.bodyStructure);
  if (Result.isFailure(read)) return { error: "malformed" };
  const structure = read.success;
  const body = structure.body;
  const fetches = fetchesOf(body);
  const texts = body.kind === "text" ? body.texts : [];
  const sources = fetches.map((fetch, index): TextSource => {
    const part = texts[index]!;
    const bytes = answered.bodyParts?.get(fetch.part);
    return {
      bytes: bytes ?? new Uint8Array(),
      complete: bytes !== undefined && bytes.length < fetch.maxLength,
      transferEncoding: answered.binaryParts?.has(fetch.part) ? "binary" : part.transferEncoding,
      charset: part.charset,
      format: part.format
    };
  });
  const shown = bodyText(sources);
  return {
    ...summaryOf(fetched, folder, structure),
    replyTo: addresses(fetched.envelope?.replyTo).kept,
    text: shown.text,
    truncated: shown.truncated || fetches.length < texts.length,
    parts: structure.parts,
    encrypted: body.kind === "encrypted" ? body.scheme : null
  };
};
