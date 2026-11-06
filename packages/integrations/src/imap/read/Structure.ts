/**
 * A message's MIME structure, from ImapFlow's parsed `BODYSTRUCTURE` (`MessageStructureObject`),
 * as the parts a patch sees and the text parts its body is read from.
 *
 * Part numbers are worked out here, as RFC 3501 §6.4.5 numbers sections, rather than taken from
 * ImapFlow: it numbers a non-multipart message's root `undefined` (IMAP's `1`), and the body of a
 * `message/rfc822` whose content isn't multipart with the wrapper's own number (IMAP's `n.1`).
 */
import type { ImapPart } from "@patchy/api";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { MIME_DEPTH, MIME_PARTS, NAME_CHARACTERS } from "./Bounds.js";
import { MalformedStructure } from "./Errors.js";
import { displayText } from "./Text.js";

/** One part as a patch sees it: the wire's. */
export type Part = ImapPart;

/** One text part a message's body is read from, with what decoding it needs. */
export interface TextPart {
  readonly part: string;
  readonly format: "plain" | "html";
  readonly transferEncoding: string;
  readonly charset: string | null;
  readonly encodedSize: number;
}

/**
 * What a message's body is: text read from one or more text parts in order, a part encrypted with
 * S/MIME or PGP (reported, never decrypted), or nothing that reads as a body.
 */
export type Body =
  | { readonly kind: "text"; readonly texts: ReadonlyArray<TextPart> }
  | { readonly kind: "encrypted"; readonly scheme: "smime" | "pgp"; readonly part: string }
  | { readonly kind: "none" };

export interface Structure {
  /** Every part but multipart containers, in order. A `message/rfc822` is listed with its own. */
  readonly parts: ReadonlyArray<Part>;
  readonly body: Body;
  /** Whether any part besides the body's own is a file: attached, named, or a message. */
  readonly hasAttachments: boolean;
}

// ---------- reading ImapFlow's tree ----------

const Parameters = Schema.Record(Schema.String, Schema.String);
/** One node of ImapFlow's tree, its children left for the walk to read under the bounds. */
const RawNode = Schema.Struct({
  type: Schema.String.check(Schema.isPattern(/^[^/\s]+\/[^/\s]+$/)),
  parameters: Schema.optional(Parameters),
  id: Schema.optional(Schema.String),
  encoding: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  disposition: Schema.optional(Schema.String),
  dispositionParameters: Schema.optional(Parameters),
  childNodes: Schema.optional(Schema.Array(Schema.Unknown))
});
const decodeNode = Schema.decodeUnknownResult(RawNode);

interface Node {
  readonly part: string;
  readonly contentType: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly encoding: string;
  readonly size: number;
  readonly disposition: Part["disposition"];
  readonly filename: string | null;
  readonly contentId: string | null;
  readonly children: ReadonlyArray<Node>;
}

/** RFC 2183: an unrecognized disposition is treated as `attachment`. */
const disposition = (value: string | undefined): Part["disposition"] => {
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined || normalized === ""
    ? null
    : normalized === "inline"
      ? "inline"
      : "attachment";
};

/**
 * One node and its children, numbered from `path`. `encapsulated` is true for a message's root and
 * a `message/rfc822`'s content: there a part that isn't multipart is section `path.1`, and a
 * multipart numbers its children under `path` itself.
 */
const walk = (
  raw: unknown,
  path: ReadonlyArray<number>,
  encapsulated: boolean,
  depth: number,
  seen: { nodes: number }
): Result.Result<Node, MalformedStructure> => {
  if (depth > MIME_DEPTH) return Result.fail(new MalformedStructure({ reason: "depth" }));
  if (++seen.nodes > MIME_PARTS) return Result.fail(new MalformedStructure({ reason: "parts" }));
  const decoded = decodeNode(raw);
  if (Result.isFailure(decoded)) return Result.fail(new MalformedStructure({ reason: "shape" }));
  const node = decoded.success;
  const contentType = node.type.toLowerCase();
  const multipart = contentType.startsWith("multipart/");
  const message = contentType === "message/rfc822";
  const childNodes = node.childNodes ?? [];
  if (
    (multipart && childNodes.length === 0) ||
    (message && childNodes.length > 1) ||
    (!multipart && !message && childNodes.length > 0)
  )
    return Result.fail(new MalformedStructure({ reason: "shape" }));
  const own = encapsulated && !multipart ? [...path, 1] : path;
  const children: Node[] = [];
  for (const [index, child] of childNodes.entries()) {
    const read = multipart
      ? walk(child, [...own, index + 1], false, depth + 1, seen)
      : walk(child, own, true, depth + 1, seen);
    if (Result.isFailure(read)) return read;
    children.push(read.success);
  }
  const parameters = node.parameters ?? {};
  return Result.succeed({
    part: own.join("."),
    contentType: Array.from(contentType).slice(0, NAME_CHARACTERS).join(""),
    parameters,
    encoding: node.encoding?.trim().toLowerCase() || "7bit",
    size: node.size ?? 0,
    disposition: disposition(node.disposition),
    filename: displayText(
      node.dispositionParameters?.["filename"] ?? parameters["name"],
      NAME_CHARACTERS
    ),
    contentId: displayText(node.id, NAME_CHARACTERS),
    children
  });
};

// ---------- selecting the body ----------

const charsetOf = (node: Node) => node.parameters["charset"]?.trim().toLowerCase() || null;
/** An attached text file is a file, never the body. */
const attached = (node: Node) => node.disposition === "attachment" || node.filename !== null;
/** A text part shown as text: plain or HTML, neither attached nor named. */
const inlineText = (node: Node) =>
  (node.contentType === "text/plain" || node.contentType === "text/html") && !attached(node);
const textPart = (node: Node): TextPart => ({
  part: node.part,
  format: node.contentType === "text/plain" ? "plain" : "html",
  transferEncoding: node.encoding,
  charset: charsetOf(node),
  encodedSize: node.size
});
const isSmime = (type: string) =>
  type === "application/pkcs7-mime" || type === "application/x-pkcs7-mime";
const contentIdOf = (value: string | undefined | null) =>
  value?.trim().replace(/^<|>$/g, "").toLowerCase();

/** A body and the parts it is made of, which aren't files beside it. */
interface Selected {
  readonly body: Body;
  readonly parts: ReadonlyArray<string>;
}
const none: Selected = { body: { kind: "none" }, parts: [] };
const leaves = (node: Node): ReadonlyArray<string> =>
  node.children.length === 0 ? [node.part] : node.children.flatMap(leaves);

const select = (node: Node): Selected => {
  const type = node.contentType;
  if (type === "multipart/alternative") {
    // Parts run from plainest to richest; plain text wins, then HTML, then whatever else.
    const chosen = node.children.map(select).filter((selected) => selected.body.kind !== "none");
    const last = (format: TextPart["format"]) =>
      [...chosen]
        .reverse()
        .find(({ body }) => body.kind === "text" && body.texts[0]!.format === format);
    return last("plain") ?? last("html") ?? chosen[0] ?? none;
  }
  if (type === "multipart/related") {
    const start = contentIdOf(node.parameters["start"]);
    const root =
      (start === undefined
        ? undefined
        : node.children.find((child) => contentIdOf(child.contentId) === start)) ??
      node.children[0]!;
    return select(root);
  }
  if (type === "multipart/signed") return select(node.children[0]!);
  if (type === "multipart/encrypted") {
    // RFC 1847: a control part, then the ciphertext.
    const ciphertext = node.children[1] ?? node.children[0]!;
    return {
      body: { kind: "encrypted", scheme: "pgp", part: ciphertext.part },
      parts: leaves(node)
    };
  }
  if (type.startsWith("multipart/")) {
    // mixed, and any subtype Patchy doesn't know, as RFC 2046 reads them: the first part that is
    // a body, then every later inline text part, as a client shows text around inline images.
    for (const [index, child] of node.children.entries()) {
      const selected = select(child);
      if (selected.body.kind === "none") continue;
      if (selected.body.kind !== "text") return selected;
      const later = node.children.slice(index + 1).filter(inlineText);
      return {
        body: { kind: "text", texts: [...selected.body.texts, ...later.map(textPart)] },
        parts: [...selected.parts, ...later.map((leaf) => leaf.part)]
      };
    }
    return none;
  }
  if (isSmime(type)) {
    const smimeType = node.parameters["smime-type"]?.trim().toLowerCase();
    return smimeType === "signed-data" || smimeType === "certs-only"
      ? none
      : { body: { kind: "encrypted", scheme: "smime", part: node.part }, parts: [node.part] };
  }
  if (inlineText(node))
    return { body: { kind: "text", texts: [textPart(node)] }, parts: [node.part] };
  // A forwarded message and every other type is never the body.
  return none;
};

// ---------- the whole ----------

/** Lists `node`'s parts into `into`, noting in `files` any file that isn't part of the body. */
const flatten = (node: Node, into: Part[], files: { any: boolean }, body: ReadonlySet<string>) => {
  if (!node.contentType.startsWith("multipart/")) {
    into.push({
      part: node.part,
      contentType: node.contentType,
      filename: node.filename,
      encodedSize: node.size,
      disposition: node.disposition,
      contentId: node.contentId
    });
    if (!body.has(node.part) && (attached(node) || node.contentType === "message/rfc822"))
      files.any = true;
  }
  for (const child of node.children) flatten(child, into, files, body);
};

/**
 * The structure of a message from ImapFlow's `bodyStructure`. One past `MIME_DEPTH` deep, past
 * `MIME_PARTS` nodes, or with a node ImapFlow's parser doesn't make, is `MalformedStructure`.
 */
export const readStructure = (raw: unknown): Result.Result<Structure, MalformedStructure> =>
  Result.map(walk(raw, [], true, 1, { nodes: 0 }), (root) => {
    const selected = select(root);
    const parts: Part[] = [];
    const files = { any: false };
    flatten(root, parts, files, new Set(selected.parts));
    return { parts, body: selected.body, hasAttachments: files.any };
  });
