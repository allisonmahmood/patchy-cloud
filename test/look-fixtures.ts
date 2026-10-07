import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LookFiles } from "../packages/core/src/look.js";

/** The four looks the prototype captured (#563), with their contrast fixed for the publish checks. */
export const LOOK_FIXTURES = ["duolingo", "finance", "linear", "patchy"] as const;
export type LookFixture = (typeof LOOK_FIXTURES)[number];

/** A fixture look's folder, as `patchy look publish` reads it. Only `patchy` has a logo. */
export const lookFixtureDir = (name: LookFixture): string =>
  fileURLToPath(new URL(`../packages/core/fixtures/looks/${name}/`, import.meta.url));

export const readLookFixture = (name: LookFixture): LookFiles => {
  const dir = lookFixtureDir(name);
  const read = (file: string) => readFileSync(`${dir}${file}`, "utf8");
  return {
    "look.css": read("look.css"),
    "LOOK.md": read("LOOK.md"),
    ...(existsSync(`${dir}logo.svg`) ? { "logo.svg": read("logo.svg") } : {})
  };
};
