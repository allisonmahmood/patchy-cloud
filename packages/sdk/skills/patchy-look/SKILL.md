---
name: patchy-look
description: Style a page in the company look, the default for the company's tools, or deliberately away from it when the person asks for a different style.
---

# The company look

<!-- look-state -->

## Which style wins

Style by the first of these that applies:

1. What the person asked for in this conversation.
2. This patch's own style: the CSS already in the repo.
3. The company look.
4. The Patchy look, when the company has none.

Follow a request for something else, such as a Halloween page or a page for a client, without
questioning it: override the look with your own CSS, or remove the import when nothing of it
should remain. Say once that the page doesn't use the company look; don't ask permission.

The look is the company's, not this patch's. Building a patch leaves it as it is; when the
person wants the look itself changed, tell them it belongs to the company and an admin changes
it with `patchy look publish`.

## Using it

- `patchy/_generated/look.css` sets the tokens below and styles plain elements (body,
  headings, links, tables, buttons and inputs) inside `@layer look`. Read it before styling, so
  you build on those element styles instead of restyling them.
- A page uses the look by importing that file. A new repo's tier 1 and 2 `src/main.tsx`
  imports it and its tier 0 `index.html` links it; the build inlines it, fonts included, so the
  published page carries it in its own bytes. A page that doesn't import it keeps its own style
  (rule 2); add the import when the person asks for the company look.
- Write your CSS outside any layer. Unlayered CSS always beats `@layer look`, whatever its
  specificity.
- Use the tokens for every colour, font, radius and gap they cover, so the patch follows when
  the company changes its look. Derive tints from them, for example
  `color-mix(in srgb, var(--look-accent) 12%, var(--look-bg))`, instead of new hex values.
- Lift the brief's component recipes rather than inventing new ones.
- `patchy/_generated/logo.svg`, when it exists, is the company's mark. Refer to it by path and
  the build embeds it: on tiers 1 and 2 `import logo from "../patchy/_generated/logo.svg";`,
  on tier 0 `<img src="/patchy/_generated/logo.svg" alt="…">` in `index.html`. Remove the
  reference if a later look has no logo.
- `patchy refresh` and `patchy dev` rewrite `patchy/_generated/` to the company's current
  look. Put every change in your own CSS.

## The tokens

| Token                 | Holds                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `--look-bg`           | The page ground.                                                          |
| `--look-surface`      | A second ground, such as a card or panel, carrying the same text colours. |
| `--look-fg`           | Body text.                                                                |
| `--look-muted`        | Secondary text: captions, meta, placeholders.                             |
| `--look-link`         | Link text.                                                                |
| `--look-success`      | Success text; tint it with `color-mix()` for fills.                       |
| `--look-warning`      | Warning text, likewise.                                                   |
| `--look-danger`       | Destructive actions and errors, likewise.                                 |
| `--look-accent`       | The principal brand emphasis fill. Not necessarily the primary button.    |
| `--look-accent-fg`    | Text and icons on the accent.                                             |
| `--look-border`       | Decorative separators and frames.                                         |
| `--look-font-body`    | The body font stack.                                                      |
| `--look-font-display` | The heading font stack.                                                   |
| `--look-radius`       | The most common corner radius.                                            |
| `--look-space`        | The reference gap, nominally 8px.                                         |

Every text colour reads at 4.5:1 on both grounds, and accent-fg on the accent. Pending and
other neutral states use fg or muted. Space in multiples of `--look-space`: half between a
label and its field, one between related controls, three for panel padding.

## The brief

<!-- look-brief -->
