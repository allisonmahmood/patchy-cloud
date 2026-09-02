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
 *   --log PATH      the server log to mine for [door]/[clerk-net] lines
 *                   (default <worktree>/.local/dev/dev.log). Only what the
 *                   server appended during the run is printed.
 *   --print-jwt-key fetch the instance JWKS with the secret key and print the
 *                   RSA public key as PEM, for CLERK_JWT_KEY. Then exit.
 *   --mode page|redirect
 *                   the server's PROTOTYPE_DOOR_MODE: `page` (default) expects
 *                   the 401 door and clicks its Sign in link; `redirect`
 *                   expects the first visit to be carried to the portal.
 *   --start-at URL  the first URL opened, and the one the portal must bring
 *                   the person back to (default: the patch URL). Give the
 *                   device URL to walk /login/device?code=... signed out.
 *   --device confirm|deny
 *                   on the device page (opened after the patch when the run
 *                   did not start there), type a machine name and submit that
 *                   action, then open the patch and expect it served.
 *   --device-delay N
 *                   sleep N seconds on the device page before submitting
 *                   (N > 60 lets the session token expire under the form).
 *   --outsider      expect the 403 "not in a company" page after sign-in,
 *                   then sign out through its form.
 *   --then-email ADDR
 *                   after --outsider's sign-out, go through the door again as
 *                   ADDR and expect the served patch.
 *   --drop SPEC     after the served page, delete cookies on the patch host
 *                   per SPEC and reload: a comma list of names, `all`, or
 *                   `all-but:<comma list>`. Repeatable; runs in order. The
 *                   portal's own cookies are never touched.
 *   --tag NAME      prefix for the screenshots, so parallel runs keep their
 *                   own PNGs.
 *   --save-cookies PATH
 *                   after the served page, write the patch host's cookies as
 *                   one Cookie header line to PATH (mode 0600), for curl.
 *
 * Reads CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY from
 * $XDG_CONFIG_HOME/patchy-cloud/dev.env. Screenshots land in .local/prototype/.
 * Every value that could be a secret (cookie values, tokens, query values) is
 * printed as a length only; the device code is the one test value printed.
 */
import { createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, "..", "..");
const args = process.argv.slice(2);
const valueFlags = new Set([
  "--wait",
  "--email",
  "--log",
  "--mode",
  "--start-at",
  "--device",
  "--device-delay",
  "--then-email",
  "--drop",
  "--tag",
  "--save-cookies"
]);
const has = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const valuesOf = (name) => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));
const patchUrl = args.find(
  (arg, index) => /^https?:\/\//.test(arg) && !valueFlags.has(args[index - 1] ?? "")
);
const waitSeconds = Number(valueOf("--wait") ?? 0);
const email = valueOf("--email") ?? "door+clerk_test@example.com";
const logFile = valueOf("--log") ?? path.join(worktree, ".local", "dev", "dev.log");
const shotsDir = path.join(worktree, ".local", "prototype");
const mode = valueOf("--mode") ?? "page";
const startUrl = valueOf("--start-at") ?? patchUrl;
const deviceAction = valueOf("--device");
const deviceDelay = Number(valueOf("--device-delay") ?? 0);
const outsider = has("--outsider");
const thenEmail = valueOf("--then-email");
const drops = valuesOf("--drop");
const tag = valueOf("--tag");
const saveCookies = valueOf("--save-cookies");
const shot = (name) => path.join(shotsDir, `${tag ? `${tag}-` : ""}${name}.png`);

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

if (
  !patchUrl ||
  !["page", "redirect"].includes(mode) ||
  (deviceAction !== undefined && !["confirm", "deny"].includes(deviceAction))
) {
  console.error(
    "usage: node scripts/prototype/login-door.mjs <patchUrl> [--wait N] [--sign-out] [--email ADDR] [--headed] [--log PATH]\n" +
      "         [--mode page|redirect] [--start-at URL] [--device confirm|deny] [--device-delay N]\n" +
      "         [--outsider] [--then-email ADDR] [--drop SPEC]... [--tag NAME]"
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

// Only what the server appends from here on belongs to this run.
const logOffset = existsSync(logFile) ? statSync(logFile).size : 0;
const printServerLog = () => {
  console.log("\n### server log ([door] / [clerk-net]) during the run\n");
  if (!existsSync(logFile)) {
    console.log(`(no log at ${logFile}; pass --log or run the server under pnpm dev)`);
    return;
  }
  const lines = readFileSync(logFile, "utf8")
    .slice(logOffset)
    .split("\n")
    .filter((line) => /\[(door|clerk-net|clerk)\]/.test(line));
  console.log("```");
  for (const line of lines) console.log(line.replace(/^\S+ \[server\] /, ""));
  console.log("```");
};

// The person's clock: moments since the run started, and how many clicks.
const runStart = Date.now();
const timeline = [];
let clicks = 0;
const mark = (label, { typing = false } = {}) =>
  timeline.push({ label, at: Date.now() - runStart, typing });
const printTimeline = () => {
  console.log("\n### Timeline (ms since the run started)\n");
  console.log("| at | +ms | moment |");
  console.log("|----|-----|--------|");
  let previous = 0;
  for (const moment of timeline) {
    console.log(
      `| ${moment.at} | ${moment.at - previous} | ${moment.label}${moment.typing ? " (typing)" : ""} |`
    );
    previous = moment.at;
  }
  const start = timeline.find((m) => m.label.startsWith("first-visit: navigation start"));
  const served = timeline.find((m) =>
    /^(served page|outsider page shown|device page shown)/.test(m.label)
  );
  if (start && served) {
    let typing = 0;
    let before = 0;
    for (const moment of timeline) {
      if (moment.typing && moment.at <= served.at) typing += moment.at - before;
      before = moment.at;
    }
    console.log(
      `\nFrom the pasted link to "${served.label}": ${served.at - start.at} ms wall, ${typing} ms of it typing, ${served.at - start.at - typing} ms without the typing. ${clicks} click(s) so far.`
    );
  }
  console.log(`\n${clicks} click(s) in the whole run.`);
};

// --- the test users -------------------------------------------------------------

const ensureUser = async (address) => {
  const existing = await bapi("GET", `/users?email_address=${encodeURIComponent(address)}`);
  const user =
    existing[0] ??
    (await bapi("POST", "/users", {
      email_address: [address],
      first_name: "Door",
      last_name: "Tester",
      skip_password_requirement: true
    }));
  console.log(`Test user ${address} -> ${user.id} (${existing.length ? "existing" : "created"})`);
  return user;
};
await ensureUser(email);
if (thenEmail) await ensureUser(thenEmail);
console.log(
  `Patch URL ${patchUrl}${startUrl === patchUrl ? "" : `, starting at ${startUrl}`}, mode ${mode}`
);

// --- the browser ----------------------------------------------------------------

mkdirSync(shotsDir, { recursive: true });
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
const target = new URL(startUrl);
const deviceUrl = new URL("/login/device?code=WXYZ-1234", patch.origin);

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

const clean = (url) =>
  !url.searchParams.has("__clerk_handshake") && !url.searchParams.has("__clerk_db_jwt");
const onPath = (base) => (url) =>
  url.origin === base.origin && url.pathname === base.pathname && clean(url);
const onPatch = onPath(patch);
const onTarget = onPath(target);
const onDevice = onPath(deviceUrl);
const onPortal = (url) => url.hostname.endsWith("accounts.dev");

const click = async (locator) => {
  clicks += 1;
  await locator.click();
};

const text = async (selector) => (await page.locator(selector).first().textContent())?.trim();

const assertServed = async (label) => {
  await page.waitForLoadState("domcontentloaded");
  const frames = await page.locator("iframe.patch-frame").count();
  const html = await page.content();
  if (frames !== 1 || !html.includes("<!-- patch:")) {
    await page.screenshot({ path: shot(`${label}-unexpected`), fullPage: true });
    throw new Error(
      `${label}: expected the served patch, got ${page.url()} (${frames} patch frames)`
    );
  }
  console.log(`${label}: served patch rendered at ${redactUrl(page.url())}`);
};

/**
 * Opens `url` signed out. Page mode: expects the 401 door, screenshots it and
 * clicks Sign in. Redirect mode: expects to be carried to the portal with no
 * click. Either way the hop recorder is running when this returns.
 */
const throughTheDoor = async (url, label) => {
  record();
  mark(`${label}: navigation start`);
  const first = await page.goto(url, { waitUntil: "domcontentloaded" });
  const status = first?.status();
  if (mode === "redirect") {
    if (!onPortal(new URL(page.url()))) {
      await page.screenshot({ path: shot(`${label}-unexpected`), fullPage: true });
      throw new Error(
        `${label}: expected to land on the portal, got ${status} ${redactUrl(page.url())}`
      );
    }
    mark(`${label}: portal shown (no click)`);
    console.log(`Door (redirect mode): landed on ${status} ${redactUrl(page.url())}`);
    printHops(`Hops on the ${label} (pasted link to the portal, redirect mode)`, stop());
    await printJar(context, `Cookie jar on reaching the portal (${label})`);
    record();
    return;
  }
  const signIn = page.locator("a", { hasText: "Sign in" });
  console.log(
    `Door: ${status} ${redactUrl(page.url())} csp=${JSON.stringify(first?.headers()["content-security-policy"])} cache-control=${first?.headers()["cache-control"]}`
  );
  if (status !== 401 || (await signIn.count()) !== 1) {
    await page.screenshot({ path: shot(`${label}-door-unexpected`), fullPage: true });
    throw new Error(
      `${label}: expected the 401 door page with one Sign in link, got ${status} with ${await signIn.count()} links`
    );
  }
  mark(`${label}: door shown`);
  await page.screenshot({ path: shot(`${label}-door`), fullPage: true });
  printHops(`Hops on the ${label} (pasted link to door page)`, stop());
  await printJar(context, `Cookie jar on the door page (${label})`);
  record();
  await click(signIn);
  mark(`${label}: Sign in clicked`);
};

/**
 * The portal's sign-in: email, Enter, the six-digit code. When the portal
 * still holds a session it bounces straight back without a form; that is
 * recorded instead.
 */
const signInOnPortal = async (address) => {
  await page.waitForURL((url) => onPortal(url) || url.origin === target.origin, {
    timeout: 30_000
  });
  const identifier = page.locator('input[name="identifier"]');
  const next = await Promise.race([
    identifier.waitFor({ timeout: 30_000 }).then(
      () => "form",
      () => "timeout"
    ),
    page
      .waitForURL((url) => url.origin === target.origin && clean(url), { timeout: 30_000 })
      .then(
        () => "back",
        () => "timeout"
      )
  ]);
  if (next !== "form") {
    mark(`portal bounced straight back (${next})`);
    console.log(`Portal: no form, ${next} at ${redactUrl(page.url())}`);
    return;
  }
  mark("portal: email form ready");
  await identifier.fill(address);
  await page.screenshot({ path: shot("portal-email"), fullPage: true });
  await identifier.press("Enter");
  mark("portal: email submitted", { typing: true });
  const code = page.locator('input[autocomplete="one-time-code"], input[name="code"]').first();
  await code.waitFor({ timeout: 30_000 });
  mark("portal: code form ready");
  await page.screenshot({ path: shot("portal-code"), fullPage: true });
  await code.focus();
  await page.keyboard.type("424242");
  mark("portal: code typed", { typing: true });
  // The portal usually submits on the sixth digit; when it does not, press Continue.
  const left = await page
    .waitForURL((url) => url.origin === target.origin, { timeout: 8_000 })
    .then(
      () => true,
      () => false
    );
  if (!left) {
    await page.screenshot({ path: shot("portal-after-code"), fullPage: true });
    console.log(
      `Portal did not submit on its own (still at ${redactUrl(page.url())}); pressing Continue.`
    );
    await click(page.locator('button:has-text("Continue")').first());
  }
};

const describeDevicePage = async (label) => {
  const url = new URL(page.url());
  const shown = await text("p.lede + p");
  const hidden = await page
    .locator('form[action="/login/device"] input[name="code"]')
    .inputValue()
    .catch(() => "(no form)");
  console.log(
    `Device page (${label}): ${redactUrl(url.href)} query code=${url.searchParams.get("code")} ` +
      `h1=${JSON.stringify(await text("h1"))} lede=${JSON.stringify(await text("p.lede"))} shown code=${JSON.stringify(shown)} hidden code=${JSON.stringify(hidden)}`
  );
  await page.screenshot({ path: shot(`device-${label}`), fullPage: true });
};

const submitDevice = async () => {
  if (deviceDelay > 0) {
    console.log(`\nWaiting ${deviceDelay}s on the device page before ${deviceAction}...`);
    await sleep(deviceDelay * 1000);
  }
  await page.locator('input[name="machine"]').fill("door-c-laptop");
  record();
  await click(page.locator(`form[action="/login/device"] button[value="${deviceAction}"]`));
  await page.waitForLoadState("domcontentloaded");
  const posted = stop();
  mark(`device ${deviceAction} submitted`);
  console.log(
    `Device ${deviceAction}: ${posted.at(-1)?.status} ${redactUrl(page.url())} kicker=${JSON.stringify(await text(".kicker"))} h1=${JSON.stringify(await text("h1"))} lede=${JSON.stringify(await text("p.lede"))}`
  );
  printHops(`Hops for the device ${deviceAction} POST`, posted);
  await page.screenshot({ path: shot(`device-${deviceAction}`), fullPage: true });
};

/** Deletes cookies on the patch host per `spec`, reloads the patch, says what the person got. */
const dropAndReload = async (spec) => {
  const onHost = (await context.cookies()).filter((c) => c.domain === patch.hostname);
  const keep = (name) =>
    spec === "all"
      ? false
      : spec.startsWith("all-but:")
        ? spec.slice("all-but:".length).split(",").includes(name)
        : !spec.split(",").includes(name);
  const kept = onHost.filter((c) => keep(c.name));
  const dropped = onHost.filter((c) => !keep(c.name)).map((c) => c.name);
  await context.clearCookies({ domain: patch.hostname });
  if (kept.length > 0) await context.addCookies(kept);
  console.log(
    `\nDropped on ${patch.hostname}: [${dropped.join(", ")}]; kept [${kept.map((c) => c.name).join(", ")}]; portal cookies untouched.`
  );
  record();
  mark(`drop ${spec}: reload start`);
  const response = await page.goto(patchUrl, { waitUntil: "domcontentloaded" });
  const reloaded = stop();
  const url = new URL(page.url());
  const outcome = onPortal(url)
    ? "carried to the portal (redirect mode)"
    : response?.status() === 200 && (await page.locator("iframe.patch-frame").count()) === 1
      ? "served, still signed in"
      : response?.status() === 401
        ? "the door: sign in again"
        : `${response?.status()} ${redactUrl(page.url())}`;
  mark(`drop ${spec}: ${outcome}`);
  console.log(`Reload after dropping [${spec}]: ${outcome}`);
  printHops(`Hops on reload after dropping [${spec}]`, reloaded);
  await page.screenshot({
    path: shot(`drop-${spec.replace(/[^a-z0-9_-]+/gi, "_")}`),
    fullPage: true
  });
  await printJar(context, `Cookie jar after the reload (dropped [${spec}])`);
};

try {
  // 1 + 2. The door (recorded too: on a dev instance a cookie-less first visit
  // is itself a handshake, dev-browser-missing), then the portal.
  await throughTheDoor(startUrl, "first-visit");
  await signInOnPortal(email);

  // 3. Where the portal brings the person back to.
  if (outsider) {
    await page.waitForURL(onTarget, { timeout: 60_000 });
    await page.waitForLoadState("domcontentloaded");
    const landed = stop();
    mark("outsider page shown");
    const h1 = await text("h1");
    console.log(
      `Outsider page: ${landed.at(-1)?.status} ${redactUrl(page.url())} kicker=${JSON.stringify(await text(".kicker"))} h1=${JSON.stringify(h1)} lede=${JSON.stringify(await text("p.lede"))} button=${JSON.stringify(await text('form[action="/sign-out"] button'))}`
    );
    await page.screenshot({ path: shot("outsider"), fullPage: true });
    if (h1 !== "You are not in a company.") {
      throw new Error(
        `Expected the outsider page, got ${redactUrl(page.url())} h1=${JSON.stringify(h1)}`
      );
    }
    printHops("Hops from sign-in to the outsider page", landed);
    await printJar(context, "Cookie jar on the outsider page");

    record();
    await click(page.locator('form[action="/sign-out"] button'));
    await page.waitForLoadState("domcontentloaded");
    const signedOut = stop();
    mark("outsider signed out through the form");
    console.log(
      `After the outsider's sign-out: ${signedOut.at(-1)?.status} ${redactUrl(page.url())} h1=${JSON.stringify(await text("h1"))}`
    );
    printHops("Hops for the outsider's sign-out (POST /sign-out and what follows)", signedOut);
    await page.screenshot({ path: shot("after-outsider-sign-out"), fullPage: true });
    await printJar(context, "Cookie jar after the outsider's sign-out");

    if (thenEmail) {
      await throughTheDoor(patchUrl, "second-visit");
      await signInOnPortal(thenEmail);
      await page.waitForURL(onPatch, { timeout: 60_000 });
      await assertServed("Second sign-in");
      mark("served page (second sign-in)");
      printHops("Hops from the second sign-in to the served page", stop());
      await page.screenshot({ path: shot("served-second"), fullPage: true });
      await printJar(context, "Cookie jar after the second sign-in");
    }
  } else if (target.pathname === deviceUrl.pathname) {
    await page.waitForURL(onTarget, { timeout: 60_000 });
    await page.waitForLoadState("domcontentloaded");
    const landed = stop();
    mark("device page shown (arrived signed out)");
    printHops("Hops from sign-in to the device page", landed);
    await describeDevicePage("signed-out-entry");
    await printJar(context, "Cookie jar on the device page");
    if (deviceAction) await submitDevice();
    record();
    await page.goto(patchUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(onPatch, { timeout: 60_000 });
    await assertServed("Patch after the device page");
    mark("served page (after the device page)");
    printHops("Hops to the patch after the device page", stop());
  } else {
    await page.waitForURL(onPatch, { timeout: 60_000 });
    await assertServed("Sign-in");
    mark("served page");
    printHops("Hops from the Sign in click to the served page", stop());
    await page.screenshot({ path: shot("served"), fullPage: true });
    await printJar(context, "Cookie jar after sign-in");
    if (saveCookies) {
      const onHost = (await context.cookies()).filter((c) => c.domain === patch.hostname);
      writeFileSync(saveCookies, `${onHost.map((c) => `${c.name}=${c.value}`).join("; ")}\n`, {
        mode: 0o600
      });
      console.log(
        `Saved ${onHost.length} patch-host cookies as one Cookie header line to ${saveCookies}`
      );
    }
    if (deviceAction) {
      record();
      await page.goto(deviceUrl.href, { waitUntil: "domcontentloaded" });
      await page.waitForURL(onDevice, { timeout: 60_000 });
      await page.waitForLoadState("domcontentloaded");
      mark("device page shown (already signed in)");
      printHops("Hops to the device page while signed in", stop());
      await describeDevicePage("signed-in-entry");
      await submitDevice();
    }
  }

  // 4. Optional: wait, then reload to watch the handshake.
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

  // 5. Optional: sign out through the device page's form, then reload.
  if (has("--sign-out")) {
    record();
    await page.goto(deviceUrl.href, { waitUntil: "domcontentloaded" });
    await page.waitForURL(onDevice, { timeout: 60_000 });
    console.log(
      `Device page: ${redactUrl(page.url())} code survived=${page.url().includes("code=WXYZ-1234")}`
    );
    await page.screenshot({ path: shot("device"), fullPage: true });
    printHops("Hops to the device page", stop());
    record();
    await click(page.locator('form[action="/sign-out"] button'));
    await page.waitForLoadState("domcontentloaded");
    console.log(`After sign-out: ${redactUrl(page.url())}`);
    await page.goto(patchUrl, { waitUntil: "domcontentloaded" });
    const again = stop();
    printHops("Hops for sign-out and the reload after it", again);
    await page.screenshot({ path: shot("after-sign-out"), fullPage: true });
    await printJar(context, "Cookie jar after sign-out");
  }

  // 6. Optional: lose cookies, one spec at a time, and reload.
  for (const spec of drops) await dropAndReload(spec);

  printTimeline();
  printServerLog();
  console.log("\nOK");
} catch (error) {
  // Whatever step failed, leave the evidence: the page as it was, and where.
  console.log(
    `\nFAILED at ${redactUrl(page.url())} (title: ${JSON.stringify(await page.title().catch(() => "?"))})`
  );
  await page.screenshot({ path: shot("failure"), fullPage: true }).catch(() => {});
  printTimeline();
  printServerLog();
  throw error;
} finally {
  await browser.close();
}
