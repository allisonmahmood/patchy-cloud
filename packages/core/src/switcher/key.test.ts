import { matchesKeyboardEvent } from "@tanstack/hotkeys";
import { describe, expect, it } from "vitest";
import { activates, claims, platformOf, type Platform, type Press } from "./key.js";

/** A trusted press with nothing held; `altGraph` is what `getModifierState("AltGraph")` reads. */
const press = (
  fields: Partial<Omit<Press, "getModifierState">> & { altGraph?: boolean }
): Press => {
  const { altGraph = false, ...rest } = fields;
  return {
    isTrusted: true,
    key: "k",
    code: "KeyK",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 75,
    getModifierState: (key) => key === "AltGraph" && altGraph,
    ...rest
  };
};

const mod = (platform: Platform) => (platform === "mac" ? { metaKey: true } : { ctrlKey: true });
const platforms = ["mac", "windows", "linux"] as const;

/** Every press either matcher could plausibly disagree on, on every platform. */
const presses = platforms.flatMap((platform) =>
  Object.entries({
    "US K": press({ ...mod(platform), shiftKey: true, key: "K" }),
    "lowercase k": press({ ...mod(platform), shiftKey: true }),
    "K on another key (Dvorak)": press({
      ...mod(platform),
      shiftKey: true,
      key: "K",
      code: "KeyV"
    }),
    "J on the K key (remapped)": press({ ...mod(platform), shiftKey: true, key: "J" }),
    "Cyrillic Л": press({ ...mod(platform), shiftKey: true, key: "Л" }),
    "Cyrillic л on another key": press({
      ...mod(platform),
      shiftKey: true,
      key: "л",
      code: "KeyL"
    }),
    "AZERTY K": press({ ...mod(platform), shiftKey: true, key: "K", keyCode: 75 }),
    "AZERTY digit row": press({ ...mod(platform), shiftKey: true, key: "&", code: "Digit1" }),
    "a symbol on the K key": press({ ...mod(platform), shiftKey: true, key: "<" }),
    "accented Latin on the K key": press({ ...mod(platform), shiftKey: true, key: "Ķ" }),
    "a dead key on the K key": press({ ...mod(platform), shiftKey: true, key: "Dead" }),
    "an empty key on the K key": press({ ...mod(platform), shiftKey: true, key: "" }),
    "AltGr typing K": press({ ...mod(platform), shiftKey: true, key: "K", altGraph: true }),
    "Windows AltGr as Ctrl+Alt": press({
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      key: "K",
      altGraph: true
    }),
    "Alt or Option held": press({ ...mod(platform), shiftKey: true, altKey: true, key: "K" }),
    "⌘ and Ctrl both": press({ metaKey: true, ctrlKey: true, shiftKey: true, key: "K" }),
    "Ctrl on a Mac, ⌘ elsewhere": press({
      ...(platform === "mac" ? { ctrlKey: true } : { metaKey: true }),
      shiftKey: true,
      key: "K"
    }),
    "no Shift": press({ ...mod(platform) }),
    "Shift alone": press({ shiftKey: true, key: "K" }),
    "Mod+Shift+L": press({ ...mod(platform), shiftKey: true, key: "L", code: "KeyL" }),
    repeat: press({ ...mod(platform), shiftKey: true, key: "K", repeat: true }),
    composing: press({ ...mod(platform), shiftKey: true, key: "K", isComposing: true }),
    Process: press({ ...mod(platform), shiftKey: true, key: "Process", keyCode: 229 }),
    Unidentified: press({ ...mod(platform), shiftKey: true, key: "Unidentified" }),
    "keyCode 229": press({ ...mod(platform), shiftKey: true, key: "k", keyCode: 229 }),
    untrusted: press({ ...mod(platform), shiftKey: true, key: "K", isTrusted: false })
  }).map(([name, event]) => ({ name: `${platform}: ${name}`, platform, event }))
);

describe("the switcher chord", () => {
  // TanStack reads only KeyboardEvent fields `Press` carries; the stand-in can't be trusted otherwise.
  const oracle = (event: Press, platform: Platform) =>
    event.isTrusted &&
    !event.repeat &&
    matchesKeyboardEvent(event as unknown as KeyboardEvent, "Mod+Shift+K", platform);

  it.each(presses)("activates as TanStack matches Mod+Shift+K: $name", ({ event, platform }) => {
    expect(activates(event, platform)).toBe(oracle(event, platform));
  });

  // The table above would pass if both matchers refused everything.
  it("activates where people press the chord, and nowhere else", () => {
    expect(
      presses.filter(({ event, platform }) => activates(event, platform)).map(({ name }) => name)
    ).toEqual(
      platforms.flatMap((platform) =>
        [
          "US K",
          "lowercase k",
          "K on another key (Dvorak)",
          "Cyrillic Л",
          "AZERTY K",
          "a symbol on the K key",
          "a dead key on the K key",
          // A Mac has no AltGr: Option is Alt, and the flag means nothing there.
          ...(platform === "mac" ? ["AltGr typing K"] : [])
        ].map((name) => `${platform}: ${name}`)
      )
    );
  });

  it.each(
    platforms.flatMap((platform) =>
      Object.entries({
        "a repeat": { repeat: true },
        "mid-composition": { isComposing: true },
        "keyCode 229": { keyCode: 229 },
        "Process on the K key": { key: "Process", keyCode: 229 },
        "Unidentified on the K key": { key: "Unidentified" },
        "Cyrillic mid-composition": { key: "л", isComposing: true }
      }).map(([name, fields]) => ({
        name: `${platform}: ${name}`,
        platform,
        event: press({ ...mod(platform), shiftKey: true, ...fields })
      }))
    )
  )("claims but doesn't activate $name", ({ event, platform }) => {
    expect(claims(event, platform)).toBe(true);
    expect(activates(event, platform)).toBe(false);
  });

  it("leaves untrusted presses and other chords alone", () => {
    for (const platform of platforms) {
      expect(claims(press({ ...mod(platform), shiftKey: true, isTrusted: false }), platform)).toBe(
        false
      );
      expect(claims(press({ ...mod(platform), shiftKey: true, key: "J" }), platform)).toBe(false);
      expect(claims(press({ ...mod(platform), key: "k" }), platform)).toBe(false);
    }
  });

  it("detects the platform as TanStack does", () => {
    expect(platformOf({ platform: "MacIntel", userAgent: "" })).toBe("mac");
    expect(
      platformOf({ platform: "", userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" })
    ).toBe("mac");
    expect(platformOf({ platform: "Win32", userAgent: "" })).toBe("windows");
    expect(platformOf({ platform: "Linux x86_64", userAgent: "X11; Linux x86_64" })).toBe("linux");
  });
});
