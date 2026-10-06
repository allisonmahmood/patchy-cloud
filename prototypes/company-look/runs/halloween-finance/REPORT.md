# Halloween costume contest — build report

- **Start:** 2026-10-06 23:55:44 CEST (from `date` at the start of the run)
- **Finish:** 2026-10-06 23:59:49 CEST (from `date` after stopping the dev loop)

The system clock reports about four minutes. That seems short for the work done, but those are the times it gave.

## What was built

- `patchy.config.ts`: I replaced the scaffold's `notes` table with two tables:
  - `entries`: name, costume and category (`scariest` / `funniest` / `group`), with a `byCategory` index.
  - `votes`: an `entry` ref and a `voter` user id, with a **unique** `(entry, voter)` index. One person can vote for an entry only once.
  - Ran `pnpm patchy refresh` afterwards.
- `src/App.tsx`: a single Preact page.
  - Sign-up form: name, costume title and a category picked from radio pills. It saves with a `type="button"` button and an Enter-key handler, because the sandbox blocks native form submission.
  - Live `useQuery` subscriptions on both tables. Entries are grouped into the three categories and sorted by vote count. The leader in each category gets a candle and a glow.
  - The Vote button toggles. Voting again removes your vote. `patchy.me()` supplies the voter id.
  - Empty state with a **Load sample data** button. It does one `insertMany` of six invented entries, two per category.
- `src/main.tsx`: now imports `./spooky.css` instead of the company `look.css`.

## How I decided what the page should look like

1. **`AGENTS.md`**: says to read `patchy-look` before styling and `patchy-preact` before building. The page's own purpose (costume contest) comes from here.
2. **`.agents/skills/patchy-look/SKILL.md`**: the most important input. Its "Which style wins" rule ranks _what the person asked for_ above the company look. It also names a Halloween page as an example and says to override the look, or drop the import when nothing of it should stay. The brief asked for purples, pumpkin orange, a creepy font and cobwebs. The Vanguard look is the opposite: white, black pills, square, no gradients, red used sparingly. So I **removed the `look.css` import entirely** and didn't use the `--look-*` tokens. I kept two practical habits from the skill:
   - colours in one place as custom properties, with tints made by `color-mix` instead of scattered hex values;
   - an 8px spacing unit.
3. **`.agents/skills/patchy-loop/SKILL.md`**: tier 1 constraints that shaped the design:
   - No external fonts, styles or assets. So there's no Google-Fonts "Creepster". The creepy display type is a fantasy font stack roughened by an inline SVG `feTurbulence`/`feDisplacementMap` filter, with an ember glow and a blood-red drop shadow.
   - Cobwebs, spiders and the moon are inline SVG or CSS. Bats and the ghost are emoji.
   - Native forms are blocked, hence the button handlers.
4. **`.agents/skills/patchy-preact/SKILL.md`** and **`patchy-tables/SKILL.md`**: use `useQuery` for live screens and render the whole subscribed result, not local copies. Use ref columns, unique indexes and branded `Id<>` types (`typecheck` caught the plain-`string` ids).
5. The brief itself set the theme: deep purple night background, pumpkin-orange primary buttons, blood red for "Voted" and the Scariest column, slime green for Best group and focus rings, fog, a dangling spider and flying bats. I also added a `prefers-reduced-motion` fallback.

## CSS files written

| File             | Lines |
| ---------------- | ----- |
| `src/spooky.css` | ~203  |

That's the only stylesheet. I didn't edit any generated CSS.

## How it was exercised

- `pnpm typecheck` and `pnpm lint` both pass.
- `pnpm patchy dev --json`, then a Playwright script in `/tmp/halloween-check/` against `/usr/bin/chromium`:
  - Empty state shown; **Load sample data** inserts 6 entries.
  - Entering a new costume (Funniest) works, and it appears live.
  - The primary viewer voted on an entry. Then the **colleague URL** (a second viewer, at a 420px mobile width) voted on the same entry. The count went to 2 on the first viewer's screen without a reload, and the leader highlight appeared.
  - I used `pnpm patchy dev reset` once to re-check the empty state. That wiped only local, disposable dev data.
- Screenshots: `/tmp/halloween-check/*.png`.
- I stopped the dev loop with `pnpm patchy dev stop`. Nothing was published.

## Known bugs and unfinished parts

- **The creepy font isn't guaranteed.** No webfont is bundled. The stack (`Creepster`, `Nosifer`, `Chiller`, `Jokerman`, `Papyrus`, …, `fantasy`) usually falls back to a plain serif, as it did in my screenshots. The SVG ooze filter and glow do the "creepy" work. A real creepy face would need a font file embedded as a data URL, and I had no font file and wasn't allowed to download one.
- **"Vote once" isn't secure.** On tier 1 the page writes the `voter` id itself, and every viewer can write any row. The unique `(entry, voter)` index stops accidental double votes, and the UI shows one vote per person per entry. But someone calling the client directly could forge votes, delete other people's votes, or delete entries. Enforcing it properly needs tier 2 handlers.
- **Count limits.** Vote counts come from one page of up to 1,000 votes, and the page shows at most 500 entries. Past that, counts and lists would be incomplete. That's fine for an office, but it isn't paginated.
- **Duplicate samples are possible.** If two people click **Load sample data** at the same moment, both inserts go through and you get 12 sample entries.
- **No editing or withdrawing entries** from the UI.
- **Raw error text.** Error messages add the client's raw message after a themed prefix, e.g. if a double-click hits the unique index.
- Bat, ghost and pumpkin icons are emoji, so they look different on each OS.
- On narrow screens the hero title can overlap the cobweb corners and moon slightly. It's decorative but not polished.
- The patch name in config is still the scaffold's `halloween-finance`.
