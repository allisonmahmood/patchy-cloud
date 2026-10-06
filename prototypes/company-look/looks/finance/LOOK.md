# Vanguard's look

Captured on 2026-10-06 from investor.vanguard.com (home, fund list, VOO fund profile, fees and commissions, an education article), the logon page at logon.vanguard.com, and corporate.vanguard.com.

## The read

Calm, plain and trustworthy: a white page, near-black text and very heavy geometric headlines, with Vanguard red held back for the logo and the one action that moves money. Three habits make it recognisable. Primary buttons are black pills while fields, cards and tables are square. Data sits open on the page between hairlines, with labels small above large, light numbers. Every figure carries its date ("as of 10/05/2026") and its caveat.

## Type

- One family, FF Mark, a geometric sans. Weight carries the hierarchy: headings are 800 to 900, body is 400, links, labels in tables and buttons are 700.
- Scale in px: 14 (small, labels, table headers), 17 (body; larger than most sites), 23, 28, 34, then 46, 57 and 68 for hero headlines only. In a tool, `h1` is 34 and a page rarely needs anything bigger.
- Big numbers are the exception to "heavy": stat values are 28 to 34px at weight 400, with tabular figures.
- Sentence case everywhere. Headlines tighten slightly at large sizes (-0.01em). The eyebrow above a page title is the one uppercase habit: 14px, weight 400, letter-spacing 0.2em.
- Dates and sources under a number are 11 to 12px italic in the muted colour.
- The fallback stack loses the geometric round "a" and "g" and, on machines with only Arial, the 800 to 900 weights; headings then fall to 700 and read flatter. Avenir Next (macOS) and Segoe UI (Windows) hold the heavy weight best.

## Colour

- About 90% of any screen is white and near-black. Grey `--look-surface` fills table headers, hover rows and quiet panels.
- Primary actions are black (`--look-fg` as fill), not red. A plain `button` is already black.
- `--look-accent` (Vanguard red) is the signature and is spent sparingly: the logo, a single "commit" action per view (Buy, Log in, Submit trade), a 4px top rule on a key section, small count badges, and a pale tint for one highlighted panel. Never on headings, body text, links or more than one button in view.
- Links are blue (`--look-link`), bold and underlined. Blue appears nowhere else except the focus ring.
- `--look-danger` is a rust red, used for errors and negative changes. It is close in hue to the accent, so destructive buttons are outlined, never filled.
- Tints come from tokens: `color-mix(in srgb, var(--look-accent) 7%, var(--look-bg))` for the pink highlight panel, `color-mix(in srgb, var(--look-border) 50%, var(--look-bg))` for row hairlines.
- Colours the tokens could not hold: a turquoise family (`#007873` for charts and positive progress, `#def5f0` for "Advised only" tags), a yellow family (`#ffaf00` risk dots, `#fff7de` panels), a gain green (`#1d9f22`, arrows only), a deep burgundy (`#96151d`) in the wordmark, and a dark slate band (`#3f4444`) behind in-page section tabs. Use them only for charts and data encodings; never as fills for actions.
- All four token pairs pass 4.5:1 at the brand's real values. `--look-muted` on `--look-surface` is only 4.2:1, so text inside grey panels and table headers uses `--look-fg`.

## Layout

- Wide, left-aligned and airy. Content sits in a 1296px column with 72px side margins at desktop; reading text holds to about 70 characters.
- Spacing is an 8px grid: 16 inside cells, 24 inside panels, 32 between groups, 64 to 96 between sections.
- Things sit open on the page, divided by hairlines, rather than boxed into cards. Boxes appear only for a form or one sidebar note, and they are square with a 1px border.
- Stats run in a grid of four or five columns, each a small label over a large light number.
- Lists of links are full-width rows with a hairline between them and an arrow at the right edge.
- Dense data is fine: tables run edge to edge of the column, 14 to 16px, with right-aligned figures.

## Components

```css
/* Page header: logo, a hairline divider, the tool's name in muted text. */
.page-header {
  display: flex;
  align-items: center;
  gap: calc(var(--look-space) * 2);
  min-height: calc(var(--look-space) * 9);
  padding: 0 calc(var(--look-space) * 9);
  border-bottom: 1px solid var(--look-border);
}
.page-header img {
  height: 28px;
}
.page-header .tool-name {
  padding-left: calc(var(--look-space) * 2);
  border-left: 1px solid var(--look-border);
  color: var(--look-muted);
  font-size: 14px;
  line-height: 36px;
}
.page-header .actions {
  margin-left: auto;
  display: flex;
  gap: calc(var(--look-space) * 2);
}

/* Eyebrow above a page title. */
.eyebrow {
  margin: 0 0 var(--look-space);
  font-size: 14px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

/* Secondary: black outline pill. */
.button-secondary {
  background: var(--look-bg);
  color: var(--look-fg);
}
.button-secondary:hover {
  background: var(--look-fg);
  color: var(--look-bg);
}

/* Commit: the one red action per view (Buy, Submit, Log in). */
.button-commit {
  background: var(--look-accent);
  border-color: var(--look-accent);
  color: var(--look-accent-fg);
}
.button-commit:hover {
  background: color-mix(in srgb, var(--look-accent) 80%, var(--look-fg));
  color: var(--look-accent-fg);
}

/* Danger: outlined so it never reads as the red commit button. */
.button-danger {
  background: var(--look-bg);
  border-color: var(--look-danger);
  color: var(--look-danger);
}
.button-danger:hover {
  background: var(--look-danger);
  color: var(--look-bg);
}

.button-small {
  min-height: calc(var(--look-space) * 4);
  padding: 0 calc(var(--look-space) * 2);
  font-size: 14px;
}

/* Status badge: small, bold, slightly rounded. */
.badge {
  display: inline-block;
  padding: 4px var(--look-space);
  border-radius: 6px;
  background: var(--look-surface);
  color: var(--look-fg);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
}
.badge-brand {
  background: color-mix(in srgb, var(--look-accent) 10%, var(--look-bg));
  color: var(--look-accent);
}
.badge-danger {
  background: color-mix(in srgb, var(--look-danger) 12%, var(--look-bg));
  color: var(--look-danger);
}
.badge-strong {
  background: var(--look-fg);
  color: var(--look-bg);
}

/* Panel: square, 1px border. The tint variant is the one highlighted box. */
.panel {
  padding: calc(var(--look-space) * 3);
  border: 1px solid var(--look-border);
  border-radius: var(--look-radius);
  background: var(--look-bg);
}
.panel-tint {
  background: color-mix(in srgb, var(--look-accent) 7%, var(--look-bg));
  border-color: transparent;
}

/* A key section opens with a 4px red rule. */
.section-ruled {
  border-top: 4px solid var(--look-accent);
  padding-top: calc(var(--look-space) * 3);
}

/* Stats: label over a large, light number, with an "as of" line. */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: calc(var(--look-space) * 4) calc(var(--look-space) * 3);
}
.stat-label {
  font-size: 14px;
}
.stat-value {
  font-size: 28px;
  font-weight: 400;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.stat-asof {
  font-size: 11px;
  font-style: italic;
  color: var(--look-muted);
}
.change-down {
  color: var(--look-danger);
}

/* Data table: no header fill, a heavy rule under the header, figures right-aligned. */
.table-data th {
  background: none;
  border-bottom: 2px solid var(--look-fg);
}
.table-data td {
  padding-block: calc(var(--look-space) * 1.5);
}
.table-data .num {
  text-align: right;
  white-space: nowrap;
}
.table-data tbody tr:hover {
  background: var(--look-surface);
}

/* Segmented control: black selected pill inside a black outline. */
.segmented {
  display: inline-flex;
  border: 1px solid var(--look-fg);
  border-radius: 999px;
}
.segmented button {
  min-height: calc(var(--look-space) * 4);
  min-width: 120px;
  border: 0;
  background: none;
  color: var(--look-fg);
  font-size: 14px;
}
.segmented button[aria-selected="true"] {
  background: var(--look-fg);
  color: var(--look-bg);
}

/* Form: one column, labels above square fields, actions left-aligned. */
.form {
  display: grid;
  gap: calc(var(--look-space) * 3);
  max-width: 416px;
}
.form-actions {
  display: flex;
  align-items: center;
  gap: calc(var(--look-space) * 3);
}
.field-hint {
  margin-top: var(--look-space);
  font-size: 14px;
  color: var(--look-muted);
}
.field-error {
  margin-top: var(--look-space);
  font-size: 14px;
  color: var(--look-danger);
}
.form input[aria-invalid="true"] {
  border-color: var(--look-danger);
}

/* Empty state: quiet grey panel, left-aligned, one way forward. */
.empty-state {
  padding: calc(var(--look-space) * 6);
  background: var(--look-surface);
}
.empty-state h3 {
  margin-bottom: var(--look-space);
}
.empty-state p {
  max-width: 52ch;
}
```

## Voice

- Plain, warm and careful. Short sentences, second person, contractions ("we're", "you'll"). Sentence case for every heading and button.
- Buttons are two or three words, verb first: "Open an account", "Compare services", "View comparison", "Log in".
- Precise about facts: every figure has a date, every claim a source or footnote. Hedge with "may" and "generally" where the rule has exceptions; never hype.
- Em dashes for asides, no exclamation marks.

Examples in a tool:

- Button: "Review trades", "Export report", "Submit for approval".
- Empty state: "No trades to review yet. New requests appear here as soon as they're submitted."
- Error: "We couldn't save this account. Check the account number and try again."
- Confirmation: "Your request was submitted. You'll get an email when it's approved."
- Data footnote: "Balances as of 10/05/2026. Values may be delayed up to 15 minutes."

## Avoid

- Red primary buttons everywhere, red headings or red links. Red is rare on purpose.
- Rounded cards, rounded inputs, drop shadows on everything, or gradients.
- Light or thin headings; Vanguard headings are always heavy.
- Bright accent colours outside charts; turquoise and yellow encode data, not actions.
- Numbers without a date, or casual, salesy copy ("Awesome!", "Let's go!").
- Centred layouts for working screens. Centre only a short hero line.

## The logo

Top-left of the page header, 28px tall, 72px in from the edge, followed by a hairline divider and the tool's name in muted 14px text. Never on a red or photographic ground in a tool; on the black footer band it reverses to white. Leave at least 16px of clear space around it.
