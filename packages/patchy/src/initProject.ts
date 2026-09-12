// @effect-diagnostics nodeBuiltinImport:off
// Activation needs lstat (without following links) and exclusive hard links for installed files.
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isManagedOutputPath } from "@patchy/api";
import { safePath } from "./ManagedProject.js";

/** Starter sources contain company configuration, never the authenticated person's identity. */
export function starterFiles(options: {
  instance: string;
  name: string;
  tier: 0 | 1;
  purpose: string;
  tarball: string;
}): Record<string, string> {
  const { instance, name, tier, purpose, tarball } = options;
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    "patchy.json": json({ instance }),
    "fixtures/.gitkeep": "",
    "package.json": json({
      name,
      private: true,
      type: "module",
      scripts: { typecheck: "tsc --noEmit", build: "vite build" },
      devDependencies: {
        patchy: tarball,
        typescript: "^6.0.3",
        vite: "^7.3.1",
        "vite-plugin-singlefile": "^2.3.0",
        "@types/node": "^22.19.0"
      }
    }),
    "patchy.config.ts": `import { defineConfig, table, t } from "patchy/config";\n\nexport default defineConfig({\n  name: ${JSON.stringify(name)},\n  tier: ${tier},\n  tables: { notes: table({ title: t.text() }) },\n  files: {},\n  uses: {}\n});\n`,
    "index.html":
      tier === 1
        ? '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notes</title></head><body><h1>Notes</h1><form id="notes"><label>Title <input name="title" required></label><button>Add note</button></form><p id="error" role="alert"></p><ul id="list"></ul><script type="module" src="/src/main.ts"></script></body></html>\n'
        : '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My patch</title></head><body><h1>My patch</h1><p>A static page. Change the config to tier 1 before adding browser code.</p></body></html>\n',
    "src/main.ts": `import { patchy } from "../patchy/_generated/client.js";\n\nconst form = document.querySelector<HTMLFormElement>("#notes")!;\nconst list = document.querySelector<HTMLUListElement>("#list")!;\nconst error = document.querySelector<HTMLParagraphElement>("#error")!;\nasync function render() {\n  const page = await patchy.tables.notes.list({ limit: 100 });\n  list.replaceChildren(...page.rows.map((note) => {\n    const item = document.createElement("li");\n    item.textContent = note.title;\n    return item;\n  }));\n}\nform.addEventListener("submit", (event) => {\n  event.preventDefault();\n  const title = String(new FormData(form).get("title") ?? "").trim();\n  if (!title) return;\n  void (async () => {\n    await patchy.tables.notes.insert({ title });\n    form.reset();\n    await render();\n  })().catch((cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : String(cause); });\n});\nvoid render().catch((cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : String(cause); });\n`,
    "vite.config.ts":
      'import { defineConfig } from "vite";\nimport { viteSingleFile } from "vite-plugin-singlefile";\n\nexport default defineConfig({ plugins: [viteSingleFile()], server: { host: "127.0.0.1" } });\n',
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        resolveJsonModule: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["node", "vite/client"]
      },
      include: ["src", "patchy", "patchy.config.ts", "vite.config.ts"]
    }),
    "AGENTS.md": `# Purpose\n\n${purpose}\n\n# Working here\n\nInstallation already ran. Do not reinstall to start building. Run \`pnpm patchy --help\` for commands; test with \`patchy dev\` (\`pnpm patchy dev\` from this repo).\n\n- \`patchy.config.ts\`: owned tables and file stores, and declared connections/shared tables.\n- \`src/main.ts\`, \`index.html\`: the browser UI; \`vite.config.ts\` builds one HTML file.\n- \`fixtures/\`: local rows only, never production data.\n- \`patchy/_generated/index.json\`: generated index linking every declaration, revision, context and skill. Never edit generated files.\n- \`.agents/skills/patchy-loop/SKILL.md\`: the local build loop.\n- \`.agents/skills/patchy-tables/SKILL.md\`: owned tables.\n- \`.agents/skills/patchy-files/SKILL.md\`: owned files.\n- Integration skills appear under \`.agents/skills/patchy-postgres/SKILL.md\` and \`.agents/skills/patchy-shared-tables/SKILL.md\` when declared.\n\nRun \`pnpm patchy refresh\` after editing declarations. Deleting \`.patchy/\` destroys local rows and files.\n`,
    "CLAUDE.md": "@AGENTS.md\n",
    ".gitignore": ".patchy/\nnode_modules/\ndist/\n"
  };
}

/** The caller discards the entire init stage on failure; no nested transaction is needed. */
export async function writeInitialGeneration(
  staging: string,
  files: readonly { path: string; contents: string }[],
  manifest: string
): Promise<{ generated: string[]; skills: string[]; fixtures: string[] }> {
  const names = new Set<string>();
  for (const file of files) {
    if (!isManagedOutputPath(file.path) || names.has(file.path))
      throw new Error(`Invalid or duplicate generated path: ${file.path}`);
    names.add(file.path);
  }
  const generated: string[] = [];
  const skills: string[] = [];
  const fixtures: string[] = [];
  for (const file of [...files, { path: "patchy/_generated/manifest.json", contents: manifest }]) {
    const target = await safePath(staging, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(target, file.contents, { flag: "wx" });
    } catch (error) {
      if (
        file.path.startsWith("fixtures/") &&
        (error as NodeJS.ErrnoException).code === "EEXIST" &&
        (await fs.lstat(target)).isFile()
      )
        continue;
      throw error;
    }
    if (file.path.startsWith("fixtures/")) fixtures.push(file.path);
    else if (file.path.startsWith(".agents/")) skills.push(file.path.split("/")[2]!);
    else generated.push(file.path);
  }
  return { generated, skills: skills.sort(), fixtures };
}

interface StarterEntry {
  readonly target: string;
  readonly stat: Stats;
}

async function entryInfo(target: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Activate a complete sibling stage without replacing an existing working directory. */
export async function activateStarter(staging: string, destination: string): Promise<void> {
  const existing = await entryInfo(destination);
  if (existing && (!existing.isDirectory() || (await fs.readdir(destination)).length > 0))
    throw new Error(`Refusing to initialize an existing tree: ${destination}`);

  const created: StarterEntry[] = [];
  if (!existing) {
    // mkdir is exclusive: a target created after the initial check must not be replaced.
    await fs.mkdir(destination);
    created.push({ target: destination, stat: await fs.lstat(destination) });
  }
  async function populate(source: string, directory: string): Promise<void> {
    for (const name of await fs.readdir(source)) {
      const from = path.join(source, name);
      const target = path.join(directory, name);
      const stat = await fs.lstat(from);
      let installed: Stats;
      if (stat.isDirectory()) {
        await fs.mkdir(target, { mode: stat.mode & 0o7777 });
        installed = await fs.lstat(target);
      } else if (stat.isFile()) {
        // The stage is on the same filesystem; retaining its inode avoids copying node_modules.
        await fs.link(from, target);
        installed = stat;
      } else if (stat.isSymbolicLink()) {
        await fs.symlink(await fs.readlink(from), target);
        installed = await fs.lstat(target);
      } else {
        throw new Error(`Unsupported starter entry: ${from}`);
      }
      created.push({ target, stat: installed });
      if (stat.isDirectory()) await populate(from, target);
    }
  }

  try {
    await populate(staging, destination);
  } catch (cause) {
    const failures: unknown[] = [];
    for (let index = created.length - 1; index >= 0; index--) {
      const entry = created[index]!;
      try {
        const current = await entryInfo(entry.target);
        // Delete only our inodes, and only empty directories; caller replacements/additions survive.
        if (!current || current.dev !== entry.stat.dev || current.ino !== entry.stat.ino) continue;
        if (entry.stat.isDirectory()) await fs.rmdir(entry.target);
        else await fs.unlink(entry.target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ENOTEMPTY" && code !== "EEXIST")
          failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError([cause, ...failures], "Starter activation rollback failed.", {
        cause
      });
    throw cause;
  }
}
