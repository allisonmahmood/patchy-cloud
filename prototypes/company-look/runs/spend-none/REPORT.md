# Spend requests — build report

## Times

- Start: 2026-10-06 23:55:28 CEST (from `date` at the first command).
- Finish: 2026-10-07 00:00:08 CEST (from `date` after stopping the dev loop), plus a few minutes to write this report.
- Inside the 45-minute time box: yes. The wall clock shows only about 5 minutes between the two readings, which looks short for the work done. I'm reporting what the clock said, not a number I measured some other way.

## What was built

- `patchy.config.ts`: replaced the scaffold's `notes` table with one owned table, `requests`. Amounts are integer USD cents. It stores requester id and name, `requestedAt`, a status (`pending`, `approved` or `rejected`) and decider id, name, time and note. It has three indexes: `byRequestedAt`, `byStatus (status, requestedAt)` and `byStatusDecided (status, decidedAt)`. Ran `pnpm patchy refresh`.
- `src/App.tsx`: the page.
  - The header shows the viewer from `patchy.me()`.
  - Three summary tiles: number of pending requests, pending total, and total approved this calendar month (by decision date).
  - An empty state with **Load sample data** (one `insertMany`) and a "Submit the first request" button.
  - A New request form that opens on demand.
  - A status filter (All / Pending / Approved / Rejected).
  - A list of request cards, newest first, showing the status, who decided and their note.
  - Pending requests get an "Approve or reject…" control with an optional note. It is hidden from the requester.
  - Every read is a live `useQuery` subscription on an index. The filter is applied by the table index, not by filtering in the browser.
- `src/data.ts`: types, money parsing and formatting, relative dates, and the eight sample rows. The samples are dated relative to the moment the button is pressed. Decided samples get `decidedAt` one day after the request.
- `src/main.tsx`: imports `styles.css`. `index.html`: the title.

## Exercised in the dev loop

I ran `pnpm patchy dev --json` and drove Chromium with Playwright. Screenshots are in `/tmp/spend-*.png`.

1. Primary viewer (Ada Park): the empty state rendered. Clicked **Load sample data**, and all eight rows appeared with the right names, amounts, statuses, deciders and notes.
2. As Ada, submitted "Team lunch for launch day", Sweetgreen, $145.50. It showed as Pending, "Ada Park (you)", with no decide control.
3. Colleague viewer (Dev Colleague, `colleagueUrl`): opened "Approve or reject…" on Ada's request, added a note and clicked Approve. It showed "Approved by Dev Colleague · today" with the note. The tiles updated live: pending went from 5 to 4, and approved in October went from $79 to $224.50.
4. As Ada again, submitted a second request and confirmed the "You can't decide on your own request" text.
5. `pnpm typecheck` and `pnpm lint` pass. The dev loop is stopped (`pnpm patchy dev stop`) and local data is kept.

## How I decided what the page should look like

In order:

1. **`AGENTS.md`**: the purpose and layout. It says nothing about visuals.
2. **`.agents/skills/patchy-loop/SKILL.md`**: the tier 1 constraints that shape the UI. All CSS is bundled with no external fonts or assets. Native form submission is blocked, so I used `type="button"` plus an Enter handler and `reportValidity()`. Read errors are not the same as an empty result. Never auto-replay a write.
3. **`.agents/skills/patchy-preact/SKILL.md`** and **`patchy-tables/SKILL.md`**: use `useQuery` to subscribe, render the whole latest result, show errors separately, and filter on an index instead of in the browser. This set the data and loading/error structure of the page.
4. **`src/App.tsx` scaffold**: the form and Enter-key pattern and the error/status paragraphs, which I kept.
5. **`node_modules/patchy/skills/patchy/SKILL.md` § Style**: the order for choosing a style is project house style, then the user's `style.md` in the state dir, then the bundled plan-doc style. This repo declares no house style. The user's `style.md` lives in the CLI state dir (default `~/.patchy`), which is outside this directory, so the run rules meant I couldn't read it. I fell back to the third option.
6. **`node_modules/patchy/skills/patchy/references/patchy-plan-style.md`**: the actual look. From it I took:
   - the `:root` tokens verbatim;
   - cream paper with the faint 32px grid and blue-to-green wash;
   - near-black ink, 2px ink borders and hard 4px offset shadows;
   - 8px cards and 999px pills;
   - heavy system-font headings;
   - flat yellow/green/red as the pending/approved/rejected colours;
   - the CSS-only glyph in the header;
   - `.note`-style callouts with a coloured left border;
   - plain builder-to-builder copy.
7. **`references/style-file.md`**: read for context on how `style.md` is structured. Nothing taken directly.

## Styling I was unsure of, or wanted and didn't have

- The bundled style is written for static plan documents, not interactive tools. It has no specs for inputs, selects, buttons, filters, disabled or focus states, or dense lists. I made all of those up in the same vocabulary: ink borders, small hard shadows, pill filters.
- I'm unsure whether these pages should run at the document's body size (17px, 3.35rem h1). I scaled down to 16px and a 2.6rem h1 for a working list.
- I left out the SVG noise overlay (`body::before`) from the baseline. On a frequently used tool it seemed like texture for its own sake.
- I didn't know whether the user's `style.md` exists or what it says. If it describes a different look, this page doesn't follow it.
- There's no shared component library or icon set (the SDK says it offers none), so the "$" mark and the glyph are pure CSS/text.

## CSS files written

- `src/styles.css`: about 670 lines (formatted one property per line; roughly 120 rules). It is the only CSS file.

## Known bugs and unfinished parts

- **No real authorization (tier 1).** The "not your own request" rule is enforced only in the UI. Any viewer could approve their own request, or edit any row, by calling the table client directly. Enforcing it needs tier 2 handlers.
- **Requester matching for sample rows is by name.** The sample people have no Patchy user id. A real user whose display name is "Sam Patel" would be treated as the requester of Sam's sample rows.
- **Two people can decide the same request at once.** Tier 1 writes are last-write-wins, and the page doesn't re-check that the request is still pending before updating.
- **"This month" and relative dates use the page-load time and the browser's time zone.** They don't roll over at midnight or month-end while the page stays open.
- **The list shows at most the newest 200 requests** (with a notice), and the summary reads at most 1,000 pending/approved rows. There's no "load more".
- **Sample-data wording:** the 1-day-old sample reads "yesterday", not "1 day ago", and decided samples show a decision date one day after the request. I chose that; the brief didn't specify it.
- **Pressing Load sample data twice quickly** (or from two tabs) can insert the set twice. The button disables itself while saving, but nothing checks for existing rows.
- **Untested in the browser:** the "Choose…" placeholder for category was added after the last browser run. Typecheck and lint pass, but I never clicked through it. Before that change, a request submitted without touching the dropdown was filed as "Software".
- **Mobile:** layout breakpoints exist at 720px but I never looked at a narrow viewport. Reject was never clicked in the browser, though it shares the approve code path.
- `fixtures/` is still empty. Sample data goes in through the button, as the brief asked.
