// PROTOTYPE for #311: esbuild bundles server/ into one ESM guest module per
// "version" and emits a manifest of module.handler -> kind for the host.
import { build } from "esbuild";
import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modules = readdirSync(join(here, "server"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.replace(/\.ts$/, ""));

// Virtual entry: the guest Worker's default export. It dispatches to the
// module-qualified handler and hands it a ctx whose table operations go over
// the `callbacks` loopback stub in ctx.props (the guest never sees a token).
const entry = `
${modules.map((m) => `import * as ${m} from "./server/${m}.ts";`).join("\n")}
const modules = { ${modules.join(", ")} };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
export default {
  async fetch(req, env, ctx) {
    const { handler, args, viewer } = await req.json();
    if (handler === "__ping") return json({ ok: true, result: "loaded" });
    const [m, f] = handler.split(".");
    const def = modules[m]?.[f];
    if (!def) return json({ ok: false, error: "no_such_handler" }, 404);
    const cb = ctx.props.callbacks;
    const c = {
      viewer,
      tables: {
        list: (table, where) => cb.call("tables.list", { table, where }),
        insert: (table, row) => cb.call("tables.insert", { table, row }),
        update: (table, where, set) => cb.call("tables.update", { table, where, set }),
      },
      run: { sleep: (ms) => cb.call("util.sleep", { ms }) },
      log: (...a) => console.log("[guest]", ...a),
    };
    try {
      return json({ ok: true, result: await def.handler(c, args ?? {}) });
    } catch (e) {
      return json({ ok: false, error: String(e?.message ?? e) });
    }
  },
};
`;

mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "entry.gen.ts"), entry);

const manifest = {};
for (const m of modules) {
  const mod = await import(join(here, "server", `${m}.ts`));
  for (const [name, def] of Object.entries(mod)) manifest[`${m}.${name}`] = def.kind;
}
writeFileSync(join(here, "dist", "manifest.json"), JSON.stringify(manifest, null, 2));

for (const version of ["v1", "v2"]) {
  await build({
    entryPoints: [join(here, "entry.gen.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    define: { PATCH_VERSION: JSON.stringify(version) },
    outfile: join(here, "dist", `${version}.js`),
    logLevel: "warning"
  });
}
console.log("built", modules, "->", Object.keys(manifest).length, "handlers, versions v1 v2");
