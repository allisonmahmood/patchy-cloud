import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { readStructure, type Structure } from "./Structure.js";

/** A leaf as ImapFlow's `parseBodystructure` builds one. */
const leaf = (
  type: string,
  extra: {
    readonly charset?: string;
    readonly name?: string;
    readonly encoding?: string;
    readonly size?: number;
    readonly disposition?: string;
    readonly filename?: string;
    readonly id?: string;
    readonly parameters?: Record<string, string>;
  } = {}
) => ({
  type,
  parameters: {
    ...(extra.charset === undefined ? {} : { charset: extra.charset }),
    ...(extra.name === undefined ? {} : { name: extra.name }),
    ...extra.parameters
  },
  encoding: extra.encoding ?? "7bit",
  size: extra.size ?? 100,
  ...(extra.id === undefined ? {} : { id: extra.id }),
  ...(extra.disposition === undefined ? {} : { disposition: extra.disposition }),
  ...(extra.filename === undefined ? {} : { dispositionParameters: { filename: extra.filename } })
});
const multipart = (subtype: string, children: ReadonlyArray<unknown>, parameters = {}) => ({
  type: `multipart/${subtype}`,
  parameters,
  childNodes: children
});
const message = (body: unknown, extra: { readonly filename?: string } = {}) => ({
  ...leaf("message/rfc822", extra),
  childNodes: [body]
});

const plain = leaf("text/plain", { charset: "utf-8", encoding: "quoted-printable" });
const html = leaf("text/html", { charset: "utf-8", encoding: "base64" });
const pdf = leaf("application/pdf", {
  encoding: "base64",
  size: 4000,
  disposition: "attachment",
  filename: "invoice.pdf"
});

const read = (raw: unknown): Structure => {
  const result = readStructure(raw);
  if (Result.isFailure(result)) throw new Error(`malformed: ${result.failure.reason}`);
  return result.success;
};
const reason = (raw: unknown) => {
  const result = readStructure(raw);
  return Result.isFailure(result) ? result.failure.reason : "read";
};
const numbers = (structure: Structure) =>
  structure.parts.map((part) => `${part.part} ${part.contentType}`);
const bodyPart = (structure: Structure) =>
  structure.body.kind === "text"
    ? structure.body.texts.map((text) => `${text.part} ${text.format}`).join(", ")
    : structure.body.kind;

describe("parts and their numbers", () => {
  it("numbers a single-part message's body 1, which ImapFlow leaves unnumbered", () => {
    const structure = read(plain);
    assert.deepStrictEqual(structure.parts, [
      {
        part: "1",
        contentType: "text/plain",
        filename: null,
        encodedSize: 100,
        disposition: null,
        contentId: null
      }
    ]);
    assert.deepStrictEqual(structure.body, {
      kind: "text",
      texts: [
        {
          part: "1",
          format: "plain",
          transferEncoding: "quoted-printable",
          charset: "utf-8",
          encodedSize: 100
        }
      ]
    });
    assert.isFalse(structure.hasAttachments);
  });

  it("lists leaves in order under their multiparts, without the containers", () => {
    const structure = read(multipart("mixed", [multipart("alternative", [plain, html]), pdf]));
    assert.deepStrictEqual(numbers(structure), [
      "1.1 text/plain",
      "1.2 text/html",
      "2 application/pdf"
    ]);
    assert.strictEqual(bodyPart(structure), "1.1 plain");
    assert.isTrue(structure.hasAttachments);
    assert.deepStrictEqual(structure.parts[2], {
      part: "2",
      contentType: "application/pdf",
      filename: "invoice.pdf",
      encodedSize: 4000,
      disposition: "attachment",
      contentId: null
    });
  });

  it("includes a forwarded message and its parts, numbered as IMAP sections", () => {
    const forwarded = message(
      multipart("mixed", [plain, leaf("image/png", { filename: "a.png" })]),
      {
        filename: "Fwd.eml"
      }
    );
    const structure = read(multipart("mixed", [plain, forwarded]));
    assert.deepStrictEqual(numbers(structure), [
      "1 text/plain",
      "2 message/rfc822",
      "2.1 text/plain",
      "2.2 image/png"
    ]);
    assert.strictEqual(bodyPart(structure), "1 plain");
    assert.isTrue(structure.hasAttachments);
  });

  it("numbers a forwarded message's single-part body n.1", () => {
    const structure = read(multipart("mixed", [plain, message(plain)]));
    assert.deepStrictEqual(numbers(structure), [
      "1 text/plain",
      "2 message/rfc822",
      "2.1 text/plain"
    ]);
    // A message that is only a forwarded message, at the root.
    assert.deepStrictEqual(numbers(read(message(plain))), ["1 message/rfc822", "1.1 text/plain"]);
  });

  it("keeps names as display text: cleaned, on one line and bounded", () => {
    const sneaky = read(
      leaf("application/octet-stream", {
        disposition: "attachment",
        filename: "invoice\u{202E}fdp.exe\u{E0041}"
      })
    );
    assert.strictEqual(sneaky.parts[0]!.filename, "invoicefdp.exe");
    const long = read(
      leaf("application/pdf", { disposition: "attachment", filename: "é".repeat(400) })
    );
    assert.strictEqual(long.parts[0]!.filename, "é".repeat(255));
    const byName = read(leaf("application/pdf", { name: "  report\n  q3.pdf " }));
    assert.strictEqual(byName.parts[0]!.filename, "report q3.pdf");
  });

  it("reads an unknown disposition as an attachment", () => {
    assert.strictEqual(
      read(leaf("image/png", { disposition: "x-shown" })).parts[0]!.disposition,
      "attachment"
    );
    assert.strictEqual(
      read(leaf("image/png", { disposition: "INLINE" })).parts[0]!.disposition,
      "inline"
    );
  });
});

describe("the body", () => {
  it("prefers plain text in an alternative, else HTML", () => {
    assert.strictEqual(bodyPart(read(multipart("alternative", [plain, html]))), "1 plain");
    assert.strictEqual(bodyPart(read(multipart("alternative", [html, plain]))), "2 plain");
    assert.strictEqual(bodyPart(read(multipart("alternative", [html]))), "1 html");
    const richOnly = multipart("alternative", [
      leaf("text/enriched"),
      multipart("related", [html, leaf("image/png", { id: "<logo@example.test>" })])
    ]);
    assert.strictEqual(bodyPart(read(richOnly)), "2.1 html");
  });

  it("reads related from its start, else its first part", () => {
    const start = multipart(
      "related",
      [
        leaf("image/png", { id: "<logo@example.test>" }),
        leaf("text/html", { id: "<root@example.test>" })
      ],
      { start: "<root@example.test>" }
    );
    assert.strictEqual(bodyPart(read(start)), "2 html");
    const first = multipart("related", [html, leaf("image/png", { id: "<logo@example.test>" })]);
    const structure = read(first);
    assert.strictEqual(bodyPart(structure), "1 html");
    assert.isFalse(structure.hasAttachments);
  });

  it("never takes an attached text file or a forwarded message as the body", () => {
    const notes = leaf("text/plain", { disposition: "attachment", filename: "notes.txt" });
    assert.strictEqual(bodyPart(read(multipart("mixed", [notes, html]))), "2 html");
    const named = leaf("text/plain", { disposition: "inline", filename: "notes.txt" });
    assert.strictEqual(bodyPart(read(multipart("mixed", [named]))), "none");
    assert.strictEqual(bodyPart(read(multipart("mixed", [message(plain)]))), "none");
    assert.strictEqual(bodyPart(read(multipart("mixed", [pdf]))), "none");
  });

  it("reads a mixed body on through every later inline text part, as a client shows it", () => {
    const image = leaf("image/jpeg", { disposition: "inline", filename: "photo.jpg" });
    const around = read(multipart("mixed", [plain, image, plain, image, html]));
    assert.strictEqual(bodyPart(around), "1 plain, 3 plain, 5 html");
    assert.isTrue(around.hasAttachments);
    const afterAlternative = read(
      multipart("mixed", [multipart("alternative", [plain, html]), pdf, plain])
    );
    assert.strictEqual(bodyPart(afterAlternative), "1.1 plain, 3 plain");
    // An attached or named text part, a forwarded message and a nested multipart stay out.
    const notes = leaf("text/plain", { disposition: "attachment", filename: "notes.txt" });
    const named = leaf("text/html", { filename: "page.html" });
    const kept = read(
      multipart("mixed", [
        plain,
        notes,
        named,
        message(plain),
        multipart("alternative", [plain]),
        html
      ])
    );
    assert.strictEqual(bodyPart(kept), "1 plain, 6 html");
    // A file before the body doesn't stop the text after it.
    assert.strictEqual(bodyPart(read(multipart("mixed", [pdf, html, plain]))), "2 html, 3 plain");
  });

  it("reads a signed message's content", () => {
    const signed = multipart("signed", [
      multipart("alternative", [plain, html]),
      leaf("application/pgp-signature", { filename: "signature.asc" })
    ]);
    assert.strictEqual(bodyPart(read(signed)), "1.1 plain");
  });

  it("reports PGP and S/MIME encryption without counting the ciphertext as a file", () => {
    const pgp = read(
      multipart("encrypted", [
        leaf("application/pgp-encrypted"),
        leaf("application/octet-stream", { filename: "encrypted.asc", disposition: "inline" })
      ])
    );
    assert.deepStrictEqual(pgp.body, { kind: "encrypted", scheme: "pgp", part: "2" });
    assert.isFalse(pgp.hasAttachments);
    const smime = read(
      leaf("application/pkcs7-mime", {
        parameters: { "smime-type": "enveloped-data" },
        disposition: "attachment",
        filename: "smime.p7m"
      })
    );
    assert.deepStrictEqual(smime.body, { kind: "encrypted", scheme: "smime", part: "1" });
    assert.isFalse(smime.hasAttachments);
    const inMixed = read(multipart("mixed", [leaf("application/x-pkcs7-mime"), pdf]));
    assert.deepStrictEqual(inMixed.body, { kind: "encrypted", scheme: "smime", part: "1" });
    assert.isTrue(inMixed.hasAttachments);
    const opaqueSigned = leaf("application/pkcs7-mime", {
      parameters: { "smime-type": "signed-data" }
    });
    assert.strictEqual(bodyPart(read(opaqueSigned)), "none");
  });
});

describe("bounds and malformed structure", () => {
  const nested = (levels: number): unknown =>
    levels === 1 ? plain : multipart("mixed", [nested(levels - 1)]);

  it("reads ten levels deep and refuses eleven", () => {
    assert.strictEqual(reason(nested(10)), "read");
    assert.strictEqual(reason(nested(11)), "depth");
  });

  it("reads 500 nodes and refuses 501", () => {
    assert.strictEqual(
      reason(
        multipart(
          "mixed",
          Array.from({ length: 499 }, () => pdf)
        )
      ),
      "read"
    );
    assert.strictEqual(
      reason(
        multipart(
          "mixed",
          Array.from({ length: 500 }, () => pdf)
        )
      ),
      "parts"
    );
  });

  it("refuses nodes ImapFlow's parser doesn't make", () => {
    assert.strictEqual(reason(null), "shape");
    assert.strictEqual(reason("text/plain"), "shape");
    assert.strictEqual(reason({ parameters: {} }), "shape");
    assert.strictEqual(reason({ type: "/" }), "shape");
    assert.strictEqual(reason({ type: "multipart/mixed", childNodes: [] }), "shape");
    assert.strictEqual(reason({ type: "text/plain", childNodes: [plain] }), "shape");
    assert.strictEqual(reason({ ...plain, size: -1 }), "shape");
    assert.strictEqual(reason({ ...plain, parameters: { charset: 8 } }), "shape");
    assert.strictEqual(reason(multipart("mixed", [plain, { type: 7 }])), "shape");
    assert.strictEqual(reason({ ...message(plain), childNodes: [plain, plain] }), "shape");
  });
});
