import { describe, expect, it } from "vitest";
import { forceStates } from "./lookPreview.js";

describe("forceStates", () => {
  it("lets the states row's stand-in classes match :hover, :focus and :focus-visible rules", () => {
    const css = `@layer look {
  button:hover:not(:disabled) { background: red; }
  a:hover, a:visited { color: blue; }
  @media (hover: hover) { input:focus { border-color: green; } }
  :focus-visible { outline: 2px solid; }
  li:not(:hover) { opacity: 0.5; }
  p { margin: 0; }
}`;
    expect(forceStates(css)).toBe(`@layer look {
  button:hover:not(:disabled), button.specimen-hover:not(:disabled) { background: red; }
  a:hover, a:visited, a.specimen-hover { color: blue; }
  @media (hover: hover) { input:focus, input.specimen-focus { border-color: green; } }
  :focus-visible, .specimen-focus { outline: 2px solid; }
  li:not(:hover) { opacity: 0.5; }
  p { margin: 0; }
}`);
  });
});
