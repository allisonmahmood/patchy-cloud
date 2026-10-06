# Spend requests: build report

## Time

- Start: 2026-10-06 23:56:30 CEST (from `date` at the first command)
- Finish: 2026-10-06 23:59:36 CEST (from `date` after the dev loop stopped), plus a minute or two to write this report
- Finished inside the 45-minute time box: yes. (The system clock shows only about 3 minutes between the two readings. That looks too short for the work done, so treat the wall-clock figures with caution. Either way it was well inside 45 minutes.)

## What was built

- `patchy.config.ts`: replaced the scaffold's `notes` table with `requests`. Fields: title, vendor, `amountCents` (integer USD cents), category, reason, requester name and id, `requestedAt`, status (`pending`/`approved`/`rejected`, default pending), decider name and id, `decidedAt` and an optional note. Indexes: `byRequestedAt`, `byStatus [status, requestedAt]` and `byStatusDecidedAt [status, decidedAt]`. The list, the status filter and the "approved this month" total all read from these indexes instead of filtering in the browser.
- `src/App.tsx`: one Preact page, tier 1, live through `useQuery`. It has:
  - a header with the logo;
  - three stat tiles: pending count, pending total, and total approved in the current calendar month (counted by decision date);
  - status filter tabs and the request table, newest first, with "Show more" paging in steps of 50;
  - an inline Review panel with an optional note and Reject/Approve buttons;
  - a New request form;
  - an empty state with **Load sample data**.
- Who is asking or deciding comes from `patchy.me()`. A pending row shows Review only if the viewer is not the requester. Rows the app creates are matched on user id. Sample rows have no id, so they are matched on name.
- Sample data uses the eight rows exactly as given, with dates relative to the button press. Decided sample rows get `decidedAt` one day after they were requested, because the brief gives no decision date. That puts the $79 charger in this month's approved total and leaves out the $3,200 deposit (decided 8 days ago, Sep 28).

## Exercised in the dev loop

I ran `pnpm patchy dev --json` and drove the shell with Playwright and Chromium. Screenshots are in `/tmp/pw-spend/`.

1. Empty state, then **Load sample data**: 8 rows appeared. The tiles showed 4 pending, $3,792 pending, $79 approved in October.
2. As the primary viewer (Ada Park), I submitted "Team lunch for the launch", Sweetgreen, $184.50, Other. Ada's own row showed "Yours: a teammate decides" and no Review button.
3. As the colleague viewer (`colleagueUrl`, "Dev Colleague"), I reviewed it, added the note "Have fun!" and approved. The tiles updated live to 4 pending, $3,792 pending, $263.50 approved. The Approved filter shows "by Dev Colleague" and the note.
4. Reloading as Ada showed the same state.

I then stopped the dev loop (`pnpm patchy dev stop`; local data is retained). `pnpm typecheck` and `pnpm lint` both pass.

## How I decided what the page should look like

In reading order:

1. **`AGENTS.md`**: pointed me to the loop skill, the Preact skill, and to `patchy-look` before any styling.
2. **`.agents/skills/patchy-loop/SKILL.md`**: tier 1 constraints. Native form submit is blocked, so buttons are `type="button"` and Enter is handled by hand. There are no external assets, so the logo is embedded. It also covers the dev loop with a second colleague viewer.
3. **`.agents/skills/patchy-preact/SKILL.md`** and **`patchy-tables/SKILL.md`**: render the subscribed result rather than keeping a copy, and use indexed list queries. These shaped the data flow more than the look.
4. **`.agents/skills/patchy-look/SKILL.md`**: the main design source. What I took from it:
   - centred 1000px column, plus a narrow (~400px) centred form inside a bordered card;
   - header recipe (logo left, uppercase grey label right, 2px bottom border);
   - stat-tile recipe for the three totals;
   - "table as a grouped panel" recipe for the list;
   - badge recipe: blue info tint for Pending, green for Approved, red for Rejected;
   - secondary, danger and text button recipes;
   - empty-state recipe, using the brief's own voice line, "No requests yet. Enjoy the quiet!";
   - nav-tab underline style for the status filter (blue for "where you are");
   - lowercase hero title with a full stop ("spend requests.") and "Nice work!" for the success message.

   From its rules: keep one green button per view where possible, never green text, 2px edges with a 4px lip, uppercase labels, and every value taken from `--look-*` tokens. Tints use `color-mix` on the tokens; there are no new hex values.

5. **`patchy/_generated/look.css`**: checked what plain elements already get (buttons, inputs, tables, labels) so my CSS only adds components on top, unlayered.
6. **`patchy/_generated/logo.svg`**: imported as a URL into the header.

## Styling uncertainties and things I wanted but didn't have

- **One green button per view:** the open Review panel shows a green Approve while the header's green New request is also visible. I kept both because Approve is clearly the next action in that panel, but strictly it breaks the rule.
- **Fonts:** the brand fonts (DIN Next Rounded, Feather Bold) aren't installed, so Chromium falls back to the system sans. The rounded look is lost and the hero title is just bold.
- **Wide table:** the brief has no recipe for a 6-column table. I combined requester and date into one cell, and status, decider and note into another, to keep it inside 1000px. On narrow screens the table only scrolls sideways; there is no card layout for mobile.
- **No icons:** the SDK has no icon set and the brief forbids the mascot, so the empty-state "mark" is the plain green-tinted square from the recipe.
- **Pending badge colour:** the brief's badges are success, danger and info. I used info (blue) for Pending; a yellow or amber "waiting" colour would read better, but the brief keeps those colours out of the chrome.

## CSS files written

- `src/styles.css`: about 158 lines. This is the only CSS file. It is unlayered and imported after `look.css` in `src/main.tsx`.

## Known bugs and unfinished parts

- **No enforced rules (tier 1):** the "not the requester" rule and "only pending can be decided" are enforced in the UI only. Anyone with access could write rows directly. Real enforcement needs tier 2 handlers.
- **Possible double decision:** approve and reject re-read the row before updating, but that isn't atomic. Two people deciding at the same instant could both write, and the last write wins.
- **Possible double sample load:** Load sample data checks for existing rows first, but the same race applies, so two viewers pressing it at the same moment could insert 16 rows.
- **Name matching for sample rows:** sample rows store names only. A real user whose display name is exactly "Sam Patel" would be treated as the requester of Sam's sample rows.
- **Empty reasons on sample rows:** the brief gives no reason text, so the eight sample rows have an empty reason. New requests require one.
- **Summary capped at 1,000 rows:** each total reads at most 1,000 rows (one page). A larger backlog would undercount.
- **Month boundary:** "Approved this month" uses the viewer's local month start, computed once at mount. A page left open across midnight at month end keeps the old month until reload. The relative "Today / Yesterday" labels also don't advance without a reload.
- **Untested errors:** I didn't exercise the error paths (failed write, `unknown_outcome`) in the browser. Errors are shown inline but not retried.
- **Unused old table:** the scaffold's `notes` table definition was removed. Nothing was published, so this only affects local data.
- **Not published**, as instructed.
