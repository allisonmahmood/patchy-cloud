import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { renderApiMarkdown } from "./markdown.js";

it("keeps docs/API.md current (run pnpm --filter @patchy/api render-docs)", () => {
  const committed = readFileSync(
    fileURLToPath(new URL("../../../docs/API.md", import.meta.url)),
    "utf8"
  );
  expect(committed).toBe(renderApiMarkdown());
});
