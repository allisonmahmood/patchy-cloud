import * as parse5 from "parse5";
import { describe, expect, it } from "vitest";
import { documentTitle, headStart } from "./html-policy.js";

/** A page's title is read under the parser's bounds: within them it reads, past one it is null. */
const titled = (markup: string) => documentTitle(`<title>Bounded</title>${markup}`);

describe("documentTitle", () => {
  it("bounds how deep a page nests, counting its implied <html> and <body>", () => {
    expect(titled("<div>".repeat(510))).toBe("Bounded");
    expect(titled("<div>".repeat(511))).toBeNull();
  });

  it("bounds the attributes on an element", () => {
    const attributes = (count: number) =>
      Array.from({ length: count }, (_, index) => ` a${index}`).join("");

    expect(titled(`<div${attributes(256)}>`)).toBe("Bounded");
    expect(titled(`<div${attributes(257)}>`)).toBeNull();
    expect(titled(`</div${attributes(257)}>`)).toBeNull();
    // A repeated <body> tag adds its attributes to the first.
    expect(
      titled(Array.from({ length: 300 }, (_, index) => `<body a${index}>`).join(""))
    ).toBeNull();
  });

  it("bounds the repair of misnested markup", () => {
    // Table content outside a cell moves to just before the table, which is cheap.
    expect(titled(`<table>${"stray<br>".repeat(6000)}</table>`)).toBe("Bounded");
    // Closing <b> early moves every child of the block it crosses, front first.
    expect(titled(`<b><div>${"<br>".repeat(600)}</b>`)).toBe("Bounded");
    expect(titled(`<b><div>${"<br>".repeat(6000)}</b>`)).toBeNull();
    // Formatting left open across paragraphs is cloned into each; distinct attributes defeat the
    // parser's own cap of three alike, so each "x<p>" clones all 500.
    const open = Array.from({ length: 500 }, (_, index) => `<b a=${index}>`).join("");
    expect(titled(`<p>${open}${"x<p>".repeat(100)}`)).toBe("Bounded");
    expect(titled(`<p>${open}${"x<p>".repeat(2000)}`)).toBeNull();
    // One clone carries the whole attribute again, so a long one counts once per clone.
    const long = `<p><b title="${"x".repeat(8000)}">`;
    expect(titled(`${long}${"x<p>".repeat(100)}`)).toBe("Bounded");
    expect(titled(`${long}${"x<p>".repeat(2200)}`)).toBeNull();
  });

  it("reads the title a browser shows: the first HTML one, at any depth", () => {
    expect(
      documentTitle("<svg><title>Icon</title></svg><title> Launch queue </title><script>1</script>")
    ).toBe("Launch queue");
    expect(documentTitle("<svg><title>Icon</title></svg><script>1</script>")).toBeNull();
    expect(documentTitle("<title> </title><title>Second</title>")).toBeNull();
    expect(documentTitle(`${"<b>".repeat(500)}<title>Deep</title>`)).toBe("Deep");
  });

  it("reads a long page's title only when the read limit leaves it whole", () => {
    const limit = 64 * 1024;
    const title = "<title>Fish &amp; chips</title>";
    expect(documentTitle(`${title}<script>${" ".repeat(limit)}</script>`)).toBe("Fish & chips");
    expect(documentTitle(`${" ".repeat(limit - 15)}${title}`)).toBeNull();
  });
});

describe("headStart", () => {
  const marker = "<script>marker</script>";
  type Element = parse5.DefaultTreeAdapterMap["element"];
  const child = (parent: parse5.DefaultTreeAdapterMap["parentNode"], name: string) =>
    parent.childNodes.find((node): node is Element => node.nodeName === name)!;
  /** How a browser reads a document: its decoder takes the byte order mark. */
  const read = (html: string) => {
    const document = parse5.parse(html.replace(/^\u{FEFF}/u, ""));
    const root = child(document, "html");
    const head = child(root, "head");
    return { mode: document.mode, root: root.attrs, head: head.attrs, first: head.childNodes[0] };
  };

  it.each([
    [
      "an explicit head, keeping its attributes",
      '<!doctype html><html lang="en"><head data-theme="dark"><title>t</title></head>'
    ],
    [
      "a head tag split across lines",
      '<!doctype html>\n<HEAD\n  data-a="<x>">\n<meta charset="utf-8">'
    ],
    ["a self-closed head", "<html><head/>text"],
    [
      "a byte order mark, comments and whitespace",
      '\u{FEFF}\n<!-- licence -->\n<!doctype html>\n<!-- x -->\n<html lang="fr">\n<!-- y -->\n<head>'
    ],
    ["no head", '<!doctype html><html lang="en"><title>t</title><body>b</body>'],
    ["no head, opened by text", "<!doctype html>hello"],
    ["no head, opened by a table", "<!doctype html><table>x<tr>"],
    ["no head, closed before it opens", "<!doctype html></head><!-- c --><p>p"],
    ["no html or head", "<!doctype html><meta charset=utf-8><p>p"],
    [
      "a head tag after content, which the parser ignores",
      '<!doctype html><title>t</title><head data-late="1">'
    ],
    ["no doctype", '<html lang="en"><body>quirks</body>'],
    ["only a doctype", "<!doctype html>"],
    ["only an html tag", '<!doctype html><html lang="en">'],
    ["nothing", ""],
    ["a byte order mark alone", "\u{FEFF}"],
    ["a finished comment at the end", "<!doctype html><!-- done -->"],
    ["an unfinished comment", "<!doctype html><!-- unfinished"],
    ["an unfinished comment that nearly closes", "<!doctype html><!-- unfinished ->"],
    ["an unfinished bogus comment", "<!doctype html><?xml version"],
    ["an unfinished root tag", '<!doctype html><html lang="en"'],
    ["an unfinished attribute value", '<!doctype html><html lang="en'],
    ["an unfinished head tag after a comment", '<!doctype html><!-- c --><head data-x="y'],
    ["an unfinished doctype", "<!doctype html"],
    ["a lone angle bracket", "<!doctype html><"]
  ])("puts markup first in the head, and changes nothing else: %s", (_, html) => {
    const at = headStart(html);
    const before = read(html);
    const after = read(html.slice(0, at) + marker + html.slice(at));
    expect(after.mode).toBe(before.mode);
    expect(after.root).toEqual(before.root);
    expect(after.head).toEqual(before.head);
    expect(after.first).toMatchObject({ nodeName: "script", childNodes: [{ value: "marker" }] });
  });

  it("reads no further than the head", () => {
    // Past the head, markup over the bounds is the page's own business.
    expect(headStart(`<!doctype html><head><title>t</title>${"<div>".repeat(600)}`)).toBe(21);
  });

  it("falls back to just past the doctype when the start of the page is over the bounds", () => {
    const attributes = Array.from({ length: 300 }, (_, index) => ` a${index}`).join("");
    expect(headStart(`\u{FEFF}<!doctype html><html${attributes}><head>`)).toBe(16);
    expect(headStart(`<html${attributes}><head>`)).toBe(0);
  });
});
