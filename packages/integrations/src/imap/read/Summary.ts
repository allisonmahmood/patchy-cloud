/**
 * A message's summary, from what one `UID FETCH` of it answers through ImapFlow: the envelope,
 * flags, internal date, size, `BODYSTRUCTURE` and the `References` header. Every field is bounded,
 * so the most a hostile header can make of one summary still lets a full page fit the result
 * bound. ImapFlow has already decoded the envelope's encoded words; here they are cleaned as text.
 */
import type { ImapAddress, ImapSummary } from "@patchy/api";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import {
  ADDRESS_CHARACTERS,
  ADDRESS_LIST_BYTES,
  ADDRESSES,
  encodedBytes,
  FLAG_CHARACTERS,
  FLAGS,
  MESSAGE_ID_CHARACTERS,
  NAME_CHARACTERS,
  REFERENCES,
  REFERENCES_HEADER_BYTES,
  SUBJECT_CHARACTERS
} from "./Bounds.js";
import type { MessageRef } from "./Refs.js";
import { readStructure, type Structure } from "./Structure.js";
import { clean, displayText } from "./Text.js";

// ---------- what ImapFlow answers ----------

/** One address as ImapFlow's envelope parser makes it: `address` is empty for a group's name. */
export interface EnvelopeAddress {
  readonly name?: string | undefined;
  readonly address?: string | undefined;
}

/** ImapFlow's `MessageEnvelopeObject`, the fields a summary reads. */
export interface Envelope {
  /** The sender's `Date`: a `Date`, or the header as written when it isn't one. */
  readonly date?: Date | string | undefined;
  readonly subject?: string | undefined;
  readonly messageId?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly from?: ReadonlyArray<EnvelopeAddress> | undefined;
  readonly replyTo?: ReadonlyArray<EnvelopeAddress> | undefined;
  readonly to?: ReadonlyArray<EnvelopeAddress> | undefined;
  readonly cc?: ReadonlyArray<EnvelopeAddress> | undefined;
}

/**
 * ImapFlow's `FetchMessageObject` for `{ uid, flags, internalDate, size, envelope, bodyStructure,
 * headers: ["references"] }`, which fetches `BODY.PEEK[HEADER.FIELDS (REFERENCES)]` into `headers`.
 * ImapFlow's own object is one of these.
 */
export interface Fetched {
  readonly uid: number;
  readonly envelope?: Envelope | undefined;
  readonly flags?: ReadonlySet<string> | undefined;
  readonly internalDate?: Date | string | undefined;
  readonly size?: number | undefined;
  readonly bodyStructure?: unknown;
  readonly headers?: Uint8Array | undefined;
}

// ---------- the summary ----------

export type Address = ImapAddress;
export type Summary = ImapSummary;

/** The folder a fetch read, under the UIDVALIDITY its `EXAMINE` reported. */
export type FolderRef = Omit<MessageRef, "uid">;

/**
 * An address list as a patch reads it, up to `ADDRESSES` entries and `ADDRESS_LIST_BYTES`
 * encoded, and whether an address was left off for those bounds. A group's name, an empty address,
 * or one past `ADDRESS_CHARACTERS` is left out without counting as cut: it was never an address
 * the summary could carry.
 */
export const addresses = (
  list: ReadonlyArray<EnvelopeAddress> | undefined
): { readonly kept: Address[]; readonly cut: boolean } => {
  const kept: Address[] = [];
  let bytes = 2;
  for (const entry of list ?? []) {
    const address = clean(entry.address ?? "").trim();
    if (address === "" || /\s/.test(address) || Array.from(address).length > ADDRESS_CHARACTERS)
      continue;
    if (kept.length >= ADDRESSES) return { kept, cut: true };
    const shaped: Address = { name: displayText(entry.name, NAME_CHARACTERS), address };
    const size = encodedBytes(shaped) + 1;
    if (bytes + size > ADDRESS_LIST_BYTES) return { kept, cut: true };
    kept.push(shaped);
    bytes += size;
  }
  return { kept, cut: false };
};

/** `<id@host>`: printable ASCII but angle brackets, inside them. */
const MESSAGE_ID = /<[\x21-\x3B\x3D\x3F-\x7E]+>/g;
const messageIds = (value: string) =>
  (value.match(MESSAGE_ID) ?? []).filter((id) => id.length <= MESSAGE_ID_CHARACTERS);

/** The first Message-ID in a header value, with its angle brackets, or `null`. */
export const messageId = (value: string | undefined): string | null =>
  value === undefined ? null : (messageIds(value)[0] ?? null);

/**
 * The Message-IDs of the `References` header ImapFlow answers in `headers`, read from its first
 * `REFERENCES_HEADER_BYTES`, each once. Past `REFERENCES`, the first, which starts the thread, and
 * the latest are kept.
 */
export const references = (headers: Uint8Array | undefined): string[] => {
  if (headers === undefined) return [];
  const text = Buffer.from(headers.subarray(0, REFERENCES_HEADER_BYTES))
    .toString("latin1")
    .replace(/\r?\n[ \t]+/g, " ");
  const ids = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const value = /^references[ \t]*:(.*)$/i.exec(line)?.[1];
    if (value !== undefined) for (const id of messageIds(value)) ids.add(id);
  }
  const all = [...ids];
  return all.length <= REFERENCES ? all : [all[0]!, ...all.slice(all.length - REFERENCES + 1)];
};

/** A `Date` as ISO 8601, or `null` for anything else, as ImapFlow leaves a date it can't read. */
const iso = (value: Date | string | undefined): string | null =>
  Predicate.isDate(value) && !Number.isNaN(value.getTime()) ? value.toISOString() : null;

const flagsOf = (flags: ReadonlySet<string> | undefined): string[] =>
  [...(flags ?? [])]
    .map((flag) => clean(flag).trim())
    .filter((flag) => flag.length > 0 && flag.length <= FLAG_CHARACTERS && !/\s/.test(flag))
    .sort()
    .slice(0, FLAGS);

/**
 * The summary of a fetched message, given its structure when the caller has read it. A structure
 * Patchy can't read has no attachments to offer, since none of its parts could be staged.
 */
export const summaryOf = (
  fetched: Fetched,
  folder: FolderRef,
  structure: Structure | undefined
): Summary => {
  const envelope = fetched.envelope ?? {};
  const from = addresses(envelope.from);
  const to = addresses(envelope.to);
  const cc = addresses(envelope.cc);
  const replyTo = addresses(envelope.replyTo);
  return {
    ref: { ...folder, uid: fetched.uid },
    from: from.kept,
    to: to.kept,
    cc: cc.kept,
    recipientsTruncated: from.cut || to.cut || cc.cut || replyTo.cut,
    subject: displayText(envelope.subject, SUBJECT_CHARACTERS),
    date: iso(envelope.date),
    internalDate: iso(fetched.internalDate),
    size: Number.isSafeInteger(fetched.size) && fetched.size! >= 0 ? fetched.size! : 0,
    flags: flagsOf(fetched.flags),
    messageId: messageId(envelope.messageId),
    inReplyTo: messageId(envelope.inReplyTo),
    references: references(fetched.headers),
    hasAttachments: structure?.hasAttachments ?? false
  };
};

/** The summary of a message one page of a scan, list or search fetched. */
export const summarize = (fetched: Fetched, folder: FolderRef): Summary => {
  const structure = readStructure(fetched.bodyStructure);
  return summaryOf(fetched, folder, Result.isSuccess(structure) ? structure.success : undefined);
};
