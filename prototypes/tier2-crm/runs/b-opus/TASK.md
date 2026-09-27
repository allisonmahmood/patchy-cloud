# Build the team's CRM

You are building an internal tool for a small sales team on Patchy, the company's private cloud for internal tools. This directory is a tier 2 patch repo, already initialised. Everything you need is in this directory: `AGENTS.md`, the project skills it points to, the installed `patchy` package's declarations, and `fixtures/`. Read the skills before writing code.

**Rules for this run**

- Work only inside this directory. Do not read or search anything outside it, and do not look for other copies of this task or other CRMs.
- The design is decided by this brief. Do not produce mockups, design options or pages for review, and do not stop to ask for a pick: build it. This overrides any standing rule about mocks before UI.
- Use only the dependencies the skills say are allowed. If you want a package that is not allowed, do not install it: note it in `REPORT.md` and write what you need yourself.
- No web search or external documentation. The `patchy` CLI is already authenticated through the environment. For checking pages, a Chromium is at `/usr/bin/chromium` and the `playwright` CLI is on PATH.
- No web search or external documentation. Installed packages' own files under `node_modules` are fine to read.
- Time box: 90 minutes from now. Stop at the time box even if unfinished, and write the report.

**What to build** (patch name: `crm-b-opus`)

Contacts, companies and deals for the team.

1. **Records and ownership.** Everyone on the team can see every company and contact. Every company, contact and deal has an owner: whoever created it, and the owner can hand it to a teammate. Only a record's owner can edit or delete it; the server enforces this, not just the page.
2. **Deals and the pipeline.** A deal belongs to a company, has a value in dollars, a stage (Lead, Qualified, Proposal, Won, Lost) and an optional private flag. A private deal is visible only to its owner, everywhere, enforced on the server. A pipeline board shows open deals by stage; when one person moves a deal, everyone who has the board open sees it move without reloading.
3. **Attachments.** A deal's owner can attach files to it (a proposal PDF, a screenshot) and remove them. Anyone who can see the deal can view and download its attachments. If a step of attaching fails partway, the page tells the user exactly what state things are in.
4. **Contracts.** The team's contracts live in another company tool that shares its file store. Find it, declare it, and on each company's page show that company's contract: a thumbnail if there is one and a way to download the PDF. The list stays live if the contracts tool changes.
5. **Import.** Import contacts from a CSV like `data/contacts.csv`. Rules: a row with an invalid email is rejected, a row with no company is rejected, a row whose email already exists (earlier in the file or already saved) is skipped as a duplicate. Companies named in valid rows are created if missing. The importer owns what they import. After an import the page shows how many rows were added, and lists each rejected or skipped row with its reason.
6. **Finance report.** The company has a finance database connected to Patchy. Find it and show, per company, invoiced, paid and outstanding totals.

**Finish**

- `pnpm typecheck` passes.
- Exercise it in the dev loop as both people the skills describe (owner and colleague), including the live pipeline and a private deal the other person cannot see.
- Publish it as `crm-b-opus`.
- Write `REPORT.md` in this directory:
  - start and finish times, and whether you finished inside the time box;
  - every package you wanted and whether you were allowed it, and what you wrote yourself instead (with rough line counts);
  - what the SDK or skills lacked: missing helpers, built-ins, unclear or wrong skill text, contract gaps; quote the skill line where relevant;
  - where you got stuck, for how long, and how you got out;
  - known bugs or unfinished parts, honestly.
