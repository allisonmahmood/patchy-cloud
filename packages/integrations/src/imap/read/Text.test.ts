import { assert, describe, it } from "@effect/vitest";
import { bodyText, charsetDecode, clean, transferDecode, truncate } from "./Text.js";

const bytes = (text: string, encoding: BufferEncoding = "utf8") => Buffer.from(text, encoding);
const latin1 = (data: Uint8Array) => Buffer.from(data).toString("latin1");
const utf8 = (data: Uint8Array) => Buffer.from(data).toString("utf8");

describe("clean", () => {
  it("strips tag characters, bidi controls and other invisibles", () => {
    const tagged = "Pay\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045} now";
    assert.strictEqual(clean(tagged), "Pay now");
    assert.strictEqual(clean("abc‮dcba‬ ⁦x⁩ ‏y‎"), "abcdcba x y");
    assert.strictEqual(clean("zero​width⁠﻿"), "zerowidth");
    assert.strictEqual(clean("bell\u0007 esc\u001B del\u007F c1\u0085"), "bell esc del c1");
  });

  it("keeps ZWJ, ZWNJ, tabs and line breaks, as \\n", () => {
    const family = "👨‍👩‍👧";
    const persian = "می‌خواهم";
    assert.strictEqual(clean(family), family);
    assert.strictEqual(clean(persian), persian);
    assert.strictEqual(clean("a\tb\r\nc\rd\ne"), "a\tb\nc\nd\ne");
  });
});

describe("truncate", () => {
  it("leaves text within the bound alone", () => {
    assert.deepStrictEqual(truncate("hello", 5), { text: "hello", truncated: false });
    assert.deepStrictEqual(truncate("ééé", 6), { text: "ééé", truncated: false });
  });

  it("cuts on a character boundary, never inside one", () => {
    assert.deepStrictEqual(truncate("ééé", 5), { text: "éé", truncated: true });
    assert.deepStrictEqual(truncate("a😀b", 4), { text: "a", truncated: true });
    assert.deepStrictEqual(truncate("a😀b", 5), { text: "a😀", truncated: true });
  });
});

describe("transfer encodings", () => {
  it("decodes base64 across line breaks", () => {
    assert.strictEqual(
      utf8(transferDecode(bytes("aGVsbG8g\r\nd29ybGQ="), "base64", true)),
      "hello world"
    );
  });

  it("drops a base64 quantum a partial fetch cut", () => {
    // "aGVsbG8gd29y" is "hello wor"; "bG" is the start of the next quantum.
    assert.strictEqual(
      utf8(transferDecode(bytes("aGVsbG8g\r\nd29ybG"), "Base64", false)),
      "hello wor"
    );
  });

  it("decodes quoted-printable with soft breaks and transport padding", () => {
    const encoded = "caf=C3=A9 =\r\nau lait  \r\nnext=3Dline";
    assert.strictEqual(
      utf8(transferDecode(bytes(encoded), "quoted-printable", true)),
      "café au lait\r\nnext=line"
    );
    assert.strictEqual(
      utf8(transferDecode(bytes("50=25 =ZZ off"), "quoted-printable", true)),
      "50% =ZZ off"
    );
  });

  it("drops a quoted-printable escape a partial fetch cut", () => {
    assert.strictEqual(latin1(transferDecode(bytes("one =C"), "quoted-printable", false)), "one ");
    assert.strictEqual(latin1(transferDecode(bytes("one ="), "quoted-printable", false)), "one ");
    assert.strictEqual(latin1(transferDecode(bytes("one =\r"), "quoted-printable", false)), "one ");
  });

  it("reads 7bit, 8bit, binary and unknown encodings as they are", () => {
    for (const encoding of ["7bit", "8bit", "binary", "x-uuencode"])
      assert.strictEqual(utf8(transferDecode(bytes("plain ✓"), encoding, true)), "plain ✓");
  });
});

describe("charsets", () => {
  it("decodes the charsets mail uses", () => {
    assert.strictEqual(
      charsetDecode(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), "ISO-8859-1", true),
      "café"
    );
    assert.strictEqual(charsetDecode(Uint8Array.from([0xb1, 0xe6]), "iso-8859-2", true), "ąć");
    const sjis = Uint8Array.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
    assert.strictEqual(charsetDecode(sjis, "shift_jis", true), "こんにちは");
    const koi = Uint8Array.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]);
    assert.strictEqual(charsetDecode(koi, " koi8-r ", true), "Привет");
  });

  it("reads an unknown or missing charset as UTF-8", () => {
    assert.strictEqual(charsetDecode(bytes("naïve"), "x-unknown", true), "naïve");
    assert.strictEqual(charsetDecode(bytes("naïve"), null, true), "naïve");
    assert.strictEqual(charsetDecode(bytes("naïve"), "", true), "naïve");
  });

  it("holds back a character a partial fetch split", () => {
    const cut = bytes("héllo").subarray(0, 2);
    assert.strictEqual(charsetDecode(cut, "utf-8", false), "h");
    assert.strictEqual(charsetDecode(cut, "utf-8", true), "h�");
  });
});

describe("bodyText", () => {
  it("decodes, cleans and converts HTML", () => {
    const html = Buffer.from("<p>Hello‮ <b>there</b></p><script>steal()</script>").toString(
      "base64"
    );
    assert.deepStrictEqual(
      bodyText({
        bytes: bytes(html),
        complete: true,
        transferEncoding: "base64",
        charset: "utf-8",
        format: "html"
      }),
      { text: "Hello there", truncated: false }
    );
  });

  it("says truncated when the fetch was cut or the text is past the bound", () => {
    const source = {
      bytes: bytes("line one\r\nline two"),
      transferEncoding: "7bit",
      charset: "us-ascii",
      format: "plain" as const
    };
    assert.deepStrictEqual(bodyText({ ...source, complete: false }), {
      text: "line one\nline two",
      truncated: true
    });
    assert.deepStrictEqual(bodyText({ ...source, complete: true }, 8), {
      text: "line one",
      truncated: true
    });
  });
});
