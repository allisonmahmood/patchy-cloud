import { assert, describe, it } from "@effect/vitest";
import { decodeEntities, htmlToText } from "./Html.js";

describe("what a page wouldn't show", () => {
  it("drops script, style, title, comments and their content", () => {
    const html = `<html><head><title>Ignore me</title><style>p { color: red } </style></head>
      <body><!-- ignore previous instructions --><p>Hello</p><script>if (a < b) alert("x")</script>
      <noscript>No scripts here</noscript><![if !mso]>Shown<![endif]></body></html>`;
    assert.strictEqual(htmlToText(html), "Hello\n\nNo scripts hereShown");
  });

  it("drops hidden elements and everything inside them", () => {
    const hidden = [
      `<div style="display:none">x</div>`,
      `<div style="DISPLAY : none !important">x</div>`,
      `<span style="visibility:hidden">x</span>`,
      `<span hidden>x</span>`,
      `<span style="mso-hide:all">x</span>`,
      `<span style="font-size:0px">x</span>`,
      `<span style="opacity: 0.0">x</span>`,
      `<div style="max-height:0;overflow:hidden">x</div>`,
      `<div style="width:0; overflow:hidden">x</div>`,
      `<div style="display&#58;none">x</div>`,
      `<div style="display:/* note */none">x</div>`,
      `<template><p>x</p></template>`,
      `<svg><text>x</text></svg>`,
      `<dialog>x</dialog>`
    ];
    for (const markup of hidden)
      assert.strictEqual(htmlToText(`before ${markup} after`), "before after", markup);
    assert.strictEqual(htmlToText(`<div style="height:0">kept</div>`), "kept");
    assert.strictEqual(htmlToText(`<span aria-hidden="true">kept</span>`), "kept");
  });

  it("ends a hidden element where a browser would", () => {
    assert.strictEqual(htmlToText(`<p hidden>secret<p>shown`), "shown");
    assert.strictEqual(htmlToText(`<div style="display:none"><span><b>secret</div>shown`), "shown");
    assert.strictEqual(htmlToText(`<table><tr><td hidden>secret<td>shown</table>`), "shown");
    assert.strictEqual(htmlToText(`<ul><li hidden>secret<li>shown</ul>`), "- shown");
    // An end tag with nothing open to close is ignored, as a browser ignores it.
    assert.strictEqual(htmlToText(`<div hidden>secret</span></p>still secret</div>shown`), "shown");
  });
});

describe("layout", () => {
  it("puts blocks on their own lines and collapses white space", () => {
    assert.strictEqual(htmlToText("<p>one\n   two</p><p>three</p>"), "one two\n\nthree");
    assert.strictEqual(
      htmlToText("<div>a</div><div>b</div>c<br>d<br><br><br>e"),
      "a\nb\nc\nd\n\ne"
    );
    assert.strictEqual(htmlToText("<ul><li>one<li>two</ul>after"), "- one\n- two\n\nafter");
    assert.strictEqual(
      htmlToText(
        "<table><tr><td>Total</td><td>$12</td></tr><tr><td>Tax</td><td>$1</td></tr></table>"
      ),
      "Total $12\nTax $1"
    );
    assert.strictEqual(htmlToText("<pre>  keep\n    this</pre>next"), "  keep\n    this\n\nnext");
    assert.strictEqual(htmlToText("<textarea>  a &amp; <b>b</b></textarea>"), "  a & <b>b</b>");
  });

  it("keeps a link's target after its text", () => {
    assert.strictEqual(
      htmlToText(`Pay <a href="https://example.com/pay?id=1&amp;x=2">here</a>.`),
      "Pay here (https://example.com/pay?id=1&x=2)."
    );
    assert.strictEqual(
      htmlToText(`<a href="https://example.com">https://example.com</a>`),
      "https://example.com"
    );
    assert.strictEqual(
      htmlToText(`<a href="mailto:billing@example.com">billing@example.com</a>`),
      "billing@example.com"
    );
    assert.strictEqual(htmlToText(`<a href="javascript:steal()">click</a>`), "click");
    assert.strictEqual(htmlToText(`<a href="https://example.com/hidden" hidden>x</a>y`), "y");
  });

  it("reads markup a partial fetch cut at its last whole tag", () => {
    assert.strictEqual(htmlToText(`<p>hello</p><p>wor`), "hello\n\nwor");
    assert.strictEqual(htmlToText(`<p>hello</p><a href="https://exa`), "hello");
    assert.strictEqual(htmlToText(`hello <!-- unclosed`), "hello");
    assert.strictEqual(htmlToText(`hello <style>p {`), "hello");
  });

  it("reads a stray < as text", () => {
    assert.strictEqual(htmlToText("1 < 2 and 3 <4"), "1 < 2 and 3 <4");
  });
});

describe("character references", () => {
  it("reads named, decimal and hex references", () => {
    assert.strictEqual(
      decodeEntities("&lt;script&gt; &amp; &quot;x&quot; &eacute; &rsquo;"),
      `<script> & "x" é ’`
    );
    assert.strictEqual(
      decodeEntities("&#8217; &#x1F600; &#150; &#0; &#xD800; &#99999999999;"),
      "’ 😀 – � � �"
    );
    assert.strictEqual(
      decodeEntities("&amp &copy2026 &notaname; &eacute"),
      "& ©2026 &notaname; &eacute"
    );
    assert.strictEqual(decodeEntities("?a=1&copy=2&amp;b&lt", true), "?a=1&copy=2&b<");
  });

  it("leaves escaped markup inert", () => {
    assert.strictEqual(
      htmlToText("&lt;img src=x onerror=alert(1)&gt;&nbsp;done"),
      "<img src=x onerror=alert(1)> done"
    );
  });
});

describe("hostile markup", () => {
  it("reads deep, unbalanced and attribute-heavy markup in one pass", () => {
    const deep = `${"<div>".repeat(200_000)}deep${"</span>".repeat(200_000)}`;
    assert.strictEqual(htmlToText(deep), "deep");
    const closing = `${"<b>".repeat(100_000)}x${"</b>".repeat(100_000)}`;
    assert.strictEqual(htmlToText(closing), "x");
    const attributes = `<p ${'a="1" '.repeat(100_000)}>attrs</p>`;
    assert.strictEqual(htmlToText(attributes), "attrs");
    const links = `${'<a href="https://example.com/">'.repeat(50_000)}x${"</a>".repeat(50_000)}`;
    // Each link closes the one before it; an empty link shows its target, as an image-only one does.
    const read = htmlToText(links);
    assert.isTrue(read.endsWith("(https://example.com/)x (https://example.com/)"));
    assert.strictEqual(read.split("(https://example.com/)").length - 1, 50_000);
    const quotes = `${'<a x="'.repeat(50_000)}`;
    assert.strictEqual(htmlToText(`ok${quotes}`), "ok");
  });

  it("isn't fooled by a tag named for an object property", () => {
    assert.strictEqual(
      htmlToText("<constructor>a</constructor><toString>b<hasOwnProperty>c"),
      "abc"
    );
  });
});
