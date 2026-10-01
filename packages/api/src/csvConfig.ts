import { registry } from "@patchy/limits/registry";

/** Release-fixed parser bounds, shared by the page and server helper. */
export const csvLimits = {
  characters: registry["csv.characters"].default,
  cells: registry["csv.cells"].default
} as const;
