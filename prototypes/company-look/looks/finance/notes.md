# Capture notes: finance (Vanguard)

For Patchy, not for building agents.

## 1. Timing

- Start 2026-10-06 23:42:30 (UTC+2). Finish 23:52.
- Fetching HTML and CSS, and mining the CSS: about 4 minutes (23:42:30 to 23:46, overlapping the screenshots).
- Screenshots: about 3 minutes of wall time for the run (23:43 to 23:45, in the background), plus about 3 minutes reading the tiles and probing computed styles (to 23:48).
- Writing `look.css`, `LOOK.md` and `logo.svg`: about 3 minutes (23:48 to 23:51), including a check render of a sample tool page with the look applied (kept in `/tmp`).
- Writing these notes: about 2 minutes.
- Total about 10 minutes. Nothing was blocked, so there was no retry time.

## 2. Sources

Settled on **Vanguard**, the first company in the list; nothing blocked it.

Fetched with curl (Chrome 130 desktop user agent):

| URL                                                                                                        | Result                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| https://investor.vanguard.com/                                                                             | 200, 32 KB HTML                                                                     |
| https://corporate.vanguard.com/                                                                            | 200, 12 KB HTML                                                                     |
| https://www.schwab.com/                                                                                    | 200, 102 KB HTML (fetched in the same first batch; not used once Vanguard worked)   |
| https://www.jpmorgan.com/                                                                                  | 200, redirected to /global, 19 KB (same; not used)                                  |
| investor.vanguard.com/etc.clientlibs/vanguard-retail-common/clientlibs/clientlib-base.min.ACSHASH3bc7….css | 200, 12.5 KB                                                                        |
| investor.vanguard.com/etc.clientlibs/marketing-site/clientlibs/clientlib-site.min.ACSHASHca75….css         | 200, 82 KB; holds the Constellation (`c11n-`) design system, the best single source |
| https://n4v.web.vanguard.com/nav-preload.css                                                               | 200, 410 B                                                                          |

Screenshotted with Playwright Chromium at 1440×900, full page, in `/tmp/look-563/shots/finance/` (and probed with `getComputedStyle` on logon, fund list and fees):

| Name      | URL                                                                                                                     | Result                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| home      | https://investor.vanguard.com/                                                                                          | 200                                                                     |
| fees      | https://investor.vanguard.com/client-benefits/investment-fees                                                           | 200                                                                     |
| fundlist  | https://investor.vanguard.com/investment-products/list/all                                                              | 200, redirected to `?filters=open`                                      |
| voo       | https://investor.vanguard.com/investment-products/etfs/profile/voo                                                      | 200; the most app-like data page                                        |
| article   | https://investor.vanguard.com/investor-resources-education/article/5-financial-behaviors-to-boost-your-financial-health | 200                                                                     |
| logon     | https://logon.vanguard.com/logon?site=pi                                                                                | 200, redirected to login.vanguard.com (OAuth); the only real app screen |
| corporate | https://corporate.vanguard.com/                                                                                         | 200                                                                     |

Blocks and walls:

- No bot block on any page. investor.vanguard.com loads an Akamai Bot Manager sensor (an obfuscated script path, `/bL9yAVJC6…`), but it let headless Chromium and curl through.
- The fund list and logon pages showed a "Important: Update browser for best experience" banner. That is user-agent sniffing: the spoofed Chrome 130 string is old by October 2026. Harmless, but onboarding should send a current user agent or the banner lands in every capture.
- A OneTrust cookie dialog ("Your privacy") exists in the DOM on every page but did not cover the screenshots.
- Fonts are served from constellation-static.web.vanguard.com; not downloaded (never embed).
- Everything behind login (the real account app) is out of reach; the logged-out sign-in page was the closest thing to product.

## 3. The read, played back

Vanguard: calm and plain-spoken, white with near-black, very heavy geometric headlines, black pill buttons over square fields and hairline tables, and Vanguard red saved for the logo and the one action that moves money.

## 4. What the 13 tokens could not hold

| Wanted                                           | Brand value                                                                                                                                           | How it was handled                                                                                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary button colour separate from brand colour | Primary buttons and the selected segment are black `#040505`; the brand red `#c20029` fills only "Buy" and "Log in"                                   | `--look-accent` is the red; the plain `button` and the segmented recipe fill with `--look-fg`. LOOK.md says so twice. An agent that follows the token table literally ("the primary button") will paint red buttons. |
| A second and third radius                        | Buttons, chips and segmented controls are pills (2rem / 5rem); badges 6px; inputs, cards, tables 0                                                    | `--look-radius: 0px`; literal `999px` in `look.css` `button` and recipes, literal `6px` in `.badge`. A radius change will not reach buttons.                                                                         |
| Input outline distinct from hairlines            | Inputs `#040505`; card borders `#cbcece`; table rows `#e8e9e9` / `#dee2e6`                                                                            | `--look-border` is `#cbcece`; inputs use `--look-fg`; row hairlines `color-mix(in srgb, var(--look-border) 50%, var(--look-bg))` (≈ `#e5e6e6`).                                                                      |
| Heading weight                                   | 800 to 900, the main display signal; the display face is the body family                                                                              | Literal `font-weight: 800` on `h1`–`h4`. `--look-font-display` equals the body stack.                                                                                                                                |
| Type scale                                       | 14 / 17 / 23 / 28 / 34 / 46 / 57 / 68 / 92 px, body 17px                                                                                              | Literal sizes in `look.css` and the LOOK.md Type section.                                                                                                                                                            |
| Narrow table face                                | FF Mark Narrow / Mark Pro Narrow with tabular figures in dense tables                                                                                 | Dropped the face; kept `font-variant-numeric: tabular-nums` on `table`.                                                                                                                                              |
| Serif display face                               | Thorndale, in `c11n-text-*-display` classes                                                                                                           | Not visible on any sampled page; dropped.                                                                                                                                                                            |
| Wordmark colour                                  | Burgundy `#96151d` (sampled from the header)                                                                                                          | Named in LOOK.md Colour prose only. The placeholder logo uses the accent, as instructed.                                                                                                                             |
| Data and status palette                          | Turquoise `#007873` / `#00bda3` / `#def5f0`, yellow `#ffaf00` / `#fff7de`, gain green `#1d9f22`, slate `#3f4444`, deep burgundy `#670026` / `#7e0e15` | Listed as literals in LOOK.md Colour for charts only; no recipe uses them. There is no success/positive status at all, which a finance tool (gain/loss, approved/rejected) will want.                                |
| Highlight panel tint                             | Pink `#ffeded`                                                                                                                                        | `color-mix(in srgb, var(--look-accent) 7%, var(--look-bg))` ≈ `#fbedf0`; close.                                                                                                                                      |
| Focus ring                                       | `#0f62c5`, 2px, 2px offset                                                                                                                            | Mapped to `--look-link` (`#145bff`).                                                                                                                                                                                 |
| Card shadow                                      | Layered `rgba(4,5,5,.06–.18)`                                                                                                                         | Dropped; sampled pages are flat. Listed under Avoid.                                                                                                                                                                 |
| Eyebrow tracking, heading tightening             | 0.2em uppercase; -0.5px to -2px at large sizes                                                                                                        | Literals.                                                                                                                                                                                                            |
| Button hover sweep                               | 0.25s width transition from the label's side                                                                                                          | Dropped for a plain colour swap.                                                                                                                                                                                     |
| Content width and margins                        | 1296px column, 72px margins                                                                                                                           | Prose in LOOK.md Layout; header padding as `calc(var(--look-space) * 9)`.                                                                                                                                            |

## 5. Contrast

All four required pairs pass at the brand's real values; nothing was changed.

| Pair                | Values                 | Ratio              |
| ------------------- | ---------------------- | ------------------ |
| fg on bg            | `#040505` on `#ffffff` | 20.41              |
| muted on bg         | `#717777` on `#ffffff` | 4.56 (just passes) |
| accent-fg on accent | `#ffffff` on `#c20029` | 6.31               |
| link on bg          | `#145bff` on `#ffffff` | 5.29               |

Others checked: danger on bg 5.56; white on danger 5.56; link on surface 4.89; accent on its 10% badge tint 5.27; danger on its 12% badge tint 4.66. **Muted on surface is 4.21 and fails**, so LOOK.md tells agents to use `--look-fg` for text in grey panels and table headers. The site sidesteps it the same way: its grey table headers use slate `#3f4444` (9.9:1 on white), not the muted grey.

## 6. Where capture.md was unclear, missing or wrong

- **Wrong for this brand:** "`--look-accent` | The brand colour as a fill: the primary button, the selected tab." Vanguard's brand colour is red but its primary button and selected tab are black. Conservative brands often do this. The table needs either a separate primary-action token or a sentence saying which wins.
- **Wrong for this brand:** "`--look-radius` | The corner radius the brand uses most, for buttons, inputs and cards." Pill buttons with square inputs and cards is a strong habit here; one radius cannot hold it.
- **Conflated:** "`--look-border` | Hairlines, dividers and input outlines." Inputs are outlined in near-black, hairlines in light grey.
- **Missing:** "`--look-font-display` | The heading font stack" has no weight. For Vanguard the display identity is weight 800–900 of the body family.
- **Unclear:** "Use the tokens, not literal values, so a token change reaches every element." Sizes, weights, letter-spacing and the pill radius have no token, so literals are unavoidable. Say which literals are fine.
- **Misleading example:** "`font: 16px/1.5 var(--look-font-body);`" A copying agent will use 16px; Vanguard's body is 17px.
- **Unclear:** "style plain elements only, with element selectors and no classes". Are pseudo-classes (`a:hover`, `button:disabled`, `::placeholder`) and attribute selectors allowed? I used `input:not([type="checkbox"], [type="radio"])` so checkboxes don't become 48px full-width fields. `ul`/`ol`, `code`, `h5`/`h6` and `caption` are not on the list.
- **Tension:** Colour says name "any colour the tokens could not hold", but Components say "using only tokens and `color-mix()`". So a named chart or status colour can never appear in a recipe. A finance tool needs gain/loss and success colours; there is no success token.
- **Missing:** "a page header with the logo" does not say how a patch references `logo.svg` (path, inline, data URI), so the recipe's `<img>` has no `src`.
- **Missing method:** "Fetch the HTML and CSS and mine them". The fastest accurate route was a design system's class prefix in the CSS (`c11n-text-*` gave the whole type scale) plus `getComputedStyle` on `h1`, `a`, `button`, `input`, `th` and `td` in the browser. Worth saying.
- **Missing source:** "A pricing page, docs, a help centre, a settings or account page". Account pages sit behind login for a bank; the logged-out **sign-in page** is the only real app screen. Name it.
- **Unclear for trademarked marks:** "Draw the logo. Recreate the mark as a simple, self-contained SVG." For a registered wordmark, recreating it is copying it. Also "a wordmark of the company's name in the display stack" renders with system fonts in an `<img>`, and Vanguard's real wordmark is a serif while its display stack is sans, so the placeholder looks nothing like it.
- **Unclear:** "Play the read back in one line before saving." To whom, in an unattended capture? I put it in these notes.
- **Missing:** what to do when a site shows two primary button styles (black and red here), dark mode (none on Vanguard), and a current user agent for fetching (see the banner in section 2).
- **Open:** "The folder stays under the size cap (to be set by this prototype)." Sizes are below.
- **Checks gap:** the publish checks don't include "plain-element styles use only tokens" or "recipes use only tokens and `color-mix()`", though the rest of the reference asks for both.

## 7. Sizes

- `look.css`: 3,433 bytes
- `LOOK.md`: 10,302 bytes
- `logo.svg`: 461 bytes
- `notes.md`: about 10.9 KB (not part of the published look)

The real mark: the word "Vanguard" in a bold, bracketed serif in burgundy (`#96151d`), with a separate "V." sail monogram used in footers and video watermarks. The placeholder is a red square with a white inset square and "Vanguard" in the display stack.
