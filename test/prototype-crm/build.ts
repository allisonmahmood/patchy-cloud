// PROTOTYPE for #315: builds a fixture patch the way `patchy publish` does, without a repo:
// the server bundle from the CLI's own guest entry, its handler map read from the bundle, and
// the page as one HTML document over the packed `patchy/client` and `patchy/preact`.
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { guestEntry } from "../../packages/patchy/src/serverBuild.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = path.join(root, "packages/patchy/dist");
const alias = {
  "patchy/server": path.join(dist, "server.js"),
  "patchy/config": path.join(dist, "config.js"),
  "patchy/client": path.join(dist, "client.js"),
  "patchy/preact": path.join(dist, "preact.js")
};

export interface Built {
  readonly server: string;
  readonly handlers: Record<string, unknown>;
  readonly html: string;
}

export async function buildPatch(name: "crm" | "contracts", title: string): Promise<Built> {
  const source = path.join(root, "test/prototype-crm/fixtures", name);
  const work = await mkdtemp(path.join(os.tmpdir(), `prototype-crm-${name}-`));
  try {
    await cp(path.join(source, "server"), path.join(work, "server"), { recursive: true });
    await mkdir(path.join(work, "patchy/_generated"), { recursive: true });
    await cp(path.join(source, "generated.ts"), path.join(work, "patchy/_generated/server.ts"));
    const modules = (await readdir(path.join(work, "server")))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => file.slice(0, -3))
      .sort();
    await mkdir(path.join(work, ".patchy"), { recursive: true });
    await writeFile(path.join(work, ".patchy/server-entry.ts"), guestEntry(modules));
    const bundled = await build({
      entryPoints: [path.join(work, ".patchy/server-entry.ts")],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      write: false,
      alias,
      logLevel: "silent"
    });
    const server = bundled.outputFiles[0]!.text;
    // What the engine's inspection reads: the same `__describe` the publish path compares.
    const file = path.join(work, "server.mjs");
    await writeFile(file, server);
    const guest = (await import(pathToFileURL(file).href)) as {
      default: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
    };
    const described = (await (
      await guest.default.fetch(
        new Request("http://guest/", {
          method: "POST",
          body: JSON.stringify({ handler: "__describe" })
        }),
        {},
        { props: {} }
      )
    ).json()) as { ok: boolean; handlers: Record<string, unknown> };
    if (!described.ok) throw new Error(`describe failed for ${name}`);
    const page = await build({
      entryPoints: [
        path.join(
          source,
          (await readdir(source)).find((entry) => entry.startsWith("page."))!
        )
      ],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      write: false,
      jsx: "automatic",
      jsxImportSource: "preact",
      alias,
      nodePaths: [path.join(root, "packages/patchy/node_modules")],
      logLevel: "silent"
    });
    const script = page.outputFiles[0]!.text.replaceAll("</script", "<\\/script");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><div id="root"></div><script>${script}</script></body></html>`;
    return { server, handlers: described.handlers, html };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
