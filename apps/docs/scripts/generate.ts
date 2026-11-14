/**
 * Writes the generated reference pages into content/docs from sources the repo already
 * maintains, so nobody copies them by hand. `dev` and `build` run it first; its output is
 * gitignored. The transform is deliberately mechanical: the source's own frontmatter becomes
 * Fumadocs frontmatter, its H1 becomes the title, and the prose is left as written.
 */
import { readFile, writeFile } from "node:fs/promises";

const repo = new URL("../../../", import.meta.url);
const content = new URL("../content/docs/", import.meta.url);

const pages = [
  { source: "packages/sdk/skills/patchy-tables/SKILL.md", page: "tables.md" },
  { source: "docs/limits.md", page: "limits.md" }
];

for (const { source, page } of pages) {
  const raw = await readFile(new URL(source, repo), "utf8");
  // A skill's frontmatter holds its name and description; docs/limits.md has none.
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  const body = frontmatter ? raw.slice(frontmatter[0].length) : raw;
  const description = frontmatter?.[1]?.match(/^description: (.*)$/m)?.[1];
  const heading = /^# (.+)\n/m.exec(body);
  if (!heading) throw new Error(`${source} has no H1 to title its page with.`);
  // Fumadocs renders the title above the body, so the H1 leaves the body.
  const rest = body.replace(heading[0], "").trimStart();
  // JSON strings are valid YAML scalars, whatever punctuation the source uses.
  const fields = [
    `title: ${JSON.stringify(heading[1])}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : [])
  ];
  await writeFile(new URL(page, content), `---\n${fields.join("\n")}\n---\n\n${rest}`);
}
