# Spend requests: build report

## Time

- Start: 2026-10-06 23:54:43 CEST (from `date` at the first command)
- Finish: 2026-10-06 23:57:31 CEST (from `date` after stopping the dev loop), plus the few minutes it took to write this report
- Inside the 45-minute time box: yes. The system clock shows under five minutes passed. That is shorter than the work felt, so treat the clock reading as the record rather than as a measured duration.

## What was built

- Tier 1 Preact page. One owned table, `requests`, replaces the scaffold's `notes` table. It stores amounts as integer cents, status as text, requester and decider names and ids, the decision note, `requestedAt` and `decidedAt`. Indexes: `byRequestedAt`, `byStatus (status, requestedAt)` and `byStatusDecided (status, decidedAt)`.
- The header shows the logo, the tool name and the signed-in viewer (`patchy.me()`).
- Three stat cards: pending count, pending amount, and the amount approved this month (counted by decision date, from the start of the local calendar month).
- A **New request** form with: what it's for, vendor, amount in USD, category, reason. It records the viewer's name and id and the time of the request.
- Status filter tabs (All, Pending, Approved, Rejected) and a list sorted newest first by `requestedAt`. Each row shows the title, vendor and reason, category, requester, relative date, amount and a status badge. Decided rows show "Approved/Rejected by X: "note"". The list loads 100 rows at a time, with a **Show more** button up to 1,000.
- Pending rows show Approve/Reject ghost buttons to everyone except the requester, who sees "Yours". Clicking one opens an inline row with an optional note and a confirm button.
- The empty state has **Load sample data**. One `insertMany` call inserts the eight requests, with dates measured back from the moment of the click.
- Every screen reads through `useQuery` subscriptions, so changes made by one viewer show up live for the other.

Verified in `pnpm patchy dev` with Playwright and Chromium. Screenshots are in `/tmp/pwtest/`.

1. Ada Park (primary viewer) saw the empty state, then loaded the sample data. The page showed 4 pending, $3,792 pending and $79 approved this month.
2. Ada submitted "Team lunch for the launch", Dishoom, $245.50. Her own row showed "Yours" and no approve buttons.
3. Dev Colleague (the `colleagueUrl` viewer) approved it with the note "Enjoy it.". Ada's page updated live: the row read "Approved by Dev Colleague: "Enjoy it."", the summary showed 4 pending and $324.50 approved this month, and the Rejected filter showed 1 row.

`pnpm typecheck` and `pnpm lint` pass. The dev loop is stopped; local data is kept.

## How the look was decided (in order)

1. **`AGENTS.md`** sent me to `patchy-look` before styling and told me `src/main.tsx` imports the company look.
2. **`.agents/skills/patchy-loop/SKILL.md`** covered tier 1 rules that shape the UI: forms can't submit natively (so buttons use `type="button"` with Enter handlers and `reportValidity()`), there are no external assets (so the logo is imported and embedded), there is no client storage, and there are two dev viewers.
3. **`.agents/skills/patchy-look/SKILL.md`** set the visual direction:
   - The style-precedence rules: no request from the user and no existing CSS in `src/`, so Linear's look applies.
   - Write CSS unlayered and use the `--look-*` tokens, with `color-mix` for tints.
   - I lifted its component recipes almost unchanged: page header, stat, card, list table, badge, secondary, ghost and danger buttons, form and empty state.
   - Rules I followed: one primary button in view; status shown as a dot plus muted words; the accent only on the primary action, the selected tab and focus; the 1024px column; the 4px grid; sentence case; the plain voice.
4. **`patchy/_generated/look.css`** showed what plain elements already get (tables, inputs, labels, buttons default to the accent fill). I only override where a recipe needs a different button.
5. **`.agents/skills/patchy-preact/SKILL.md` and `patchy-tables/SKILL.md`** were for behaviour, not looks: `useQuery`, indexed lists and whole-result rendering.

## Styling uncertainties and wants

- **Status colours.** The look's status set has no "approved" or "rejected". I mapped Pending to in-progress yellow `#f0bf00`, Approved to done green `#27a644` and Rejected to the danger red. These are literal hex values the brief allows, not tokens.
- **Selected filter tab.** There is no tab recipe. I made one from the ghost button plus the brief's "selected tint that carries brand" (accent at 14% and a 35% border).
- **Approve and Reject.** The confirm button for Approve is secondary rather than primary, so New request stays the only primary button in view. Reject uses the danger recipe. A dedicated "positive" button would have been useful.
- **Header.** The logo already includes the "Linear" wordmark, and I also put the tool name next to it. That duplicates the page `h1` a little; I wasn't sure whether the header should carry the tool name at all.
- **Missing pieces I wanted:**
  - a select/dropdown recipe (the native `<select>` arrow doesn't quite match the inputs);
  - a toast for confirmations (the brief mentions one but gives no recipe);
  - a table-row "expanded" pattern for the inline decision.
- **Font.** Inter isn't bundled, so the page falls back to system fonts and weights 510/590 snap to 500/600, as the brief warns.

## CSS files written

- `src/app.css`: about 153 lines. It is the only CSS file; it is unlayered, imported after `look.css` in `src/main.tsx`, and roughly half of it is the look brief's recipes copied in.

`patchy/_generated/look.css` is generated and I did not edit it.

## Known bugs and unfinished parts

- **Self-approval is blocked only in the UI.** On tier 1 every viewer can write any row through the client, so a determined requester could approve their own request, and two people deciding at the same time is last-write-wins. Enforcing this needs tier 2 handlers, which I did not build.
- **Sample rows have no user ids.** They are matched to the viewer by name, so a real user named e.g. "Sam Patel" would be treated as the requester of Sam's sample rows.
- **Sample decision dates are my assumption.** The brief gives none, so each decided sample is set to one day after it was requested (capped at now). With today being 6 October, only the $79 charger counts as approved this month.
- **"Approved this month" uses the decision date** and the browser's local month start. The month boundary is computed once per page load.
- **Summary limits.** The cards sum at most 1,000 pending or approved-this-month rows (one page). There is no paging beyond that.
- **Relative dates don't tick.** "Today"/"Yesterday" only re-render when data changes, and their thresholds are approximate (24-hour buckets, not calendar days, after the first day).
- **One change not seen in the browser.** I changed money formatting to always show two decimals for non-whole amounts ($245.50, not $245.5) after the browser run. Typecheck and lint passed afterwards, but I did not re-screenshot it.
- **No editing, cancelling or deleting of requests, and no notifications.**
- **Leftover `notes` table.** The scaffold's table was removed from the config; before the first publish, local data for it is simply discarded.
- **Not published**, as instructed.
