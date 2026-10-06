# Build the team's spend requests tool

You are building an internal tool for a small team on Patchy, the company's private cloud for internal tools. This directory is a tier 1 patch repo, already initialised. Everything you need is in this directory: `AGENTS.md`, the project skills it points to, and the installed `patchy` package's declarations. Start with `AGENTS.md`.

**Rules for this run**

- Work only inside this directory. Do not read or search anything outside it, and do not look for other copies of this task or other tools.
- Build it. Do not produce mockups, design options or pages for review, and do not stop to ask anything: make every decision yourself. This overrides any standing rule about mocks before UI.
- No web search, no external documentation and no new dependencies. Installed packages' own files under `node_modules` are fine to read.
- To look at your page, a Chromium is at `/usr/bin/chromium` and the `playwright` CLI is on PATH; write screenshots under `/tmp`.
- Do not publish.
- Time box: 45 minutes from now. Stop at the time box even if unfinished, and write the report.

**What to build**

A place where people ask to spend company money and someone approves it.

1. Anyone can submit a request: what it's for, the vendor, the amount in dollars, a category (Software, Travel, Equipment, Events, Other) and a short reason. The request records who asked and when.
2. Everyone sees every request in one list, newest first: who asked, what for, the vendor, the amount, the category, when, and the status (Pending, Approved or Rejected). People can filter by status.
3. Anyone other than the requester can approve or reject a pending request, with an optional note. The list shows who decided and their note.
4. At the top: the number and total amount of pending requests, and the total approved this month.
5. With no requests yet, the page shows an empty state with a **Load sample data** button that inserts exactly these eight requests. They are invented people; store their names as given. Dates are relative to the moment the button is pressed.

| What for                     | Vendor       | Amount | Category  | Requested by | When        | Status   | Decided by | Note                         |
| ---------------------------- | ------------ | -----: | --------- | ------------ | ----------- | -------- | ---------- | ---------------------------- |
| Customer dinner              | Lucia's      |    312 | Other     | Sam Patel    | today       | Pending  |            |                              |
| Flights for the Berlin visit | Lufthansa    |    860 | Travel    | Jordan Lee   | 1 day ago   | Pending  |            |                              |
| Figma seats renewal          | Figma        |   1440 | Software  | Maya Chen    | 2 days ago  | Pending  |            |                              |
| React Summit tickets         | React Summit |   1180 | Events    | Priya Nair   | 3 days ago  | Pending  |            |                              |
| Replacement laptop charger   | Apple        |     79 | Equipment | Maya Chen    | 5 days ago  | Approved | Jordan Lee |                              |
| Offsite venue deposit        | Harbor Hall  |   3200 | Events    | Priya Nair   | 9 days ago  | Approved | Sam Patel  | Keep the total under $3,500. |
| Standing desks for new hires | Fully        |   2150 | Equipment | Jordan Lee   | 12 days ago | Rejected | Sam Patel  | Wait for the office move.    |
| Notion team plan             | Notion       |    480 | Software  | Sam Patel    | 20 days ago | Approved | Maya Chen  |                              |

**Finish**

- `pnpm typecheck` passes.
- Exercise it in the dev loop the way the skills describe: load the sample data, submit a request as one person and approve it as the other.
- Stop the dev loop when you are done.
- Write `REPORT.md` in this directory:
  - start and finish times, and whether you finished inside the time box;
  - how you decided what the page should look like: which files or skills informed it, in what order, and what you took from each;
  - anything about styling you were unsure of, or wanted and did not have;
  - every CSS file you wrote, with rough line counts;
  - known bugs or unfinished parts, honestly.
