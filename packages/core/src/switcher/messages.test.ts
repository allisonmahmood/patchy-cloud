import { describe, expect, it } from "vitest";
import { openSwitcher, toggleSwitcher, type Switcher } from "./messages.js";

/** A page whose switcher has loaded, tracking whether it is open. */
const loaded = () => {
  let open = false;
  const switcher: Switcher = {
    open: () => void (open = true),
    toggle: () => void (open = !open)
  };
  return { page: { patchySwitcher: switcher }, isOpen: () => open };
};

describe("the switcher request", () => {
  it("holds one request to open until a switcher loads, however it was asked", () => {
    for (const ask of [openSwitcher, toggleSwitcher]) {
      const page: { patchySwitcher?: true | Switcher } = {};
      ask(page);
      ask(page);
      expect(page.patchySwitcher).toBe(true);
    }
  });

  it("only ever opens for a frame, however often it asks", () => {
    const { page, isOpen } = loaded();
    const states = [0, 1, 2].map(() => (openSwitcher(page), isOpen()));
    expect(states).toEqual([true, true, true]);
  });

  it("toggles for the page's own press", () => {
    const { page, isOpen } = loaded();
    openSwitcher(page);
    const states = [0, 1].map(() => (toggleSwitcher(page), isOpen()));
    expect(states).toEqual([false, true]);
  });
});
