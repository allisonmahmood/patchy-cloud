# Duolingo capture notes

For Patchy, not for building agents. Prototype run for #563, 2026-10-06.

## 1. Timing

- Start 23:42:18, finish 23:56 (about 14 minutes).
- Fetching HTML, CSS and JS and mining them: about 3 minutes (23:42–23:45). The palette is not in the CSS, which cost a detour into the JS bundles.
- Screenshots and studying them: about 6 minutes (23:44–23:51), most of it Playwright waiting out `networkidle` on duolingo.com pages.
- Writing `look.css`, `LOOK.md`, `logo.svg`, plus one render of a test page against the look: about 4 minutes (23:51–23:55).
- `notes.md`: about 2 minutes.

## 2. URLs

Fetched with curl:

- `https://www.duolingo.com/` — 200, 11 KB SPA shell, no content without JS.
- `https://www.duolingo.com/info`, `https://www.duolingo.com/help` — 200, the same SPA shell.
- `https://blog.duolingo.com/` — 200, full HTML (Ghost).
- `https://careers.duolingo.com/` — 200, 3 KB SPA shell.
- `https://design.duolingo.com/` — redirects to `https://blog.duolingo.com/hub/design/`. The old public brand-guidelines site is gone; the footer still links "Brand guidelines" (not followed).
- CSS: `https://d35aaqx5ub95lt.cloudfront.net/css/app-14909179.css`, `https://d35aaqx5ub95lt.cloudfront.net/css/4779-c36ad395.css`. The CDN serves gzip regardless; the first curl without `--compressed` saved binary, refetched.
- CSS: `https://careers.duolingo.com/main.38fd7ac1ce32eedcfab3.css`, `https://blog.duolingo.com/assets/css/screen.css?v=63HAoWH2y8LcdHbb`.
- JS: `https://d35aaqx5ub95lt.cloudfront.net/js/app-c397ede4.js`, `.../js/4779-9b5aed3c.js`, `.../js/9819-d15f24d2.js`, `.../js/8553-a0eeda7a.js`. The named palette (owl, macaw, eel, wolf, swan, polar, snow, cardinal, fire-ant, humpback… each as a light/dark hex pair) lives in `4779-9b5aed3c.js`; the CSS only says `rgb(var(--color-macaw))`.

Screenshotted at 1440×900, full page (in `/tmp/look-563/shots/duolingo/`):

- `https://www.duolingo.com/` (front page)
- `https://www.duolingo.com/courses`
- `https://www.duolingo.com/register` (course picker)
- `https://www.duolingo.com/log-in` (closest thing to the product's own UI)
- `https://www.duolingo.com/super`
- `https://www.duolingo.com/efficacy`
- `https://support.duolingo.com/hc/en-us` — redirects to `https://www.duolingo.com/help` (FAQ panels)
- `https://blog.duolingo.com/hub/design/`
- `https://blog.duolingo.com/core-tabs-redesign/` — the page scrolls inside a container, so the full-page shot is only the first 900px.
- `https://careers.duolingo.com/` — same inner-scroll problem, first 900px only.
- `https://press.duolingo.com/`
- `https://status.duolingo.com/` — stock Atlassian Statuspage, ignored for the read.
- A 2× crop of `https://www.duolingo.com/log-in` with computed styles of its buttons, inputs and h1.

Failures and blocks: no bot blocks, no cookie wall. Every `www.duolingo.com` page timed out on `networkidle` after 30s (recaptcha and analytics keep connections open) but rendered fine on fallback. The logged-in app (lessons, profile, leaderboards), which is the real product, is not reachable logged out; the log-in, register and help pages stood in for it.

## 3. The read

Duolingo: a white page, warm grey text and one loud green; everything pressable is chunky, rounded, uppercase and sits on a hard 4px lip, in heavy rounded type.

The real mark is Duo, a round green owl's head silhouette with tufted ears, beside a lowercase rounded "duolingo" wordmark in the same green; sub-sites append a word ("blog", "careers", "press room"). `logo.svg` is a placeholder: a green rounded square on a darker lip with a white dot, and "duolingo" as SVG text.

## 4. What the 13 tokens could not hold

- **The second brand colour, macaw blue (#1cb0f6).** It is the primary button on log in, help and careers, the link colour, the selected-tab underline and the focus colour. Only a darker palette blue survives, as `--look-link` (#2b70c9). A blue primary button cannot be expressed; the green one stands in everywhere.
- **Lip colours** (tree-frog #58a700 under green, whale #1899d6 under blue, swan under white). Derived with `color-mix(in srgb, var(--look-accent), black 18%)` = #48a702, close to the real #58a700 but darker and more saturated.
- **Display headlines in green.** Feather headlines are often owl green on white (2.1:1). Dropped: `h1` is `--look-fg` grey. This is the biggest loss of flavour.
- **Hare #afafaf**, the light grey of the uppercase marketing nav and disabled text. Dropped; nav uses `--look-muted` to pass.
- **Status colours** bee yellow #ffc800, fox orange #ff9600, beetle purple #ce82ff. No warning badge is possible with tokens and `color-mix()` only; the badge recipe has success, danger, info and neutral.
- **Light washes** sea-sponge #d7ffb8, iguana #ddf4ff, walking-fish #ffdfe0. Approximated with `color-mix()` tints of accent, link and danger (accent at 20% gives #def5cc, near sea-sponge).
- **Dark theme.** Duolingo ships a full dark palette (snow #131f24, polar #202f36, swan #37464f, owl #93d333, macaw #49c0f8). A look has no dark slot. Dropped, except that its dark text became `--look-accent-fg`.
- **Type scale and weights.** Page title 40, headings 28/24/20/16, body 17 (20 in-app), labels 13–15 uppercase at 0.05em, body weight 500. All literals in `look.css` element styles and LOOK.md recipes.
- **Border width and lip depth** (2px borders, 4px bottom lip). The brand's single most recognisable habit is a literal repeated across `look.css` and every recipe. A `--look-border-width` would have earned its place.
- **Second radius.** 16px for buttons and cards, 12px on some buttons, 8px and 5px on badges, 50% on avatars. Badges use a literal 8px.
- **Press motion** (hover `brightness(1.1)`, press `translateY(4px)` and the lip disappears). Literal in `look.css`.
- **Super Duolingo's navy and gradients.** Dropped on purpose; they are marketing, not tool chrome.

## 5. Contrast

| Pair                | Brand's real value          | Ratio       | Shipped            | Ratio |
| ------------------- | --------------------------- | ----------- | ------------------ | ----- |
| fg on bg            | eel #4b4b4b on snow #ffffff | 8.72        | same               | 8.72  |
| muted on bg         | wolf #777777 on #ffffff     | 4.48 (fail) | #767676            | 4.54  |
| accent-fg on accent | #ffffff on owl #58cc02      | 2.09 (fail) | #131f24 on #58cc02 | 8.05  |
| link on bg          | macaw #1cb0f6 on #ffffff    | 2.44 (fail) | humpback #2b70c9   | 4.93  |

- The green fill is kept. Duolingo's white button text on it fails even the 3:1 large-text bar (the labels are 15px bold, not "large"). The nearest brand green that could carry white, tree-frog #58a700, only reaches 3.02, and anything darker stops reading as Duolingo. So the text changed instead: #131f24 is the colour Duolingo's own dark theme sets on its green buttons (`snow` resolves to #131f24 there).
- Whale #1899d6 was the first candidate for the link and fails at 3.20; humpback is the darkest blue already in the palette that passes.
- Not required but checked: danger fire-ant #ea2b2b is 4.30 as text on white and as white on it (kept as the brand's red; cardinal #ff4b4b is 3.30). Muted on surface (#767676 on #f7f7f7) is 4.24, which is what placeholders in inputs get. Link on surface is 4.60. Badge text on tints was darkened with `color-mix(..., black 20–25%)` to pass (danger 5.7).

## 6. Where `capture.md` was unclear, missing something or wrong

- "`--look-accent` | The brand colour as a fill: the primary button, the selected tab." Duolingo has two colours for those jobs: green is the brand and the "do this next" button, blue is the primary button on its utility pages and its selected tab. The token assumes one colour does both. I picked green and pushed blue into `--look-link`.
- "When the brand's real colour fails, keep the brand colour where it passes" does not say which side of a fill pair to change when the pair fails. White on green passes nowhere. I kept the fill and changed the text; the rule should say which to prefer (I'd say keep the fill, it carries recognition).
- The four pairs miss two combinations the reference itself sets up: muted on surface ("`--look-surface` … table headers", "`--look-muted` … placeholders" on surface-filled inputs) and danger (error text on bg, white on a danger fill). Duolingo fails both slightly (4.24, 4.30) while passing all four checked pairs.
- "style plain elements only, with element selectors and no classes: `body`, `h1`–`h4`, … `label` and `:focus-visible`" does not say whether states and pseudo-elements are allowed (`button:hover`, `button:active`, `button:disabled`, `input:focus`, `input::placeholder`) or other elements (`tr`). Duolingo's press motion only exists in `:active`. I used them.
- "A plain `button` is the brand's primary button." For a loud brand this makes every bare button in a patch (icon buttons, tab buttons, a close ×) a big green uppercase block with a lip. The reference could say that patches use a recipe class for non-primary buttons, or offer an `.button-icon` recipe.
- "`--look-font-display` | The heading font stack" — Duolingo uses its display face (Feather) only for hero moments; product headings are the body font in bold. The reference does not say whether `h2`–`h4` take the display stack. I used it on `h1` only.
- "Concrete CSS a patch can lift, using only tokens and `color-mix()`" — unclear whether literal sizes, border widths and radii are allowed in recipes. They have to be (there are no size tokens); I used them. Also unclear whether a recipe may use a literal colour the tokens cannot hold (the warning yellow); I left it out.
- "Fetch the HTML and CSS and mine them for colours" fails on single-page apps: duolingo.com's HTML is an empty shell and its CSS only references variables set from JS. Add: when the CSS uses variables you cannot find, read computed styles in the browser, or search the JS bundles.
- "Draw the logo… a wordmark of the company's name in the display stack will do." SVG `<text>` renders in whatever fallback the viewer has, so its width is unpredictable and can overflow the viewBox. Worth saying: leave slack in the viewBox, or convert to paths when the font is available.
- "Sample more than the front page… a settings or account page." For consumer products the real app is behind a login; the reference could say what to use instead (log-in and sign-up flows, help centre, app-store screenshots).
- The reference has no slot or advice for a brand's dark theme.
- "Play the read back in one line before saving" — to whom, in an unattended capture? I recorded it here.
- Screenshot tooling: pages that scroll inside a container (blog post, careers) give only the first viewport with `fullPage`. Not a `capture.md` problem, but the person running the capture should know.

## 7. Sizes

- `look.css`: 4,053 bytes
- `LOOK.md`: 10,230 bytes
- `logo.svg`: 580 bytes
