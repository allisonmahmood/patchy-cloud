// @effect-diagnostics nodeBuiltinImport:off
// PROTOTYPE for #563: stands in for look generation. With PATCHY_PROTOTYPE_LOOK set to a
// look folder (prototypes/company-look/looks/<name>), init, refresh and dev start lay down
// the look as managed files, and init's scaffold imports it. Never merged.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ManagedFile } from "./ManagedProject.js";

export const prototypeLookDir = (): string | undefined =>
  // eslint-disable-next-line no-restricted-properties -- prototype switch, read outside Effect on purpose
  process.env["PATCHY_PROTOTYPE_LOOK"] || undefined;

/** The generated look files: look.css, the logo and the patchy-look skill holding the brief. */
export async function prototypeLookFiles(): Promise<readonly ManagedFile[]> {
  const dir = prototypeLookDir();
  if (!dir) return [];
  const read = (name: string) => fs.readFile(path.join(dir, name), "utf8");
  const brief = await read("LOOK.md");
  const title = /^# (.+?)'s look\s*$/m.exec(brief);
  const company = title?.[1] ?? "The company";
  const template = await fs.readFile(path.join(dir, "..", "..", "patchy-look-skill.md"), "utf8");
  const skill = template
    .replace(/<!-- PROTOTYPE[^\n]*-->\n\n/, "")
    .replaceAll("{{company}}", company)
    .replace("{{brief}}", brief.replace(/^# .*\n+/, "").trimEnd());
  return [
    { path: "patchy/_generated/look.css", contents: await read("look.css") },
    { path: "patchy/_generated/logo.svg", contents: await read("logo.svg") },
    { path: ".agents/skills/patchy-look/SKILL.md", contents: skill }
  ];
}

/** Adds the look import to the tier 1 and 2 scaffold and points AGENTS.md at the skill. */
export function withPrototypeLookStarter(files: Record<string, string>): Record<string, string> {
  if (!prototypeLookDir() || !files["src/main.tsx"]) return files;
  return {
    ...files,
    "src/main.tsx": `import "../patchy/_generated/look.css";\n${files["src/main.tsx"]}`,
    "AGENTS.md": files["AGENTS.md"]!.replace(
      "- On tier 2, read",
      "- Read `.agents/skills/patchy-look/SKILL.md` before styling a page: the company look, imported by `src/main.tsx`.\n- On tier 2, read"
    )
  };
}
