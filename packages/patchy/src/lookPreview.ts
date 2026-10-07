/**
 * The look specimen: one fixed page Patchy owns, styled only by a look, and the file
 * `patchy look preview` writes from it. The specimen's own CSS sits in a layer beneath the
 * look's and only lays the page out from tokens, so every element style shown is the look's.
 * The page carries everything it needs, fonts and logo included, and its CSP refuses any other
 * request, so it renders offline exactly as a patch would.
 */
import * as CssTree from "css-tree";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import type { LookFiles, LookToken } from "@patchy/core/look";

/** One look on the specimen, with what its masthead calls it. */
export interface Pane {
  readonly files: LookFiles;
  /** Such as `Candidate` or `Revision 3, the company's look`. */
  readonly label: string;
  /** A sentence under the label, such as that the company has no look yet. */
  readonly note?: string;
}

// The page's only requests are its own data: URLs; a look that points elsewhere renders as a patch would.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** Pseudo-classes the states row shows at rest, by the class standing in for each. */
const FORCED: Readonly<Record<string, string>> = {
  hover: "specimen-hover",
  focus: "specimen-focus",
  "focus-visible": "specimen-focus"
};

/**
 * `look.css` with every selector that uses `:hover`, `:focus` or `:focus-visible` directly
 * also matching a stand-in class, so the states row shows those styles without a pointer or a
 * keyboard. A class weighs the same as a pseudo-class and the alias joins the same rule, so the
 * cascade is unchanged; the rest of the text is left as written.
 */
export const forceStates = (css: string): string => {
  const inserts: Array<{ readonly at: number; readonly text: string }> = [];
  CssTree.walk(CssTree.parse(css, { positions: true }), {
    visit: "Rule",
    enter: (rule) => {
      if (rule.prelude.type !== "SelectorList" || rule.prelude.loc === undefined) return;
      const aliases = rule.prelude.children.toArray().flatMap((selector) => {
        if (selector.type !== "Selector") return [];
        const parts = selector.children.toArray();
        const forced = (node: CssTree.CssNode) =>
          node.type === "PseudoClassSelector" ? FORCED[node.name.toLowerCase()] : undefined;
        if (!parts.some(forced)) return [];
        return [
          parts.map((node) => (forced(node) ? `.${forced(node)}` : CssTree.generate(node))).join("")
        ];
      });
      if (aliases.length > 0)
        inserts.push({ at: rule.prelude.loc.end.offset, text: `, ${aliases.join(", ")}` });
    }
  });
  return inserts.reduceRight(
    (text, { at, text: alias }) => text.slice(0, at) + alias + text.slice(at),
    css
  );
};

/** The brief's `# Acme's look` heading, the masthead's wordmark when there's no logo. */
const briefTitle = (brief: string) => /^#[ \t]+(.+?)[ \t]*$/m.exec(brief)?.[1] ?? "Look";

/** A `<style>` body that cannot close its element early. */
const styleText = (css: string) => css.replace(/<\/style/gi, "<\\/style");

const head = (title: string, styles: string) => `<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${CSP}" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
${styles}`;

/** The specimen in one look, a whole document. */
const specimen = ({ files, label, note }: Pane) => {
  const title = briefTitle(files["LOOK.md"]);
  const logo = files["logo.svg"];
  const mark =
    logo === undefined
      ? `<span class="wordmark">${escapeHtml(title)}</span>`
      : `<img class="logo" src="data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}" alt="${escapeAttribute(title)}" />`;
  return `<!doctype html>
<html lang="en">
<head>
${head(
  `${title}: ${label}`,
  `<style>
@layer specimen, look;
${SPECIMEN_CSS}
</style>
<style>
${styleText(forceStates(files["look.css"]))}
</style>`
)}
</head>
<body>
<main class="specimen">
  <header class="masthead">
    ${mark}
    <div class="pane-label">
      <strong>${escapeHtml(label)}</strong>
      ${note === undefined ? "" : `<span>${escapeHtml(note)}</span>`}
    </div>
  </header>
  <div class="about">This specimen shows look.css alone: its tokens and the styles it gives plain elements. It doesn't show the brief's recipes, and it can't show how this look meets a patch's own components.</div>
${SPECIMEN_BODY}
</main>
</body>
</html>
`;
};

/**
 * The preview file: one specimen, or two side by side. Each of two sits in its own frame, so
 * each look's element styles reach only its own specimen.
 */
export const previewPage = (first: Pane, second?: Pane): string => {
  if (second === undefined) return specimen(first);
  const panes = [first, second];
  const frames = panes
    .map(
      (pane) =>
        `<iframe title="${escapeAttribute(pane.label)}" srcdoc="${escapeAttribute(specimen(pane))}"></iframe>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
${head(
  `Look preview: ${panes.map(({ label }) => label).join(" beside ")}`,
  `<style>
body { margin: 0; display: grid; grid-template-columns: 1fr 1fr; }
iframe { display: block; width: 100%; height: 100vh; border: 0; }
iframe + iframe { border-left: 1px solid #8888; }
@media (max-width: 900px) {
  body { grid-template-columns: 1fr; }
  iframe + iframe { border-left: 0; border-top: 1px solid #8888; }
}
</style>`
)}
</head>
<body>
${frames}
</body>
</html>
`;
};

// The specimen's own layout. Beneath `@layer look`, so the look wins wherever both speak; it
// styles only its own classes, from tokens.
const SPECIMEN_CSS = `@layer specimen {
  .specimen {
    box-sizing: border-box;
    max-width: 960px;
    margin: 0 auto;
    padding: calc(var(--look-space) * 6) calc(var(--look-space) * 4);
  }
  .masthead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: calc(var(--look-space) * 2);
    padding-bottom: calc(var(--look-space) * 3);
    border-bottom: 1px solid var(--look-border);
  }
  .logo { display: block; height: 32px; width: auto; max-width: 100%; }
  .wordmark { font-family: var(--look-font-display); font-size: 1.25rem; font-weight: 700; color: var(--look-fg); }
  .pane-label { display: grid; margin-left: auto; text-align: right; color: var(--look-muted); }
  .pane-label strong { color: var(--look-fg); }
  .about { margin: calc(var(--look-space) * 2) 0 calc(var(--look-space) * 6); color: var(--look-muted); font-size: 0.875rem; }
  .specimen > section { margin-bottom: calc(var(--look-space) * 8); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--look-space) * 2); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: calc(var(--look-space) * 4); align-items: start; }
  .muted { color: var(--look-muted); }
  .card { background: var(--look-surface); border: 1px solid var(--look-border); border-radius: var(--look-radius); padding: calc(var(--look-space) * 3); }
  .stat { font-family: var(--look-font-display); font-size: 2rem; line-height: 1.1; color: var(--look-fg); }
  .badge {
    --tone: var(--look-muted);
    display: inline-block;
    padding: 0 var(--look-space);
    border: 1px solid color-mix(in srgb, var(--tone) 35%, transparent);
    border-radius: var(--look-radius);
    background: color-mix(in srgb, var(--tone) 10%, transparent);
    color: var(--tone);
    font-size: 0.8125rem;
    white-space: nowrap;
  }
  .badge.success { --tone: var(--look-success); }
  .badge.warning { --tone: var(--look-warning); }
  .badge.danger { --tone: var(--look-danger); }
  .scroll { overflow-x: auto; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .stack { display: grid; gap: calc(var(--look-space) * 3); }
  .field { display: grid; gap: calc(var(--look-space) / 2); }
  .error { margin: 0; color: var(--look-danger); }
  .empty { text-align: center; padding: calc(var(--look-space) * 8) calc(var(--look-space) * 3); border: 1px dashed var(--look-border); border-radius: var(--look-radius); }
  .states { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); gap: calc(var(--look-space) * 3); align-items: end; }
  .state { display: grid; gap: var(--look-space); justify-items: start; }
  .state > small { color: var(--look-muted); }
  .state.wide { grid-column: 1 / -1; }
  .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(140px, 100%), 1fr)); gap: calc(var(--look-space) * 2); }
  .swatch { border: 1px solid var(--look-border); border-radius: var(--look-radius); overflow: hidden; font-size: 0.8125rem; }
  .swatch > div { height: 48px; }
  .swatch > code { display: block; padding: var(--look-space); }
  @media (max-width: 600px) {
    .specimen { padding: calc(var(--look-space) * 3) calc(var(--look-space) * 2); }
  }
}`;

// What the specimen shows, from #547: headings, text with a link and muted meta, primary and
// disabled buttons, stat cards and a badge per status, a table, a form with an invalid field,
// an empty state, the states row and colour swatches. Long labels and non-Latin names are on
// purpose: they show how the look's fonts and fallbacks hold up.
const SPECIMEN_BODY = `  <section>
    <h1>Vendor spend, third quarter</h1>
    <p>Every vendor above $1,000 this quarter, with who owns the relationship. Totals update when finance closes the month. Read the <a href="#policy">spending policy</a> before adding a vendor.</p>
    <p><small class="muted">Updated 6 October by Maya Chen</small></p>
    <h2>Second-level heading</h2>
    <h3>Third-level heading</h3>
    <h4>Fourth-level heading</h4>
    <p>Body text runs at the brand's reading size. <strong>Strong text</strong> sits inside it, and so does a <a href="#link">link to another page</a>.</p>
  </section>

  <section class="row">
    <button type="button">Approve request</button>
    <button type="button" disabled>Disabled</button>
    <a href="#vendors">See all vendors</a>
  </section>

  <section class="grid">
    <div class="card">
      <small class="muted">Waiting on a decision</small>
      <div class="stat">4 · $3,792</div>
      <p class="muted">Oldest asked 6 days ago.</p>
      <span class="badge">Pending</span>
    </div>
    <div class="card">
      <small class="muted">Approved this month</small>
      <div class="stat">$3,759</div>
      <p class="muted">Three requests, one over budget.</p>
      <div class="row">
        <span class="badge success">Approved</span>
        <span class="badge warning">Over budget</span>
        <span class="badge danger">1 rejected</span>
      </div>
    </div>
    <div class="card">
      <h3>Figma seats renewal</h3>
      <p class="muted">Maya Chen asked 2 days ago · Software</p>
      <div class="row">
        <button type="button">Approve</button>
        <a href="#reject">Reject</a>
      </div>
    </div>
  </section>

  <section id="vendors">
    <h2>Vendors</h2>
    <div class="scroll">
      <table>
        <thead>
          <tr><th>Vendor</th><th>Owner</th><th>Status</th><th class="num">This quarter</th></tr>
        </thead>
        <tbody>
          <tr><td>Harbor Hall International Conference and Events Management</td><td>José Álvarez</td><td><span class="badge success">Approved</span></td><td class="num">$3,200</td></tr>
          <tr><td>Fully</td><td>王秀英</td><td><span class="badge">Pending</span></td><td class="num">$2,150</td></tr>
          <tr><td>Figma</td><td>Nguyễn Thị Hoa</td><td><span class="badge warning">Due Friday</span></td><td class="num">$1,440</td></tr>
          <tr><td>React Summit</td><td>أحمد الفارسي</td><td><span class="badge danger">Rejected</span></td><td class="num">$1,180</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="grid">
    <form class="stack" action="#">
      <h3>New request</h3>
      <div class="field">
        <label for="purpose">What it's for, in words someone in finance will understand</label>
        <input id="purpose" value="Conference tickets" />
      </div>
      <div class="field">
        <label for="category">Category</label>
        <select id="category"><option>Events</option><option>Software</option></select>
      </div>
      <div class="field">
        <label for="amount">Amount</label>
        <input id="amount" inputmode="decimal" placeholder="0.00" aria-invalid="true" aria-describedby="amount-error" />
        <p class="error" id="amount-error">Enter an amount in dollars.</p>
      </div>
      <div class="field">
        <label for="reason">Reason</label>
        <textarea id="reason" rows="3">Two seats for the design team.</textarea>
      </div>
      <label><input type="checkbox" checked /> Tell the budget owner</label>
      <div class="row">
        <button type="submit">Submit request</button>
        <a href="#cancel">Cancel</a>
      </div>
    </form>
    <div class="empty">
      <h3>No requests yet</h3>
      <p class="muted">When someone asks to spend money, it shows up here.</p>
      <button type="button">New request</button>
    </div>
  </section>

  <section>
    <h2>States</h2>
    <div class="states">
      <div class="state"><button type="button">Resting</button><small>Button</small></div>
      <div class="state"><button type="button" class="specimen-hover">Hover</button><small>Button, hover</small></div>
      <div class="state"><button type="button" class="specimen-focus">Focus</button><small>Button, keyboard focus</small></div>
      <div class="state"><button type="button" disabled>Disabled</button><small>Button, disabled</small></div>
      <div class="state"><button type="button" aria-busy="true">Saving…</button><small>Button, busy</small></div>
      <div class="state wide"><button type="button">Approve and notify the vendor's finance contact</button><small>Button, long label</small></div>
      <div class="state"><a href="#resting">Resting link</a><small>Link</small></div>
      <div class="state"><a href="#hover" class="specimen-hover">Hovered link</a><small>Link, hover</small></div>
      <div class="state"><a href="#focus" class="specimen-focus">Focused link</a><small>Link, keyboard focus</small></div>
      <div class="state"><input aria-label="Resting field" value="Resting" /><small>Field</small></div>
      <div class="state"><input aria-label="Focused field" class="specimen-focus" value="Focus" /><small>Field, focus</small></div>
      <div class="state"><input aria-label="Invalid field" aria-invalid="true" value="Invalid" /><small>Field, invalid</small></div>
      <div class="state"><input aria-label="Disabled field" disabled value="Disabled" /><small>Field, disabled</small></div>
    </div>
  </section>

  <section>
    <h2>Colours</h2>
    <div class="swatches">
${(
  [
    "bg",
    "surface",
    "fg",
    "muted",
    "link",
    "success",
    "warning",
    "danger",
    "accent",
    "accent-fg",
    "border"
  ] satisfies LookToken[]
)
  .map(
    (token) =>
      `      <div class="swatch"><div style="background: var(--look-${token})"></div><code>${token}</code></div>`
  )
  .join("\n")}
    </div>
  </section>`;
