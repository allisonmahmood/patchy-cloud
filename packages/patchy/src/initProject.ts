// @effect-diagnostics nodeBuiltinImport:off
// Activation needs lstat (without following links) and exclusive hard links for installed files.
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isManagedOutputPath } from "@patchy/api";
import { safePath } from "./ManagedProject.js";
import type { ReleaseToolchain } from "@patchy/api";
import toolchain from "./toolchain.json" with { type: "json" };

/** Starter sources contain company configuration, never the authenticated person's identity. */
export function starterFiles(options: {
  instance: string;
  name: string;
  tier: 0 | 1 | 2;
  purpose: string;
  tarball: string;
  toolchain?: typeof ReleaseToolchain.Type;
}): Record<string, string> {
  const { instance, name, tier, purpose, tarball, toolchain: versions = toolchain } = options;
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    "patchy.json": json({ instance, description: purpose }),
    "fixtures/.gitkeep": "",
    "helpers/.gitkeep": "",
    "package.json": json({
      name,
      private: true,
      type: "module",
      scripts: {
        typecheck: "tsc --noEmit",
        build: "vite build",
        ...(tier >= 1 ? { lint: "eslint ." } : {})
      },
      devDependencies: {
        patchy: tarball,
        typescript: versions.typescript.accepted,
        vite: versions.vite.accepted,
        "vite-plugin-singlefile": versions["vite-plugin-singlefile"].accepted,
        "@types/node": versions["@types/node"].accepted,
        ...(tier >= 1
          ? {
              eslint: "^10.11.0",
              "typescript-eslint": "^8.70.1",
              "eslint-plugin-react-hooks": "^7.1.1"
            }
          : {})
      }
    }),
    "patchy.config.ts": `import { defineConfig, table, t } from "patchy/config";\n\nexport default defineConfig({\n  name: ${JSON.stringify(name)},\n  tier: ${tier},\n  tables: { notes: table("One note per id, with a title.", { title: t.text() }) },\n  files: {},\n  uses: {}\n});\n`,
    "index.html":
      tier >= 1
        ? '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notes</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n'
        : '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My patch</title></head><body><h1>My patch</h1><p>A static page. Change the config to tier 1 before adding browser code.</p></body></html>\n',
    ...(tier >= 1
      ? {
          "src/main.tsx": `import { render } from "patchy/preact";
import { App } from "./App.js";

render(<App />, document.getElementById("root")!);
`,
          "src/App.tsx": `import { useEffect, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";

export function App() {
  const [notes, setNotes] = useState<readonly { id: string; title: string }[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void ${tier === 2 ? "patchy.server.notes.list({})" : "patchy.tables.notes.list({ limit: 100 })"}
      .then((result) => { if (active) setNotes(${tier === 2 ? "result" : "result.rows"}); })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function save(form: HTMLFormElement) {
    if (loading || saving || !form.reportValidity()) return;
    const title = String(new FormData(form).get("title") ?? "").trim();
    if (!title) return;
    setSaving(true);
    setError("");
    void (async () => {
      await ${tier === 2 ? "patchy.server.notes.create" : "patchy.tables.notes.insert"}({ title });
      form.reset();
${
  tier === 2
    ? "      setNotes(await patchy.server.notes.list({}));"
    : `      const page = await patchy.tables.notes.list({ limit: 100 });
      setNotes(page.rows);`
}
    })()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false));
  }

  // The sandbox blocks native form submission; save through the broker instead.
  return (
    <>
      <h1>Notes</h1>
      <form id="notes" onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.isComposing) {
          event.preventDefault();
          save(event.currentTarget);
        }
      }}>
        <label>Title <input name="title" required disabled={loading || saving} /></label>
        <button type="button" disabled={loading || saving} onClick={(event) => save(event.currentTarget.form!)}>Add note</button>
      </form>
      <p role="status">{loading ? "Loading notes..." : saving ? "Saving note..." : ""}</p>
      <p id="error" role="alert">{error}</p>
      <ul id="list">{notes.map((note) => <li key={note.id}>{note.title}</li>)}</ul>
    </>
  );
}
`,
          "eslint.config.js": `import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["patchy/_generated/**", "dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.{js,jsx,ts,tsx}", "helpers/**/*.{js,jsx,ts,tsx}", "server/**/*.{js,jsx,ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // useQuery is recognized by its use-prefix; it has no effect dependency array.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "^(?:react|react-dom|preact)(?:/|$)",
          message: "Import Preact with compat semantics from patchy/preact."
        }]
      }]
    }
  }
];
`
        }
      : {
          "src/main.ts": `import { patchy } from "../patchy/_generated/client.js";\n\nconst form = document.querySelector<HTMLFormElement>("#notes")!;\nconst list = document.querySelector<HTMLUListElement>("#list")!;\nconst error = document.querySelector<HTMLParagraphElement>("#error")!;\nasync function render() {\n  const page = await patchy.tables.notes.list({ limit: 100 });\n  list.replaceChildren(...page.rows.map((note) => {\n    const item = document.createElement("li");\n    item.textContent = note.title;\n    return item;\n  }));\n}\nfunction save() {\n  if (!form.reportValidity()) return;\n  const title = String(new FormData(form).get("title") ?? "").trim();\n  if (!title) return;\n  void (async () => {\n    await patchy.tables.notes.insert({ title });\n    form.reset();\n    await render();\n  })().catch((cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : String(cause); });\n}\n// The sandbox blocks native form submission; save through the broker instead.\nform.querySelector("button")!.addEventListener("click", save);\nform.addEventListener("keydown", (event) => {\n  if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.isComposing) {\n    event.preventDefault();\n    save();\n  }\n});\nvoid render().catch((cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : String(cause); });\n`
        }),
    ...(tier === 2
      ? {
          "server/notes.ts": `import { query, mutation, t } from "../patchy/_generated/server.js";

export const list = query({
  args: {},
  result: t.array(t.row("notes")),
  handler: async (ctx) => (await ctx.tables.notes.list({ limit: 100 })).rows
});

export const create = mutation({
  args: { title: t.text() },
  result: t.row("notes"),
  handler: async (ctx, args) => ctx.tables.notes.insert({ title: args.title })
});
`
        }
      : {}),
    "vite.config.ts":
      tier >= 1
        ? 'import { defineConfig } from "vite";\nimport { viteSingleFile } from "vite-plugin-singlefile";\n\nexport default defineConfig({\n  plugins: [viteSingleFile()],\n  oxc: { jsx: { importSource: "patchy/preact" } },\n  build: { modulePreload: false },\n  server: { host: "127.0.0.1" }\n});\n'
        : 'import { defineConfig } from "vite";\nimport { viteSingleFile } from "vite-plugin-singlefile";\n\nexport default defineConfig({ plugins: [viteSingleFile()], server: { host: "127.0.0.1" } });\n',
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
        types: ["node", "vite/client"],
        ...(tier >= 1
          ? {
              jsx: "react-jsx",
              jsxImportSource: "patchy/preact",
              isolatedModules: true,
              verbatimModuleSyntax: true
            }
          : {})
      },
      include: [
        "src",
        ...(tier >= 1 ? ["helpers", "server"] : []),
        "patchy",
        "patchy.config.ts",
        "vite.config.ts"
      ]
    }),
    "AGENTS.md": `# Purpose\n\n${purpose}\n\nThe purpose above is independent of the published description in \`patchy.json\`.\n\n# Working here\n\nInstallation already ran. Do not reinstall to start building. Run \`pnpm patchy --help\` for commands. Read the release-bound \`.agents/skills/patchy-loop/SKILL.md\` for how to exercise the tier configured in \`patchy.config.ts\`.\n\n- \`patchy.json\`: instance, optional patch id, published description and its sync stamp. Edit the description here; cloud edits pull down at refresh, dev start and publish.\n- \`patchy.config.ts\`: the tier, owned tables and file stores with their descriptions, and declared connections/shared tables.\n- \`src/\`, \`index.html\`: the page UI. Browser code runs at tier 1 or above; \`vite.config.ts\` builds one HTML file. Tier 1 calls declared resources directly; tier 2 calls generated \`patchy.server.*\` handlers.\n- \`server/\`: hosted handlers when tier 2 is declared. Import bound builders from \`patchy/_generated/server.ts\`. Keep server implementation out of the page; page imports from here must be type-only.\n- \`helpers/\`: company-owned code shared by the page or server. Keep each helper's imports compatible with where it runs.\n- \`fixtures/\`: local rows only, never production data.\n- \`patchy/_generated/index.json\`: generated index linking every declaration, revision, context and skill. Never edit generated files.\n- \`.agents/skills/patchy-loop/SKILL.md\`: the local build loop and moving tiers.\n- On tiers 1 and 2, read \`.agents/skills/patchy-preact/SKILL.md\` before building a Preact page.\n- On tier 2, read \`.agents/skills/patchy-server/SKILL.md\` before writing handlers.\n- \`.agents/skills/patchy-tables/SKILL.md\`: owned tables.\n- \`.agents/skills/patchy-files/SKILL.md\`: owned files.\n- Integration skills appear under \`.agents/skills/patchy-postgres/SKILL.md\` and \`.agents/skills/patchy-shared-tables/SKILL.md\` when declared.\n\nRun \`pnpm typecheck\` and, when \`package.json\` declares it, \`pnpm lint\` before publishing. Run \`pnpm patchy refresh\` after editing declarations, changing tier or adding, removing or renaming server modules. Refresh never edits \`src/\`, \`server/\` or \`helpers/\`. Deleting \`.patchy/\` destroys local rows and files.\n`,
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
