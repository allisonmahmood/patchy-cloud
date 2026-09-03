#!/usr/bin/env node
/**
 * PROTOTYPE for #131 — throwaway driver for the confirm page. Opens the
 * device URL `patchy login` printed, walks the door and the portal as a
 * +clerk_test user, screenshots the three copy variants, then presses
 * Confirm or Deny and prints what the page said.
 *
 *   node scripts/prototype/patchy-login.mjs <deviceUrl> confirm|deny|look [flags]
 *
 * Flags
 *   --machine NAME  what to type into the machine-name field (default: leave the prefill)
 *   --v a|b|c       which variant to submit from (default a)
 *   --delay N       sleep N seconds on the confirm page before submitting
 *                   (N > 65 lets the session token go stale under the form: #122 item 9)
 *   --email ADDR    the +clerk_test address (default door+clerk_test@example.com, code 424242)
 *   --extras        also screenshot the bare /login/device and an unknown code
 *   --tag NAME      screenshot prefix
 *
 * Screenshots land in .local/prototype/. Cookie and token values are never printed.
 */
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, "..", "..");
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const [deviceUrlRaw, action = "look"] = args;
if (!deviceUrlRaw || !["confirm", "deny", "look"].includes(action)) {
  console.error(
    "usage: node scripts/prototype/patchy-login.mjs <deviceUrl> confirm|deny|look [--machine NAME] [--v a|b|c] [--delay N] [--email ADDR] [--extras] [--tag NAME]"
  );
  process.exit(1);
}
const machine = valueOf("--machine");
const variant = valueOf("--v") ?? "a";
const delay = Number(valueOf("--delay") ?? 0);
const email = valueOf("--email") ?? "door+clerk_test@example.com";
const extras = args.includes("--extras");
const tag = valueOf("--tag") ?? "login";
const shotsDir = path.join(worktree, ".local", "prototype");
const shot = (name) => path.join(shotsDir, `${tag}-${name}.png`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Clerk test user through the Backend API -------------------------------------

const devEnvFile = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "patchy-cloud",
  "dev.env"
);
const devEnv = Object.fromEntries(
  readFileSync(devEnvFile, "utf8")
    .split("\n")
    .map((line) => /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line))
    .filter(Boolean)
    .map(([, key, raw]) => [key, raw.replace(/^(['"])(.*)\1$/, "$2")])
);
const bapi = async (method, route, body) => {
  const response = await fetch(`https://api.clerk.com/v1${route}`, {
    method,
    headers: {
      authorization: `Bearer ${devEnv.CLERK_SECRET_KEY}`,
      "content-type": "application/json"
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok)
    throw new Error(`${method} ${route} -> ${response.status} ${await response.text()}`);
  return response.json();
};
const existing = await bapi("GET", `/users?email_address=${encodeURIComponent(email)}`);
if (existing.length === 0) {
  await bapi("POST", "/users", {
    email_address: [email],
    first_name: "Door",
    last_name: "Tester",
    skip_password_requirement: true
  });
}

// --- the browser ------------------------------------------------------------------

mkdirSync(shotsDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
});
const page = await context.newPage();
const deviceUrl = new URL(deviceUrlRaw);
const origin = deviceUrl.origin;
const clean = (url) =>
  !url.searchParams.has("__clerk_handshake") && !url.searchParams.has("__clerk_db_jwt");
const onPortal = (url) => url.hostname.endsWith("accounts.dev");
const text = async (selector) => (await page.locator(selector).first().textContent())?.trim();
const describe = async (label) => {
  const status = page.url();
  console.log(`\n[${label}] ${status.replace(/code=[^&]+/, "code=…")}`);
  console.log(`  kicker: ${JSON.stringify(await text(".kicker"))}`);
  const h1 = (await page.locator("h1").count()) ? await text("h1") : null;
  if (h1) console.log(`  h1:     ${JSON.stringify(h1)}`);
  console.log(`  lede:   ${JSON.stringify(await text("p.lede"))}`);
};

const started = Date.now();
const first = await page.goto(deviceUrl.href, { waitUntil: "domcontentloaded" });
console.log(`Door: ${first?.status()} at ${page.url().replace(/code=[^&]+/, "code=…")}`);
if (first?.status() === 401) {
  await page.locator("a", { hasText: "Sign in" }).click();
  await page.waitForURL((url) => onPortal(url) || url.origin === origin, { timeout: 30_000 });
  const identifier = page.locator('input[name="identifier"]');
  const form = await identifier.waitFor({ timeout: 15_000 }).then(
    () => true,
    () => false
  );
  if (form) {
    await identifier.fill(email);
    await identifier.press("Enter");
    const code = page.locator('input[autocomplete="one-time-code"], input[name="code"]').first();
    await code.waitFor({ timeout: 30_000 });
    await sleep(800);
    await code.click();
    await page.keyboard.type("424242", { delay: 60 });
    let left = await page
      .waitForURL((url) => url.origin === origin, { timeout: 8_000 })
      .then(
        () => true,
        () => false
      );
    if (!left) {
      await page.locator('button:has-text("Continue")').first().click();
      left = await page
        .waitForURL((url) => url.origin === origin, { timeout: 8_000 })
        .then(
          () => true,
          () => false
        );
    }
    if (!left) {
      await code.fill("424242");
      await page.locator('button:has-text("Continue")').first().click();
    }
  }
  try {
    await page.waitForURL(
      (url) => url.origin === origin && url.pathname === deviceUrl.pathname && clean(url),
      { timeout: 60_000 }
    );
  } catch (error) {
    await page.screenshot({ path: shot("stuck"), fullPage: true });
    console.log(
      `Stuck at ${page.url().replace(/code=[^&]+/, "code=…")}; body starts: ${JSON.stringify((await page.locator("body").innerText()).slice(0, 300))}`
    );
    throw error;
  }
}
console.log(`Signed in and on the device page after ${Date.now() - started} ms.`);
const landed = page.url();
await describe("device page as opened");

// Every variant, screenshotted; then the one to submit from.
const withVariant = (v) => {
  const url = new URL(landed);
  url.searchParams.set("v", v);
  return url.href;
};
const isConfirmPage = (await page.locator('input[name="machine"]').count()) > 0;
if (landed.includes("code=") && isConfirmPage) {
  for (const v of ["a", "b", "c"]) {
    await page.goto(withVariant(v), { waitUntil: "domcontentloaded" });
    await page.screenshot({ path: shot(`confirm-${v}`), fullPage: true });
    console.log(
      `  variant ${v}: prefilled machine name = ${JSON.stringify(await page.locator('input[name="machine"]').inputValue())}`
    );
  }
  await page.goto(withVariant(variant), { waitUntil: "domcontentloaded" });
}

if (extras) {
  await page.goto(`${origin}/login/device`, { waitUntil: "domcontentloaded" });
  await describe("bare /login/device");
  await page.screenshot({ path: shot("bare"), fullPage: true });
  await page.goto(`${origin}/login/device?code=ZZZZ-ZZZZ`, { waitUntil: "domcontentloaded" });
  await describe("unknown code");
  await page.screenshot({ path: shot("unknown"), fullPage: true });
  await page.goto(withVariant(variant), { waitUntil: "domcontentloaded" });
}

if (action !== "look" && landed.includes("code=") && isConfirmPage) {
  if (delay > 0) {
    console.log(`\nWaiting ${delay}s on the confirm page before pressing ${action}...`);
    await sleep(delay * 1_000);
  }
  if (machine !== undefined) await page.locator('input[name="machine"]').fill(machine);
  const posted = [];
  page.on("response", (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      posted.push(`${response.status()} ${request.method()} ${new URL(response.url()).pathname}`);
    }
  });
  await page.locator(`form[action="/login/device"] button[value="${action}"]`).click();
  await page.waitForLoadState("domcontentloaded");
  await sleep(300);
  console.log(`\nAfter ${action}: hops ${JSON.stringify(posted)}`);
  await describe(`after ${action}`);
  await page.screenshot({ path: shot(`after-${action}`), fullPage: true });
}

await browser.close();
