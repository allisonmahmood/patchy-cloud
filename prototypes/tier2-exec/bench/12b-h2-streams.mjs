// PROTOTYPE for #311: measurement 12, seven SSE streams from one Chromium,
// over HTTP/2 (all seven flow) and with HTTP/2 disabled (the seventh blocks
// behind the six-connection limit: its navigation cannot even open).
import { chromium } from "playwright";
import { save } from "./lib.mjs";
const base = `https://${process.env.SPIKE_ALB_DNS}`;
const openStream = async (p, doc) => {
  try {
    await p.goto(`${base}/healthz`, { waitUntil: "commit", timeout: 10_000 });
  } catch (e) {
    return "navigation blocked (timeout 10 s)";
  }
  await p.evaluate((doc) => {
    window.__events = 0;
    window.__opened = false;
    const es = new EventSource(`/stream?doc=${doc}`);
    es.onopen = () => (window.__opened = true);
    es.addEventListener("tick", () => window.__events++);
  }, doc);
  return "opened";
};
const state = (p) =>
  p
    .evaluate(() => ({ opened: window.__opened ?? false, events: window.__events ?? 0 }))
    .catch(() => ({ opened: false, events: 0 }));
async function run(label, args) {
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const pages = [],
    nav = [];
  for (let i = 1; i <= 7; i++) {
    const p = await ctx.newPage();
    nav.push(await openStream(p, `${label}-${i}`));
    pages.push(p);
  }
  await new Promise((r) => setTimeout(r, 6000));
  const after6s = await Promise.all(pages.map((p, i) => (nav[i] === "opened" ? state(p) : nav[i])));
  await pages[0].close(); // free one connection
  let seventh = pages[6];
  if (nav[6] !== "opened") {
    seventh = await ctx.newPage(); // the blocked page is stuck in navigation; use a fresh one
    nav[6] = `after closing one: ${await openStream(seventh, `${label}-7b`)}`;
  }
  await new Promise((r) => setTimeout(r, 4000));
  const seventhAfterClosingOne = nav[6].endsWith("opened") ? await state(seventh) : nav[6];
  await browser.close();
  const out = { label, args, navigation: nav, after6s, seventhAfterClosingOne };
  console.log(JSON.stringify(out));
  return out;
}
const out = { http2: await run("h2", []), http11: await run("h1", ["--disable-http2"]) };
save("12b-h2-streams", out);
