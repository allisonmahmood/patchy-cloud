import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, root)));

it("keeps the global skill's lock hash current (see docs/SKILL_DISTRIBUTION.md)", () => {
  const lock = JSON.parse(read("skills-lock.json").toString("utf8")) as {
    skills: Record<string, { skillPath: string; computedHash: string }>;
  };
  const skill = lock.skills["patchy"]!;
  expect(createHash("sha256").update(read(skill.skillPath)).digest("hex")).toBe(skill.computedHash);
});
