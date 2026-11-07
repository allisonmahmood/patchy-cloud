import { assert, describe, it } from "@effect/vitest";
import {
  bodyText,
  charsetDecode,
  clean,
  displayText,
  transferDecode,
  truncate,
  type TextSource
} from "./Text.js";

const bytes = (text: string, encoding: BufferEncoding = "utf8") => Buffer.from(text, encoding);
const latin1 = (data: Uint8Array) => Buffer.from(data).toString("latin1");
const utf8 = (data: Uint8Array) => Buffer.from(data).toString("utf8");

describe("clean", () => {
  it("strips tag characters, bidi controls and other invisibles", () => {
    const tagged = "Pay\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045} now";
    assert.strictEqual(clean(tagged), "Pay now");
    assert.strictEqual(
      clean("abc\u{202E}dcba\u{202C} \u{2066}x\u{2069} \u{200F}y\u{200E}"),
      "abcdcba x y"
    );
    assert.strictEqual(clean("zero\u{200B}width\u{2060}\u{FEFF}"), "zerowidth");
    assert.strictEqual(clean("bell\u0007 esc\u001B del\u007F c1\u0085"), "bell esc del c1");
  });

  it("keeps ZWJ, ZWNJ, tabs and line breaks, as \\n", () => {
    const family = "👨\u{200D}👩\u{200D}👧";
    const persian = "می\u{200C}خواهم";
    assert.strictEqual(clean(family), family);
    assert.strictEqual(clean(persian), persian);
    assert.strictEqual(clean("a\tb\r\nc\rd\ne"), "a\tb\nc\nd\ne");
  });
});

describe("displayText", () => {
  it("puts a header value on one line, cleaned and bounded, or null", () => {
    assert.strictEqual(
      displayText("  Re:\r\n\tquarterly\u{202E} numbers  ", 100),
      "Re: quarterly numbers"
    );
    assert.strictEqual(displayText("ééé", 2), "éé");
    assert.strictEqual(displayText("a 😀😀", 3), "a 😀");
    assert.isNull(displayText(" \u{200B} ", 10));
    assert.isNull(displayText(undefined, 10));
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
    // Every label WHATWG reads as windows-1252: 0x80 to 0x9F are characters, not C1 controls,
    // except the five it leaves undefined.
    for (const charset of ["windows-1252", "iso-8859-1", "latin1"])
      assert.strictEqual(
        charsetDecode(Uint8Array.from([0x93, 0x80, 0x35, 0x81, 0x94]), charset, true),
        "\u{201C}\u{20AC}5\u{81}\u{201D}"
      );
  });

  it("reads an unknown or missing charset as UTF-8, else latin1", () => {
    for (const charset of ["x-unknown", "utf-7", null, ""]) {
      assert.strictEqual(charsetDecode(bytes("naïve"), charset, true), "naïve");
      assert.strictEqual(
        charsetDecode(Uint8Array.from([0x6e, 0x61, 0xef, 0x76, 0x65]), charset, true),
        "naïve"
      );
    }
    // windows-1252, as WHATWG reads latin1: 0x93 and 0x94 are curly quotes.
    assert.strictEqual(
      charsetDecode(Uint8Array.from([0x93, 0x68, 0x69, 0x94]), null, true),
      "\u{201C}hi\u{201D}"
    );
    // A declared charset wins, even over bytes that would read as UTF-8.
    assert.strictEqual(charsetDecode(bytes("é"), "iso-8859-1", true), "Ã©");
  });

  it("reads US-ASCII over 8-bit bytes as if it named no charset", () => {
    // ASCII can't hold an 8-bit byte, so the label isn't the truth: UTF-8 where it reads, else latin1.
    assert.strictEqual(charsetDecode(bytes("naïve"), "us-ascii", true), "naïve");
    assert.strictEqual(charsetDecode(Uint8Array.from([0x6e, 0xef]), "US-ASCII", true), "nï");
    assert.strictEqual(charsetDecode(bytes("plain"), "us-ascii", true), "plain");
  });

  it("holds back a UTF-8 character a cut split when no charset is named", () => {
    assert.strictEqual(charsetDecode(bytes("héllo").subarray(0, 2), null, false), "h");
  });

  it("holds back a character a partial fetch split", () => {
    const cut = bytes("héllo").subarray(0, 2);
    assert.strictEqual(charsetDecode(cut, "utf-8", false), "h");
    assert.strictEqual(charsetDecode(cut, "utf-8", true), "h�");
  });
});

describe("bodyText", () => {
  const source = (text: string, extra: Partial<TextSource> = {}): TextSource => ({
    bytes: bytes(text),
    complete: true,
    transferEncoding: "7bit",
    charset: "utf-8",
    format: "plain",
    ...extra
  });

  it("decodes, cleans and converts HTML", () => {
    const html = Buffer.from("<p>Hello\u{202E} <b>there</b></p><script>steal()</script>").toString(
      "base64"
    );
    assert.deepStrictEqual(
      bodyText([source(html, { transferEncoding: "base64", format: "html" })]),
      {
        text: "Hello there",
        truncated: false
      }
    );
  });

  it("joins several parts with a blank line, skipping empty ones", () => {
    const parts = [
      source("Here is the photo:\r\n\r\n"),
      source("   \r\n"),
      source("<p>And the <b>receipt</b>.</p>", { format: "html" }),
      source("\r\n\r\n    indented sign-off\r\n")
    ];
    assert.deepStrictEqual(bodyText(parts), {
      text: "Here is the photo:\n\nAnd the receipt.\n\n    indented sign-off",
      truncated: false
    });
  });

  it("says truncated when a fetch was cut or the text is past the bound", () => {
    const lines = source("line one\r\nline two", { charset: "us-ascii" });
    assert.deepStrictEqual(bodyText([lines, { ...lines, complete: false }]), {
      text: "line one\nline two\n\nline one\nline two",
      truncated: true
    });
    assert.deepStrictEqual(bodyText([lines, source("second")], 8), {
      text: "line one",
      truncated: true
    });
  });
});
