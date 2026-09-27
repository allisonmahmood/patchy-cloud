// Local two-viewer walkthrough against `pnpm patchy dev`: node scripts/e2e.mjs <url> <colleagueUrl>
import { chromium } from "/home/quan2m/.local/share/mise/installs/npm-playwright/latest/node_modules/playwright/index.mjs";
const [ownerUrl, colleagueUrl] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const open = async (url, name) => {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${name} console]`, m.text());
  });
  await page.goto(url);
  const app = page.frameLocator("iframe");
  await app.locator("#viewer").filter({ hasText: "Signed in" }).waitFor();
  return { page, app, name };
};
const shot = (who, file) => who.page.screenshot({ path: `.patchy/${file}.png` });
const tab = (who, name) => who.app.locator("nav button", { hasText: name }).click();
const log = (...args) => console.log("✓", ...args);

const owner = await open(ownerUrl, "owner");
const colleague = await open(colleagueUrl, "colleague");
log(
  "owner",
  await owner.app.locator("#viewer").textContent(),
  "| colleague",
  await colleague.app.locator("#viewer").textContent()
);

// Import
await tab(owner, "Import");
await owner.app.locator("input[type=file]").setInputFiles("data/contacts.csv");
await owner.app.locator("#import-result").waitFor({ timeout: 20000 });
log("import:", await owner.app.locator("#import-result .summary").textContent());
console.log(await owner.app.locator("#import-result tbody").innerText());
await shot(owner, "import");

// Deals: a public one and a private one
await tab(owner, "Pipeline");
const newDeal = async (title, company, value, secret) => {
  await owner.app.getByRole("button", { name: "New deal" }).click();
  await owner.app.locator("input[name=title]").fill(title);
  await owner.app.locator("select[name=company]").selectOption({ label: company });
  await owner.app.locator("input[name=value]").fill(value);
  if (secret) await owner.app.locator("input[name=private]").check();
  await owner.app.getByRole("button", { name: "Create deal" }).click();
  await owner.app.locator(`[data-deal="${title}"]`).waitFor();
};
await newDeal("Acme expansion", "Acme Robotics", "50000", false);
await newDeal("Cobalt secret renewal", "Cobalt Freight", "12500", true);
log("owner board has both deals");

await tab(colleague, "Pipeline");
await colleague.app.locator('[data-deal="Acme expansion"]').waitFor();
log(
  "colleague sees Acme expansion; private visible to colleague?",
  await colleague.app.locator('[data-deal="Cobalt secret renewal"]').count()
);

// Live move
await owner.app.locator('[data-deal="Acme expansion"] select').selectOption("Proposal");
await colleague.app
  .locator('[data-stage="Proposal"] [data-deal="Acme expansion"]')
  .waitFor({ timeout: 10000 });
log("colleague saw the move to Proposal live");
await shot(colleague, "colleague-board");
await shot(owner, "owner-board");

// Attachments
await owner.app.locator('[data-deal="Acme expansion"] button.title').click();
await owner.app
  .locator("#deal-panel input[type=file]")
  .setInputFiles([".patchy/proposal.pdf", ".patchy/shot.png"]);
await owner.app.locator(".attempts li.ok").nth(1).waitFor({ timeout: 15000 });
log("attached:", await owner.app.locator(".attempts").innerText());
await shot(owner, "deal-panel");
await colleague.app.locator('[data-deal="Acme expansion"] button.title').click();
await colleague.app.locator("#deal-panel .files li").nth(1).waitFor();
log("colleague sees attachments:", await colleague.app.locator("#deal-panel .files").innerText());
log(
  "colleague edit/attach controls:",
  await colleague.app.locator("#deal-panel").getByRole("button", { name: "Edit" }).count(),
  await colleague.app.locator("#deal-panel input[type=file]").count()
);
const [download] = await Promise.all([
  colleague.page.waitForEvent("download", { timeout: 5000 }).catch((e) => e),
  colleague.app
    .locator("#deal-panel .files li")
    .first()
    .getByRole("button", { name: "Download" })
    .click()
]);
log("colleague download:", download?.suggestedFilename?.() ?? String(download));
await shot(colleague, "colleague-deal");
await colleague.app.locator("#deal-panel .close").click();

// Server enforcement: owner has the edit form open, hands the deal over in another tab, then saves.
await owner.app.locator("#deal-panel").getByRole("button", { name: "Edit" }).click();
const owner2 = await open(ownerUrl, "owner2");
await owner2.app.locator('[data-deal="Acme expansion"] button.title').click();
await owner2.app
  .locator("#deal-panel .ownership select")
  .selectOption({ label: "Colleague" })
  .catch(async () => {
    console.log("members:", await owner2.app.locator("#deal-panel .ownership select").innerText());
    const option = owner2.app.locator("#deal-panel .ownership select option").nth(1);
    await owner2.app
      .locator("#deal-panel .ownership select")
      .selectOption(await option.getAttribute("value"));
  });
await owner2.app.locator("#deal-panel .facts").filter({ hasNotText: "you" }).waitFor();
log("handed over; owner line now:", await owner2.app.locator("#deal-panel .facts").innerText());
await owner.app.locator("input[name=title]").fill("Acme expansion (hijacked)");
await owner.app.locator("#deal-panel").getByRole("button", { name: "Save" }).click();
await owner.app.locator("#deal-panel .form .error").waitFor();
log(
  "stale edit refused by server:",
  await owner.app.locator("#deal-panel .form .error").textContent()
);
await colleague.app.locator('[data-deal="Acme expansion"] select').waitFor();
log("colleague now owns it and has the stage menu");

// Company page: contract
await tab(owner, "Companies");
await owner.app.getByRole("button", { name: "Acme Robotics" }).click();
await owner.app.locator("#contract img").waitFor({ timeout: 10000 });
log("contract:", await owner.app.locator("#contract").innerText());
await shot(owner, "company");
await tab(owner, "Companies");
await owner.app.getByRole("button", { name: "Driftwood Studio" }).click();
await owner.app.locator("#contract button").waitFor();
log("driftwood contract:", await owner.app.locator("#contract").innerText());

// Finance
await tab(owner, "Finance");
await owner.app.locator("#finance").waitFor({ timeout: 15000 });
console.log(await owner.app.locator("#finance").innerText());
await shot(owner, "finance");
await browser.close();
