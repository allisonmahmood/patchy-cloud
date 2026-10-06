// PROTOTYPE for #563: the checks `patchy look publish` would run, plus extra pairs measured
// to decide which belong in the rule. Node only, no browser, as the CLI would run them.
// Usage: node check.mjs [look...]
import * as fs from "node:fs/promises";
import * as path from "node:path";

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
const REQUIRED_PAIRS = [
  ["fg", "bg"],
  ["muted", "bg"],
  ["accent-fg", "accent"],
  ["link", "bg"]
];
// Measured, not enforced: candidates for the rule.
const EXTRA_PAIRS = [
  ["fg", "surface"],
  ["muted", "surface"],
  ["accent", "bg"],
  ["danger", "bg"],
  ["border", "bg"]
];

/** sRGB [r, g, b] in 0..255 from hex or rgb()/rgba(); undefined for anything else. */
function parseColour(value) {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (m) return m.slice(1, 4).map(Number);
  if (v === "white") return [255, 255, 255];
  if (v === "black") return [0, 0, 0];
  return undefined;
}

const luminance = ([r, g, b]) => {
  const c = [r, g, b].map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const looks = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (await fs.readdir(path.join(root, "looks"))).sort();
const results = [];
for (const look of looks) {
  const dir = path.join(root, "looks", look);
  const css = await fs.readFile(path.join(dir, "look.css"), "utf8");
  const problems = [];
  if (!/^\s*@layer look\s*\{/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")))
    problems.push("not wrapped in @layer look");
  const declared = [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)];
  const values = new Map(declared.map(([, name, value]) => [name, value.trim()]));
  for (const token of TOKENS)
    if (!values.has(`--look-${token}`)) problems.push(`missing --look-${token}`);
  for (const [name] of values)
    if (!TOKENS.some((t) => name === `--look-${t}`)) problems.push(`extra custom property ${name}`);
  if (/@import/i.test(css)) problems.push("@import");
  for (const [, target] of css.matchAll(/url\(\s*['"]?([^'")]+)/gi))
    if (!target.startsWith("data:")) problems.push(`external url(${target})`);
  const colour = (t) => parseColour(values.get(`--look-${t}`) ?? "");
  const pair = ([a, b]) => {
    const [x, y] = [colour(a), colour(b)];
    return x && y ? contrast(x, y) : undefined;
  };
  const required = REQUIRED_PAIRS.map((p) => {
    const ratio = pair(p);
    if (ratio === undefined) problems.push(`can't parse ${p.join("/")}`);
    else if (ratio < 4.5) problems.push(`${p[0]} on ${p[1]} is ${ratio.toFixed(2)}:1`);
    return `${p[0]}/${p[1]} ${ratio?.toFixed(2) ?? "?"}`;
  });
  const extra = EXTRA_PAIRS.map((p) => `${p[0]}/${p[1]} ${pair(p)?.toFixed(2) ?? "?"}`);
  const sizes = {};
  for (const name of await fs.readdir(dir))
    sizes[name] = (await fs.stat(path.join(dir, name))).size;
  const elements = css.replace(/:root\s*\{[^}]*\}/, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const literals = (elements.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi) ?? []).length;
  results.push({
    look,
    ok: problems.length === 0,
    problems,
    required,
    extra,
    sizes,
    colourLiteralsOutsideTokens: literals,
    scheme: /color-scheme:\s*([a-z ]+)/.exec(css)?.[1] ?? null
  });
}
console.log(JSON.stringify(results, null, 1));
