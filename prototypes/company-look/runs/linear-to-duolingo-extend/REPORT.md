# Report: Mine filter, CSV export, category summary

- **Started:** 2026-10-07 02:20:57 CEST (`date` at the start of the run)
- **Finished:** 2026-10-07 02:24:46 CEST (`date` right after stopping the dev loop), plus the few minutes it took to write this report. The machine clock seemed to run slowly compared with the work done, so treat these as the clock's readings, not a precise measure of elapsed time.

## What was added

1. **Mine** is a toggle button (`aria-pressed`) to the right of the status tabs, after a thin divider. It works together with the status tabs, so "Approved + Mine" is possible. Each pairing reads its own index. I added two non-unique indexes to `patchy.config.ts`, `byRequester` (`requesterId, requestedAt`) and `byRequesterStatus` (`requesterId, status, requestedAt`), so the filtering happens in the query and not in the browser. I then ran `pnpm patchy refresh`. Mine stays disabled until `patchy.me()` returns the viewer.
2. **Download CSV** is a quiet button at the right end of the toolbar.
   - It pages through the current query (status plus Mine) 1,000 rows at a time, up to 10,000 rows. So it exports everything the filter matches, not just the rows currently shown.
   - It builds the file with `patchy/csv` `stringify` (formula protection left on) and hands it to the shell with `patchy.download`.
   - After the handoff it shows "Downloaded N requests." If the viewer clicks "Not now" (`download_discarded`), nothing is shown. Any other failure shows an error.
   - The filename includes the filter, e.g. `spend-requests-mine-approved-2026-10-07.csv`.
3. **Approved this month by category** is a panel directly under the three stat cards.
   - It reuses the existing `approvedThisMonth` subscription (by decision date), so it adds no new query.
   - All five categories are listed, sorted by amount, with a single-colour bar, the request count and the dollar amount. Categories with no spend are greyed out. Unknown category values are counted under Other.
   - There is a hover title on each row and a screen-reader-only table header.

## How I decided what it should look like (in order)

1. **`AGENTS.md`**: the purpose and file layout, and which skills to read.
2. **`.agents/skills/patchy-loop/SKILL.md`**:
   - `patchy/csv` and `patchy.download` are the supported ways to export (no in-frame downloads). Show success only after the handoff, and handle `download_discarded`.
   - "Use bounded pages, not fetch-everything browser filtering" and "declare the index the UI needs" are why I added indexes for Mine.
   - The dev loop: `patchy dev --json`, plus a second viewer at `colleagueUrl`.
3. **`.agents/skills/patchy-look/SKILL.md`**: this decided the styling. Its order of precedence is (1) the person's request, (2) **the patch's own CSS in `src/`**, (3) the company's (Duolingo) look. The brief asked for no particular style. `src/app.css` already has its own clear style: 1px hairlines, font weight 510, 12–13px grey meta text, "quiet tabs, the selected one carries a brand tint", and softly tinted cards. So the new parts follow `app.css`, not the Duolingo brief's 2px borders, button lips and uppercase labels. From the look skill I kept only the rule about colours: use `--look-*` tokens and `color-mix` from them, no new hex values.
4. **`.agents/skills/patchy-preact/SKILL.md` and `patchy-tables/SKILL.md`**:
   - `useQuery` behaviour, and the `list` options for `index`, `eq` and `cursor`.
   - Indexes are additive. This patch has not been published, so they are safe to add.
5. **`src/App.tsx` and `src/app.css`** (the existing code): I reused existing pieces and did not invent new ones.
   - Mine reuses `.tab` / `.tab-selected`.
   - Download CSV reuses `.button-ghost`.
   - The panel reuses `.card`, `.stat-label` and `.stat-sub`.
   - Status and error messages reuse `.muted` and `.error`.
   - Wording follows the existing copy ("Couldn't …", "Try another filter.").
6. **The dataviz skill** (a Claude Code skill, not a project skill): one series of amounts across categories means a ranked bar list in one colour. Values are written as text, no legend is needed, and bars have rounded ends. No palette validation was needed for a single colour. The bar uses a darkened accent, `color-mix(accent 70%, fg)`, so it shows up on the light card.
7. **Screenshots in the dev shell** (Playwright + `/usr/bin/chromium`) showed that `look.css`'s base `button` rule (48px minimum height, a green 4px "lip" shadow, uppercase text) leaks onto `.tab` and `.button-ghost`. The existing status tabs and Approve/Reject buttons already looked chunky and green-lipped, which the patch's CSS comments say they shouldn't be. Since the new toolbar controls share these classes, I added a small reset.

## CSS changes (all in `src/app.css`, about 29 lines added, none removed)

| Lines | Change                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `.toolbar-divider`: a 1px × 16px divider between the status tabs and Mine.                                                                                                                                                                                                                                                                                                                                |
| 6     | **Reset on the existing `.tab` and `.button-ghost`** (and their `:active` state): `min-height: 0`, `margin-bottom: 0`, `box-shadow: none`, `text-transform: none`, `letter-spacing: 0`, `transform: none`. **This visibly changes existing controls:** the status tabs and the row Approve/Reject buttons lose the inherited green lip and uppercase, and go back to the quiet style `app.css` describes. |
| 1     | `.tab:disabled, .button-ghost:disabled`: half opacity and a transparent background, instead of the look's grey disabled fill.                                                                                                                                                                                                                                                                             |
| 19    | The `.breakdown*` panel: margins, header row, a borderless inner table (overrides the look's table border, header background and uppercase), bar cell, the bar itself, count and amount columns, and the greyed-out zero rows.                                                                                                                                                                            |
| 1     | In the existing `@media (max-width: 720px)` block: `.toolbar { flex-wrap: wrap; }` so the longer toolbar wraps on narrow screens.                                                                                                                                                                                                                                                                         |

Other changes, besides CSS:

- `src/App.tsx`: about 130 lines added (list arguments, CSV building and export, Mine state, the `CategoryBreakdown` component).
- `patchy.config.ts`: 2 index lines.
- The generated files were regenerated by `pnpm patchy refresh`.

## Verification

- `pnpm typecheck` and `pnpm lint` both pass.
- I ran `pnpm patchy dev --json` and drove the real shell with Playwright, as Ada (primary viewer) and as the colleague viewer:
  - I loaded the sample data, approved "Figma seats renewal" as Ada, and created "Team lunch" as Ada.
  - Mine as Ada showed only Team lunch. Mine + Approved showed "None of your approved requests". Mine as the colleague showed an empty "None of your requests".
  - The panel showed Software $1,440 and Equipment $79, matching the $1,519 stat card.
  - Download CSV on Approved brought up the shell's download card. After clicking it, the browser received `spend-requests-approved-2026-10-07.csv` with all 4 approved rows and the right columns, and the page showed "Downloaded 4 requests."
- The dev loop is stopped (`pnpm patchy dev stop`); local data was kept.

## Known bugs and unfinished parts

- **Mine only matches on `requesterId`.** The existing "Yours" label falls back to matching by name when `requesterId` is null (sample rows). Mine does not, so name-only rows never appear under Mine. Real requests made through the form always have an id.
- **The summary panel reads at most 1,000 approvals per month** (the existing query's limit). If there are more, it says "First 1,000 approvals" and the totals are undercounted, as the existing "Approved this month" card already is.
- **CSV export stops at 10,000 rows** and says so in its message. Pages are fetched one after another at click time, so they are not a single consistent snapshot. Amounts are in dollars with 2 decimal places, and timestamps are ISO UTC strings as stored.
- **"This month" uses the viewer's local month start**, as the existing card does. There is no handling for time zones.
- **On narrow screens (under about 720px)** the request table still overflows sideways. That was already the case before this change and is not fixed. The toolbar now wraps instead of overflowing.
- **The button reset changes existing visuals** (tabs and Approve/Reject) as described above. The patch's `.button-secondary` and `.button-danger` (the compose and decide buttons) still inherit the look's lip, and I left them alone.
- **Index changes:** according to the loop skill, schema changes before the first publish recreate local dev data. The table was empty when I started the dev loop, so I can't tell whether anything was wiped. Published data isn't affected, because there is no publish yet.
