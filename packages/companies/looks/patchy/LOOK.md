# Patchy's look

Captured on 2026-10-06 from Patchy's own plan documents and app pages. This is the look a company gets until it captures its own.

## The read

Patchy feels hand-built: warm cream paper, a faint engineering grid, and everything that matters drawn in near-black ink. Friendly on the surface, serious underneath. Three habits make it recognisable: **2px ink frames with hard offset shadows** (no blur, ever), **heavy system-font headings**, and **flat colour used in small, deliberate doses** (a blue button, a blue-washed selected tab, a green or amber pill). It is a workbench, not a dark AI dashboard.

## Type

- One system stack for everything (`--look-font-body` and `--look-font-display` are the same). There is no brand font, so the fallback loses nothing; what carries the brand is weight.
- Weights: body 450, labels and links 750, headings 850, the page title 900. Variable system fonts (SF Pro, Segoe UI Variable) render these exactly; fixed-weight fonts such as Arial round 450 to 400 and 850 to 700, which flattens the contrast between text and headings. Do not compensate with size.
- Scale for tools: page title 2.25rem, section 1.5rem, sub-section 1.15rem, body 16px, table and control text 0.9rem, captions 0.85rem. Headings sit tight (line-height about 1.05) and use `text-wrap: balance`.
- Sentence case everywhere. Uppercase only for tiny labels (badges, stat labels), at 0.74rem, weight 800, letter-spacing 0.05em.
- Numbers in tables and stats use `font-variant-numeric: tabular-nums`.
- Code, ids and commands use a mono stack the tokens do not hold: `ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace`. Mono sits on cream with a faint ink border, never in a dark terminal panel.

## Colour

- A screen is about 90% paper and ink. Paper (`--look-bg`) is the ground; white (`--look-surface`) is anything you work on: panels, tables, inputs. Ink (`--look-fg`, and `--look-border`, which holds the same ink) draws the text, every frame and every shadow.
- The accent blue appears in one primary button per view, focus rings, checkboxes and info badges. Never as a page or panel background, never on headings, never as a gradient.
- Links are the darker blue (`--look-link`), bold and underlined.
- Red (`--look-danger`) is for destructive actions and errors only. Danger buttons are a red tint with red text inside the usual ink frame, not a solid red slab.
- Hairlines are ink mixed toward transparent: `color-mix(in srgb, var(--look-border) 30%, transparent)` for row rules and dashed dividers, 14% for the faintest lines.
- Tints come from the tokens: `color-mix(in srgb, var(--look-accent) 10%, var(--look-surface))` for an info wash, the same with `--look-danger` at 8% for an error wash and `--look-success` or `--look-warning` at 10% for their badges. The selected tab or nav item is an accent wash at 14% in an ink frame.
- **Dropped from the brief:** the blue-to-green paper wash behind the page and the noise overlay. Both read as documents, not tools; the grid stays.

## Layout

- Content width up to about 1180px for tools, centred, with `calc(var(--look-space) * 4)` gutters. Reading columns stay at 70ch.
- Put the working area in one white panel (`.panel`) on the paper, the way Patchy's own app sits in one framed card. Inside it, sections divide with space and an `h2`, not with more boxes.
- Few cards, each bold. A card has the full 2px frame and a 4px hard shadow. Do not nest framed cards, and do not tile dashboards of them.
- Medium density: rows 8px top and bottom, controls 44px tall, 8px between buttons, 24 to 32px between sections.
- Left-aligned everything. Actions sit at the end of the form or the top right of the panel header.
- Dashed frames mark the unfinished or empty: empty states, drop zones, placeholders.

## Components

Lift these as they are. The plain `button` in `look.css` is already the primary button's colours and frame. Give every button `class="button"` for the hard ink shadow, and add a variant for the others: `<button class="button button-secondary">Cancel</button>`.

```css
/* Pressable: a hard ink shadow on hover, and the press. */
.button:hover:not(:disabled) {
  box-shadow: 2px 2px 0 var(--look-border);
}
.button:active:not(:disabled) {
  box-shadow: none;
  transform: translate(1px, 1px);
}

/* Secondary button: white with an ink frame. Pair with the plain button. */
.button-secondary {
  background: var(--look-surface);
  color: var(--look-fg);
}

/* Quiet button: no frame, for low-stakes actions in rows and toolbars. */
.button-quiet {
  border-color: transparent;
  background: transparent;
  color: var(--look-fg);
  text-decoration: underline;
}
.button-quiet:hover:not(:disabled) {
  box-shadow: none;
  background: color-mix(in srgb, var(--look-accent) 10%, transparent);
}

/* Danger button: red text on a red tint, still in the ink frame. */
.button-danger {
  background: color-mix(in srgb, var(--look-danger) 8%, var(--look-surface));
  color: var(--look-danger);
}

/* Status badge: an ink-framed pill. Neutral by default; pick one variant per state. */
.badge {
  display: inline-block;
  padding: 2px calc(var(--look-space) * 1.25);
  border: 2px solid var(--look-border);
  border-radius: 999px;
  background: var(--look-surface);
  color: var(--look-fg);
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  line-height: 1.5;
  text-transform: uppercase;
  white-space: nowrap;
}
.badge-info {
  background: color-mix(in srgb, var(--look-accent) 10%, var(--look-surface));
  color: var(--look-link);
}
.badge-danger {
  background: color-mix(in srgb, var(--look-danger) 8%, var(--look-surface));
  color: var(--look-danger);
}
.badge-success {
  background: color-mix(in srgb, var(--look-success) 10%, var(--look-surface));
  color: var(--look-success);
}
.badge-warning {
  background: color-mix(in srgb, var(--look-warning) 10%, var(--look-surface));
  color: var(--look-warning);
}

/* Card or panel: the full ink frame with a hard shadow. One level only. */
.panel {
  padding: calc(var(--look-space) * 2.5);
  border: 2px solid var(--look-border);
  border-radius: var(--look-radius);
  background: var(--look-surface);
  box-shadow: 4px 4px 0 var(--look-border);
}
.panel > :first-child {
  margin-top: 0;
}

/* Callout: a 6px coloured left edge. Info by default; .note-danger for errors. */
.note {
  margin: calc(var(--look-space) * 2) 0;
  padding: calc(var(--look-space) * 1.75) calc(var(--look-space) * 2);
  border: 1.5px solid color-mix(in srgb, var(--look-border) 30%, transparent);
  border-left: 6px solid var(--look-accent);
  border-radius: var(--look-radius);
  background: var(--look-surface);
}
.note > :last-child {
  margin-bottom: 0;
}
.note-danger {
  border-left-color: var(--look-danger);
  background: color-mix(in srgb, var(--look-danger) 8%, var(--look-surface));
}

/* Stat: a small uppercase label over a heavy number. Use inside a .panel or a row of them. */
.stat {
  display: grid;
  gap: calc(var(--look-space) * 0.5);
}
.stat-label {
  color: var(--look-muted);
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.stat-value {
  color: var(--look-fg);
  font-family: var(--look-font-display);
  font-size: 2rem;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

/* Page header: the company's name and a status badge on one line, then the title and one line
   of framing. */
.page-header {
  margin-bottom: calc(var(--look-space) * 4);
}
.page-header-line {
  display: flex;
  align-items: center;
  gap: calc(var(--look-space) * 1.5);
  margin-bottom: calc(var(--look-space) * 3);
}
.wordmark {
  color: var(--look-fg);
  font-family: var(--look-font-display);
  font-size: 1.25rem;
  font-weight: 850;
}
.page-header-line .badge {
  margin-left: auto;
}
.page-header h1 {
  margin-bottom: var(--look-space);
}
.page-header p {
  margin: 0;
  color: var(--look-muted);
}

/* Nav or tabs: the selected item is an accent wash in an ink frame. */
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--look-space) * 0.5);
}
.tabs a {
  padding: calc(var(--look-space) * 0.75) calc(var(--look-space) * 1.5);
  border: 2px solid transparent;
  border-radius: calc(var(--look-radius) - 2px);
  color: var(--look-fg);
  text-decoration: none;
}
.tabs a[aria-current="page"] {
  border-color: var(--look-border);
  background: color-mix(in srgb, var(--look-accent) 14%, var(--look-surface));
  box-shadow: 2px 2px 0 var(--look-border);
}

/* Form: stacked label, field, hint or error; actions at the end. */
.form {
  display: grid;
  gap: calc(var(--look-space) * 2.5);
  max-width: 36rem;
}
.form-hint {
  margin: calc(var(--look-space) * 0.75) 0 0;
  color: var(--look-muted);
  font-size: 0.85rem;
}
.form-error {
  margin: calc(var(--look-space) * 0.75) 0 0;
  color: var(--look-danger);
  font-size: 0.85rem;
  font-weight: 750;
}
.form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--look-space);
}

/* Ink table: the brief's report table. Framed, ink header row, zebra rows.
   Use for a small summary table that is the point of the page; keep the plain table for working lists. */
.table-ink {
  border: 2px solid var(--look-border);
  border-collapse: separate;
  border-spacing: 0;
  border-radius: var(--look-radius);
  overflow: hidden;
  box-shadow: 4px 4px 0 var(--look-border);
}
.table-ink th {
  border-bottom: 0;
  background: var(--look-fg);
  color: var(--look-surface);
}
.table-ink td {
  border-bottom-color: color-mix(in srgb, var(--look-border) 14%, transparent);
}
.table-ink tbody tr:nth-child(even) td {
  background: color-mix(in srgb, var(--look-fg) 3%, var(--look-surface));
}

/* Empty state: a dashed frame, a short heading, one line, one action. */
.empty {
  display: grid;
  justify-items: center;
  gap: var(--look-space);
  padding: calc(var(--look-space) * 5) calc(var(--look-space) * 3);
  border: 2px dashed color-mix(in srgb, var(--look-border) 30%, transparent);
  border-radius: var(--look-radius);
  text-align: center;
}
.empty h3 {
  margin: 0;
}
.empty p {
  margin: 0 0 var(--look-space);
  color: var(--look-muted);
}

/* Mono: ids, commands and code on cream, never a dark panel. */
.mono {
  padding: 0.1em 0.4em;
  border: 1.5px solid color-mix(in srgb, var(--look-border) 30%, transparent);
  border-radius: calc(var(--look-radius) - 2px);
  background: var(--look-bg);
  font-family:
    ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, "Liberation Mono",
    monospace;
  font-size: 0.88em;
}
```

```html
<header class="page-header">
  <div class="page-header-line">
    <span class="wordmark">Acme Co</span>
    <span class="badge badge-warning">Draft</span>
  </div>
  <h1>Expense approvals</h1>
  <p>Requests waiting on finance, oldest first.</p>
</header>
```

## Voice

Builder to builder. Short sentences, concrete nouns, honest status. Say what happened and what happens next; name the owner and the way back when an action has consequences. Use the product's words (patch, table, row, owner, review, rollback) and plain verbs. No hype, no emoji, no exclamation marks, no "seamless" or "powerful".

- Button: "Approve request", "Save changes", "Retire patch". A verb and its object, sentence case.
- Empty state: "No requests yet. New ones land here when someone submits the form."
- Error: "Couldn't save the row. Amount must be a number."
- Confirmation: "Deleted Q3 budget. You can restore it for 30 days."
- Status: "Waiting on finance", "Approved by Sam", "Failed at 14:02".

## Avoid

- Dark dashboards, glass, gradients and glows.
- Blurred or soft shadows. Shadows are hard, ink, offset down and right.
- Thin grey 1px card outlines. A frame is 2px ink or it is not there.
- Pills on buttons. Pills are for badges; buttons have the 8px radius.
- The accent as a background for panels, headers or whole rows.
- Dashboards tiled with cards, nested cards, and oversized hero headers.
- Animation of any kind beyond the 1px press.
- Emoji and exclamation marks in copy.

## The logo

This look is Patchy's own and stands in for a company with none, so it carries no logo: Patchy's mark never goes on a company's page. The company's name, set as `.wordmark` in the display stack, goes top left in the page header, never inside a coloured block, and does not repeat in the body or footer.
