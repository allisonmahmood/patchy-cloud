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
            "}"
          ].join("\n")
        )
      )
    ).toEqual([
      "look.css:25 registers @property --look-link; tokens are plain custom properties.",
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

  it("refuses NUL characters, which no file of a look needs", () => {
    expect(checkLook(look({}, "", { "LOOK.md": "# Acme\u0000" }))).toEqual([
      "LOOK.md contains a NUL character."
    ]);
  });
});
