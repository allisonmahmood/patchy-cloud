<!-- PROTOTYPE for #563: the draft of the global skill's look-capture reference. -->

# Capturing a company look

A **look** is how a company's internal tools look by default. An agent captures it once,
from the company's website, and every new patch starts in it. Patchy fixes the shape; the
company sets the values. A look folder holds four files:

| File       | What it is                                                                    |
| ---------- | ----------------------------------------------------------------------------- |
| `look.css` | The fixed tokens and plain-element styles, all inside `@layer look`.          |
| `LOOK.md`  | The brief: how the brand behaves, with component recipes as CSS.              |
| `logo.svg` | The company's mark. Self-contained SVG, no external references.               |
| `notes.md` | Capture notes for Patchy, not for agents: sources, timings, what was missing. |

## `look.css`

### The fixed tokens

Set every one of these, and no other custom properties. Patchy owns the names, so a patch
that uses `var(--look-accent)` follows the company when its accent changes.

| Token                 | Holds                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| `--look-bg`           | The page ground.                                                            |
| `--look-fg`           | Body text on `--look-bg`.                                                   |
| `--look-muted`        | Secondary text on `--look-bg`: captions, meta, placeholders.                |
| `--look-surface`      | A raised or inset area on the page: cards, panels, table headers.           |
| `--look-border`       | Hairlines, dividers and input outlines.                                     |
| `--look-accent`       | The brand colour as a fill: the primary button, the selected tab.           |
| `--look-accent-fg`    | Text and icons on `--look-accent`.                                          |
| `--look-link`         | Link text on `--look-bg`. Often the accent; darker when the accent is pale. |
| `--look-danger`       | Destructive actions and errors.                                             |
| `--look-font-body`    | The body font stack, ending in system fallbacks.                            |
| `--look-font-display` | The heading font stack, ending in system fallbacks.                         |
| `--look-radius`       | The corner radius the brand uses most, for buttons, inputs and cards.       |
| `--look-space`        | The base spacing unit; layouts use multiples of it.                         |

Four pairs must reach 4.5:1 contrast: fg on bg, muted on bg, accent-fg on accent, and link
on bg. When the brand's real colour fails, keep the brand colour where it passes and say
in `LOOK.md` what you changed and why.

### The plain-element styles

After `:root`, style plain elements only, with element selectors and no classes: `body`,
`h1`–`h4`, `p`, `a`, `hr`, `small`, `table`, `th`, `td`, `button`, `input`, `select`,
`textarea`, `label` and `:focus-visible`. Use the tokens, not literal values, so a token
change reaches every element. A plain `button` is the brand's primary button; other button
kinds are recipes in `LOOK.md`.

```css
@layer look {
  :root {
    --look-bg: #ffffff;
    /* …every token above… */
  }
  body {
    margin: 0;
    background: var(--look-bg);
    color: var(--look-fg);
    font: 16px/1.5 var(--look-font-body);
  }
  /* …headings, links, tables, buttons, inputs… */
}
```

Everything sits in `@layer look`, so any CSS a patch writes outside a layer wins regardless
of specificity. The file has no `@import` and no external `url()`. Company fonts are
usually licensed per domain and cannot be copied, so every font token is a stack that
starts with the brand font's name (it renders on machines that have it installed) and
continues with the closest system fonts. A font the company has the right to self-host is
embedded in `look.css` as a `data:` URI `@font-face`; for this prototype, never embed one.

## `LOOK.md`

The brief a building agent reads before styling a page. A thin palette note drifts
off-brand within a page or two, so write the design system, not swatches. Use these
sections, in this order:

1. **Title and provenance.** `# <Company>'s look`, then one line: where it was captured
   from, which pages, and when.
2. **The read.** One paragraph: what the brand feels like and the two or three habits
   that make it recognisable.
3. **Type.** The scale, weights, casing and letter-spacing habits, and what the fallback
   stack loses compared with the real font.
4. **Colour.** How the brand spends its colours: where the accent appears and where it
   never does, how much of a screen is neutral, and any colour the tokens could not hold.
   Derive tints with `color-mix()` from tokens instead of adding new hex values.
5. **Layout.** Density, content width, alignment, how sections divide, whether things
   sit in cards or open on the page, how much air.
6. **Components.** Concrete CSS a patch can lift, using only tokens and `color-mix()`:
   the secondary and danger buttons, a status badge, a card or panel, a stat, a page
   header with the logo, a form layout, a table treatment beyond the plain one, and an
   empty state. Give each as a class the patch can copy, such as `.button-secondary`.
7. **Voice.** How the brand writes: sentence length, formality, punctuation, favoured
   words. Give examples of tool copy in that voice: a button label, an empty state, an
   error, a confirmation.
8. **Avoid.** What would make a page feel off-brand.
9. **The logo.** Where it goes and how big.

## Capturing from a website

- **Read the code, and look at the page.** Fetch the HTML and CSS and mine them for
  colours, fonts, spacing, radii and repeated class patterns. Then screenshot the site in a
  browser and study the images: density, alignment and how much air are easier to see than
  to parse out of a stylesheet.
- **Sample more than the front page.** Heroes are unrepresentative. A pricing page, docs,
  a help centre, a settings or account page, or a blog post is usually closer to what an
  internal tool needs. Look at at least three inner pages.
- **Capture patterns, not swatches.** If the site boxes everything into cards, the tools
  box things into cards. The recurring structures are the look.
- **Prefer the product to the marketing.** When the site shows the company's own app
  (screenshots, docs, a logged-out app page), weigh it over campaign pages: internal tools
  are apps.
- **Capture the voice.** Copy tone is part of the look.
- **Draw the logo.** Recreate the mark as a simple, self-contained SVG. When the mark can't
  be copied, a wordmark of the company's name in the display stack will do.
- **Play the read back** in one line before saving.

## Checks before a look is published

- Every token is set, and no other custom property is declared.
- The four pairs reach 4.5:1.
- No `@import` and no external `url()`.
- The folder stays under the size cap (to be set by this prototype).
