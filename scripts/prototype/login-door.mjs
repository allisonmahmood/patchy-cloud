#!/usr/bin/env node
/**
 * PROTOTYPE for #119 — throwaway driver for the login door. Walks the whole
 * round trip a person makes, headlessly, and prints what the wire did.
 *
 *   node scripts/prototype/login-door.mjs <patchUrl> [flags]
 *   node scripts/prototype/login-door.mjs --print-jwt-key
 *
 * Flags
 *   --wait N        after the first served page, sleep N seconds, reload the
 *                   patch and record the hops (N > 60 forces the handshake).
 *   --sign-out      after the served page, open /login/device, submit its
 *                   sign-out form, reload the patch and record the hops.
 *   --email ADDR    the +clerk_test address to sign in as
 *                   (default door+clerk_test@example.com; code 424242).
 *   --headed        show the browser.
 *   --log PATH      the dev.log to mine for [door]/[clerk-net] lines
 *                   (default <worktree>/.local/dev/dev.log).
 *   --print-jwt-key fetch the instance JWKS with the secret key and print the
 *                   RSA public key as PEM, for CLERK_JWT_KEY. Then exit.
 *
 * Reads CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY from
 * $XDG_CONFIG_HOME/patchy-cloud/dev.env. Screenshots land in .local/prototype/.
 * Every value that could be a secret (cookie values, tokens, query values) is
 * printed as a length only.
 */
import { createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, "..", "..");
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const patchUrl = args.find((arg) => /^https?:\/\//.test(arg));
const waitSeconds = Number(valueOf("--wait") ?? 0);
const email = valueOf("--email") ?? "door+clerk_test@example.com";
const logFile = valueOf("--log") ?? path.join(worktree, ".local", "dev", "dev.log");
const shotsDir = path.join(worktree, ".local", "prototype");

// --- the developer's Clerk keys ------------------------------------------------

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
const secretKey = devEnv.CLERK_SECRET_KEY;
if (!secretKey) throw new Error(`No CLERK_SECRET_KEY in ${devEnvFile}`);

const bapi = async (method, route, body) => {
  const response = await fetch(`https://api.clerk.com/v1${route}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  if (!response.ok)
    throw new Error(`BAPI ${method} ${route} -> ${response.status} ${JSON.stringify(json)}`);
  return json;
};

if (has("--print-jwt-key")) {
  const { keys } = await bapi("GET", "/jwks");
  const pem = createPublicKey({ key: keys[0], format: "jwk" }).export({
    type: "spki",
    format: "pem"
  });
  process.stdout.write(pem);
  process.exit(0);
}

if (!patchUrl) {
  console.error(
    "usage: node scripts/prototype/login-door.mjs <patchUrl> [--wait N] [--sign-out] [--email ADDR] [--headed] [--log PATH]"
  );
  process.exit(2);
}

// --- helpers -------------------------------------------------------------------

const redactUrl = (raw) => {
  try {
    const url = new URL(raw);
    const keys = [...url.searchParams.keys()];
    return `${url.origin}${url.pathname}${keys.length ? `?[${keys.join(",")}]` : ""}`;
  } catch {
    return raw;
  }
};

const redactCookie = (directive) => {
  const [pair, ...attributes] = directive.split(";");
  const equals = pair.indexOf("=");
  if (equals === -1) return directive;
  return [
    `${pair.slice(0, equals)}=<len ${pair.length - equals - 1}>`,
    ...attributes.map((a) => a.trim())
  ].join("; ");
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const printHops = (title, hops) => {
  console.log(`\n### ${title}\n`);
  console.log("| # | +ms | status | url | set-cookie |");
  console.log("|---|-----|--------|-----|------------|");
  for (const hop of hops) {
    const cookies = hop.setCookies.length ? hop.setCookies.map((c) => `\`${c}\``).join("<br>") : "";
    console.log(`| ${hop.n} | ${hop.ms} | ${hop.status} | ${hop.url} | ${cookies} |`);
  }
  console.log(
    `\n${hops.length} hops, ${hops.reduce((sum, hop) => sum + hop.ms, 0)} ms wall from the click.`
  );
};

const printJar = async (context, title) => {
  const cookies = await context.cookies();
  console.log(`\n### ${title}\n`);
  console.log("| name | domain | path | sameSite | httpOnly | secure | expires | value |");
  console.log("|------|--------|------|----------|----------|--------|---------|-------|");
  for (const c of cookies) {
    const expires = c.expires === -1 ? "session" : new Date(c.expires * 1000).toISOString();
    console.log(
      `| ${c.name} | ${c.domain} | ${c.path} | ${c.sameSite} | ${c.httpOnly} | ${c.secure} | ${expires} | <len ${c.value.length}> |`
    );
  }
};

const printServerLog = (since) => {
  console.log("\n### server log ([door] / [clerk-net]) during the run\n");
  if (!existsSync(logFile)) {
    console.log(`(no log at ${logFile}; pass --log or run the server under pnpm dev)`);
    return;
  }
  const lines = readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => /\[(door|clerk-net|clerk)\]/.test(line))
    .filter((line) => {
      const stamp = Date.parse(line.split(" ")[0]);
      return Number.isNaN(stamp) || stamp >= since - 1000;
    });
  console.log("```");
  for (const line of lines) console.log(line.replace(/^\S+ \[server\] /, ""));
  console.log("```");
};

// --- the test user -------------------------------------------------------------

const existing = await bapi("GET", `/users?email_address=${encodeURIComponent(email)}`);
const user =
  existing[0] ??
  (await bapi("POST", "/users", {
    email_address: [email],
    first_name: "Door",
    last_name: "Tester",
    skip_password_requirement: true
  }));
console.log(`Test user ${email} -> ${user.id} (${existing.length ? "existing" : "created"})`);
console.log(`Patch URL ${patchUrl}`);

// --- the browser ----------------------------------------------------------------

mkdirSync(shotsDir, { recursive: true });
const runStart = Date.now();
const browser = await chromium.launch({
  headless: !has("--headed"),
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
});
// A regular Chrome UA on purpose: with the default "HeadlessChrome" UA the
// Frontend API omits `Secure` from the handshake's `SameSite=None` cookies,
// and Chromium then refuses them all, so the handshake loops to the door.
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
});
const page = await context.newPage();
const patch = new URL(patchUrl);

let hops = [];
let recording = false;
let lastHopAt = Date.now();
page.on("response", async (response) => {
  const request = response.request();
  if (!recording || !request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
  const now = Date.now();
  let setCookies = [];
  try {
    setCookies = (await response.headersArray())
      .filter((h) => h.name.toLowerCase() === "set-cookie")
      .map((h) => redactCookie(h.value));
  } catch {
    // A redirect response's headers can be gone by the time we ask; keep the hop.
  }
  hops.push({
    n: hops.length + 1,
    ms: now - lastHopAt,
    status: response.status(),
    url: redactUrl(response.url()),
    setCookies
  });
  lastHopAt = now;
});
const record = () => {
  hops = [];
  recording = true;
  lastHopAt = Date.now();
};
const stop = () => {
  recording = false;
  return hops;
};

const onPatch = (url) =>
  url.origin === patch.origin &&
  url.pathname === patch.pathname &&
  !url.searchParams.has("__clerk_handshake") &&
  !url.searchParams.has("__clerk_db_jwt");
const assertServed = async (label) => {
  await page.waitForLoadState("domcontentloaded");
  const frames = await page.locator("iframe.patch-frame").count();
  const html = await page.content();
  if (frames !== 1 || !html.includes("<!-- patch:")) {
    await page.screenshot({ path: path.join(shotsDir, `${label}-unexpected.png`), fullPage: true });
    throw new Error(
      `${label}: expected the served patch, got ${page.url()} (${frames} patch frames)`
    );
  }
  console.log(`${label}: served patch rendered at ${redactUrl(page.url())}`);
};

try {
  // 1. The door. Recorded too: on a dev instance a cookie-less first visit is
  // itself a handshake (dev-browser-missing), so this is the first round trip.
  record();
  const first = await page.goto(patchUrl, { waitUntil: "domcontentloaded" });
  const firstHops = stop();
  const doorStatus = first?.status();
  const signIn = page.locator("a", { hasText: "Sign in" });
  console.log(
    `Door: ${doorStatus} ${redactUrl(page.url())} csp=${JSON.stringify(first?.headers()["content-security-policy"])} cache-control=${first?.headers()["cache-control"]}`
  );
  if (doorStatus !== 401 || (await signIn.count()) !== 1) {
    await page.screenshot({ path: path.join(shotsDir, "door-unexpected.png"), fullPage: true });
    throw new Error(
      `Expected the 401 door page with one Sign in link, got ${doorStatus} with ${await signIn.count()} links`
    );
  }
  await page.screenshot({ path: path.join(shotsDir, "door.png"), fullPage: true });
  printHops("Hops on the first, cookie-less visit (pasted link to door page)", firstHops);
  await printJar(context, "Cookie jar on the door page");

  // 2. Sign in on the portal.
  record();
  await signIn.click();
  await page.waitForURL((url) => url.hostname.endsWith("accounts.dev"), { timeout: 30_000 });
  const identifier = page.locator('input[name="identifier"]');
  await identifier.waitFor({ timeout: 30_000 });
  await identifier.fill(email);
  await page.screenshot({ path: path.join(shotsDir, "portal-email.png"), fullPage: true });
  await identifier.press("Enter");
  const code = page.locator('input[autocomplete="one-time-code"], input[name="code"]').first();
  await code.waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(shotsDir, "portal-code.png"), fullPage: true });
  await code.focus();
  await page.keyboard.type("424242");
  // The portal usually submits on the sixth digit; when it does not, press Continue.
  const left = await page
    .waitForURL((url) => url.origin === patch.origin, { timeout: 8_000 })
    .then(
      () => true,
      () => false
    );
  if (!left) {
    await page.screenshot({ path: path.join(shotsDir, "portal-after-code.png"), fullPage: true });
    console.log(
      `Portal did not submit on its own (still at ${redactUrl(page.url())}); pressing Continue.`
    );
    await page.locator('button:has-text("Continue")').first().click();
  }
  await page.waitForURL(onPatch, { timeout: 60_000 });
  await assertServed("Sign-in");
  const signInHops = stop();
  await page.screenshot({ path: path.join(shotsDir, "served.png"), fullPage: true });
  printHops("Hops from the Sign in click to the served page", signInHops);
  await printJar(context, "Cookie jar after sign-in");

  // 3. Optional: wait, then reload to watch the handshake.
  if (waitSeconds > 0) {
    console.log(`\nWaiting ${waitSeconds}s...`);
    await sleep(waitSeconds * 1000);
    record();
    await page.goto(patchUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(onPatch, { timeout: 60_000 });
    await assertServed(`Reload after ${waitSeconds}s`);
    printHops(`Hops on reload after ${waitSeconds}s`, stop());
    await printJar(context, `Cookie jar after the reload`);
  }

  // 4. Optional: sign out through the device page's form, then reload.
  if (has("--sign-out")) {
    record();
    await page.goto(new URL("/login/device?code=WXYZ-1234", patch.origin).href, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForURL(
      (url) => url.pathname === "/login/device" && url.searchParams.get("code") === "WXYZ-1234",
      { timeout: 60_000 }
    );
    console.log(
      `Device page: ${redactUrl(page.url())} code survived=${page.url().includes("code=WXYZ-1234")}`
    );
    await page.screenshot({ path: path.join(shotsDir, "device.png"), fullPage: true });
    printHops("Hops to the device page", stop());
    record();
    await page.locator('form[action="/sign-out"] button').click();
    await page.waitForLoadState("domcontentloaded");
    console.log(`After sign-out: ${redactUrl(page.url())}`);
    await page.goto(patchUrl, { waitUntil: "domcontentloaded" });
    const again = stop();
    printHops("Hops for sign-out and the reload after it", again);
    await page.screenshot({ path: path.join(shotsDir, "after-sign-out.png"), fullPage: true });
    await printJar(context, "Cookie jar after sign-out");
  }

  printServerLog(runStart);
  console.log("\nOK");
} catch (error) {
  // Whatever step failed, leave the evidence: the page as it was, and where.
  console.log(
    `\nFAILED at ${redactUrl(page.url())} (title: ${JSON.stringify(await page.title().catch(() => "?"))})`
  );
  await page
    .screenshot({ path: path.join(shotsDir, "failure.png"), fullPage: true })
    .catch(() => {});
  printServerLog(runStart);
  throw error;
} finally {
  await browser.close();
}
