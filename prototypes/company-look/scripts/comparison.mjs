// PROTOTYPE for #563: builds the self-contained comparison page from comparison.html,
// inlining every `shot:<name>` image from shots/ as a data URI, or with a base URL pointing
// at them (PatchPage caps a page at 512 KiB). Usage: node comparison.mjs [base URL]
//   →  .local/company-look/comparison.html
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(root, "../../.local/company-look");
await fs.mkdir(out, { recursive: true });
let html = await fs.readFile(path.join(root, "comparison.html"), "utf8");
const names = [...new Set([...html.matchAll(/shot:([\w-]+)/g)].map((m) => m[1]))];
const base = process.argv[2];
for (const name of names) {
  const bytes = await fs.readFile(path.join(root, "shots", `${name}.webp`));
  const src = base ? `${base}/${name}.webp` : `data:image/webp;base64,${bytes.toString("base64")}`;
  html = html.replaceAll(`shot:${name}"`, `${src}"`);
}
await fs.writeFile(path.join(out, "comparison.html"), html.replace(/<!-- PROTOTYPE[^>]*-->\n/, ""));
console.log(
  path.join(out, "comparison.html"),
  `${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB`,
  `${names.length} images`
);
