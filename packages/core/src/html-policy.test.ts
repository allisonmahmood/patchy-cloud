import { describe, expect, it } from "vitest";
import { readFixtureCorpus } from "../../../test/html-fixtures.mjs";
import { BLOCKED_PROTOCOLS, BLOCKED_TAGS, documentTitle, validateHtml } from "./html-policy.js";

type BlockedTag = (typeof BLOCKED_TAGS)[number];
type Scheme<Protocol> = Protocol extends `${infer Name}:` ? Name : never;
type BlockedScheme = Scheme<(typeof BLOCKED_PROTOCOLS)[number]>;

/** Adding a blocked tag or protocol fails typecheck until it has a reject fixture. */
type RequiredRejectFixtures = Record<
  `blocked-tag-${BlockedTag}.html` | `blocked-protocol-${BlockedScheme}.html`,
  readonly string[]
> &
  Readonly<Record<string, readonly string[]>>;

const expectedErrorsByRejectFixture: Readonly<Record<string, readonly string[]>> = {
  "blocked-protocol-file.html": ['Blocked unsafe URL in "href" attribute.'],
  "blocked-protocol-javascript.html": ['Blocked unsafe URL in "href" attribute.'],
  "blocked-protocol-vbscript.html": ['Blocked unsafe URL in "href" attribute.'],
  "blocked-tag-applet.html": ["Blocked <applet> tag found."],
  "blocked-tag-base.html": ["Blocked <base> tag found."],
  "blocked-tag-embed.html": ["Blocked <embed> tag found."],
  "blocked-tag-form.html": ["Blocked <form> tag found."],
  "blocked-tag-iframe.html": ["Blocked <iframe> tag found."],
  "blocked-tag-link.html": ["Blocked <link> tag found."],
  "blocked-tag-object.html": ["Blocked <object> tag found."],
  "blocked-tag-script.html": ["Blocked <script> tag found."],
  "inline-event-handler.html": ['Blocked inline event handler attribute "onclick" found.'],
  "meta-refresh.html": ["Blocked meta refresh tag found."],
  "noscript-blocked-tag.html": ["Blocked <form> tag found."],
  "srcdoc-attribute.html": ['Blocked "srcdoc" attribute found.'],
  "unsafe-inline-css.html": ["Blocked unsafe inline CSS."]
} satisfies RequiredRejectFixtures;

const fontWarning = (source: string) =>
  `@font-face source "${source}" won't load: static pages load fonts only from data: URLs. Embed the font as a data: URL or use a system font stack.`;
const importWarning = (target: string) =>
  `@import "${target}" won't load: static pages can't load other stylesheets. Inline its CSS, with any fonts embedded as data: URLs.`;

const expectedWarningsByAcceptFixture: Readonly<Record<string, readonly string[]>> = {
  "embedded-font.html": [],
  "portfolio.html": [],
  "project-status.html": [],
  "remote-font.html": [fontWarning("https://example.test/remote.woff2")],
  "remote-image.html": []
};

const acceptFixtures = await readFixtureCorpus("accept");
const rejectFixtures = await readFixtureCorpus("reject");

describe("validateHtml", () => {
  it("defines exact warnings for every accept fixture", () => {
    expect(Object.keys(expectedWarningsByAcceptFixture).sort()).toEqual(
      acceptFixtures.map(({ filename }) => filename)
    );
  });

  it.each(acceptFixtures)("accepts $filename with its specified warnings", ({ filename, html }) => {
    const expectedWarnings = expectedWarningsByAcceptFixture[filename];
    if (!expectedWarnings) {
      throw new Error(`Missing expected warnings for ${filename}.`);
    }

    expect(validateHtml(html)).toMatchObject({ ok: true, warnings: expectedWarnings });
  });

  it("defines exact errors for every reject fixture", () => {
    expect(Object.keys(expectedErrorsByRejectFixture).sort()).toEqual(
      rejectFixtures.map(({ filename }) => filename)
    );
  });

  it.each(rejectFixtures)("rejects $filename for its specified reason", ({ filename, html }) => {
    const expectedErrors = expectedErrorsByRejectFixture[filename];
    if (!expectedErrors) {
      throw new Error(`Missing expected errors for ${filename}.`);
    }

    expect(validateHtml(html).errors).toEqual(expectedErrors);
  });

  it("rejects a document over the size limit without parsing it", () => {
    expect(validateHtml("<div>".repeat(1000), { maxBytes: 1024 }).errors).toEqual([
      "HTML document is 5000 bytes; maximum is 1024 bytes."
    ]);
  });

  it("bounds how deep a document nests, counting its implied <html> and <body>", () => {
    expect(validateHtml("<div>".repeat(510)).ok).toBe(true);
    expect(validateHtml("<div>".repeat(511)).errors).toEqual([
      "HTML nests elements more than 512 deep."
    ]);
  });

  it("bounds the attributes on an element", () => {
    const attributes = (count: number) =>
      Array.from({ length: count }, (_, index) => ` a${index}`).join("");
    const tooMany = ["An element has more than 256 attributes."];

    expect(validateHtml(`<div${attributes(256)}>`).ok).toBe(true);
    expect(validateHtml(`<div${attributes(257)}>`).errors).toEqual(tooMany);
    expect(validateHtml(`</div${attributes(257)}>`).errors).toEqual(tooMany);
    // A repeated <body> tag adds its attributes to the first.
    expect(
      validateHtml(Array.from({ length: 300 }, (_, index) => `<body a${index}>`).join("")).errors
    ).toEqual(tooMany);
  });

  it("bounds the repair of misnested markup", () => {
    const tooMuch = [
      "HTML needs too much repair to check: close elements in the order they were opened, and keep table content inside cells."
    ];

    // Table content outside a cell moves to just before the table, which is cheap.
    expect(validateHtml(`<table>${"stray<br>".repeat(6000)}</table>`).ok).toBe(true);
    // Closing <b> early moves every child of the block it crosses, front first.
    expect(validateHtml(`<b><div>${"<br>".repeat(600)}</b>`).ok).toBe(true);
    expect(validateHtml(`<b><div>${"<br>".repeat(6000)}</b>`).errors).toEqual(tooMuch);
    // Formatting left open across paragraphs is cloned into each; distinct attributes defeat the
    // parser's own cap of three alike, so each "x<p>" clones all 500.
    const open = Array.from({ length: 500 }, (_, index) => `<b a=${index}>`).join("");
    expect(validateHtml(`<p>${open}${"x<p>".repeat(100)}`).ok).toBe(true);
    expect(validateHtml(`<p>${open}${"x<p>".repeat(2000)}`).errors).toEqual(tooMuch);
    // One clone carries the whole attribute again, so a long one counts once per clone.
    const long = `<p><b title="${"x".repeat(8000)}">`;
    expect(validateHtml(`${long}${"x<p>".repeat(100)}`).ok).toBe(true);
    expect(validateHtml(`${long}${"x<p>".repeat(2200)}`).errors).toEqual(tooMuch);
  });

  it("warns when title is missing", () => {
    const result = validateHtml("<main>No title</main>");

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("No <title> found; Patchy Cloud will use a generic title.");
  });

  it("warns about each @font-face source that isn't a data: URL, wherever the rule sits", () => {
    const result = validateHtml(`<title>Fonts</title>
      <style>
        @font-face { src: local("Inter"), url(https://example.test/a.woff2) format("woff2"); }
        @media print { @font-face { src: url(fonts/b.woff2); } }
        @supports (display: grid) { @font-face { src: url(//example.test/c.woff2); } }
      </style>
      <svg><style>@font-face { src: url(https://example.test/d.woff2); }</style></svg>`);

    expect(result).toMatchObject({
      ok: true,
      warnings: [
        fontWarning("https://example.test/a.woff2"),
        fontWarning("fonts/b.woff2"),
        fontWarning("//example.test/c.woff2"),
        fontWarning("https://example.test/d.woff2")
      ]
    });
  });

  it("warns about every @import, naming its target", () => {
    const result = validateHtml(`<title>Imports</title>
      <style>@import url("https://example.test/a.css"); @import "https://example.test/b.css";</style>`);

    expect(result).toMatchObject({
      ok: true,
      warnings: [
        importWarning("https://example.test/a.css"),
        importWarning("https://example.test/b.css")
      ]
    });
  });

  it("does not warn about embedded fonts, other URLs or template content", () => {
    const result = validateHtml(`<title>Quiet</title>
      <style>
        @font-face { src: url("DATA:font/woff2;base64,AA") format("woff2"); }
        @font-face { src: url("  data:font/woff2;base64,AA"), url(#glyphs), local("Inter"); }
        body { background-image: url(https://example.test/texture.png); }
      </style>
      <template><style>@import "https://example.test/a.css";</style></template>`);

    expect(result).toMatchObject({ ok: true, warnings: [] });
  });

  it("accepts CSS too deeply nested to read", () => {
    expect(
      validateHtml(`<title>Deep</title><style>${"@media{".repeat(5_000)}</style>`)
    ).toMatchObject({ ok: true, warnings: [] });
  });

  it("reads the title a browser shows: the first HTML one, at any depth", () => {
    expect(
      documentTitle("<svg><title>Icon</title></svg><title> Launch queue </title><script>1</script>")
    ).toBe("Launch queue");
    expect(documentTitle("<svg><title>Icon</title></svg><script>1</script>")).toBeNull();
    expect(documentTitle("<title> </title><title>Second</title>")).toBeNull();
    expect(documentTitle(`${"<b>".repeat(500)}<title>Deep</title>`)).toBe("Deep");
  });

  it("gives up on a bundle's title past the bounds a static page is held to", () => {
    expect(documentTitle(`${"<b>".repeat(600)}<title>Deep</title>`)).toBeNull();
    const open = Array.from({ length: 500 }, (_, index) => `<b a=${index}>`).join("");
    expect(documentTitle(`<title>Clones</title><p>${open}${"x<p>".repeat(2000)}`)).toBeNull();
  });

  it("reads a long bundle's title only when the read limit leaves it whole", () => {
    const limit = 64 * 1024;
    const title = "<title>Fish &amp; chips</title>";
    expect(documentTitle(`${title}<script>${" ".repeat(limit)}</script>`)).toBe("Fish & chips");
    expect(documentTitle(`${" ".repeat(limit - 15)}${title}`)).toBeNull();
  });
});
