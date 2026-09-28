import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderLimitsMarkdown, renderServerSkillLimits } from "../src/render.js";

if (process.argv.includes("--skill")) {
  process.stdout.write(renderServerSkillLimits());
} else {
  const target = fileURLToPath(new URL("../../../docs/limits.md", import.meta.url));
  writeFileSync(target, renderLimitsMarkdown());
  process.stdout.write(`Wrote ${target}\n`);
}
