import { describe, expect, it } from "vitest";
import { documentTitle } from "./html-policy.js";

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
