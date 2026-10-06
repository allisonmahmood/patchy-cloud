# Linear capture notes

For Patchy, not for building agents.

## 1. Timing

Started 23:42:07, finished 23:50 on 2026-10-06 (wall clock, about 8 minutes).

| Phase                                                                 | Clock         | Roughly |
| --------------------------------------------------------------------- | ------------- | ------- |
| Fetching HTML (7 pages) and CSS (86 files), mining tokens and buttons | 23:42 – 23:44 | 2 min   |
| Screenshots (8 pages, full and fold, run in parallel with the mining) | 23:42 – 23:44 | 1.5 min |
| Studying shots, detail crops, computed styles                         | 23:44 – 23:45 | 1 min   |
| Contrast maths, writing four files, one sample render to check        | 23:45 – 23:50 | 5 min   |

## 2. URLs

All returned 200. No bot blocks, captchas or consent walls; plain `curl` with a desktop user agent and headless Chromium both got full pages.

- HTML via curl: `https://linear.app/`, `/pricing`, `/docs`, `/changelog`, `/method`, `/customers`, `/features`.
- CSS via curl: 86 stylesheets under `https://static.linear.app/web/_next/static/css/` (the key ones: `layout.C0PJmvhY.css` for theme tokens and the type scale, `dcAi4KbO.css` for buttons). Plus about 260 KB of inline styled-components CSS in the HTML.
- Screenshots at 1440×900, full page and fold, in `/tmp/look-563/shots/linear/`: `/`, `/pricing`, `/docs`, `/docs/creating-issues`, `/changelog`, `/method`, `/customers`, `/features`.
- Detail crops: the product mock in the front-page hero, the front page's intake section (Slack thread and board), the pricing comparison table. Computed styles read from `/docs` (body, h1, p, topic card).
- Not fetched: font files (`static.linear.app/fonts/InterVariable.woff2`, Tiempos Headline, Berkeley Mono), only noted.
- Check render: a sample purchase-requests tool built from `look.css` plus the LOOK.md recipes, `/tmp/look-563/shots/linear/sample.png`.

## 3. The read

Near-black and grey with one rationed indigo, Inter at medium weights with tight tracking, and dense left-aligned lists divided by hairlines rather than boxes.

## 4. What the 13 tokens could not hold

| Wanted                        | Brand value                                                                                            | Handled                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A theme choice                | The site ships `dark`, `light` and `glass` themes; every marketing page is dark, docs can toggle light | Captured dark only. Added `color-scheme: dark` to `:root` (a property, not a custom property) so native selects and scrollbars match.         |
| Secondary text                | `#d0d6e0`                                                                                              | `color-mix(in srgb, var(--look-fg) 68%, var(--look-muted))` in LOOK.md                                                                        |
| Quaternary text               | `#62666d` (3.45:1, decoration only)                                                                    | `color-mix(in srgb, var(--look-muted) 70%, var(--look-bg))`, flagged as never for words                                                       |
| Surface levels                | `#0f1011`, `#141516`, `#191a1b`, `#1c1c1f`, `#232326`                                                  | One surface (`#141516`, matches the docs cards). Hover and selected rows via `color-mix` of fg into bg.                                       |
| Border levels                 | `#23252a`, `#34343a`, `#3e3e44`, white at 5% and 8%                                                    | One border (`#23252a`). Danger border via `color-mix`.                                                                                        |
| Accent variants               | `#7170ff` accent, `#828fff` hover, `#18182f` tint                                                      | Hover is `filter: brightness(115%)` (Linear's own); tint is `color-mix`                                                                       |
| The invert button             | `#e5e5e6` pill, the site's main CTA                                                                    | `.button-invert` recipe with `color-mix(fg 92%, bg)` and a literal `9999px`                                                                   |
| Status colours                | green `#27a644`, yellow `#f0bf00`, orange `#fc7840`, blue `#4ea7fc`, teal `#00b8cc`                    | Literal hex in the LOOK.md badge recipe and Colour section; teal dropped                                                                      |
| Mono font                     | Berkeley Mono                                                                                          | Literal stack in LOOK.md Type                                                                                                                 |
| Serif display                 | Tiempos Headline (method page headlines)                                                               | Dropped; LOOK.md says tools never use it                                                                                                      |
| Type scale, weights, tracking | 15px/1.6 body, 13px UI, 2rem/1.5/1.25/1.0625rem titles, weights 510/590, -0.011 to -0.022em            | Literals in `look.css` element styles                                                                                                         |
| OpenType features             | `"cv01", "ss03"`                                                                                       | Literal on `body`                                                                                                                             |
| More than one radius          | 4, 6, 8, 12px and pill; site buttons are pills, app buttons about 6px, cards 8px                       | Token 8px (most frequent, and cards plus inputs). Pill as a literal in badge and invert recipes; ghost uses `calc(var(--look-radius) - 2px)`. |
| A spacing scale               | 4, 6, 8, 12, 16, 24, 32, 64                                                                            | Token 4px; 6px gaps written as `calc(* 1.5)` or a literal                                                                                     |
| Shadows                       | `--shadow-low/medium/high`                                                                             | One literal ceiling in LOOK.md; Linear dark barely uses them                                                                                  |
| Header glass                  | `#0b0b0bcc` with 20px blur                                                                             | `color-mix(bg 85%, transparent)` plus literal blur in `.page-header`                                                                          |
| Widths                        | page 1024px, prose 624px, header 64–72px                                                               | Literals in LOOK.md Layout and recipes                                                                                                        |
| Selection colour              | `color-mix(in lch, brand, black 10%)`                                                                  | Dropped; `::selection` is not in the element list                                                                                             |
| Logo colours                  | n/a                                                                                                    | Baked hex in `logo.svg` (accent and fg); cannot follow the tokens                                                                             |

## 5. Contrast

| Pair                | Brand value            | Ratio |
| ------------------- | ---------------------- | ----- |
| fg on bg            | `#f7f8f8` on `#08090a` | 18.73 |
| muted on bg         | `#8a8f98` on `#08090a` | 6.13  |
| accent-fg on accent | `#ffffff` on `#5e6ad2` | 4.70  |
| link on bg          | `#828fff` on `#08090a` | 6.95  |

Nothing was changed: all four are the site's own dark-theme values. The one choice was between two indigos: the site's `--color-accent` and light-theme `--color-brand-bg` is `#7170ff`, and white on it is 3.84:1, so the look uses the dark-theme brand fill `#5e6ad2` instead (Linear's own light theme ships the failing pair). Also: muted holds 5.63 on the surface; white on `--look-danger` `#eb5757` is only 3.48, so the danger button is red text on a red tint (5.17); the quaternary grey `#62666d` is 3.45 and is marked decoration only.

## 6. Where `capture.md` was unclear, missing something or wrong

- **One theme only.** "`--look-bg` | The page ground." Linear ships dark, light and glass themes. Nothing says which to capture, whether a look can have two, or that a dark look needs `color-scheme: dark`. I picked dark and set `color-scheme`, which is a property, not a custom property, so "no other custom properties" did not forbid it; the reference should say so explicitly.
- **Tokens versus literals.** "Use the tokens, not literal values, so a token change reaches every element." There are no tokens for font size, weight, line height, letter-spacing or control height, so the type scale is necessarily literal. Either say "colours, fonts, radius and space come from tokens" or add a type-scale token.
- **Pseudo-classes.** "style plain elements only, with element selectors and no classes". Silent on `a:hover`, `button:disabled`, `input::placeholder`, `::selection`. I used the first three and dropped selection.
- **The accent is not always the primary button.** "`--look-accent` | The brand colour as a fill: the primary button". On linear.app the primary button is an off-white pill and the brand indigo is barely used; in the product, the primary button is indigo. "Prefer the product to the marketing" settled it, but the token's definition assumes they are the same thing.
- **"Uses most" is ambiguous.** "`--look-radius` | The corner radius the brand uses most, for buttons, inputs and cards." Linear's buttons and cards differ (pill or 6px versus 8px). Most by count, or most by prominence? I took count (8px).
- **One spacing unit is not a scale.** "`--look-space` | The base spacing unit". 4 or 8 are both defensible for Linear and some gaps are 6px. I took 4px.
- **Status colours have nowhere to go.** Components must use "only tokens and `color-mix()`" and "Derive tints with `color-mix()` from tokens instead of adding new hex values", yet the status badge it asks for needs green, yellow and orange that no token holds and no tint derives. I used literals.
- **Danger has no contrast rule and no foreground.** The four required pairs skip danger, and there is no `--look-danger-fg`. White on Linear's red fails (3.48). Suggest requiring danger as text on bg to pass, and saying danger is text unless a pair passes.
- **Logo colour.** "`logo.svg` | The company's mark. Self-contained SVG". No guidance on colour or size: a dark look's logo baked in light text is invisible on light ground, and `currentColor` turns black inside `<img>`. Suggest saying the logo is drawn for `--look-bg`, and giving a target height and viewBox.
- **Self-hosted fonts and the size cap.** "A font the company has the right to self-host is embedded in `look.css` as a `data:` URI". Inter is OFL and Linear self-hosts it, so under the real rule it would be embedded: the variable woff2 is around 350 KB, about 470 KB as base64, which collides with "The folder stays under the size cap (to be set by this prototype)." The cap needs to say whether fonts count.
- **Two candidate brand values.** "When the brand's real colour fails, keep the brand colour where it passes". Linear has two indigos, one passing and one failing; the line does not cover picking between real brand values. I picked the passing one and said so in LOOK.md.
- **No render check.** "Checks before a look is published" has no "build a sample page with it and look". Doing one caught the biggest gap: on this Linux machine the stack falls through to Liberation Sans (Arial metrics), noticeably wider and heavier than Inter, so the look reads less like Linear without the font. Suggest adding the check, and in Type asking for the most likely fallback per OS.
- **Component list misses the app shell.** The list has a page header but no sidebar navigation, toast or modal. Linear's most recognisable product structure is the left sidebar plus list; I described it in Layout without a recipe. Confirmations in Linear are toasts.
- **"Secondary text" is a common fourth tier.** Most SaaS brands, Linear included, have a text step between fg and muted. Worth naming the `color-mix` convention in the reference so looks agree.

## 7. Sizes

- `look.css`: 3,280 bytes
- `LOOK.md`: 10,524 bytes
- `logo.svg`: 441 bytes
- `notes.md`: not counted toward the look

## The real mark

A white disc whose lower-left part is cut by four parallel diagonal stripes, beside a "Linear" wordmark in a medium-weight Inter. The placeholder is an indigo rounded square plus the name in the display stack.
