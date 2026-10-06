// PROTOTYPE for #563: screenshots a run's tool in the dev loop. With --fresh it wipes local
// rows first and shoots the empty state, presses "Load sample data" and shoots the list.
// Without it, it shoots the page as it is. The caller sets PATH, PATCHY_STATE_DIR and
// PATCHY_PROTOTYPE_LOOK. Usage: node shoot-run.mjs <run dir> <out prefix> [--fresh]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const [dir, out, flag] = process.argv.slice(2);
const fresh = flag === "--fresh";
const patchy = (...args) =>
  execFileSync("pnpm", ["--silent", "patchy", ...args], { cwd: dir, encoding: "utf8" });
try {
  patchy("dev", "stop");
} catch {}
if (fresh) await fs.rm(path.join(dir, ".patchy"), { recursive: true, force: true });
const started = JSON.parse(patchy("dev", "--json").trim().split("\n").at(-1));
if (!started.ok) throw new Error(JSON.stringify(started));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(started.url, { waitUntil: "load" });
await page.waitForTimeout(3500);
const content = () => page.frames().find((f) => f.url().includes("/~content/")) ?? page.mainFrame();

async function shoot(name) {
  const height = await content().evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1280, height: Math.min(Math.max(height + 80, 900), 4000) });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}-${name}.png` });
  console.log(`${out}-${name}.png (${height}px)`);
}

if (fresh) {
  await shoot("empty");
  const button = content().getByRole("button", { name: /load sample data/i });
  await button.click({ timeout: 5000 });
  await page.waitForTimeout(3000);
  await page.setViewportSize({ width: 1280, height: 900 });
}
await shoot(fresh ? "loaded" : "page");
if (errors.length) console.log("errors", errors);
await browser.close();
patchy("dev", "stop");
