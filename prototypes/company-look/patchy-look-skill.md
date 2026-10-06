---
name: patchy-look
description: Style a page in {{company}}'s look, the company's default for its tools, or deliberately away from it when the person asks for a different style.
---

<!-- PROTOTYPE for #563: the generated patchy-look project skill. {{company}} and {{brief}} are filled from the look folder. -->

# {{company}}'s look

{{company}} has a company look, the style its tools start in. `src/main.tsx` imports
`patchy/_generated/look.css`, which sets the `--look-*` tokens and styles plain elements
(body, headings, links, tables, buttons, inputs) inside `@layer look`. The brief below
covers what those elements can't: layout, components and voice. `patchy/_generated/logo.svg`
is the company's mark.

## Which style wins

1. What the person asked for in this conversation.
2. This patch's own style: the CSS already in `src/`.
3. {{company}}'s look.

Follow a request for something else, such as a Halloween page or a client's colours,
without questioning it. Override the look with your own CSS, or remove the import when
nothing of it should remain. Say once that the page doesn't use {{company}}'s look; don't
ask permission.

## Using it

- Write your CSS outside any layer. Unlayered CSS always beats `@layer look`, whatever its
  specificity.
- Use the tokens for every colour, font, radius and spacing they cover, so the patch
  follows when the company changes its look. Derive tints and shades from them, for
  example `color-mix(in srgb, var(--look-accent) 12%, var(--look-bg))`, instead of new hex
  values.
- Lift the brief's component recipes rather than inventing new ones.
- Import the logo as a URL, `import logo from "../patchy/_generated/logo.svg";`; the build
  embeds it.
- Never edit `patchy/_generated/`; `patchy refresh` rewrites it. Building a patch never
  changes the company look. If the person wants the look itself changed, tell them it is
  the company's, not this patch's.

## The tokens

| Token                 | Holds                                                 |
| --------------------- | ----------------------------------------------------- |
| `--look-bg`           | The page ground.                                      |
| `--look-fg`           | Body text.                                            |
| `--look-muted`        | Secondary text: captions, meta, placeholders.         |
| `--look-surface`      | A raised or inset area: cards, panels, table headers. |
| `--look-border`       | Hairlines, dividers and input outlines.               |
| `--look-accent`       | The brand colour as a fill: the primary button.       |
| `--look-accent-fg`    | Text and icons on the accent.                         |
| `--look-link`         | Link text.                                            |
| `--look-danger`       | Destructive actions and errors.                       |
| `--look-font-body`    | The body font stack.                                  |
| `--look-font-display` | The heading font stack.                               |
| `--look-radius`       | The corner radius for buttons, inputs and cards.      |
| `--look-space`        | The base spacing unit; use multiples of it.           |

{{brief}}
