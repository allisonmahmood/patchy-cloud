import { describe, expect, it } from "vitest";
import { declarations, offTokens } from "./rules.js";

const roles = (css: string) => offTokens(css).map((finding) => finding.role);

describe("the stylesheet's rule", () => {
  it("reads each declaration under its selector, through media and supports blocks", () => {
    expect(
      declarations(
        "/* a, b { color: red } */ .a, .b { color: var(--ink); } @media (max-width: 639px) { @supports (x: y) { .c { gap: 4px } } }"
      )
    ).toEqual([
      { selector: ".a, .b", property: "color", value: "var(--ink)" },
      { selector: ".c", property: "gap", value: "4px" }
    ]);
  });

  it("refuses a colour written by hand, wherever it is written", () => {
    expect(
      roles(
        ".a { color: #12110f; } .b { background: rgba(18, 17, 15, .05); } .c { border: 1px solid white; } .d { box-shadow: inset 0 0 0 1px hsl(0 0% 0%); }"
      )
    ).toEqual(["colour", "colour", "colour", "colour"]);
    expect(
      roles(
        '.a { color: var(--ink); background: transparent; border-color: currentColor; } .b { border: 1px solid color-mix(in srgb, var(--ink) 18%, transparent); } .c::before { content: "red"; }'
      )
    ).toEqual([]);
  });

  it("refuses type written by hand, and takes the tokens", () => {
    expect(
      roles(
        '.a { font-size: 13px; } .b { font-weight: 600; } .c { line-height: 20px; } .d { font: 600 11px/1 system-ui; } .e { font-family: monospace; } .f { font-weight: bold; } .g { font-family: "Comic Sans MS"; } .h { font: caption; }'
      )
    ).toEqual(["type", "type", "type", "type", "type", "type", "type", "type"]);
    expect(
      roles(
        ".a { font: var(--text-meta); font-weight: var(--weight-medium); line-height: var(--line-body); } .b { font-family: var(--font-mono); font-size: inherit; }"
      )
    ).toEqual([]);
  });

  it("refuses a corner or a shadow written by hand, but not a ring with no offset", () => {
    expect(
      roles(
        ".a { border-radius: 8px; } .b { border-top-left-radius: 4px; } .c { box-shadow: 3px 3px 0 var(--ink); }"
      )
    ).toEqual(["radius", "radius", "shadow"]);
    // A token beside a corner written by hand still writes that corner by hand.
    expect(
      roles(
        ".a { border-radius: var(--r-modal) 40px; } .b { border-radius: 4px / 2vh; } .c { border-radius: calc(40px); }"
      )
    ).toEqual(["radius", "radius", "radius"]);
    expect(
      roles(
        ".a { border-radius: var(--r-control); } .b { border-radius: 50%; } .c { border-radius: 0 0 var(--r-modal) var(--r-modal); } .d { border-radius: calc(var(--r-control) + 2px); } .e { box-shadow: var(--float); } .f { box-shadow: inset 0 0 0 1px var(--danger); } .g { box-shadow: none; }"
      )
    ).toEqual([]);
  });

  it("holds a control's height to the tokens, so a coarse pointer raises it, and leaves rows alone", () => {
    expect(
      roles(
        ".btn { min-height: 38px; } textarea.field { min-height: 92px; } .seg a { min-height: 28px; } .x .field-group > input { height: 2rem; } .chip { min-height: 5vh; } .btn-sm { min-height: min(38px, 44px); } .menu-item { min-height: 38px!important; }"
      )
    ).toEqual(Array.from({ length: 7 }, () => "control height"));
    expect(
      roles(
        ".btn { min-height: var(--h-control); } .field-group > input { min-height: calc(var(--h-control) - 2px); } .table th { height: 36px; } .card-foot { min-height: 52px; } .tile-option > input { height: 1px; } .btn svg { height: 16px; }"
      )
    ).toEqual([]);
  });

  it("lets drawings keep their own size, corners and letters, but never their own colour or shadow", () => {
    expect(
      roles(
        ".mono { width: 28px; height: 28px; border-radius: 7px; font: 600 11px/1 var(--font-ui); } .app-account .avatar { font-size: 10px; } kbd { border-radius: 4px; } .dot::before { height: 8px; border-radius: 50%; }"
      )
    ).toEqual([]);
    expect(
      roles(
        ".avatar { box-shadow: inset 0 0 0 1px rgba(18, 17, 15, .18); } .glyph-sm { box-shadow: 1.5px 1.5px 0 var(--ink); }"
      )
    ).toEqual(["colour", "shadow"]);
    // A list is a drawing only when every selector in it is one.
    expect(roles(".mono, .title { font-size: 17px; }")).toEqual(["type"]);
  });
});
