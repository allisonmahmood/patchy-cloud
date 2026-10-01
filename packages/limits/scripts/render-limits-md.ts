import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderLimitsMarkdown, renderServerSkillLimits } from "../src/render.js";

if (process.argv.includes("--skill")) {
  process.stdout.write(renderServerSkillLimits());
} else {
  const target = fileURLToPath(new URL("../../../docs/limits.md", import.meta.url));
  writeFileSync(target, renderLimitsMarkdown());
  const snapshot = new URL("../generated/server-skill-limits.md", import.meta.url);
  mkdirSync(new URL("../generated/", import.meta.url), { recursive: true });
  writeFileSync(snapshot, renderServerSkillLimits());
  process.stdout.write(`Wrote ${fileURLToPath(snapshot)}\n`);
  process.stdout.write(`Wrote ${target}\n`);
}
