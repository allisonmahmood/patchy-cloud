# Update the spend requests tool to our current look

This directory is the team's spend requests tool, a tier 1 patch on Patchy, the company's private cloud for internal tools. It already works. Everything you need is in this directory: `AGENTS.md`, the project skills it points to, the installed `patchy` package's declarations, and the existing code. Start with `AGENTS.md`.

**Rules for this run**

- Work only inside this directory. Do not read or search anything outside it.
- Build it. Do not produce mockups, design options or pages for review, and do not stop to ask anything: make every decision yourself. This overrides any standing rule about mocks before UI.
- No web search, no external documentation and no new dependencies.
- To look at your page, a Chromium is at `/usr/bin/chromium` and the `playwright` CLI is on PATH; write screenshots under `/tmp`.
- Do not publish.
- Time box: 30 minutes from now.

**What to do**

Update this tool to our current company look. Keep everything that works today working.

**Finish**

- `pnpm typecheck` passes.
- Exercise it in the dev loop the way the skills describe.
- Stop the dev loop when you are done.
- Write `REPORT.md` in this directory, replacing any existing one:
  - start and finish times;
  - what you changed and why: which files or skills informed it, in what order, and what you took from each;
  - every CSS change you made, with rough line counts;
  - known bugs or unfinished parts, honestly.
