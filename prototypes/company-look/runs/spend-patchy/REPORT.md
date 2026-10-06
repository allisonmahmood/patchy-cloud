# Spend requests: build report

## Time

- Start: 2026-10-06 23:55:13 CEST (first `date` call)
- Finish: 2026-10-06 23:58:30 CEST (`date` after stopping the dev loop)
- Finished inside the 45-minute time box. The machine clock reports about 3½ minutes between those two calls. That seems short for the amount of work, so the shell clock may not match wall time. Either way, the work finished well inside the box.

## What was built

- `patchy.config.ts`: replaced the scaffold `notes` table with one `requests` table (tier 1). It stores amount as integer cents, the requester's name and id, `requestedAt`, a `status` that defaults to `pending`, and the decider's name, id and note plus `decidedAt`. It has three indexes: `byRequestedAt`, `byStatus (status, requestedAt)` and `byStatusDecided (status, decidedAt)`.
- `src/App.tsx`: the page, which has:
  - a header showing who is signed in;
  - three summary stats: pending count, pending total, and approved this calendar month (by decision date);
  - a "New request" form;
  - a request list, newest first, with All/Pending/Approved/Rejected filter tabs;
  - an inline "Decide" row with an optional note and Approve/Reject buttons;
  - an empty state with **Load sample data**.

  All reads are `useQuery` subscriptions, so a second viewer's changes appear live.

- `src/sample.ts`: the eight sample requests, dated relative to the moment the button is pressed. Names are stored as given and `requestedById` is null.
- `src/main.tsx`: imports `src/app.css` after `look.css`. `index.html`: the title is now "Spend requests".

Exercised in `pnpm patchy dev` with Playwright and Chromium (screenshots `/tmp/spend-*.png`):

1. As Ada Park (the primary viewer), loaded the sample data, which produced exactly 8 rows.
2. Ada submitted "Team lunch for launch day" ($245.50). Her own row shows "Your request. A teammate decides." and has no Decide button.
3. As Dev Colleague (the `colleagueUrl` viewer), approved it with a note. Both views updated live.
4. Final numbers: Pending 4 / $3,792, and Approved in October $324.50. That is the $79 charger decided on Oct 1 plus the new $245.50. The sample approvals from 9 and 20 days ago fall in September.
5. The Approved filter tab worked.

`pnpm typecheck` and `pnpm lint` pass. The dev loop was stopped (`Stopped. Local data retained.`). Nothing was published.

## How I decided what the page should look like

In this order:

1. **`AGENTS.md`**: pointed me to the look skill and told me `src/main.tsx` imports the company look.
2. **`.agents/skills/patchy-loop/SKILL.md`**: tier 1 constraints that shape the UI:
   - no native form submit, so I used `type="button"` buttons and an Enter handler;
   - no external assets;
   - render from subscriptions.

   It also told me to use the `colleagueUrl` to test as a second viewer.

3. **`.agents/skills/patchy-preact/SKILL.md`**: `useQuery` for subscribed screens, and separate loading and error states.
4. **`.agents/skills/patchy-look/SKILL.md`**: the main source for the visuals. What I took from it:
   - the token-only colours and the "which style wins" order;
   - the `.page-header` with the 32px logo top left;
   - `.panel` frames with a 2px ink border and a 4px hard shadow;
   - `.stat` label/value;
   - yellow-highlight `.tabs`, used for the status filter;
   - `.badge-warning`, `-success` and `-danger` for Pending, Approved and Rejected;
   - `.button-secondary`, `-danger` and `-quiet`;
   - the dashed `.empty` state, `.form-hint` and `.form-error`, and `.note-danger` for load errors;
   - a 1180px max width, tabular numbers and sentence-case copy in its voice ("Approve request", "Couldn't save the request. …").

   Its example header even reads "Expense approvals", which confirmed the direction.

5. **`patchy/_generated/look.css`**: checked what plain elements already get (the primary button, inputs, labels, the table with an ink header rule) so I didn't restyle them.
6. **`.agents/skills/patchy-tables/SKILL.md`**: index and range rules. These drove the `byStatusDecided` index for the "approved this month" stat instead of filtering every row in the browser.

Layout: the form sits in a narrow panel beside the list panel, and stacks below 860px. The three stats share one framed strip divided by dashed rules, because the brief says "don't tile dashboards of cards". The list uses the plain `table` from look.css, not `.table-ink`, because the brief reserves the ink table for small summary tables.

## Styling: unsure or missing

- **Two panels side by side.** The brief prefers one white working panel, but I used two plus the stats strip, so the form stays visible next to the list. That is arguably a mild departure.
- **No filter-tab recipe for buttons.** The `.tabs` recipe styles `<a aria-current>`. A status filter isn't navigation, so I used `<button aria-pressed>` and re-created the tab look on buttons, including resetting the primary-button styles.
- **No success token.** Green, amber and highlight yellow are hex literals copied from the brief, so they won't follow a company look change. I also used the green literal for the "Submitted …" confirmation text.
- **Missing pieces I'd have liked:**
  - a compact/small button size (I made `.button-small`);
  - a "row expanded / inline editor" recipe (I tinted the decision row with an accent wash at 6%);
  - an amount/currency input recipe (I wrote a `$` prefix overlay).
- **Fonts.** The test Chromium on Linux renders the system stack with fixed-weight fonts, so 450/850 weights flatten as the brief warns. I didn't compensate.

## CSS files written

- `src/app.css`: about 365 lines. Most of it is recipes lifted from the look brief. Page-specific rules are about 120 lines: stats strip, two-column layout, amount prefix, filter tabs on buttons, request table cells and the decision row.

No other CSS files. `patchy/_generated/look.css` is untouched.

## Known bugs and unfinished parts

- **Tier 1 means nothing is enforced on the server.**
  - "Anyone other than the requester" is only a UI rule. A viewer could still write a decision on their own request through the broker.
  - The "already decided" check is a read-then-write, not a transaction, so two simultaneous deciders could both write (last write wins).
  - Moving to tier 2 handlers would fix both.
- **Self-approval check for sample rows is by name only.** Sample rows have no user id, so the check compares names. A real user who happens to be named "Sam Patel" couldn't decide Sam's sample rows.
- **List size limits.**
  - The list shows the newest 200 rows and says so when there are more. There is no "load more".
  - The pending and approved-this-month stats read at most 1,000 rows each.
- **Month boundaries and dates.** "Approved this month" uses the viewer's local month start, computed once at page load, so a page left open across midnight at month end won't roll over. Relative dates ("Today", "Yesterday") are also computed once per list render and only refresh on reload or remount.
- **Sample data edge cases.**
  - The empty-state button checks for existing rows first, but two people pressing it at the same instant could still insert 16 rows.
  - Sample rows have no reason; I invented decision times of request + 4h, capped at now.
- **Reason is required on the form.** The brief said "a short reason" and I made it required. Sample rows have none.
- **Mobile layout untested.** I didn't screenshot the narrow (<860px) layout.
