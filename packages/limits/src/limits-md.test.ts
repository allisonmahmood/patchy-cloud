import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { renderLimitsMarkdown, renderServerSkillLimits } from "./render.js";

it("keeps docs/limits.md current (run pnpm --filter @patchy/limits render-docs)", () => {
  const committed = readFileSync(
    fileURLToPath(new URL("../../../docs/limits.md", import.meta.url)),
    "utf8"
  );
  expect(committed).toBe(renderLimitsMarkdown());
});

it("keeps the server-skill limits snapshot current (run pnpm --filter @patchy/limits render-docs)", () => {
  const committed = readFileSync(
    fileURLToPath(new URL("../generated/server-skill-limits.md", import.meta.url)),
    "utf8"
  );
  expect(committed).toBe(renderServerSkillLimits());
});
