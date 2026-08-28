import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderApiMarkdown } from "./markdown.js";

describe("docs/API.md", () => {
  it("matches what the schemas render to (run `pnpm --filter @patchy/api render-docs` to refresh)", () => {
    const committed = readFileSync(
      fileURLToPath(new URL("../../../docs/API.md", import.meta.url)),
      "utf8"
    );
    expect(committed).toBe(renderApiMarkdown());
  });
});
