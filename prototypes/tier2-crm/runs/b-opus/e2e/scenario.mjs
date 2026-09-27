// Two-person walkthrough against `patchy dev`: owner = publishing user, colleague = fixture colleague.
import { chromium } from "/home/quan2m/.local/share/mise/installs/npm-playwright/1.63.0/node_modules/playwright/index.mjs";
const [ownerUrl, colleagueUrl] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const open = async (url, who) => {
  const page = await (
    await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })
  ).newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`[${who} console]`, m.text()));
  await page.goto(url);
  const frame = () => page.frames().find((f) => f.url().includes("/~content/"));
  for (let i = 0; i < 50 && !frame(); i++) await page.waitForTimeout(200);
  await frame().waitForSelector("#viewer");
  return { page, f: frame(), who };
};
const check = (label, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"} ${label} ${extra}`);
const call = (who, path, args) =>
  who.f.evaluate(
    async ([path, args]) => {
      const [mod, fn] = path.split(".");
      try {
        return { ok: await window.patchy.server[mod][fn](args) };
      } catch (e) {
        return { code: e.code, name: e.name };
      }
    },
    [path, args]
  );

const owner = await open(ownerUrl, "owner");
const colleague = await open(colleagueUrl, "colleague");
console.log(
  "owner:",
  await owner.f.textContent("#viewer"),
  "colleague:",
  await colleague.f.textContent("#viewer")
);

// Import
await owner.f.click("text=Import");
await owner.f.setInputFiles('input[type="file"]', "data/contacts.csv");
await owner.f.waitForSelector("#import-report", { timeout: 15000 });
console.log(await owner.f.textContent("#import-report p"));
const problems = await owner.f.$$eval("#import-report tbody tr", (rows) =>
  rows.map((r) => r.innerText.replace(/\t/g, " | "))
);
console.log(problems.join("\n"));
await owner.page.screenshot({ path: "e2e/import.png", fullPage: true });
// Re-import: everything skipped
await owner.f.setInputFiles('input[type="file"]', "data/contacts.csv");
await owner.f.waitForFunction(() => document.querySelector("#import-added")?.textContent === "0");
check("re-import adds nothing", true);

// Deals: one shared, one private, via server calls from the owner's page
const companies = (await call(owner, "companies.list", {})).ok;
const acme = companies.find((c) => c.name === "Acme Robotics");
const fjord = companies.find((c) => c.name === "Fjord Analytics");
check("importer owns companies", acme.ownerName === "Patchy Dev");
const shared = (
  await call(owner, "deals.create", {
    title: "Acme expansion",
    companyId: acme.id,
    valueCents: 4500000,
    stage: "Lead",
    private: false
  })
).ok;
const secret = (
  await call(owner, "deals.create", {
    title: "Secret Fjord renewal",
    companyId: fjord.id,
    valueCents: 1200000,
    stage: "Proposal",
    private: true
  })
).ok;

// Colleague: sees the shared deal live, never the private one
await owner.f.click("text=Pipeline");
await colleague.f.click("text=Pipeline");
await colleague.f.waitForSelector('[data-deal="Acme expansion"]');
check("colleague sees shared deal", true);
check(
  "colleague cannot see private deal on board",
  (await colleague.f.$('[data-deal="Secret Fjord renewal"]')) === null
);
check(
  "owner sees private deal on board",
  (await owner.f.$('[data-deal="Secret Fjord renewal"]')) !== null
);
check(
  "private deal get refused for colleague",
  (await call(colleague, "deals.get", { id: secret.id })).code === "not_found"
);
const fjordPage = (await call(colleague, "companies.get", { id: fjord.id })).ok;
check("private deal absent from colleague's company page", fjordPage.deals.length === 0);
check(
  "private attachments refused for colleague",
  (await call(colleague, "attachments.list", { dealId: secret.id })).code === "not_found"
);

// Server enforcement of ownership
check(
  "colleague move refused",
  (await call(colleague, "deals.move", { id: shared.id, stage: "Won" })).code === "not_owner"
);
check(
  "colleague rename company refused",
  (await call(colleague, "companies.rename", { id: acme.id, name: "Hijacked" })).code ===
    "not_owner"
);
check(
  "colleague delete deal refused",
  (await call(colleague, "deals.remove", { id: shared.id })).code === "not_owner"
);

// Live move: owner drags Lead -> Qualified; colleague's board moves without reload
await owner.f.dragAndDrop('[data-deal="Acme expansion"]', '.column[data-stage="Qualified"]');
await colleague.f.waitForSelector('.column[data-stage="Qualified"] [data-deal="Acme expansion"]', {
  timeout: 8000
});
check("colleague saw drag move live", true);
await owner.f.selectOption('select[aria-label="Stage of Acme expansion"]', "Proposal");
await colleague.f.waitForSelector('.column[data-stage="Proposal"] [data-deal="Acme expansion"]', {
  timeout: 8000
});
check("colleague saw select move live", true);
await colleague.page.screenshot({ path: "e2e/colleague-board.png", fullPage: true });
await owner.page.screenshot({ path: "e2e/owner-board.png", fullPage: true });

// Attachments: owner attaches, colleague sees and can download
await owner.f.click('[data-deal="Acme expansion"] .title');
await owner.f.setInputFiles('input[type="file"]', "fixtures/shared-contracts/acme-robotics.png");
await owner.f.waitForSelector(".notice.ok");
console.log("owner notice:", await owner.f.textContent(".notice"));
await owner.f.setInputFiles('input[type="file"]', {
  name: "notes.exe",
  mimeType: "application/x-msdownload",
  buffer: Buffer.from("MZ")
});
await owner.f.waitForSelector(".notice.error");
console.log("owner notice (bad type):", await owner.f.textContent(".notice"));
await colleague.f.click('[data-deal="Acme expansion"] .title');
await colleague.f.waitForSelector(".files li");
check(
  "colleague sees attachment",
  (await colleague.f.textContent(".files li")).includes("acme-robotics.png")
);
check("colleague has no attach button", (await colleague.f.$("text=Attach file")) === null);
const dl = colleague.page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
await colleague.f.click(".files li >> text=Download");
const download = await dl;
check("colleague download", download !== null, download ? download.suggestedFilename() : "");
await owner.page.screenshot({ path: "e2e/deal.png", fullPage: true });

// Handoff to colleague, who may then move it
await owner.f.click("text=Hand over");
await owner.f
  .selectOption('select[aria-label="New owner"]', { label: "Colleague" })
  .catch(async () => {
    const opts = await owner.f.$$eval('select[aria-label="New owner"] option', (o) =>
      o.map((x) => x.textContent)
    );
    console.log("handoff options", opts);
    await owner.f.selectOption('select[aria-label="New owner"]', { index: 1 });
  });
await owner.page.waitForTimeout(800);
check(
  "colleague may move after handoff",
  !!(await call(colleague, "deals.move", { id: shared.id, stage: "Won" })).ok
);
check(
  "owner can no longer move",
  (await call(owner, "deals.move", { id: shared.id, stage: "Lead" })).code === "not_owner"
);

// Company page contract
await owner.f.click("text=Companies");
await owner.f.click("text=Acme Robotics");
await owner.f.waitForSelector("img.contract-thumb[src^='blob:']", { timeout: 8000 });
check("acme contract thumbnail", true);
await owner.page.screenshot({ path: "e2e/company.png", fullPage: true });
await owner.f.click("text=Companies");
await owner.f.click("text=Cobalt Freight");
await owner.f.waitForSelector(".contract button");
check(
  "cobalt: pdf, no thumbnail",
  (await owner.f.textContent(".contract")).includes("No thumbnail")
);
await owner.f.click("text=Companies");
await owner.f.click("text=Granite Legal");
await owner.f.waitForSelector("text=No contract on file");
check("granite: no contract", true);

// Finance
await owner.f.click("text=Finance");
await owner.f.waitForSelector("#finance");
console.log(
  (
    await owner.f.$$eval("#finance tr", (r) => r.map((x) => x.innerText.replace(/\t/g, " | ")))
  ).join("\n")
);
await owner.page.screenshot({ path: "e2e/finance.png", fullPage: true });
await browser.close();
