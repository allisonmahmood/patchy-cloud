import { describe, expect, it } from "vitest";
import { LOOK_FIXTURES, readLookFixture } from "../../../test/look-fixtures.js";
import { checkLook, LOOK_TOKENS, type LookFiles, type LookToken } from "./look.js";

/** Patchy's colours, which pass every pair. Token n sits on line n + 3 of `look.css`. */
const passing: Record<LookToken, string> = {
  bg: "#fffdf4",
  surface: "#fffefa",
  fg: "#12110f",
  muted: "#69645a",
  link: "#093b92",
  success: "#1d7a3a",
  warning: "#8a5300",
  danger: "#b4220f",
  accent: "#1263e6",
  "accent-fg": "#fffefa",
  border: "#12110f",
  "font-body": "system-ui, sans-serif",
  "font-display": "system-ui, sans-serif",
  radius: "8px",
  space: "8px"
};

/** A look with these token declarations; anything in `after` starts on line 20. */
const look = (
  tokens: Partial<Record<string, string | undefined>> = {},
  after = "",
  files: Partial<LookFiles> = {}
): LookFiles => {
  const declarations = Object.entries({ ...passing, ...tokens })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([token, value]) => `    --look-${token}: ${value};`);
  return {
    "look.css": `@layer look {\n  :root {\n${declarations.join("\n")}\n  }\n}\n${after}`,
    "LOOK.md": "# Acme's look\n",
    ...files
  };
};

describe("checkLook", () => {
  it.each(LOOK_FIXTURES)("accepts the %s look", (name) => {
    expect(checkLook(readLookFixture(name))).toEqual([]);
  });

  it("accepts the base look every case below breaks", () => {
    expect(LOOK_TOKENS).toHaveLength(15);
    expect(checkLook(look())).toEqual([]);
  });

  it("names a token that is missing, declared twice or not one of the fifteen", () => {
    expect(
      checkLook(
        look(
          { warning: undefined, info: "#12110f" },
          "@layer look { :root { --look-accent: #000000; } }"
        )
      )
    ).toEqual([
      "look.css:17 declares --look-info, which is not a look token.",
      "look.css is missing --look-warning.",
      "look.css declares --look-accent twice, on lines 10 and 20; declare each token once."
    ]);
  });

  it("counts only tokens declared in :root directly inside @layer look, where they always apply", () => {
    expect(
      checkLook(
        look(
          {},
          [
            "@layer look {",
            "  @media (prefers-color-scheme: dark) {",
            "    :root { --look-bg: #000000; }",
            "  }",
            "  .theme { --look-fg: #ffffff; }",
            '  @property --look-link { syntax: "<color>"; inherits: true; initial-value: #000000; }',
            '  @property --\\6c ook-fg { syntax: "<color>"; inherits: true; initial-value: #fffdf4; }',
            "}"
          ].join("\n")
        )
      )
    ).toEqual([
      "look.css:25 registers @property --look-link; a look uses plain custom properties only.",
      "look.css:26 registers @property --\\6c ook-fg; a look uses plain custom properties only.",
      "look.css:22 declares --look-bg outside :root in @layer look; declare tokens only there.",
      "look.css:24 declares --look-fg outside :root in @layer look; declare tokens only there."
    ]);
  });

  it("refuses names written with backslash escapes, which honest CSS never needs", () => {
    expect(
      checkLook(
        look(
          {},
          [
            "@layer look {",
            "  :root { --\\6c ook-fg: #ffffff; }",
            '  a { background: u\\72l("https://cdn.example.com/paper.png"); }',
            '  @\\69mport "brand.css";',
            "}"
          ].join("\n")
        )
      )
    ).toEqual([
      "look.css:21 escapes --\\6c ook-fg with a backslash; write names plainly.",
      "look.css:22 escapes u\\72l with a backslash; write names plainly.",
      "look.css:23 escapes @\\69mport with a backslash; write names plainly."
    ]);
  });

  it("refuses a colour that is not an opaque #RRGGBB, and a token with no value", () => {
    expect(
      checkLook(
        look({
          bg: "#fff",
          surface: "#fffefa80",
          border: "rgb(0 0 0)",
          accent: "transparent",
          radius: ""
        })
      )
    ).toEqual([
      "look.css:3 sets --look-bg to #fff; colours must be opaque #RRGGBB.",
      "look.css:4 sets --look-surface to #fffefa80; colours must be opaque #RRGGBB.",
      "look.css:11 sets --look-accent to transparent; colours must be opaque #RRGGBB.",
      "look.css:13 sets --look-border to rgb(0 0 0); colours must be opaque #RRGGBB.",
      "look.css:16 gives --look-radius no value."
    ]);
  });

  it("refuses !important anywhere, which would beat a patch's own CSS", () => {
    expect(
      checkLook(
        look(
          { link: "#093b92 !important" },
          "@layer look { a { color: var(--look-link) !important; } }"
        )
      )
    ).toEqual([
      "look.css:7 uses !important; a patch's own CSS must always win over the look.",
      "look.css:20 uses !important; a patch's own CSS must always win over the look."
    ]);
  });

  it("refuses text below 4.5:1 on either ground, and accent-fg below 4.5:1 on accent", () => {
    expect(checkLook(look({ muted: "#7d786d", "accent-fg": "#7fb0ff" }))).toEqual([
      "--look-muted on --look-bg is 4.31:1; text colours need 4.5:1.",
      "--look-muted on --look-surface is 4.35:1; text colours need 4.5:1.",
      "--look-accent-fg on --look-accent is 2.41:1; text colours need 4.5:1."
    ]);
  });

  it("refuses any reference outside the look, keeping data: URLs", () => {
    const font = `@font-face { font-family: Brand; src: url("data:font/woff2;base64,d09GMgABAAA="); }`;
    expect(
      checkLook(
        look(
          {},
          [
            font,
            '@import "brand.css";',
            "@layer look {",
            "  body { background: url(https://cdn.example.com/paper.png); }",
            "  h1 { background: url(//cdn.example.com/rule.svg); }",
            '  hr { border-image: url("rule.svg") 2; }',
            '  main { background: image-set("https://cdn.example.com/a.png" 1x, url(data:image/png;base64,AA==) 2x); }',
            '  aside { background: -webkit-image-set("b.png" 1x); }',
            '  nav { background: image(src("c.png")); }',
            "}"
          ].join("\n"),
          {
            "logo.svg": [
              '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
              '  <defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs>',
              '  <rect fill="url(#g)" width="4" height="4"/>',
              '  <image href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/>',
              '  <image xlink:href="https://example.com/mark.png" width="4" height="4"/>',
              "  <style>@import url(https://example.com/logo.css);</style>",
              "</svg>"
            ].join("\n")
          }
        )
      )
    ).toEqual([
      'look.css:21 imports "brand.css"; a look is one self-contained file.',
      "look.css:23 references https://cdn.example.com/paper.png; every URL must be a data: URL.",
      "look.css:24 references //cdn.example.com/rule.svg; every URL must be a data: URL.",
      "look.css:25 references rule.svg; every URL must be a data: URL.",
      "look.css:26 references https://cdn.example.com/a.png; every URL must be a data: URL.",
      "look.css:27 references b.png; every URL must be a data: URL.",
      "look.css:28 references c.png; every URL must be a data: URL.",
      "logo.svg references https://example.com/mark.png; embed it as a data: URL.",
      "logo.svg references https://example.com/logo.css; embed it as a data: URL."
    ]);
  });

  it("keeps every rule inside @layer look, where unlayered patch CSS beats it", () => {
    expect(
      checkLook(
        look(
          {},
          "@layer base { a { color: red; } }\nbody { margin: 0; }\n@media print { a { color: black; } }"
        )
      )
    ).toEqual([
      "look.css:20 has @layer base outside @layer look; only @font-face may sit outside it.",
      "look.css:21 has a rule outside @layer look; only @font-face may sit outside it.",
      "look.css:22 has @media outside @layer look; only @font-face may sit outside it."
    ]);
  });

  it("accepts a leading @charset and the @layer look; statement", () => {
    const base = look();
    expect(
      checkLook({ ...base, "look.css": `@charset "utf-8";\n@layer look;\n${base["look.css"]}` })
    ).toEqual([]);
  });

  it("refuses a LOOK.md over 32 KiB, an empty one, and a look over 512 KiB", () => {
    const font = `@font-face { font-family: Brand; src: url("data:font/woff2;base64,${"A".repeat(520 * 1024)}"); }`;
    expect(checkLook(look({}, "", { "LOOK.md": "#".repeat(33 * 1024) }))).toEqual([
      "LOOK.md is 33.0 KiB; the limit is 32 KiB."
    ]);
    expect(checkLook(look({}, "", { "LOOK.md": " \n" }))).toEqual(["LOOK.md is empty."]);
    expect(checkLook(look({}, font))).toEqual([
      "The look is 520.5 KiB; the limit is 512 KiB, embedded fonts included."
    ]);
  });

  it("reads nested @supports conditions inside @layer look, and checks what they hold", () => {
    const conditional = (body: string) =>
      look(
        {},
        `@layer look {\n  @supports ((display:grid)) and (not (margin-trim:inline)) {\n${body}\n  }\n}`
      );
    expect(checkLook(conditional("    main { display: grid; }"))).toEqual([]);
    expect(
      checkLook(conditional("    body { background: url(https://cdn.example.com/paper.png); }"))
    ).toEqual([
      "look.css:22 references https://cdn.example.com/paper.png; every URL must be a data: URL."
    ]);
  });

  it("refuses CSS it cannot parse, and a logo that is not an SVG", () => {
    expect(
      checkLook(
        look({}, "@layer look { a { color red; } }", { "logo.svg": "<png>not an svg</png>" })
      )
    ).toEqual([
      "look.css:20 could not be parsed: Colon is expected.",
      "logo.svg must be one <svg> element."
    ]);
  });

  it("refuses a logo that runs script or embeds HTML", () => {
    expect(
      checkLook(
        look({}, "", {
          "logo.svg": [
            '<svg xmlns="http://www.w3.org/2000/svg" onload="go()">',
            "  <script>go()</script>",
            '  <foreignObject width="4" height="4"><p>Acme</p></foreignObject>',
            "</svg>"
          ].join("\n")
        })
      )
    ).toEqual([
      "logo.svg has an onload attribute; a logo is a picture, not a program.",
      "logo.svg has a <script>; a logo is a picture, not a program.",
      "logo.svg has a <foreignObject>; draw the logo in SVG."
    ]);
  });

  describe("reads logo.svg as strict XML, as browsers do when they show it as an image", () => {
    const logo = (svg: string) => checkLook(look({}, "", { "logo.svg": svg }));
    const xmlns = 'xmlns="http://www.w3.org/2000/svg"';
    const unnamespaced =
      'logo.svg\'s <svg> is not in the SVG namespace; set xmlns="http://www.w3.org/2000/svg" on it.';
    const malformed = (at: string, problem: string) =>
      `logo.svg:${at} is not well-formed XML (${problem}); a logo is XML, not HTML, so quote every attribute, close every tag, declare prefixes such as xmlns:xlink, and write & as &amp; and &nbsp; as &#160;. For an inline <svg> copied from a page, serialize it with new XMLSerializer().serializeToString(svg) in a browser.`;

    it.each([
      ["no xmlns", '<svg viewBox="0 0 8 8"/>', unnamespaced],
      ["an https xmlns", '<svg xmlns="https://www.w3.org/2000/svg"/>', unnamespaced],
      [
        "a space-padded xmlns",
        '<svg xmlns=" http://www.w3.org/2000/svg "/>',
        "logo.svg's xmlns has spaces around its namespace; delete them."
      ],
      [
        "a space-padded xmlns:xml",
        `<svg ${xmlns} xmlns:xml=" http://www.w3.org/XML/1998/namespace "/>`,
        "logo.svg's xmlns:xml has spaces around its namespace; delete them."
      ],
      [
        "a namespace over 256 characters",
        `<svg ${xmlns} xmlns:a="urn:${"x".repeat(300)}"/>`,
        "logo.svg's xmlns:a is longer than 256 characters; a namespace is a short URI, so shorten it."
      ],
      [
        "only xmlns:svg on an unprefixed root",
        '<svg xmlns:svg="http://www.w3.org/2000/svg"/>',
        unnamespaced
      ],
      [
        "an undeclared xlink: prefix",
        `<svg ${xmlns}><use xlink:href="#m"/></svg>`,
        malformed("1:62", 'unbound namespace prefix: "xlink"')
      ],
      [
        "&nbsp;",
        `<svg ${xmlns}><title>Acme&nbsp;Inc</title></svg>`,
        malformed("1:57", "undefined entity")
      ],
      [
        "a bare & in <title>",
        `<svg ${xmlns}><title>Smith & Co</title></svg>`,
        malformed("1:71", "unclosed tag: title")
      ],
      [
        "an unquoted attribute",
        `<svg ${xmlns} viewBox=0></svg>`,
        malformed("1:49", "unquoted attribute value")
      ],
      ["an unclosed tag", `<svg ${xmlns}><g></svg>`, malformed("1:49", "unexpected close tag")],
      [
        "a duplicate attribute",
        `<svg ${xmlns}><path fill="#000" fill="#111"/></svg>`,
        malformed("1:71", "duplicate attribute: fill")
      ],
      [
        "a <!DOCTYPE>",
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg ${xmlns}/>`,
        "logo.svg has a <!DOCTYPE>; delete it, since a logo needs none."
      ],
      [
        "an XML 1.1 declaration",
        `<?xml version="1.1"?><svg ${xmlns}/>`,
        'logo.svg declares XML 1.1; write version="1.0", which every browser reads.'
      ]
    ])("refuses %s", (_, svg, message) => {
      expect(logo(svg)).toEqual([message]);
    });

    it("refuses an inline <svg> read back from a page, and accepts it serialized as XML", () => {
      expect(
        logo(
          '<svg viewBox="0 0 120 32" class="logo"><title>Acme&nbsp;Inc</title><use xlink:href="#m"></use><path d="M0,0h10v10z" fill="#123"></path></svg>'
        )
      ).toEqual([malformed("1:56", "undefined entity")]);
      // What Chromium's XMLSerializer writes for the same element.
      expect(
        logo(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32" class="logo"><title>Acme Inc</title><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#m"/><path d="M0,0h10v10z" fill="#123"/></svg>'
        )
      ).toEqual([]);
    });

    it("accepts an XML declaration, a prefixed root, and & in comments and CDATA", () => {
      const illustrator = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!-- Generator: Adobe Illustrator 28.0.0 -->",
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 120 32">',
        "  <style>.cls-1{fill:#123}</style>",
        '  <defs><path id="m" d="M0,0h10v10z"/></defs>',
        '  <use class="cls-1" xlink:href="#m"/>',
        "</svg>"
      ].join("\n");
      expect(logo(illustrator)).toEqual([]);
      expect(
        logo(
          '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><svg:path d="M0,0h8v8z"/></svg:svg>'
        )
      ).toEqual([]);
      expect(
        logo(`<svg ${xmlns}><!-- Smith & Co --><title><![CDATA[Smith & Co]]></title></svg>`)
      ).toEqual([]);
      expect(
        logo(`<svg ${xmlns} xmlns:href="http://www.w3.org/1999/xlink" xmlns:on="urn:meta"/>`)
      ).toEqual([]);
    });

    it("matches attribute names in any case, as the HTML parser did", () => {
      expect(
        logo(
          `<svg ${xmlns}><rect STYLE="fill:url(#g)"/><image HREF="https://example.com/mark.png"/></svg>`
        )
      ).toEqual(["logo.svg references https://example.com/mark.png; embed it as a data: URL."]);
    });

    it("refuses an attribute with url( that does not read as CSS, rather than crashing on it", () => {
      expect(
        logo(
          [
            `<svg ${xmlns}>`,
            '<g aria-label="a url(x) b ;}"/>',
            `<g data-name='url("a" b'/>`,
            '<g fill="url(x)) {"/>',
            // Brackets nested past the stack, which css-tree could otherwise read.
            `<g fill="url(#g) ${"(".repeat(20_000)}${")".repeat(20_000)}"/>`,
            "</svg>"
          ].join("")
        )
      ).toEqual(
        ["aria-label", "data-name", "fill", "fill"].map(
          (name) =>
            `logo.svg's ${name} has url( but does not read as CSS, so what it points at cannot be checked; take the url( out, or write plain CSS such as url(#paint).`
        )
      );
    });

    it("checks a <style>'s CDATA like its text", () => {
      expect(
        logo(
          `<svg ${xmlns}><style><![CDATA[@import url(https://example.com/logo.css);]]></style></svg>`
        )
      ).toEqual(["logo.svg references https://example.com/logo.css; embed it as a data: URL."]);
    });
    it("refuses a logo nested more than 64 deep, and parses no logo past the size limit", () => {
      const nested = (depth: number) =>
        `<svg ${xmlns}>${"<g>".repeat(depth - 1)}${"</g>".repeat(depth - 1)}</svg>`;
      expect(logo(nested(64))).toEqual([]);
      expect(logo(nested(65))).toEqual([
        "logo.svg nests elements more than 64 deep; flatten its groups."
      ]);
      expect(logo(`<svg>${"&".repeat(513 * 1024)}`)).toEqual([
        "The look is 513.5 KiB; the limit is 512 KiB, embedded fonts included."
      ]);
    });
  });

  it("refuses NUL characters, which no file of a look needs", () => {
    expect(checkLook(look({}, "", { "LOOK.md": "# Acme\u0000" }))).toEqual([
      "LOOK.md contains a NUL character."
    ]);
  });
});
