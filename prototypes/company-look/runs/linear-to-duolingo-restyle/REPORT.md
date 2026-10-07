# Report: spend requests restyle to the company look

- **Start:** 2026-10-07 02:21:17 CEST (`date` at the start of the run)
- **Finish:** 2026-10-07 02:24:14 CEST (`date` after stopping the dev loop)

The system clock shows about 3 minutes between these readings, which seems short for the amount of work done. These are the clock's readings as printed. I didn't measure the time separately.

## What I read, in order, and what I took from each

1. **`AGENTS.md`**: the tool is tier 1. Read `patchy-look` before styling and `patchy-preact`/`patchy-loop` for the build loop. Run `pnpm typecheck` and `pnpm lint`.
2. **`patchy.config.ts`, `patchy.json`, `package.json`**: tier 1, one `requests` table, no `uses`. `lint` is declared, so I ran it too.
3. **`.agents/skills/patchy-look/SKILL.md`**: this was the main input. The company look is now **Duolingo's**. It calls for:
   - 2px borders with a 4px bottom "lip"
   - 16px radius
   - weight 500/700 only
   - uppercase letter-spaced labels on buttons, nav, table heads and meta
   - one green button per view and no green text
   - link blue for "where you are"
   - a 1000px centred column
   - a 72px white header with a 32px logo

   I copied its component recipes directly: `.button-secondary`, `.button-danger`, `.button-text`, `.badge` plus its success/danger/info variants, `.card`, `.stat`, `.page-header`, the nav underline, the table panel and `.empty-state`, along with its voice examples. Its "which style wins" rule ranks the patch's own CSS above the look. I treated this request ("update to our current company look") as rule 1, so the look wins.

4. **`.agents/skills/patchy-loop/SKILL.md`**: exercise with `pnpm patchy dev --json` and test both `url` and `colleagueUrl`. Native form submit is blocked, and that was already handled.
5. **`.agents/skills/patchy-preact/SKILL.md`**: no changes needed to the hooks or `useQuery`. The logic was left untouched.
6. **`patchy/_generated/look.css`**: shows what the look already styles at element level inside `@layer look` (buttons are green with a lip, inputs, tables, labels, focus). My unlayered CSS overrides it. This file is how I found that `button:disabled` loses to unlayered `.button-secondary`, so I added explicit disabled rules.
7. **`src/app.css`, `src/App.tsx`, `src/main.tsx`**: the old styling was a Linear-style look: 1px hairlines, weight 510/590, a blurred translucent sticky header, outlined pill badges with coloured dots (including a hard-coded yellow `#f0bf00` and green `#27a644`), and quiet tinted tabs. `main.tsx` already imports `look.css`, so it needed no change.

## What changed

### `src/app.css`: rewritten (153 lines before, 195 after)

Every rule was replaced. By area, with rough line counts:

- **Header** (~17 lines): 72px tall, solid white, 2px bottom border, no blur or translucency. The logo goes from 24px to 32px. The title gets a 2px divider and uppercase grey 15px/700. The viewer name is uppercase grey 13px/700.
- **Page / title row** (~10 lines): max width 1024 → 1000px, smaller paddings in multiples of 8, the title row is centred, and the primary button gets wider padding. Error text is 15px **bold** danger, as the brief requires for red text.
- **Buttons** (~25 lines):
  - `.button-secondary` uses the brief's recipe: white, link-blue text, 2px border and a 4px lip. This replaces the old 32px-high grey 1px button.
  - `.button-danger` is now solid red with white text and a darker red lip, instead of a 12% red tint.
  - `.button-ghost` is replaced by the brief's `.button-text` (quiet uppercase grey), plus hover/active/disabled resets.
  - New `.button-small` (36px) and `.button-reject` (dark-red text) for the per-row Approve/Reject buttons.
  - Explicit `:disabled` rules for the secondary and danger buttons.
- **Stats** (~20 lines): bordered white tiles with a 4px bottom edge instead of grey cards with 1px borders. The value is 28px/700 in the display font, the label is uppercase 13px/700 placed under the value (via `order`), and the gap is 16px.
- **Compose form** (~14 lines): uses `.card` (white, 2px with a 4px bottom, 16px radius). The h2 goes up to 24px and gaps are 16px. Inputs keep the look's surface fill instead of the forced white background, and the `max-width: 624px` was dropped so the form fills the card.
- **Status tabs** (~16 lines): now Duolingo's nav pattern. Uppercase grey labels with no fill or lip. The selected tab is link blue with a 3px blue underline sitting on the 2px toolbar rule. This replaces the green-tinted pills. The "N shown" count is an uppercase meta label.
- **Request table** (~25 lines): relies on the look's bordered table panel (2px border, 16px radius, uppercase headers, 2px dividers). I removed the 12px header override and the 1px-era tints.
  - Hovered rows use `--look-surface`, and title and amount are bold.
  - The open decision row gets a light link-blue tint, with a higher-specificity selector so hover doesn't override it.
  - New `.table-scroll` wrapper (`overflow-x: auto`) so the table scrolls on narrow screens instead of overflowing the page.
- **Badges** (~18 lines): the brief's badge: 8px radius, uppercase 13px/700, no border or dot. Pending uses the info (blue) tint, approved the success (green-wash) tint and rejected the danger tint. The hard-coded hex colours are gone, so every colour now comes from a token or `color-mix` of tokens.
- **Empty state** (~13 lines): the brief's recipe: 96px green-wash rounded mark, 24px h2, muted paragraph and 64px vertical padding.
- **Responsive** (~6 lines): on narrow screens the title row stacks so the button is full width, and the header title and viewer name are hidden.

### `src/App.tsx`: markup and copy only, no logic changes

- Row Approve/Reject buttons: `button-ghost` → `button-secondary button-small` (Reject also gets `button-reject`).
- Cancel / Show more: `button-ghost` → `button-text`.
- Empty state: `<strong>/<span>` → mark + `<h2>` + `<p>`. The copy changed to the brief's voice: "No requests yet. Enjoy the quiet!" The filtered empty state reads "No pending requests" / "Nothing here right now. Try another filter."
- The table is wrapped in `<div class="table-scroll">`.

There is still one green button per view: "New request", "Submit request" while composing (the header button is hidden then), or "Load sample data" in the empty state. The approve confirmation stays a secondary (white/blue) button, so it doesn't add a second green button.

## Verification

- `pnpm typecheck` passes and `pnpm lint` passes.
- I ran `pnpm patchy dev --json` and drove it with Playwright and `/usr/bin/chromium`. The script is at `/tmp/spend-look-check/run.mjs` and the screenshots are in the same folder.
  - Working: the page loads, I created a request as Ada (shown as "YOURS" with no approve buttons), approved one request with a note, and rejected another.
  - All four filter tabs return the right counts, and the stats update.
  - The colleague URL shows Approve on Ada's request.
  - At 420px wide, the page stacks and the table scrolls horizontally.
- The dev loop is stopped (`pnpm patchy dev stop`). Local data was kept.
- I did not publish.

## Known bugs / unfinished

- **The empty state was not checked visually.** Local dev data already had rows when I started. I didn't run `patchy dev reset`, which would have wiped them, so I never saw the zero-rows screen or the "Load sample data" path in the browser. The filtered empty state ("No pending requests") also never came up, because every filter had rows.
- **Brand fonts are missing locally.** DIN Next Rounded and Feather aren't installed, so the screenshots use the system sans fallback, as the brief predicts. Weights and uppercase labels carry the look.
- **The h1 stays sentence case** ("Spend requests"). I didn't use the optional lowercase hero ("spend requests.").
- **Column widths shift** when a row's actions column changes (approve buttons vs. "Yours" vs. empty), and long titles wrap at desktop width. This behaviour was there before the restyle.
- **The table needs horizontal scrolling on phones.** There is no card-per-row mobile layout.
- **A date oddity I left alone:** a sample row created "0 days ago" showed as "Yesterday". That comes from the existing `formatWhen` and sample-time logic near midnight, not from the restyle.
- **A note on screenshots:** I first wrote screenshots to `/tmp/pwtest`. Another process overwrote my script there with one for a different app, so I moved to `/tmp/spend-look-check` and didn't touch its files.
