/**
 * Writes `docs/API.md` from the live `PatchyApi`. Run through
 * `pnpm --filter @patchy/api render-docs`; `src/api-md.test.ts` fails on drift.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderApiMarkdown } from "../src/markdown.js";

const target = fileURLToPath(new URL("../../../docs/API.md", import.meta.url));
writeFileSync(target, renderApiMarkdown());
process.stdout.write(`Wrote ${target}\n`);
