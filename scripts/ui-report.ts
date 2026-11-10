/**
 * How far first-party pages are from the UI system: what the governance checks will refuse once
 * every page is on the templates. For now it only reports; nothing fails.
 *
 *   pnpm ui:report
 *
 * - **Raw values**: a type size or weight, colour, radius, shadow or control height written in an
 *   app stylesheet chunk instead of drawn from the token block. Geometry (widths, gaps, border
 *   widths, gradient stops) is fine.
 * - **Page styles**: a page module that passes `styles` to `pageResponse`, writes `<style>` or sets
 *   an inline `style`.
 * - **Hand-drawn components**: button, badge, notice or field markup written in a page module
 *   instead of drawn by core's helpers. Hidden inputs are protocol, not fields, and don't count.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Properties whose lengths are visual roles: type size, radius, shadow, control height. */
const sized = /^(font(-size)?|border-radius|box-shadow|(min-)?height)$/;
/** Properties whose colours are visual roles. Their widths and gradient stops are geometry. */
const coloured =
  /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|fill|stroke)$/;

const colour = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i;
/** A named colour, as the whole value of a colour property: `red`, not `transparent`. */
const named = /^(?!(transparent|currentcolor|inherit|initial|unset|none)$)[a-z]+$/i;
const size = /\b\d+(\.\d+)?(px|rem|em)\b|\b[1-9]00\b/i;

const isRaw = (property: string, value: string) => {
  const given = value.trim();
  // Any number is a raw weight or line height: tokens carry both.
  if (property === "font-weight" || property === "line-height") return /\d/.test(given);
  if (
    coloured.test(property) &&
    (colour.test(given) || (/color$|^color$/.test(property) && named.test(given)))
  )
    return true;
  return sized.test(property) && size.test(given);
};

export interface Finding {
  readonly where: string;
  readonly what: string;
}

/** Raw visual values in one chunk's CSS, comments ignored. */
export const rawValues = (chunk: string, css: string): Finding[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)]
    .filter(([, property, value]) => isRaw(property!, value!))
    .map(([, property, value]) => ({ where: chunk, what: `${property}: ${value!.trim()}` }));

/** Page styles and hand-drawn components in one page module's source. */
export const pageFindings = (file: string, source: string): Finding[] => {
  const found: Finding[] = [];
  const add = (what: string, pattern: RegExp) => {
    const count = [...source.matchAll(pattern)].length;
    if (count > 0) found.push({ where: file, what: `${what} ×${count}` });
  };
  add("passes styles to pageResponse", /\bstyles:\s/g);
  add("writes <style>", /<style\b/g);
  add("sets an inline style", /\sstyle="/g);
  // A <button>, or anything else drawn as one, such as a link with the btn class.
  add("draws a button", /<button\b|<(?!button\b)[a-z]+\b[^>]*class="btn\b/g);
  add("draws a badge", /class="(pill|tag|badge)\b/g);
  add("draws a notice", /class="(note|notice)\b/g);
  add("draws a field", /<(input(?![^>]*type="hidden")|textarea|select)\b/g);
  return found;
};

/** Page modules: TypeScript under packages/<name>/src, outside core, tests and the CLI. */
const pageModules = async (root: string) => {
  const packages = path.join(root, "packages");
  const files: string[] = [];
  for (const name of await readdir(packages)) {
    if (["core", "patchy", "sdk"].includes(name)) continue;
    const src = path.join(packages, name, "src");
    const entries = await readdir(src, { recursive: true }).catch(() => []);
    for (const entry of entries)
      if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.includes("test/"))
        files.push(path.join(src, entry));
  }
  return files.sort();
};

const main = async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const { chunks } = await import("../packages/core/src/styles/index.js");
  const raws = Object.entries(chunks)
    .filter(([name]) => name !== "fonts" && name !== "tokens")
    .flatMap(([name, css]) => rawValues(name, css));
  const pages = (
    await Promise.all(
      (await pageModules(root)).map(async (file) =>
        pageFindings(path.relative(root, file), await readFile(file, "utf8"))
      )
    )
  ).flat();
  const byChunk = Object.groupBy(raws, (finding) => finding.where);
  console.log(`Raw visual values in app CSS: ${raws.length}`);
  for (const [chunk, found] of Object.entries(byChunk))
    console.log(
      `  ${chunk}: ${found!.length} (${found!
        .slice(0, 3)
        .map((f) => f.what)
        .join("; ")})`
    );
  console.log(`\nPage modules off the system: ${new Set(pages.map((f) => f.where)).size}`);
  for (const finding of pages) console.log(`  ${finding.where}: ${finding.what}`);
  console.log("\nReport only: nothing here fails the build yet.");
};

if (import.meta.main) await main();
