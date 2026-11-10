import { describe, expect, it } from "vitest";
import { appStyles, chunks } from "./index.js";
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

  it("sets nothing in capitals", () => {
    expect(appStyles).not.toMatch(/text-transform:\s*uppercase/);
  });
});
