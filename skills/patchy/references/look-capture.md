# Capturing a look

A company's **look** is how its tools look by default: three text files an admin
publishes with `patchy look publish <dir> --note "<why>"`. Capture one on the
person's machine into a new folder outside any patch repo, from a website, a brand
book or wherever else the brand already lives, and keep the folder until the
publish succeeds. Captures took 8 to 14 minutes in testing; tell the person about
ten.

| File       | What it holds                                                            |
| ---------- | ------------------------------------------------------------------------ |
| `look.css` | The 15 tokens and plain-element styles, all inside `@layer look`.        |
| `LOOK.md`  | The brief: how the brand behaves, with component recipes a patch copies. |
| `logo.svg` | Optional: the company's mark as one self-contained SVG.                  |

Only these three are published. Fonts and images go inside them as `data:` URLs;
publish names anything else in the folder in a warning and leaves it behind.

For the depth a capture needs, read the brief `patchy look --json` returns: the
company's current `LOOK.md`, or the Patchy look's while the company has none. A
thin palette note drifts off-brand within a page or two.

## `look.css`

```css
@layer look {
  :root {
    --look-bg: #ffffff;
    /* …the other 14 tokens… */
  }
  body {
    background: var(--look-bg);
    color: var(--look-fg);
    font: 16px/1.5 var(--look-font-body);
  }
  /* …headings, links, tables, buttons and inputs, with their states… */
}
```

Each token is declared once, in that `:root` rule directly inside `@layer look`.
Patchy fixes the names and meanings; the company sets the values, every colour an
opaque `#RRGGBB`.

| Token                                               | Holds                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--look-bg`                                         | The page ground.                                                                                                       |
| `--look-surface`                                    | A second ground, such as a card or panel, carrying the same text colours.                                              |
| `--look-fg`                                         | Body text.                                                                                                             |
| `--look-muted`                                      | Secondary text: captions, meta, placeholders.                                                                          |
| `--look-link`                                       | Link text. Often darker than the accent, so a pale accent stays a fill.                                                |
| `--look-success`, `--look-warning`, `--look-danger` | Status text; fills are `color-mix()` tints of them. Neutral and pending states use fg or muted.                        |
| `--look-accent`                                     | The principal brand emphasis fill. Many brands keep buttons black or white and spend the brand colour elsewhere.       |
| `--look-accent-fg`                                  | Text and icons on the accent.                                                                                          |
| `--look-border`                                     | Decorative separators and frames.                                                                                      |
| `--look-font-body`, `--look-font-display`           | Font stacks: the brand font first, the closest system fonts after.                                                     |
| `--look-radius`                                     | The most common corner radius.                                                                                         |
| `--look-space`                                      | The reference gap, nominally 8px: half between a label and its field, one between related controls, three for padding. |

- **Contrast.** fg, muted, link, success, warning and danger each reach 4.5:1 on
  both bg and surface; accent-fg reaches it on accent. When a brand pair fails,
  keep the fill, which carries recognition, and change the text. Between two real
  brand values, take the one that passes. Say in `LOOK.md` which values changed.
- **Element styles** cover body, headings, paragraphs, links, tables, buttons,
  inputs, selects and labels, with their hover, focus, disabled and invalid
  states. They take colours, fonts, borders, radius and spacing from the tokens;
  sizes, weights and line heights are literals. A plain `button` is the brand's
  primary button. Signature effects (shadows, transforms, uppercase, a lip under
  a button) belong in the brief's recipes: a new revision's element styles land
  on every patch that imports the look, including buttons it styled itself.
- **Which theme.** Capture the colour scheme the company's own app uses. A dark
  look sets `color-scheme: dark` in `:root`, so native controls match.
- **Fonts.** Embed a font the company may self-host as a `data:` URL
  `@font-face`, subset to Latin and few weights: the folder is capped at 512 KiB,
  and three Inter weights came to about 418 KB. A font licensed per domain is
  named first in the stack and not embedded.
- Everything but `@font-face` and a leading `@charset` sits inside `@layer look`,
  so a patch's own CSS always wins. Every `url()` is a `data:` URL.

`patchy look preview <dir> --json` lists in `failures` every reason `look publish`
would refuse the folder, worded as publish words it. The folder is ready when
`failures` is empty.

## `LOOK.md`

The brief a building agent reads before styling a patch: about 10 to 12 KB, at
most 32 KiB, in these nine sections in order.

1. **Title and provenance.** `# <Company>'s look`, then where it was captured
   from, which pages and when.
2. **The read.** What the brand feels like and the two or three habits that make
   it recognisable.
3. **Type.** Scale, weights, casing and letter-spacing, and what the fallback
   stack loses against the real font.
4. **Colour.** How the brand spends its colours: where the accent appears and
   where it never does, how much of a screen is neutral, values the tokens can't
   hold, and any value changed for contrast.
5. **Layout.** Density, content width, alignment, how sections divide, cards or
   open page.
6. **Components.** Recipes a patch copies and owns: markup plus CSS using the
   tokens and `color-mix()`, with literal sizes, weights and shadows where the
   brand needs them. Every brief has a badge per status (neutral too), tabs or a
   segmented filter, a select and a small button, beside the brand's own:
   secondary and danger buttons, a card or panel, a stat, a page header with the
   logo, a form, a table beyond the plain one, an empty state.
7. **Voice.** Sentence length, formality, punctuation and favoured words, with
   tool copy in that voice: a button label, an empty state, an error, a
   confirmation.
8. **Avoid.** What would make a page feel off-brand.
9. **The logo.** Where it goes and how big.

## `logo.svg`

The company's own mark, drawn to sit on `--look-bg`. A PNG goes inside an SVG as
`<image href="data:image/png;base64,…">`. SVG text renders in the viewer's
fallback font, so leave slack in the viewBox or convert a wordmark to paths. With
no usable mark, leave the file out: patches then show the company's name.

## From a website

- **Read the code, and look at the page.** Fetch the HTML and CSS and mine them
  for colours, fonts, radii, spacing and repeated patterns, then screenshot pages
  in a browser: density, alignment and air are easier to see than to parse. A
  design system's class prefix is the fastest route to the real values;
  `getComputedStyle` on headings, links, buttons, inputs and table cells confirms
  them.
- **Single-page apps** serve an empty HTML shell and CSS whose variables are set
  from JavaScript. Read computed styles in the browser, or search the JS bundles
  for the palette.
- **Prefer the product to the marketing.** Internal tools are apps. Weigh the
  company's own app, docs, help centre, pricing and account pages over campaign
  pages and heroes, and sample at least three inner pages.
- **Apps behind a login.** The sign-in, sign-up and help pages are the product's
  own screens. Fetch with a current browser's user agent: an old one put an
  "update your browser" banner into a capture.
- **Patterns, not swatches.** If the site boxes everything into cards, the tools
  do too. The recurring structures are the look.
- **The voice** is part of the look: capture how the site writes.
- The company's own logo and licensed fonts belong in a real capture.

## From a brand book, or anything else

Take the values, logo, fonts and voice from the book, and app patterns (density,
tables, forms, status, states) from wherever the brand already runs as an app: the
company's product, its sign-in page or an existing patch. A document style alone
has no buttons, fields or tables. Say in `LOOK.md` what was invented. Figma
screenshots and an existing patch ("make our look match Sam's CRM") work the same
way.

## Showing it

Render the specimen with `patchy look preview <dir>` and show it to the person:
open the file it prints for them, or screenshot it. It shows `look.css` on plain
elements, not the brief's recipes. Play the read back in one line ("deep forest
green on cream, serif headings, plain-spoken — sound right?") and fold in
corrections until they agree. When they reject a faithful capture of their
marketing site, ask where the brand looks right to them, such as their product or
a brand book, and capture from there.
