// @effect-diagnostics nodeBuiltinImport:off -- PROTOTYPE for #315: read synchronously when a build plugin is created.
// PROTOTYPE for #315: the two client allowlists the reference CRM runs compare (brief step 8).
//
// Preact and @preact/signals are the floor in both. "restricted" (A) admits nothing else;
// "wide" (B) also pins the Zag.js Preact adapter with the four machines a CRM uses and
// TanStack's Preact table. The variant is chosen once, at `patchy init`, from the prototype-only
// PATCHY_PROTOTYPE_VARIANT, and recorded in patchy.json as `prototypeVariant`; refresh writes
// the pins, the import check admits them, and generation serves the matching skill, all from
// that one field, so they cannot disagree.
import { readFileSync } from "node:fs";
import * as path from "node:path";

export type Variant = "restricted" | "wide";

/** Exact pins, one Zag version for the adapter and every machine. */
export const widePins = {
  "@zag-js/preact": "1.44.0",
  "@zag-js/combobox": "1.44.0",
  "@zag-js/dialog": "1.44.0",
  "@zag-js/select": "1.44.0",
  "@zag-js/menu": "1.44.0",
  "@tanstack/preact-table": "9.2.4"
} as const;

export const floorPins = { preact: "10.29.8", "@preact/signals": "2.11.2" } as const;

export const pinsFor = (variant: Variant): Readonly<Record<string, string>> =>
  variant === "wide" ? { ...floorPins, ...widePins } : floorPins;

/** The bare imports `src/` may use besides `patchy`. */
export const clientAllowlist = (variant: Variant): readonly string[] =>
  Object.keys(pinsFor(variant));

export const parseVariant = (value: unknown): Variant => (value === "wide" ? "wide" : "restricted");

/** The repo's recorded variant; absent or unreadable is "restricted". */
export const readVariant = (root: string): Variant => {
  try {
    const repo = JSON.parse(readFileSync(path.join(root, "patchy.json"), "utf8")) as {
      prototypeVariant?: unknown;
    };
    return parseVariant(repo.prototypeVariant);
  } catch {
    return "restricted";
  }
};
