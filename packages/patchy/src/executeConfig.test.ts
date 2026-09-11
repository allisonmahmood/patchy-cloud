// @effect-diagnostics nodeBuiltinImport:off
// Temporary config repos exercise the actual Node child-process boundary.
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manifest } from "@patchy/api";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { executeConfig } from "./config.js";
import * as ConfigExecution from "./executeConfig.js";
import { MANIFEST_VERSION, RELEASE } from "./release.js";

const builders = new URL("./config.ts", import.meta.url).href;
const encodeManifest = Schema.encodeSync(Manifest);
const decodeManifest = Schema.decodeUnknownSync(Manifest);
const directories: string[] = [];
const fixture = async (source: string, index?: unknown) => {
  const directory = await mkdtemp(join(tmpdir(), "patchy-config-"));
  directories.push(directory);
  const path = join(directory, "patchy.config.ts");
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(
    path,
    `import { defineConfig, table, t, files, postgres, sharedTable } from ${JSON.stringify(builders)};\n${source}`
  );
  if (index !== undefined) {
    await mkdir(join(directory, "patchy/_generated"), { recursive: true });
    await writeFile(join(directory, "patchy/_generated/index.json"), JSON.stringify(index));
  }
  return path;
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("executeConfig", () => {
  it("executes TypeScript locally and round-trips all definitions and real stamps through the API schema", async () => {
    const path = await fixture(
      `
      import { title } from "./values.ts";
      const tier: 1 = 1;
      console.log("config output is not the result channel");
      export default defineConfig({ name: "config-test", tier, tables: {
        notes: table({
          title: t.text().default(title), body: t.text().optional(),
          count: t.integer().default(0), score: t.number().default(1.5),
          active: t.boolean().default(false), at: t.timestamp().default("now"),
          data: t.json().default({ nested: [null, true] }),
          parent: t.ref("notes").optional()
        }, { indexes: { byCount: ["count"], byTitle: { columns: ["title"], unique: true } }, shared: true })
      }, files: { attachments: files() }, uses: {
        sales: postgres("warehouse"), contacts: sharedTable("abcdefghijkl", "contacts")
      } });
    `,
      {
        uses: [
          { alias: "sales", id: "connection-real", revision: 7 },
          { alias: "contacts", id: "abcdefghijkl/contacts", revision: 12 }
        ]
      }
    );
    await writeFile(join(path, "..", "values.ts"), 'export const title: string = "hello";');
    const manifest = await executeConfig(path);
    expect(encodeManifest(decodeManifest(manifest))).toEqual(manifest);
    expect(manifest).toEqual({
      manifestVersion: MANIFEST_VERSION,
      release: RELEASE,
      name: "config-test",
      tier: 1,
      tables: {
        notes: {
          columns: {
            title: { kind: "text", default: "hello" },
            body: { kind: "text", optional: true },
            count: { kind: "integer", default: 0 },
            score: { kind: "number", default: 1.5 },
            active: { kind: "boolean", default: false },
            at: { kind: "timestamp", default: "now" },
            data: { kind: "json", default: { nested: [null, true] } },
            parent: { kind: "ref", table: "notes", optional: true }
          },
          indexes: {
            byCount: { columns: ["count"] },
            byTitle: { columns: ["title"], unique: true }
          },
          shared: true
        }
      },
      files: { attachments: {} },
      uses: {
        sales: { kind: "postgres", handle: "warehouse", id: "connection-real", revision: 7 },
        contacts: {
          kind: "sharedTable",
          patchId: "abcdefghijkl",
          table: "contacts",
          id: "abcdefghijkl/contacts",
          revision: 12
        }
      }
    });
  });

  it("reports a thrown config locally without leaking process state into the caller", async () => {
    const before = process.title;
    const path = await fixture(
      'process.title = "patchy-config-child"; throw new Error("config exploded");'
    );
    await expect(executeConfig(path)).rejects.toThrow("config exploded");
    expect(process.title).toBe(before);
  });

  it("does not execute cached config exports from an earlier attempt", async () => {
    const path = await fixture('export default defineConfig({ name: "first-name", tier: 0 });');
    expect((await executeConfig(path)).name).toBe("first-name");
    await writeFile(
      path,
      'export default { name: "second-name", tier: 0, tables: {}, files: {}, uses: {} };'
    );
    expect((await executeConfig(path)).name).toBe("second-name");
  });

  it("rejects a process exit that never returns a config", async () => {
    const path = await fixture("process.exit(0);");
    await expect(executeConfig(path)).rejects.toThrow();
  });

  it.each([
    '{ id: { kind: "text" } }',
    '{ count: { kind: "integer", default: 1.5 } }',
    '{ title: { kind: "text", optional: true, default: "bad" } }',
    '{ title: { kind: "text", default: undefined } }',
    '{ data: { kind: "json", default: { hidden: undefined } } }',
    '{ score: { kind: "number", default: Infinity } }'
  ])("refuses invalid definitions instead of silently changing them: %s", async (columns) => {
    const path = await fixture(
      `export default { name: "invalid-config", tier: 1, tables: { notes: { columns: ${columns}, indexes: {} } }, files: {}, uses: {} };`
    );
    await expect(executeConfig(path)).rejects.toThrow();
  });

  it("refuses declarations without generated stamps instead of inventing ids or revisions", async () => {
    const path = await fixture(
      'export default defineConfig({ name: "missing-stamps", tier: 1, uses: { sales: postgres("warehouse") } });'
    );
    await expect(executeConfig(path)).rejects.toThrow();
  });

  it.each([
    { uses: [] },
    { uses: [{ alias: "sales", id: "real", revision: -1 }] },
    {
      uses: [
        { alias: "sales", id: "first", revision: 1 },
        { alias: "sales", id: "second", revision: 2 }
      ]
    }
  ])("rejects absent, invalid and ambiguous generated stamps: %j", async (index) => {
    const path = await fixture(
      'export default defineConfig({ name: "bad-stamps", tier: 1, uses: { sales: postgres("warehouse") } });',
      index
    );
    await expect(executeConfig(path)).rejects.toThrow();
  });

  it("does not rebind a changed shared declaration to its old generated identity", async () => {
    const path = await fixture(
      'export default defineConfig({ name: "changed-shared", tier: 1, uses: { contacts: sharedTable("abcdefghijkl", "contacts") } });',
      { uses: [{ alias: "contacts", id: "abcdefghijkl/other", revision: 1 }] }
    );
    await expect(executeConfig(path)).rejects.toThrow();
  });

  it("evaluates staged edits with relative imports without replacing the author's config", async () => {
    const path = await fixture('export default defineConfig({ name: "original-name", tier: 1 });');
    const original = await readFile(path, "utf8");
    await writeFile(join(path, "..", "name.ts"), 'export const name = "staged-name";');
    const source = `import { name } from "./name.ts";\n${original.replace('"original-name"', "name")}`;
    const manifest = await ConfigExecution.executeConfig(path, { resolve: false, source });
    expect(manifest.name).toBe("staged-name");
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(
      ConfigExecution.executeConfig(path, {
        resolve: false,
        source: `${source}\nthrow new Error("staged config refused");`
      })
    ).rejects.toThrow("staged config refused");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(
      (await readdir(join(path, ".."))).filter((name) => name.startsWith(".patchy-config-"))
    ).toEqual([]);
  });
});
