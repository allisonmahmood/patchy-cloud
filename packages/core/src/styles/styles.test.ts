import { describe, expect, it } from "vitest";
import { appStyles, chunks } from "./index.js";
import { offTokens } from "./rules.js";
import { tokens } from "./tokens.js";

describe("the app's stylesheet", () => {
  it("is its chunks in order, fonts and tokens first", () => {
    expect(appStyles).toBe(Object.values(chunks).join(""));
    expect(Object.keys(chunks).slice(0, 2)).toEqual(["fonts", "tokens"]);
  });

  it("names only tokens it defines, so a typo can't fall back to nothing", () => {
    const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+):/g)].map(([, name]) => name));
    const used = new Set([...appStyles.matchAll(/var\((--[a-z0-9-]+)/g)].map(([, name]) => name));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it("draws every colour, type role, corner, shadow and control height from the token block", () => {
    // Fonts hold the fallback faces' metrics, and tokens is the block itself.
    const checked = Object.entries(chunks).filter(
      ([chunk]) => chunk !== "fonts" && chunk !== "tokens"
    );
    const found = checked.flatMap(([chunk, css]) =>
      offTokens(css).map(
        ({ selector, property, value, role }) =>
          `${chunk}: ${selector} { ${property}: ${value} } is a ${role}`
      )
    );
    expect(found, "pnpm ui:report lists these; draw each from a token").toEqual([]);
  });

  it("never fixes a background to the window, so scrolling repaints nothing", () => {
    expect(appStyles).not.toMatch(/background(-attachment)?:[^;}]*\bfixed\b/);
  });

  it("sets nothing in capitals", () => {
    expect(appStyles).not.toMatch(/text-transform:\s*uppercase/);
  });
});
