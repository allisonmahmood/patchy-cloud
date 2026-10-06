// PROTOTYPE for #563: renders the specimen for each look (or the named ones) to
// .local/company-look/specimen-<look>.{html,png}. Usage: node specimen.mjs [look...]
import { chromium } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(root, "../../.local/company-look");
await fs.mkdir(out, { recursive: true });
const looks = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (await fs.readdir(path.join(root, "looks"))).sort();
const template = await fs.readFile(path.join(root, "specimen/specimen.html"), "utf8");
const browser = await chromium.launch();
for (const look of looks) {
  const dir = path.join(root, "looks", look);
  const css = await fs.readFile(path.join(dir, "look.css"), "utf8");
  const logo = await fs.readFile(path.join(dir, "logo.svg"));
  const company =
    /^# (.+?)'s look/m.exec(await fs.readFile(path.join(dir, "LOOK.md"), "utf8"))?.[1] ?? look;
  const html = template
    .replace("/*LOOK_CSS*/", () => css)
    .replace("/*LOGO_URL*/", `data:image/svg+xml;base64,${logo.toString("base64")}`)
    .replace("/*COMPANY*/", company);
  const file = path.join(out, `specimen-${look}.html`);
  await fs.writeFile(file, html);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`file://${file}`);
  await page.screenshot({ path: path.join(out, `specimen-${look}.png`), fullPage: true });
  await page.close();
  console.log(`${look}: ${path.join(out, `specimen-${look}.png`)}`);
}
await browser.close();
