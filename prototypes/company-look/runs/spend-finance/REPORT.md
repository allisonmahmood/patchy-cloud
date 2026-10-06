# Spend requests: build report

## Time

- Start: 23:54:58 CEST, 2026-10-06 (first `date` call)
- Finish: about 23:59–00:00 CEST by the same clock (`date` read 23:58:59 when I stopped the dev loop; this report was written just after)
- Inside the 45-minute time box: yes. The system clock reports far less elapsed time than the work felt like. I'm reporting what the clock said, not an estimate.

## What was built

- **Tier 1**, one owned table `requests` in `patchy.config.ts`. It replaces the scaffold's `notes` table, which had never been published. Amounts are stored as integer cents. It has three indexes: `byRequestedAt`, `byStatus` (status, requestedAt) and `byStatusDecided` (status, decidedAt).
- **`src/App.tsx`** contains:
  - a page header;
  - three stats: pending count, pending amount and approved this month;
  - a list filtered by status, newest first;
  - a form to submit a new request;
  - an inline review row with an optional note and Approve / Reject;
  - an empty state with **Load sample data** and **Make a request**.
- Every screen is driven by `useQuery` subscriptions. The stats use their own indexed queries: Pending, and Approved with `decidedAt >= the first of the current month`.
- **`src/sample.ts`** holds the eight invented requests, dated relative to the moment the button is pressed. They are inserted in one `insertMany`.
- The requester is the viewer from `patchy.me()`. The page stores both the name and the user id. A request can't be decided by its requester: the page matches on user id, or on the stored name for sample rows, which have no id.
- **Exercised in `pnpm patchy dev`** with Playwright and Chromium. Screenshots are in `/tmp/spend-*.png`.
  1. Empty state, then Load sample data. The stats showed 4 pending, $3,792 pending and $79 approved in October.
  2. As Ada Park (primary viewer), I submitted "Team lunch for the launch", $245.50. Her own row shows "Waiting for a teammate" and no Review button.
  3. As Dev Colleague (`colleagueUrl`), I reviewed it, added a note and approved it. Both viewers then showed it Approved "by Dev Colleague" with the note. Approved this month rose to $324.50.
  4. The Pending filter showed the four remaining pending sample rows.
- `pnpm typecheck` and `pnpm lint` pass. The dev loop is stopped and local data was kept. Nothing was published.

## How I decided what the page should look like

I read these in this order:

1. **`AGENTS.md`**: the purpose. It sent me to the loop, Preact and look skills and said the company look is imported by `src/main.tsx`.
2. **`.agents/skills/patchy-loop/SKILL.md`**: the tier 1 limits that shape the UI:
   - no native form submit, so buttons are `type="button"` with an Enter key handler and `reportValidity()`;
   - no external assets;
   - `colleagueUrl` gives a second viewer for testing.
3. **`.agents/skills/patchy-preact/SKILL.md`** and **`patchy-tables/SKILL.md`**: use `useQuery` and render the latest subscribed result rather than re-reading after writes; use indexed, bounded pages.
4. **`.agents/skills/patchy-look/SKILL.md`**: almost all of the visual decisions came from here.
   - I lifted its component recipes directly: page header with logo and tool name, eyebrow, secondary / commit / danger / small buttons, badges, panel, `section-ruled`, stats, `table-data`, segmented control, form, empty state.
   - Its colour rules drove these choices:
     - black pill buttons by default;
     - the one red commit button is **Approve**, the action that moves money. It only appears inside the single open review row, so there's only ever one in view;
     - **Reject** is outlined in the danger colour;
     - the red 4px rule sits over the stats;
     - the pale accent tint marks the row under review.
   - Layout came from it too: a wide left-aligned 1296px column with 72px margins, data open between hairlines, the form as the only boxed element, and figures right-aligned.
   - Voice came from it: sentence case, verb-first buttons, no exclamation marks, and an "as of 10/06/2026" line under every stat.
5. **`patchy/_generated/look.css`**: to see which plain elements were already styled (buttons, inputs, tables, labels), so I only wrote what they don't cover. I also took the real token values from it.
6. **`patchy/_generated/logo.svg`**: imported as a URL for the header.

## Styling I was unsure of, or wanted and didn't have

- **The Approved badge colour.** No token holds a "positive" colour. I used the brief's turquoise pair (`#def5f0` / `#007873`), which the brief allows for data encodings. These are the only hard-coded hex values in my CSS.
- **The Pending badge.** The grey recipe badge disappeared on the grey hover row, so I gave it a white fill with a hairline border instead. That's my own change, not a recipe.
- **Cancel styled as a link.** The look has no tertiary or text button, so I styled Cancel like a link (blue, underlined). The brief says blue is for links only, so this bends that rule a little.
- **Fonts.** FF Mark isn't available, and the frame can't load external fonts. The page fell back to the system sans, so headings render flatter than intended, as the brief warns.
- **Some sizes outside the brief's scale.** The table is 15px and the meta lines are 13px. The brief says 14–16px for tables and lists 14 / 17 as the small sizes.
- **Things I didn't have:** no date-picker or select styling in `look.css`, so the select keeps native `appearance: auto`. There are no icons and no guidance for an inline "review" pattern inside a table, so the tinted expanded row is my own composition from the panel-tint idea.
- **Narrow widths.** Below 1100px the form moves above the list. I didn't check narrow widths beyond that rule. The table has no horizontal-scroll handling on small screens.

## CSS files written

- `src/app.css`: about 144 lines. It's the only CSS file I wrote, it's unlayered, and it uses `--look-*` tokens throughout.

## Known bugs and unfinished parts

- **Approval rules aren't enforced.** On tier 1, "anyone other than the requester" is checked only in the UI. Any viewer could change rows through the client directly. Enforcing it needs tier 2 handlers.
- **Two people can decide at once.** Before a decision, the page re-reads the row and refuses if it's no longer pending. That's a check-then-write without a transaction, so two simultaneous decisions can still race, and the last write wins.
- **Sample rows are matched by name.** They have no user id, so the requester check compares display names. A real colleague whose name matched an invented person ("Sam Patel") would be blocked from deciding that sample row.
- **Sample decision dates are invented.** Decided sample rows get `decidedAt` = request time + 4 hours. "Approved this month" counts by decision date in the viewer's local time. On 10/06 that counts only the $79 charger, because the $3,200 and $480 approvals fall in September. That's correct by my definition, but it's a choice the brief didn't specify.
- **The month boundary is fixed at load.** The stats' "as of" date and month start are computed once per page load and don't roll over at midnight.
- **The list is capped.** It shows at most 200 rows, and there's a note when it's truncated. The stats read up to 1,000 rows per status. There's no pagination UI.
- **Load sample data has no lock.** The empty state disappears once rows exist, but two people pressing the button at the same moment could insert the samples twice.
- **Little testing of errors.** Error states are rendered but weren't exercised. Neither was the empty state's inline "Make a request" form, which opens inside the button row.
- **Sample reasons are blank.** The task's table has no reason column, so the sample rows store an empty reason and the list doesn't show one.
