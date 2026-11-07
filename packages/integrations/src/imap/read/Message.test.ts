import { assert, describe, it } from "@effect/vitest";
import { TEXT_FETCH_BYTES } from "./Bounds.js";
import { readMessage, textFetches, type Message } from "./Message.js";
import type { Fetched } from "./Summary.js";

const folder = { connection: "con_invoices", folder: "INBOX", uidValidity: 7 };
const text = (subtype: string, size: number, encoding = "7bit", charset = "utf-8") => ({
  type: `text/${subtype}`,
  parameters: { charset },
  encoding,
  size
});
const photo = {
  type: "image/jpeg",
  encoding: "base64",
  size: 90_000,
  disposition: "inline",
  dispositionParameters: { filename: "photo.jpg" }
};
const fetchedWith = (bodyStructure: unknown): Fetched => ({
  uid: 9,
  envelope: {
    subject: "Photos",
    from: [{ name: "Ada", address: "ada@example.com" }],
    replyTo: [{ name: "Ada at home", address: "ada@example.test" }]
  },
  internalDate: new Date("2026-11-01T08:00:00.000Z"),
  size: 120_000,
  bodyStructure
});
const answer = (parts: Record<string, string>, binary: ReadonlyArray<string> = []) => ({
  bodyParts: new Map(Object.entries(parts).map(([part, value]) => [part, Buffer.from(value)])),
  binaryParts: new Set(binary)
});
const asMessage = (outcome: ReturnType<typeof readMessage>): Message => {
  if ("error" in outcome) throw new Error(`unread: ${outcome.error}`);
  return outcome;
};

describe("textFetches", () => {
  it("asks each text part one byte past its size, within one shared budget", () => {
    const mixed = {
      type: "multipart/mixed",
      childNodes: [text("plain", 120), photo, text("plain", 40)]
    };
    assert.deepStrictEqual(textFetches(fetchedWith(mixed)), [
      { part: "1", maxLength: 121 },
      { part: "3", maxLength: 41 }
    ]);
    const big = {
      type: "multipart/mixed",
      childNodes: [text("html", TEXT_FETCH_BYTES), text("plain", 40)]
    };
    assert.deepStrictEqual(textFetches(fetchedWith(big)), [
      { part: "1", maxLength: TEXT_FETCH_BYTES }
    ]);
    assert.deepStrictEqual(textFetches(fetchedWith(text("plain", 0))), [
      { part: "1", maxLength: TEXT_FETCH_BYTES }
    ]);
  });

  it("asks nothing of an encrypted, bodiless or unreadable structure", () => {
    assert.deepStrictEqual(textFetches(fetchedWith({ type: "application/pkcs7-mime" })), []);
    assert.deepStrictEqual(textFetches(fetchedWith(photo)), []);
    assert.deepStrictEqual(textFetches(fetchedWith({ type: 7 })), []);
  });
});

describe("readMessage", () => {
  it("is the summary, replyTo, parts and the joined text of every body part", () => {
    const mixed = {
      type: "multipart/mixed",
      childNodes: [text("plain", 30), photo, text("html", 80, "base64")]
    };
    const message = asMessage(
      readMessage(
        fetchedWith(mixed),
        folder,
        answer({
          "1": "Here is the photo:\r\n",
          "3": Buffer.from("<p>Taken <b>Sunday</b>.</p><style>p{}</style>").toString("base64")
        })
      )
    );
    assert.strictEqual(message.text, "Here is the photo:\n\nTaken Sunday.");
    assert.isFalse(message.truncated);
    assert.deepStrictEqual(message.ref, { ...folder, uid: 9 });
    assert.strictEqual(message.subject, "Photos");
    assert.deepStrictEqual(message.replyTo, [{ name: "Ada at home", address: "ada@example.test" }]);
    assert.deepStrictEqual(
      message.parts.map((part) => `${part.part} ${part.contentType}`),
      ["1 text/plain", "2 image/jpeg", "3 text/html"]
    );
    assert.isTrue(message.hasAttachments);
    assert.isNull(message.encrypted);
  });

  it("reads a part that came back through BINARY as it is", () => {
    const message = asMessage(
      readMessage(
        fetchedWith(text("plain", 20, "base64")),
        folder,
        answer({ "1": "already decoded" }, ["1"])
      )
    );
    assert.strictEqual(message.text, "already decoded");
  });

  it("says truncated when a part came back whole-length, or not at all", () => {
    const cut = asMessage(
      readMessage(fetchedWith(text("plain", 4)), folder, answer({ "1": "abcde" }))
    );
    assert.strictEqual(cut.text, "abcde");
    assert.isTrue(cut.truncated);
    const missing = { type: "multipart/mixed", childNodes: [text("plain", 10), text("plain", 10)] };
    const partial = asMessage(readMessage(fetchedWith(missing), folder, answer({ "1": "first" })));
    assert.strictEqual(partial.text, "first");
    assert.isTrue(partial.truncated);
  });

  it("says truncated when the shared budget left a part out", () => {
    const big = {
      type: "multipart/mixed",
      childNodes: [text("plain", TEXT_FETCH_BYTES), text("plain", 10)]
    };
    const message = asMessage(
      readMessage(fetchedWith(big), folder, answer({ "1": "short", "2": "never read" }))
    );
    assert.strictEqual(message.text, "short");
    assert.isTrue(message.truncated);
  });

  it("reports an encrypted body with no text", () => {
    const smime = {
      type: "application/pkcs7-mime",
      parameters: { "smime-type": "enveloped-data" },
      disposition: "attachment",
      dispositionParameters: { filename: "smime.p7m" },
      size: 5_000
    };
    const message = asMessage(readMessage(fetchedWith(smime), folder, answer({})));
    assert.strictEqual(message.encrypted, "smime");
    assert.strictEqual(message.text, "");
    assert.isFalse(message.truncated);
    assert.isFalse(message.hasAttachments);
  });

  it("answers malformed for a structure it can't read", () => {
    assert.deepStrictEqual(
      readMessage(fetchedWith({ type: "multipart/mixed", childNodes: [] }), folder, answer({})),
      {
        error: "malformed"
      }
    );
    assert.deepStrictEqual(readMessage(fetchedWith(undefined), folder, answer({})), {
      error: "malformed"
    });
  });
});
