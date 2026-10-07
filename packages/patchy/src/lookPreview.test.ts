import { describe, expect, it } from "vitest";
import { forceStates } from "./lookPreview.js";

describe("forceStates", () => {
  it("swaps each hover and focus pseudo-class in place for itself or its stand-in class", () => {
    const css = `@layer look {
  button:hover:not(:disabled) { background: red; }
  a:hover, a:visited { color: blue; }
  @media (hover: hover) { input:focus { border-color: green; } }
  :focus-visible { outline: 2px solid; }
  p { margin: 0; }
}`;
    expect(forceStates(css)).toBe(`@layer look {
  button:is(:hover, .specimen-hover):not(:disabled) { background: red; }
  a:is(:hover, .specimen-hover), a:visited { color: blue; }
  @media (hover: hover) { input:is(:focus, .specimen-focus) { border-color: green; } }
  :is(:focus-visible, .specimen-focus) { outline: 2px solid; }
  p { margin: 0; }
}`);
  });

  // Each of these misrendered when the stand-in joined the rule as a separate selector.
  it("reaches inside :not() and :is(), so a stand-in matches exactly what the state would", () => {
    expect(forceStates("button:not(:hover) { opacity: 0.5; }")).toBe(
      "button:not(:is(:hover, .specimen-hover)) { opacity: 0.5; }"
    );
    expect(forceStates("button:is(:hover) { color: red; }")).toBe(
      "button:is(:is(:hover, .specimen-hover)) { color: red; }"
    );
    // Keyboard focus matches both, so the stand-in keeps its ring.
    expect(forceStates("input:focus:not(:focus-visible) { outline: none; }")).toBe(
      "input:is(:focus, .specimen-focus):not(:is(:focus-visible, .specimen-focus)) { outline: none; }"
    );
  });
});
