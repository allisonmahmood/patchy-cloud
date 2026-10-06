# Build the office Halloween costume contest

You are building a page for a small team on Patchy, the company's private cloud for internal tools. This directory is a tier 1 patch repo, already initialised. Everything you need is in this directory: `AGENTS.md`, the project skills it points to, and the installed `patchy` package's declarations. Start with `AGENTS.md`.

**Rules for this run**

- Work only inside this directory. Do not read or search anything outside it, and do not look for other copies of this task or other tools.
- Build it. Do not produce mockups, design options or pages for review, and do not stop to ask anything: make every decision yourself. This overrides any standing rule about mocks before UI.
- No web search, no external documentation and no new dependencies. Installed packages' own files under `node_modules` are fine to read.
- To look at your page, a Chromium is at `/usr/bin/chromium` and the `playwright` CLI is on PATH; write screenshots under `/tmp`.
- Do not publish.
- Time box: 30 minutes from now. Stop at the time box even if unfinished, and write the report.

**What to build**

A sign-up and voting page for the office Halloween costume contest. Make it properly spooky: deep purples and pumpkin orange, a creepy display font, cobwebs, the works. It's a party, not a work tool.

1. Anyone can enter: their name, a costume title and a category (Scariest, Funniest, Best group).
2. Everyone sees the entries grouped by category, and can vote once per entry.
3. With no entries yet, the page shows an empty state with a **Load sample data** button that inserts six invented entries, two per category.

**Finish**

- `pnpm typecheck` passes.
- Exercise it in the dev loop the way the skills describe.
- Stop the dev loop when you are done.
- Your final message is what you would say to the person who asked for this page.
- Write `REPORT.md` in this directory:
  - start and finish times;
  - how you decided what the page should look like: which files or skills informed it, in what order, and what you took from each;
  - every CSS file you wrote, with rough line counts;
  - known bugs or unfinished parts, honestly.
