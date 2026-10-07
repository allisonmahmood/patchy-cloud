# Linear's look

Captured from linear.app (front page, pricing, docs, docs/creating-issues, changelog, method, customers, features) on 2026-10-06.

## The read

Linear is a quiet, near-black workspace where the content does the talking. Almost everything is grey on black; colour is rationed to one indigo and to small status dots. Three habits make it recognisable: dark neutral ground with hairline borders instead of shadows, Inter at medium and semibold weights with tight negative letter-spacing, and dense, left-aligned lists of short items, each with a muted ID or meta beside it.

## Type

- One family, Inter, for everything. Weights are 400 for body, 510 for labels, buttons and table headers, 590 for headings. Never 700.
- Body is 15px/1.6 with -0.011em tracking; app-like UI (tables, buttons, inputs, labels, meta) drops to 13px. Tiny meta is 12px.
- Headings: h1 2rem/1.125 at -0.022em, h2 1.5rem, h3 1.25rem, h4 1.0625rem, all at -0.012em. Large headings always get the tighter -0.022em.
- Sentence case everywhere. Uppercase appears only as a tiny eyebrow above a page title (12px, muted, `letter-spacing: 0.02em`).
- Numbers in stats and tables use `font-variant-numeric: tabular-nums`.
- Code, issue keys in diagrams and keyboard hints use a mono stack: `"Berkeley Mono", ui-monospace, "SF Mono", Menlo, monospace`.
- The fallback loses Inter's tuned weights (510 and 590 snap to 500 and 600 on system fonts) and its alternate characters (`cv01`, `ss03`: open digits, a flatter "a"). Without Inter installed, SF or Segoe UI read close enough. The site's editorial pages set some headlines in a serif (Tiempos Headline); tools never use it.

## Colour

- About 95% of any screen is neutral: `--look-bg` ground, `--look-surface` panels, `--look-fg` and `--look-muted` text, `--look-border` hairlines.
- Text has four steps. Use `--look-fg` for primary text and `--look-muted` for meta. The secondary step between them is `color-mix(in srgb, var(--look-fg) 68%, var(--look-muted))`, used for body text in long descriptions. The faintest step, `color-mix(in srgb, var(--look-muted) 70%, var(--look-bg))`, is decoration only (disabled icons, separators like `·`). It fails contrast, so never put words in it.
- `--look-accent` (indigo) appears only on the one primary action, the selected state of a toggle or tab, the focus ring and text selection. Never use it for headings, icons, borders or backgrounds of large areas.
- Contrast: the accent is Linear's dark-theme brand fill `#5e6ad2` (white on it is 4.7:1), not the brighter `#7170ff` the site uses for glows and its light theme, because white on that is only 3.8:1. Nothing else was changed; every other token is the site's own value.
- `--look-link` is a lighter indigo so it passes on black. Long-form links can also be `--look-fg` with a muted underline, as the changelog does.
- `--look-danger` is red text, never a fill: white on it is only 3.5:1. Use the tinted danger button below.
- Status colours are small dots, never fills or text. Linear's set, as literals because the tokens cannot hold them: done `#27a644`, in progress `#f0bf00`, blocked or urgent `#fc7840`, info `#4ea7fc`, bug or error `#eb5757` (the danger token), backlog and cancelled `var(--look-muted)`.
- Hover and selected rows tint with `color-mix(in srgb, var(--look-fg) 4%, var(--look-bg))`. A selected tint that carries brand is `color-mix(in srgb, var(--look-accent) 14%, var(--look-bg))`.
- No gradients and no pure white. Shadows are almost absent; a panel floating over content gets `0 4px 24px rgb(0 0 0 / 0.2)` at most.

## Layout

- Dense but airy: compact rows (40 to 44px) inside generous page margins. Content is left-aligned; centre only an empty state or a one-line hero.
- The content column is 1024px max with 24px side padding and 64px top padding. Prose and forms cap at 624px.
- App pages use a fixed 240px sidebar on `--look-bg` with a hairline right border, a 64px top bar and an open main area. Sidebar items are 13px, 28px tall, muted icon plus fg label.
- Sections divide with a hairline (`--look-border`) and air, not with boxes. Lists and tables sit open on the page; cards are for grids of equal things (docs topics, stats).
- Spacing is a 4px grid: 4, 8, 12, 16, 24, 32, 64. Gaps between small things are 6 to 8px.

## Components

```css
/* A quieter button for everything that is not the one primary action. */
.button-secondary {
  height: 32px;
  padding: 0 calc(var(--look-space) * 3);
  border: 1px solid var(--look-border);
  border-radius: var(--look-radius);
  background: var(--look-surface);
  color: var(--look-fg);
  font: 510 13px/30px var(--look-font-body);
  cursor: pointer;
}
.button-secondary:hover {
  background: color-mix(in srgb, var(--look-fg) 8%, var(--look-bg));
}

/* Toolbar and inline actions: no box until hovered. */
.button-ghost {
  height: 28px;
  padding: 0 calc(var(--look-space) * 2);
  border: 0;
  border-radius: calc(var(--look-radius) - 2px);
  background: transparent;
  color: var(--look-muted);
  font: 510 13px/28px var(--look-font-body);
  cursor: pointer;
}
.button-ghost:hover {
  background: var(--look-surface);
  color: var(--look-fg);
}

/* Destructive: red text on a red-tinted ground, never a solid red fill. */
.button-danger {
  height: 32px;
  padding: 0 calc(var(--look-space) * 3);
  border: 1px solid color-mix(in srgb, var(--look-danger) 35%, var(--look-bg));
  border-radius: var(--look-radius);
  background: color-mix(in srgb, var(--look-danger) 12%, var(--look-bg));
  color: var(--look-danger);
  font: 510 13px/30px var(--look-font-body);
  cursor: pointer;
}

/* The site's light pill call-to-action. At most one per page, in the page header. */
.button-invert {
  height: 32px;
  padding: 0 calc(var(--look-space) * 3);
  border: 0;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--look-fg) 92%, var(--look-bg));
  color: var(--look-bg);
  font: 510 13px/32px var(--look-font-body);
  cursor: pointer;
}
.button-invert:hover {
  background: var(--look-fg);
}

/* Status badge: outlined pill with a coloured dot. Set the dot per status. */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--look-border);
  border-radius: 9999px;
  color: var(--look-muted);
  font: 510 12px/1 var(--look-font-body);
}
.badge::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--look-muted);
}
.badge-done::before {
  background: #27a644;
}
.badge-progress::before {
  background: #f0bf00;
}
.badge-blocked::before {
  background: #fc7840;
}
.badge-error::before {
  background: var(--look-danger);
}

/* Card: a quiet raised panel. Grids of cards use a 16px gap. */
.card {
  padding: calc(var(--look-space) * 6) calc(var(--look-space) * 5);
  border: 1px solid var(--look-border);
  border-radius: var(--look-radius);
  background: var(--look-surface);
}
.card h3 {
  font-size: 15px;
  margin-bottom: var(--look-space);
}
.card p {
  color: var(--look-muted);
  font-size: 13px;
  margin: 0;
}

/* Stat: muted label over a big tight number. */
.stat {
  display: grid;
  gap: var(--look-space);
}
.stat-label {
  color: var(--look-muted);
  font-size: 13px;
  font-weight: 510;
}
.stat-value {
  font: 590 2rem/1.1 var(--look-font-display);
  letter-spacing: -0.022em;
  font-variant-numeric: tabular-nums;
}

/* Page header: logo left, quiet nav, actions right, hairline under. */
.page-header {
  display: flex;
  align-items: center;
  gap: calc(var(--look-space) * 6);
  height: 64px;
  padding: 0 calc(var(--look-space) * 6);
  border-bottom: 1px solid var(--look-border);
  background: color-mix(in srgb, var(--look-bg) 85%, transparent);
  backdrop-filter: blur(20px);
  position: sticky;
  top: 0;
}
.page-header img {
  height: 24px;
}
.page-header nav {
  display: flex;
  gap: calc(var(--look-space) * 6);
  font-size: 13px;
}
.page-header nav a {
  color: var(--look-muted);
  text-decoration: none;
}
.page-header nav a[aria-current] {
  color: var(--look-fg);
}
.page-header .actions {
  margin-left: auto;
  display: flex;
  gap: calc(var(--look-space) * 2);
}

/* Form: one column, labels above, actions bottom right. */
.form {
  display: grid;
  gap: calc(var(--look-space) * 5);
  max-width: 624px;
}
.form .hint {
  color: var(--look-muted);
  font-size: 12px;
  margin-top: var(--look-space);
}
.form .actions {
  display: flex;
  justify-content: flex-end;
  gap: calc(var(--look-space) * 2);
}

/* List table: the app's issue list. Muted key column, hover tint, no vertical rules. */
.table-list td {
  height: 44px;
  padding-block: 0;
}
.table-list tr:hover td {
  background: color-mix(in srgb, var(--look-fg) 4%, var(--look-bg));
}
.table-list .key {
  width: 1%;
  white-space: nowrap;
  color: var(--look-muted);
  font-variant-numeric: tabular-nums;
}
.table-list .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* Empty state: centred, quiet, one action. */
.empty {
  display: grid;
  justify-items: center;
  gap: calc(var(--look-space) * 2);
  padding: calc(var(--look-space) * 16) calc(var(--look-space) * 6);
  text-align: center;
  color: var(--look-muted);
  font-size: 13px;
}
.empty strong {
  color: var(--look-fg);
  font-size: 15px;
  font-weight: 510;
}
```

## Voice

Short, plain, confident sentences. Sentence case, no exclamation marks, no emoji, no hype in the UI itself. Verbs first on actions. Changelog lines start with the verb: "Fixed…", "Added…", "Projects now have…". Favoured words: issue, project, cycle, team, workflow, focus, momentum, quality. Write "you", rarely "we".

- Button: "Create issue", "Assign to me", "Save changes", "Archive".
- Empty state: "No open requests" / "New requests from your team show up here."
- Error: "Couldn't save the request. Check your connection and try again."
- Confirmation: "Request archived" (a toast, no full stop).

## Avoid

- Light backgrounds, white cards, or any large area of indigo.
- Gradients, glows, heavy drop shadows, glassy blur everywhere (the header is the one place for blur).
- Bold 700 weights, loose letter-spacing on headings, or uppercase labels beyond the tiny eyebrow.
- Coloured text for status. Status is a dot plus muted words.
- Big rounded "bubbly" corners above 12px, and pill shapes on anything but badges and the single invert call-to-action.
- More than one primary button in view.
- Exclamation marks, cheerful filler, and marketing superlatives in tool copy.

## The logo

Top left of the page header, 24px tall, 24px from the left edge, vertically centred in the 64px bar. Always on `--look-bg`, never on an accent fill or inside a card. Nothing else sits to its left.
