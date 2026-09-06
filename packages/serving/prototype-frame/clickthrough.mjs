// PROTOTYPE — drives the ticket's click-through list in every installed
// Playwright browser against a running `pnpm proto:frame`, and prints what each
// browser did. Wayfinder #175.
import { chromium, firefox, webkit } from "@playwright/test";

const ORIGIN = process.env.ORIGIN ?? "http://localhost:4175";
const engines = { chromium, firefox, webkit };
const results = {};
const say = (browser, name, verdict) => {
  (results[name] ??= {})[browser] = verdict;
  console.log(`[${browser}] ${name}: ${verdict}`);
};

const out = (page) => page.frameLocator("#patch").getByTestId("out");
const signIn = async (context, as) => {
  await context.request.get(`${ORIGIN}/login?as=${as}`);
};
const waitFor = (locator, text) => locator.filter({ hasText: text }).waitFor({ timeout: 5000 });
const apiLog = async (context) => (await context.request.get(`${ORIGIN}/_log`)).json();
const clearLog = (context) => context.request.delete(`${ORIGIN}/_log`);
const pageCount = (pdf) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;

async function run(browserName) {
  const engine = engines[browserName];
  let browser;
  try {
    browser = await engine.launch();
  } catch (e) {
    say(browserName, "launch", `not installed (${e.message.split("\n")[0]})`);
    return;
  }
  const version = browser.version();
  say(browserName, "version", version);

  // ---- ada, member of acme, on the company patch --------------------------
  const ctx = await browser.newContext({ acceptDownloads: true });
  await signIn(ctx, "ada");
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.text()));

  // deep link
  await page.goto(`${ORIGIN}/acme/inventory/items/2`);
  const title = page.frameLocator("#patch").locator("#title");
  await waitFor(title, "Item 2");
  say(browserName, "deep link into a route", `frame rendered "${await title.textContent()}"`);
  await waitFor(out(page), "rows.read items");
  say(browserName, "sdk round-trip (rows.read)", (await out(page).textContent()).match(/rows\.read.*/)[0]);

  // navigate inside, then back/forward
  await page.frameLocator("#patch").locator('[data-route="/items/3"]').first().click();
  await waitFor(title, "Item 3");
  const urlAfter = new URL(page.url()).pathname;
  await page.goBack();
  await waitFor(title, "Item 2");
  const urlBack = new URL(page.url()).pathname;
  await page.goForward();
  await waitFor(title, "Item 3");
  say(
    browserName,
    "in-frame navigation + back/forward",
    `click -> ${urlAfter}; back -> ${urlBack} frame "Item 2"; forward -> frame "Item 3"`
  );

  // image via broker bytes + blob URL
  const logo = page.frameLocator("#patch").locator("#logo");
  await page.waitForTimeout(300);
  const imgState2 = await logo.evaluate((img) => ({ src: img.src.slice(0, 10), w: img.naturalWidth }));
  say(browserName, "own file as image via blob URL", `src ${imgState2.src}… naturalWidth ${imgState2.w} (${imgState2.w > 0 ? "rendered" : "NOT rendered"})`);

  // mutation via broker: server must see the exact Origin
  await clearLog(ctx);
  await page.frameLocator("#patch").locator("#add").click();
  await waitFor(out(page), "rows.insert");
  const post = (await apiLog(ctx)).find((l) => l.method === "POST");
  say(browserName, "mutation via broker", `${(await out(page).textContent()).match(/rows\.insert.*/)[0]}; API saw Origin ${post?.origin}, cookie ${post?.cookie}, Sec-Fetch-Site ${post?.secFetchSite}`);

  // shell-owned download
  const dlShell = page.waitForEvent("download", { timeout: 5000 }).then((d) => d.suggestedFilename(), () => null);
  await page.frameLocator("#patch").locator("#dl-shell").click();
  say(browserName, "download, shell-owned", (await dlShell) ? `download event: ${await dlShell}` : "no download event");

  // in-frame anchor download (sandbox without allow-downloads)
  consoleLines.length = 0;
  const dlFrame = page.waitForEvent("download", { timeout: 2000 }).then((d) => d.suggestedFilename(), () => null);
  await page.frameLocator("#patch").locator("#dl-frame").click();
  const dlFrameName = await dlFrame;
  say(browserName, "download, in-frame anchor", dlFrameName ? `download event: ${dlFrameName} (sandbox did NOT block)` : `no download event; console: ${consoleLines.find((l) => /download|sandbox/i.test(l)) ?? "(silent)"}`);

  // window.print() inside the frame opens a real dialog that blocks the whole
  // browser, so it runs last, in a browser of its own (see modalPrintCheck).

  // unknown op
  await page.frameLocator("#patch").locator("#unknown").click();
  await waitFor(out(page), "unknown op");
  say(browserName, "broker refuses unknown op", (await out(page).textContent()).match(/unknown op.*/)[0]);

  // escape attempts from inside the frame
  await page.frameLocator("#patch").locator("#escape").click();
  await waitFor(out(page), "direct fetch");
  await page.waitForTimeout(200);
  const esc = (await out(page).textContent()).split("\n").filter((l) => /top\.document|document\.cookie|localStorage|origin:|direct fetch|top navigation/.test(l));
  say(browserName, "sandbox from inside (strict CSP)", esc.join(" | "));
  say(browserName, "top navigation actually happened?", page.url().startsWith(ORIGIN) ? "no, still on the shell" : `YES -> ${page.url()}`);

  // a foreign frame and the shell window itself must be refused by the broker
  const refused = await page.evaluate(async () => {
    window.postMessage({ v: 1, id: "x", op: "rows.read", args: { table: "items" } }, "*");
    const f = document.createElement("iframe");
    f.sandbox = "allow-scripts";
    f.srcdoc = `<script>parent.postMessage({ v: 1, id: "y", op: "rows.read", args: { table: "items" } }, "*")</script>`;
    document.body.append(f);
    await new Promise((r) => setTimeout(r, 500));
    return window.__brokerRefused.map((r) => `${r.source}@${r.origin}:${r.data.id}`);
  });
  say(browserName, "broker ignores window messages", `refused ${refused.length} message(s): ${refused.join(", ")}`);

  // astra's inferred holes: a table name that is a path, and an inherited op name
  const inFrame = (fn, arg) => page.frameLocator("#patch").locator("body").evaluate(fn, arg);
  const traversal = await inFrame(() => PatchySDK.raw("rows.read", { table: "../../deck/tables/slides" }).then((r) => `answered with ${JSON.stringify(r).slice(0, 40)}`, (e) => `refused: ${e.code}`));
  const inherited = await inFrame(() => PatchySDK.raw("toString").then((r) => `answered with ${JSON.stringify(r)}`, (e) => `refused: ${e.code}`));
  say(browserName, "table name as a path / inherited op name", `${traversal} / ${inherited}`);

  // the frame navigates itself: the replacement document must get no broker
  await inFrame(() => { location.href = "/acme/deck/~content"; });
  await page.waitForTimeout(1500);
  const revoked = await page.evaluate(() => window.__brokerRevoked ?? 0);
  const deckOut = await page.frameLocator("#patch").getByTestId("out").textContent().catch(() => "(no out)");
  say(browserName, "frame navigated itself", `broker revoked ${revoked}x; replacement document's SDK output: ${JSON.stringify(deckOut.trim()) || '""'} (rows.read never answered)`);
  await page.goto(`${ORIGIN}/acme/inventory`);
  await waitFor(out(page), "rows.read");

  // ---- the probe patch: patch code trying the API directly (loose CSP) ----
  await clearLog(ctx);
  await page.goto(`${ORIGIN}/acme/probe`);
  await waitFor(out(page), "done");
  const probeOut = (await out(page).textContent()).trim().split("\n").join(" | ");
  const probeLog = (await apiLog(ctx)).filter((l) => l.path.startsWith("/api")).map((l) => `${l.method} origin=${l.origin} cookie=${l.cookie} sfs=${l.secFetchSite} -> ${l.outcome}`);
  say(browserName, "frame fetching the API directly", `${probeOut} || server: ${probeLog.join(" ; ")}`);

  // ---- the content URL opened directly at top level -----------------------
  await clearLog(ctx);
  await page.goto(`${ORIGIN}/acme/inventory/~content`);
  const direct = await page.evaluate(async () => {
    const r = {};
    r.origin = window.origin;
    try { r.cookie = JSON.stringify(document.cookie); } catch (e) { r.cookie = e.name; }
    try { r.fetch = (await fetch("/api/acme/inventory/tables/items/rows", { credentials: "include" })).status; } catch (e) { r.fetch = `blocked ${e.name}`; }
    return r;
  });
  say(browserName, "content URL opened directly", `origin ${direct.origin}, document.cookie ${direct.cookie}, fetch ${direct.fetch}`);

  // ---- variants -------------------------------------------------------------
  // allow-downloads on the sandbox: could the frame download by itself if we let it?
  await page.goto(`${ORIGIN}/acme/inventory?sandbox=allow-downloads`);
  await waitFor(out(page), "rows.read");
  const dlFrame2 = page.waitForEvent("download", { timeout: 3000 }).then((d) => d.suggestedFilename(), () => null);
  await page.frameLocator("#patch").locator("#dl-frame").click();
  const dlFrame2Name = await dlFrame2;
  say(browserName, "download, in-frame anchor + allow-downloads", dlFrame2Name ? `download event: ${dlFrame2Name}` : "no download event");
  await ctx.close();

  // ---- public patch, signed out ---------------------------------------------
  const anon = await browser.newContext();
  const apage = await anon.newPage();
  await apage.goto(`${ORIGIN}/acme/deck`);
  await waitFor(out(apage), "rows.read");
  const hasSession = await apage.evaluate(() => "__session" in window);
  say(browserName, "public patch, signed out", `${(await out(apage).textContent()).match(/rows\.read.*/)[0]}; session script in shell: ${hasSession}`);
  await anon.close();

  // ---- bob from globex ----------------------------------------------------
  const bobCtx = await browser.newContext();
  await signIn(bobCtx, "bob");
  const bpage = await bobCtx.newPage();
  const r = await bpage.goto(`${ORIGIN}/acme/inventory`);
  const door = await bpage.locator("[data-door]").textContent().catch(() => "(no door)");
  say(browserName, "other-company viewer, company patch", `${r.status()} ${door}`);
  await bpage.goto(`${ORIGIN}/acme/deck`);
  await waitFor(out(bpage), "rows.read");
  say(browserName, "other-company viewer, public patch", (await out(bpage).textContent()).match(/rows\.read.*/)[0]);
  await bobCtx.close();

  await browser.close();
}

// window.print() in the frame (allow-modals is granted) opens a real dialog that
// blocks the whole browser, so it gets a browser of its own, abandoned if it hangs.
async function modalPrintCheck(browserName) {
  let browser;
  try {
    browser = await engines[browserName].launch();
  } catch {
    return;
  }
  const ctx = await browser.newContext();
  await signIn(ctx, "ada");
  const page = await ctx.newPage();
  const lines = [];
  page.on("console", (m) => lines.push(m.text()));
  await page.goto(`${ORIGIN}/acme/inventory`);
  await waitFor(out(page), "rows.read");
  const timeout = new Promise((r) => setTimeout(() => r("blocked for 3s: a print dialog opened"), 3000));
  const returned = page
    .frameLocator("#patch")
    .locator("#print-frame")
    .click({ noWaitAfter: true, timeout: 3000 })
    .then(() => waitFor(out(page), "window.print()"))
    .then(() => out(page).textContent())
    .then((t) => t.match(/window\.print\(\).*/)[0], (e) => `no signal (${e.message.split("\n")[0]})`);
  const verdict = await Promise.race([returned, timeout]);
  say(browserName, "window.print() in frame (allow-modals granted)", `${verdict}; console: ${lines.find((l) => /print|sandbox|modal/i.test(l)) ?? "(silent)"}`);
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 3000))]);
}

// ---- the API guard, from outside a browser -----------------------------------
async function guard() {
  const post = (headers) =>
    fetch(`${ORIGIN}/api/acme/inventory/tables/items/rows`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session=ada", ...headers },
      body: "{}"
    }).then((r) => r.status);
  console.log(`[guard] POST no Origin: ${await post({})}; Origin null: ${await post({ origin: "null" })}; other origin: ${await post({ origin: "http://127.0.0.1:4175" })}; exact: ${await post({ origin: ORIGIN })}`);
}

await guard();
for (const name of Object.keys(engines)) {
  try {
    await run(name);
    await modalPrintCheck(name);
  } catch (e) {
    say(name, "aborted", e.message.split("\n")[0]);
  }
}

console.log("\n## Results\n");
const browsers = Object.keys(engines);
console.log(`| check | ${browsers.join(" | ")} |`);
console.log(`| --- | ${browsers.map(() => "---").join(" | ")} |`);
for (const [name, byBrowser] of Object.entries(results)) {
  console.log(`| ${name} | ${browsers.map((b) => byBrowser[b] ?? "").join(" | ")} |`);
}

process.exit(0);
