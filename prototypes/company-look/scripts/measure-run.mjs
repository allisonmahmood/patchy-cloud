// PROTOTYPE for #563: how a run's tool used the look. Static reads of the repo plus the
// agent's transcript. Usage: node measure-run.mjs <run dir> <look|none> [transcript.ndjson]
import * as fs from "node:fs/promises";
import * as path from "node:path";

const [dir, look, transcript] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "..");
const TOKENS = [
  "bg",
  "fg",
  "muted",
  "surface",
  "border",
  "accent",
  "accent-fg",
  "link",
  "danger",
  "font-body",
  "font-display",
  "radius",
  "space"
];

async function walk(d) {
  const out = [];
  for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const sources = (await walk(path.join(dir, "src"))).concat(path.join(dir, "index.html"));
const read = async (f) => fs.readFile(f, "utf8").catch(() => "");
const text = (await Promise.all(sources.map(read))).join("\n");
const cssFiles = [];
for (const f of sources) {
  const body = await read(f);
  const styleBlocks = f.endsWith(".css")
    ? body
    : [...body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  if (styleBlocks.trim())
    cssFiles.push({
      file: path.relative(dir, f),
      lines: styleBlocks.split("\n").length,
      bytes: Buffer.byteLength(styleBlocks)
    });
}
const tokenUse = Object.fromEntries(
  TOKENS.map((t) => [t, (text.match(new RegExp(`var\\(--look-${t}\\b(?!-)`, "g")) ?? []).length])
);
const literals = [
  ...new Set(text.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [])
];
const ownProps = [
  ...new Set([...text.matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]))
].filter((p) => !p.startsWith("--look-"));
const main = await read(path.join(dir, "src/main.tsx"));
const generated = await read(path.join(dir, "patchy/_generated/look.css"));
const lookSource = look === "none" ? "" : await read(path.join(root, "looks", look, "look.css"));

let agent = {};
if (transcript) {
  const lines = (await read(transcript))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const result = lines.find((l) => l.type === "result");
  const reads = lines
    .flatMap((l) => (l.type === "assistant" ? l.message.content : []))
    .filter((c) => c.type === "tool_use")
    .map((c) => c.input.file_path ?? c.input.command ?? "")
    .filter((s) => /SKILL\.md|look\.css|LOOK|logo\.svg/.test(s))
    .map((s) => s.replace(dir + "/", "").slice(0, 120));
  agent = {
    minutes: result ? +(result.duration_ms / 60000).toFixed(1) : null,
    turns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ? +result.total_cost_usd.toFixed(2) : null,
    lookReads: [...new Set(reads)]
  };
}

console.log(
  JSON.stringify(
    {
      run: path.basename(dir),
      look,
      importsLook: /_generated\/look\.css/.test(main),
      generatedLookUntouched: look === "none" ? null : generated === lookSource,
      usesLogo: /_generated\/logo\.svg/.test(text),
      cssFiles,
      inlineStyleProps: (text.match(/style=\{\{/g) ?? []).length,
      tokenUse,
      tokenUseTotal: Object.values(tokenUse).reduce((a, b) => a + b, 0),
      colorMix: (text.match(/color-mix\(/g) ?? []).length,
      colourLiterals: literals,
      ownCustomProperties: ownProps,
      layers: [...new Set([...text.matchAll(/@layer\s+([\w-]+)/g)].map((m) => m[1]))],
      fonts: { fontFace: /@font-face/.test(text), importRule: /@import/.test(text) },
      report: (await read(path.join(dir, "REPORT.md"))).length > 0,
      ...agent
    },
    null,
    1
  )
);
