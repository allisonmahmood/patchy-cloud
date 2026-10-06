# Capture notes: Patchy (the default look)

## Times

- Started 2026-10-06 23:42 CEST.
- Finished 2026-10-06 23:50 CEST (about 8 minutes, including one headless render of a sample tool page to check it).

## Sources

- `skills/patchy/references/patchy-plan-style.md`: the brief, the main source for values.
- `skills/patchy/references/welcome-patch.html`: the brief applied.
- `packages/core/src/html.ts`: Patchy's own app pages. The brief is written for documents and bans `<form>` and `<input>`, so it has no buttons, fields or working tables. The shell already translates the style into app UI. I used it for those translations, the same way capture.md's "Prefer the product to the marketing" rule says to.

## What the 13 tokens could not hold

| Source habit                                                                                        | Handling                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 32px engineering grid                                                                               | Kept in plain `body`: two `linear-gradient`s of `color-mix(in srgb, var(--look-fg) 3.5%, transparent)`, sized `calc(var(--look-space) * 4)`. This only gives 32px because the space token is 8px.                                                                                                                         |
| Paper wash (blue to cream to green gradient, `html` in paper-blue)                                  | Dropped. One `--look-bg` holds the cream. Paper-green can't be derived from any token. On a long tool page the wash stretches and suits a document more than a tool.                                                                                                                                                      |
| Noise overlay (`feTurbulence` `data:` SVG, fixed, multiply blend)                                   | Dropped. It's allowed (a `data:` URI isn't external), but it's a full-screen blended layer, adds compositing cost on scroll, and only decorates a document.                                                                                                                                                               |
| Hard offset shadows                                                                                 | Colour comes from the token (`var(--look-border)`); the offsets are literal: 2px on button hover and the selected tab, 4px on panels and the ink table. There is no shadow token, so a company with soft shadows can only say so in LOOK.md.                                                                              |
| `999px` pills                                                                                       | A literal in the `.badge` recipe. The single radius token holds the 8px card/button radius.                                                                                                                                                                                                                               |
| Second radius (6px fields in the app)                                                               | `calc(var(--look-radius) - 2px)` for inputs and tabs.                                                                                                                                                                                                                                                                     |
| Ink vs. body text (`--ink` #12110f for headings, frames and shadows; `--ink-soft` #36332d for body) | `--look-fg` = ink. Plain `body` text is `color-mix(in srgb, var(--look-fg) 86%, var(--look-bg))` = #33322f, which stands in for ink-soft. **Judgment call:** the token's contract says `--look-fg` is body text, but in Patchy ink is the brand colour and body text is a softer version of it.                           |
| Two line weights (2px ink frames vs 14% / 30% ink hairlines)                                        | `--look-border` = ink (#12110f, the same value as fg). Hairlines are `color-mix(... var(--look-border) 30%/14%, transparent)`. **Judgment call:** a hairline as the token value (line-strong as solid, #b8b6af) is 1.99:1 on the paper, which fails the 3:1 that input outlines need, and Patchy's frames are ink anyway. |
| Flat palette: blue, blue-dark, green, yellow, red, red-ink, amber-ink                               | Blue → `--look-accent`, blue-dark → `--look-link`, red-ink → `--look-danger`. Flat red #e94b35 dropped (3.77:1 under white text). Green, amber and yellow are **literals in LOOK.md recipes** (`.badge-success`, `.badge-warning`, the selected `.tabs` item), each marked with a comment and listed under Colour.        |
| Paper tints (blue, green, amber, red)                                                               | Blue and red tints come from `color-mix` with accent/danger. Accent at 9% on paper gives #eaeff3 against the source's #eaf5ff, a little greyer, which is acceptable. Green and amber are literals (above).                                                                                                                |
| Selected tab is yellow, primary button is blue                                                      | `--look-accent` = blue (primary button, focus, checkboxes). Yellow selected tab is a literal (above).                                                                                                                                                                                                                     |
| Mono stack (`--font-mono`)                                                                          | No token. A literal stack in the `.mono` recipe and the Type section.                                                                                                                                                                                                                                                     |
| Weights 450 / 750 / 850 / 900                                                                       | No token. Literal in plain styles and recipes; described in Type.                                                                                                                                                                                                                                                         |
| Glyph                                                                                               | The two sources disagree. The brief's glyph is a 20px yellow/green diagonal tile; the app's is a 30px green tile rotated -5° with an ink corner mark. `logo.svg` follows the app.                                                                                                                                         |
| Danger colour                                                                                       | The two sources disagree here too. The brief uses red-ink #b4220f; the app uses `--danger` #963c22. I used the brief's colour.                                                                                                                                                                                            |

### Translating a document style into app UI (judgment calls)

- **Type scale shrunk.** h1 3.35rem/900 → 2.25rem/900. Body 17px/1.65 → 16px/1.5 (capture.md's example). The brief's sizes are tuned for reading.
- **Primary button.** The brief has none. I took the app's: blue fill, white text, 2px ink frame, a 2px hard shadow on hover. I added a 1px press (`translate`, no transition).
- **Fields.** The brief bans `<input>`. I took the app's: 1.5px ink, 6px radius, 44px tall, white.
- **Plain table.** Follows the app: muted bold header, 2px ink rule under it, 30% hairlines between rows, white ground so the grid never runs behind data. The brief's `.tbl` (framed, ink header row, zebra) became the `.table-ink` recipe, meant for small summary tables. The ink header row is very Patchy but heavy across a long working list.
- **Cards.** The brief says both "8px cards" with hard shadows and "avoid rounded card-heavy SaaS clutter". I resolved it as one framed `.panel` per view (the app's single framed card), with no nesting and no card grids.
- **Danger button.** Red text on a red tint inside the ink frame (the app's), not a solid red fill.
- **`--look-space` = 8px.** The brief has no spacing scale (it uses 4, 9, 12, 14, 18, 20, 26, 42, 56, 96). I chose 8 because the grid is 32 (4 × 8) and the radius is 8.
- **Table cells are middle-aligned.** The app top-aligns them, but in the test render a 44px row button pushed the text out of line with it.

## Contrast

All four required pairs pass with the source values unchanged, so LOOK.md has nothing to report.

| Pair                | Values             | Ratio |
| ------------------- | ------------------ | ----- |
| fg on bg            | #12110f on #fffdf4 | 18.52 |
| muted on bg         | #69645a on #fffdf4 | 5.77  |
| accent-fg on accent | #fffefa on #1263e6 | 5.26  |
| link on bg          | #093b92 on #fffdf4 | 10.04 |

Other pairs I checked: body text (fg 86% mix, #33322f) on bg 12.58; muted on surface 5.83; danger on bg 6.49; accent-fg on danger 6.55; danger on its 8% tint 5.72; link on the 10% accent tint 8.76; success #2f6a17 on #eff9e8 6.07; warning #8a5a00 on #fff7e4 5.55; ink on yellow 11.46; muted on the zebra row 5.49.

The one source colour I avoided for contrast: flat red #e94b35 under white text is 3.77:1, so danger is the brief's own text-safe red-ink. That is a choice between source colours, not an alteration of one.

## Where capture.md was unclear, missing something or wrong

1. **It assumes a website.** "An agent captures it once, from the company's website" (line 5–6). This capture came from a brief, and the reference says nothing about brand guides or briefs. One website rule still turned out to matter most: "Prefer the product to the marketing" (line 112). The brief is a document style, and the app UI only exists in Patchy's own shell. A brief-specific rule could be: "if the source is a brand guide, also find where the brand is applied to an app".
2. **No status colours.** Line 93 requires "a status badge", but line 91 says "using only tokens and `color-mix()`" and line 88 says "Derive tints with `color-mix()` from tokens instead of adding new hex values." Success and warning can't be derived from accent or danger. I used flagged literals. Suggestion: add `--look-success` and `--look-warning`, or allow marked literals in recipes.
3. **`--look-border` mixes two jobs.** "Hairlines, dividers and input outlines" (line 29). A hairline is meant to be faint; an input outline needs 3:1 (WCAG 1.4.11). One value can't do both. The contrast checks (line 39) don't cover border on bg either, so a capture can ship invisible inputs and still pass.
4. **`--look-accent` assumes the button and the tab share a colour.** "the primary button, the selected tab" (line 30). In Patchy they don't (blue and yellow).
5. **`--look-fg` assumes body text is the darkest ink.** "Body text on `--look-bg`" (line 25). Patchy uses a heading/frame ink and a softer body ink. The token table has no slot for the second.
6. **`--look-surface` assumes headers are filled.** "cards, panels, table headers" (line 28). Patchy's table headers have no fill; the brief's version is an inverted ink row.
7. **No mono token.** Internal tools show ids, codes and commands constantly. I used a literal stack in a recipe.
8. **The plain-element rules are ambiguous.** "style plain elements only, with element selectors and no classes: `body`, `h1`–`h4`, …" (lines 45–47). It doesn't say whether the list is exhaustive, or whether pseudo-classes, pseudo-elements and attribute selectors are allowed. I used `:hover`, `:active`, `:disabled`, `::placeholder`, `[type="checkbox"]` and `[aria-invalid="true"]`. Two consequences the reference doesn't mention: plain `input` also styles checkboxes and radios, so they need a reset; and zebra rows need `tr`, which isn't in the list.
9. **"Literal values" isn't defined.** "Use the tokens, not literal values" (line 47–48). It's unclear whether this covers lengths. I read it as colours, fonts, radius and spacing. Font sizes, weights, border widths and shadow offsets stay literal, since no token holds them.
10. **Contrast checks are incomplete.** The required pairs (line 39–40) skip danger on bg (error text) and muted on surface (captions inside panels), which a tool hits constantly. Both pass here.
11. **The logo's use isn't specified.** Line 13 and section 9 say where the logo goes, but not how a patch gets it: copied into the repo, inlined, or served from a Patchy URL. LOOK.md assumes `<img src="logo.svg">` next to the page.
12. **The component list leaves things out.** Section 6 (line 91–94) omits tabs/nav, even though line 30 names the selected tab as an accent use. It also omits callouts, which tools need for errors. I added `.tabs`, `.note`, `.button-quiet` and `.mono` beyond the list.
13. **A system-font brand fits awkwardly.** "every font token is a stack that starts with the brand font's name" (line 70–71). Patchy's brand font is the system stack, so both tokens are identical and Type's "what the fallback stack loses" becomes a note about variable weights instead.
14. **Size cap TBD** (line 125). Sizes below.

## Sizes

- `look.css`: 4,915 bytes
- `LOOK.md`: 12,087 bytes
- `logo.svg`: 602 bytes

Checks run: exactly the 13 tokens declared, each once, and no other custom property in `look.css` or LOOK.md's recipes. No `@import` and no `url(`. Rendered a sample tool page in headless Chromium (stats, table with badges, buttons, form with an error, ink table, empty state); it reads as Patchy.
