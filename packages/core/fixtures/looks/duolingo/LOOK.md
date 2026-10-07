# Duolingo's look

Captured 2026-10-06 from duolingo.com (front page, courses, register, log in, Super, efficacy), its help centre, blog (design hub and a post), careers and press sites.

## The read

Bright, chunky and friendly, like a game that happens to be serious about learning. A white page, warm grey text and one loud green; everything you can press is fat, rounded and sits on a hard 4px "lip" so it looks physically pushable, and it drops onto that lip when pressed. Three habits make it recognisable: **2px borders with a thicker bottom edge** on buttons and cards, **bold uppercase letter-spaced labels** on every button and nav item, and **round, heavy type** that never goes light.

## Type

- **Body** is DIN Next Rounded at weight 500, never 400; bold is 700. Body runs large: 17px on pages, 20px in the app's lessons and inputs. Line height about 1.5.
- **Headings** in the product (log in, course picker, help) are the body font at 700, sentence case, in `--look-fg`: page title 40px, then 28, 24, 20. Letter-spacing 0.
- **Display** is Feather Bold, Duolingo's own chunky rounded face, used for the big moment on a page (`h1` only), tracked in at -0.02em. Marketing sets it all lowercase with full stops ("free. fun. effective.", "duolingo works"); a tool may do the same for its one hero title, never for h2 and below.
- **Labels**: buttons, nav items, table heads, meta lines and eyebrows are 13–15px, 700, `text-transform: uppercase`, `letter-spacing: 0.05em`. Write the copy in sentence case and let CSS uppercase it.
- **What the fallback loses.** Both brand fonts are licensed and only render where installed. Without them you get the system sans: square terminals instead of rounded ones, and Feather's bouncy weight becomes a plain bold. Safari on a Mac gets SF Pro Rounded through `ui-rounded`, which is close; Chrome ignores `ui-rounded`. Keep the heavy weights and uppercase labels: they carry the look when the shapes don't.

## Colour

- About 90% of a screen is white and grey. `--look-fg` (a warm dark grey, never black) for text, `--look-muted` for meta, `--look-border` for every edge, `--look-surface` for inputs and table heads.
- **Green (`--look-accent`) is for the one thing to do next**: the primary button, a progress bar, a success check, the selected state. One green button per view. Green is never text: on white it is 2.1:1.
- **Blue is for links and "where you are"**: link text, the selected nav tab's underline, focused input borders, group headings inside a panel (help centre). Duolingo's real link blue (#1cb0f6) is 2.4:1 on white, so `--look-link` is the darker blue from Duolingo's own palette (#2b70c9, 4.9:1).
- **Changed to pass 4.5:1.** Duolingo puts white text on its green (2.1:1). `--look-accent-fg` is the near-black (#131f24) Duolingo's own dark theme puts on its green buttons (8.1:1). Its secondary grey (#777) is 4.48:1, so `--look-muted` is darker (#6f6f6f) and holds 4.5:1 on `--look-surface` too. The link blue is changed as above. The green itself is kept. Danger is a deeper red than Duolingo's own (#d42424), and `--look-success` and `--look-warning` are deep enough to be text on both grounds.
- **The 3D lip** is the button's colour, darker: `color-mix(in srgb, var(--look-accent), black 18%)` for green, `var(--look-border)` for white buttons and cards.
- **Tints** come from tokens: `color-mix(in srgb, var(--look-accent) 15%, var(--look-bg))` for a success wash, the same with `--look-danger` for errors, with `--look-link` for info.
- Duolingo's other brights (yellow, orange, purple, pink) live in illustrations and course icons, not in chrome. Leave them out.

## Layout

- Centred single column. Content max 1000px for lists and dashboards; forms and dialogs are narrow, about 380px, centred on the page.
- Lots of air around few things: 32–64px between sections, 12–16px between controls. Spacing is multiples of `--look-space` (8px).
- Things that can be clicked sit in bordered tiles (2px border, 4px bottom lip, 16px radius) in a grid with 16px gaps. Lists sit in one bordered panel with 2px dividers between rows (help centre), not as separate cards.
- Sections divide with a 2px rule or plain space, never with background bands in a tool.
- Header: white, logo left, uppercase grey nav right, 2px bottom border.

## Components

```css
/* Secondary: the white "I already have an account" button. */
.button-secondary {
  background: var(--look-bg);
  color: var(--look-link);
  border: 2px solid var(--look-border);
  box-shadow: 0 4px 0 var(--look-border);
}
.button-secondary:hover {
  filter: none;
  background: var(--look-surface);
}

/* Danger: same lip, red. */
.button-danger {
  background: var(--look-danger);
  color: var(--look-bg);
  box-shadow: 0 4px 0 color-mix(in srgb, var(--look-danger), black 22%);
}

/* Quiet text button, like "FORGOT?" inside the password field. */
.button-text {
  background: none;
  box-shadow: none;
  min-height: auto;
  padding: 0;
  color: var(--look-muted);
}

/* Status badge: small, bold, uppercase, rounded but not a pill. */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 8px;
  font: 700 13px/1.4 var(--look-font-body);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: var(--look-surface);
  color: var(--look-muted);
}
.badge-success {
  background: color-mix(in srgb, var(--look-accent) 20%, var(--look-bg));
  color: var(--look-fg);
}
.badge-danger {
  background: color-mix(in srgb, var(--look-danger) 12%, var(--look-bg));
  color: color-mix(in srgb, var(--look-danger), black 25%);
}
.badge-info {
  background: color-mix(in srgb, var(--look-link) 12%, var(--look-bg));
  color: color-mix(in srgb, var(--look-link), black 20%);
}

/* Card: the course tile. Clickable cards press like buttons. */
.card {
  background: var(--look-bg);
  border: 2px solid var(--look-border);
  border-bottom-width: 4px;
  border-radius: var(--look-radius);
  padding: calc(var(--look-space) * 3);
}
a.card,
button.card {
  display: block;
  color: inherit;
  text-decoration: none;
}
a.card:hover {
  background: var(--look-surface);
  text-decoration: none;
}
a.card:active {
  transform: translateY(2px);
  border-bottom-width: 2px;
}

/* Stat: a bordered tile, big bold number, uppercase label. */
.stat {
  border: 2px solid var(--look-border);
  border-bottom-width: 4px;
  border-radius: var(--look-radius);
  padding: calc(var(--look-space) * 2);
}
.stat-value {
  font: 700 28px/1.1 var(--look-font-display);
  color: var(--look-fg);
}
.stat-label {
  margin-top: 4px;
  color: var(--look-muted);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

/* Page header with the logo. */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 72px;
  padding: 0 calc(var(--look-space) * 3);
  border-bottom: 2px solid var(--look-border);
  background: var(--look-bg);
}
.page-header img {
  height: 32px;
  width: auto;
}
.page-header nav {
  display: flex;
  gap: calc(var(--look-space) * 4);
  height: 100%;
}
.page-header nav a {
  display: flex;
  align-items: center;
  color: var(--look-muted);
  font-size: 15px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  border-bottom: 3px solid transparent;
  margin-bottom: -2px;
}
.page-header nav a:hover {
  text-decoration: none;
  color: var(--look-fg);
}
.page-header nav a[aria-current="page"] {
  color: var(--look-link);
  border-bottom-color: var(--look-link);
}

/* Form: narrow, centred, stacked; the primary button spans the width. */
.form {
  display: grid;
  gap: calc(var(--look-space) * 1.5);
  max-width: 380px;
  margin: 0 auto;
}
.form button {
  width: 100%;
}
.form .hint {
  color: var(--look-muted);
  font-size: 15px;
}
.form .error {
  color: var(--look-danger);
  font-size: 15px;
  font-weight: 700;
}
input[aria-invalid="true"] {
  border-color: var(--look-danger);
}

/* Table as a grouped panel, like the help centre: blue group heading, tall rows. */
.table-panel {
  border: 2px solid var(--look-border);
  border-radius: var(--look-radius);
  overflow: hidden;
}
.table-panel > h3 {
  margin: 0;
  padding: calc(var(--look-space) * 3) calc(var(--look-space) * 4);
  color: var(--look-link);
  font-size: 17px;
  border-bottom: 2px solid var(--look-border);
}
.table-panel table {
  border: 0;
  border-radius: 0;
}
.table-panel td {
  padding: calc(var(--look-space) * 3) calc(var(--look-space) * 4);
}
.table-panel tbody tr:hover {
  background: var(--look-surface);
  cursor: pointer;
}

/* Empty state: centred, one line of cheer, one green button. */
.empty-state {
  display: grid;
  justify-items: center;
  gap: calc(var(--look-space) * 2);
  padding: calc(var(--look-space) * 8) calc(var(--look-space) * 3);
  text-align: center;
}
.empty-state .mark {
  width: 96px;
  height: 96px;
  border-radius: 28px;
  background: color-mix(in srgb, var(--look-accent) 20%, var(--look-bg));
}
.empty-state h2 {
  margin: 0;
  font-size: 24px;
}
.empty-state p {
  margin: 0;
  color: var(--look-muted);
  max-width: 32ch;
}
```

## Voice

Short, warm, a little cheeky. Second person, contractions, plain words. Celebrates small wins ("Nice work!"), apologises briefly, never blames. Exclamation marks are allowed, one per message. Lowercase punchy fragments are fine for a hero title ("fast. simple. done."), sentences everywhere else.

- Button: "Get started", "Save changes", "Keep going" (rendered uppercase).
- Empty state: "No requests yet. Enjoy the quiet!"
- Error: "That didn't save. Check your connection and try again."
- Confirmation: "Nice work! Your changes are saved."

## Avoid

- Thin 1px hairlines, sharp corners, soft blurred drop shadows. Edges are 2px, corners 16px, shadows are hard offsets.
- Light or regular (400) weights, serif fonts, mixed-case button labels.
- Green text, green links, or more than one green button in view.
- Dark navy pages and gradients: those belong to Super Duolingo marketing, not tools.
- Bright illustration colours (yellow, orange, purple) in the interface.
- Drawing the owl or any mascot. Use the logo, plain shapes, or nothing.

## The logo

Top-left of the page header, 32px tall, with 24px of space before the nav. On a login or empty page it may sit centred above the title at 40px. Always on white; never recolour it.
