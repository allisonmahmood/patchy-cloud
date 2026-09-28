import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const skill = new URL("../../sdk/skills/patchy-server/SKILL.md", import.meta.url);
  const source = readFileSync(skill, "utf8");
  writeFileSync(
    skill,
    source.replace(
      /<!-- generated-limits:start -->[\s\S]*?<!-- generated-limits:end -->/,
      `<!-- generated-limits:start -->\n\n${renderServerSkillLimits()}\n<!-- generated-limits:end -->`
    )
  );
  process.stdout.write(`Wrote ${fileURLToPath(snapshot)}\n`);
  process.stdout.write(`Wrote ${target}\n`);
}
