/**
 * A message's text, from the raw bytes of its text part to what a patch reads. Cleaning is lossy
 * and best-effort: mail is untrusted, so what can't be seen on a rendered page doesn't reach the
 * patch, and what could steer how text renders is dropped.
 *
 * The runtime's own `TextDecoder` reads every charset the WHATWG Encoding standard names, on Node
 * and Bun alike, which covers the charsets mail uses in practice; no charset library is needed.
 */
import { TEXT_BYTES } from "./Bounds.js";
import { htmlToText } from "./Html.js";

/**
 * Characters that never reach a patch:
 *
 * - C0 and C1 controls and DEL, except tab and newline;
 * - bidi embeddings, overrides, isolates and marks (U+061C, U+200E–U+200F, U+202A–U+202E,
 *   U+2066–U+2069);
 * - zero-width space, word joiner and the invisible operators (U+200B, U+2060–U+2064), and the
 *   byte-order mark (U+FEFF);
 * - Unicode tag characters (U+E0000–U+E007F).
 *
 * ZWJ and ZWNJ (U+200D, U+200C) stay: emoji sequences and several scripts need them.
 */
const INVISIBLE =
  /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}-\u{9F}\u{61C}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}]/gu;

/** `text` without invisible characters, with every line break as `\n`. */
export const clean = (text: string): string => text.replace(/\r\n?/g, "\n").replace(INVISIBLE, "");

/**
 * A header value or name as display text: cleaned, on one line, cut to `maxCharacters` code
 * points, or `null` when nothing is left.
 */
export const displayText = (value: string | undefined, maxCharacters: number): string | null => {
  if (value === undefined) return null;
  const text = Array.from(clean(value).replace(/\s+/g, " ").trim())
    .slice(0, maxCharacters)
    .join("")
    .trim();
  return text.length === 0 ? null : text;
};

const encoder = new TextEncoder();

/** `text` cut to at most `maxBytes` of UTF-8, never inside a character. */
export const truncate = (
  text: string,
  maxBytes: number
): { readonly text: string; readonly truncated: boolean } => {
  // A UTF-16 code unit is at most 3 bytes of UTF-8, so a short string can't be over.
  if (text.length * 3 <= maxBytes) return { text, truncated: false };
  const room = new Uint8Array(maxBytes);
  // `encodeInto` writes whole characters only; `read` is the code units that fit.
  const { read } = encoder.encodeInto(text, room);
  return read >= text.length
    ? { text, truncated: false }
    : { text: text.slice(0, read), truncated: true };
};

const BASE64_ALPHABET = /[^A-Za-z0-9+/]/g;
const HEX = /^[0-9A-Fa-f]{2}$/;

/**
 * The bytes of a part with its transfer encoding removed. `complete` is false when the fetch was
 * cut short, and a trailing unit cut with it (a partial base64 quantum, a partial `=XX`) is
 * dropped rather than decoded as garbage. `7bit`, `8bit`, `binary`, a part fetched with `BINARY`
 * and an encoding Patchy doesn't know are read as they are.
 */
export const transferDecode = (
  bytes: Uint8Array,
  encoding: string,
  complete: boolean
): Uint8Array => {
  switch (encoding.trim().toLowerCase()) {
    case "base64": {
      const alphabet = Buffer.from(bytes).toString("latin1").replace(BASE64_ALPHABET, "");
      const whole = complete
        ? alphabet
        : alphabet.slice(0, alphabet.length - (alphabet.length % 4));
      return Buffer.from(whole, "base64");
    }
    case "quoted-printable":
      return quotedPrintable(bytes, complete);
    default:
      return bytes;
  }
};

/** RFC 2045 quoted-printable: `=XX` escapes, soft line breaks, transport padding dropped. */
const quotedPrintable = (bytes: Uint8Array, complete: boolean): Uint8Array => {
  let source = Buffer.from(bytes).toString("latin1");
  if (!complete) source = source.replace(/=[0-9A-Fa-f\r]?$/, "");
  const lines = source.split(/\r?\n/);
  const out: number[] = [];
  for (const [index, raw] of lines.entries()) {
    const last = index === lines.length - 1;
    // Trailing white space is transport padding, except on a last line the cut left unfinished.
    const line = last && !complete ? raw : raw.replace(/[ \t]+$/, "");
    const soft = line.endsWith("=");
    const body = soft ? line.slice(0, -1) : line;
    for (let at = 0; at < body.length; at++) {
      const pair = body.slice(at + 1, at + 3);
      if (body[at] === "=" && HEX.test(pair)) {
        out.push(Number.parseInt(pair, 16));
        at += 2;
      } else out.push(body.charCodeAt(at));
    }
    if (!soft && !last) out.push(0x0d, 0x0a);
  }
  return Uint8Array.from(out);
};

const declaredDecoder = (charset: string | null) => {
  const label = charset?.trim();
  if (label === undefined || label === "") return undefined;
  try {
    return new TextDecoder(label);
  } catch {
    return undefined;
  }
};
const latin1 = new TextDecoder("latin1");

/**
 * Bytes as text in the charset the part's header names. With none, or one the runtime doesn't
 * know such as `utf-7`, they read as UTF-8, or as latin1 (windows-1252, as WHATWG reads the label)
 * when they aren't valid UTF-8. When `complete` is false, a character the cut split is held back.
 */
export const charsetDecode = (
  bytes: Uint8Array,
  charset: string | null,
  complete: boolean
): string => {
  const declared = declaredDecoder(charset);
  if (declared !== undefined) return declared.decode(bytes, { stream: !complete });
  try {
    // A fresh decoder each time: one decoding with `stream` holds a cut character for the next.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !complete });
  } catch {
    return latin1.decode(bytes);
  }
};

/** The text part a message's body was selected from, as its structure describes it. */
export interface TextSource {
  /** The raw section bytes the fetch answered, transfer-encoded unless fetched with `BINARY`. */
  readonly bytes: Uint8Array;
  /**
   * Whether `bytes` are the whole part: fewer bytes came back than the partial fetch asked for,
   * or at least the part's `encodedSize`.
   */
  readonly complete: boolean;
  readonly transferEncoding: string;
  readonly charset: string | null;
  readonly format: "plain" | "html";
}

/**
 * A message's text from its text parts in order: each decoded, HTML made inert text and cleaned,
 * joined by a blank line, and cut to `maxBytes` of UTF-8. `truncated` is true when a fetch or the
 * cut left any of it out.
 */
export const bodyText = (
  sources: ReadonlyArray<TextSource>,
  maxBytes: number = TEXT_BYTES
): { readonly text: string; readonly truncated: boolean } => {
  const texts = sources
    .map((source) => {
      const decoded = charsetDecode(
        transferDecode(source.bytes, source.transferEncoding, source.complete),
        source.charset,
        source.complete
      );
      // Blank lines at either end would pile up between parts; indentation stays.
      return clean(source.format === "html" ? htmlToText(decoded) : decoded)
        .replace(/^\n+/, "")
        .trimEnd();
    })
    .filter((text) => text.length > 0);
  const cut = truncate(texts.join("\n\n"), maxBytes);
  return { text: cut.text, truncated: cut.truncated || sources.some((source) => !source.complete) };
};
