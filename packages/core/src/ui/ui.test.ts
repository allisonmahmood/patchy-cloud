import { describe, expect, it } from "vitest";
import * as Components from "../components.js";
import * as CopyLine from "../copy-line.js";
import { appStyles } from "../styles/index.js";
import * as Ui from "./index.js";
import {
  button,
  choiceGroup,
  copyButton,
  dialog,
  disclosure,
  doorPage,
  field,
  galleryPage,
  type GalleryPage,
  galleryPages,
  idFor,
  indexPage,
  input,
  linkButton,
  menu,
  notice,
  prefixInput,
  radio,
  secretInput,
  settingsPage,
  steps,
  switchForm,
  row,
  table,
  tabs,
  unopenedName
} from "./index.js";

/** Exports that draw nothing a page shows: the enhancer and copy scripts, the gallery and ids. */
const notDrawn = [
  "uiScript",
  "uiScriptPath",
  "uiScriptTag",
  "copyScript",
  "copyScriptPath",
  "galleryPage",
  "galleryPages",
  "galleryPath",
  "idFor"
] as const;

/** Where the gallery shows a part: the state table holding its states, or a page of its own. */
type Shown = string | { readonly page: GalleryPage };

/**
 * Where the gallery shows each part core gives pages. The compiler fails a new export missing
 * from it, and the gallery test fails a table or page the gallery doesn't draw, so a helper
 * arrives with its states.
 */
const shownAt = {
  button: "Button",
  linkButton: "Button",
  iconButton: "Button",
  icon: "Button",
  field: "Field",
  input: "Field",
  prefixInput: "Field",
  secretInput: "Field",
  select: "Field",
  textarea: "Field",
  checkbox: "Choice",
  radio: "Choice",
  choiceGroup: "Choice",
  choiceCards: "Choice",
  tileOptions: "Choice",
  switchForm: "Switch",
  copyLine: "Copy line",
  checklist: "Checklist",
  searchField: "Search field",
  fieldRow: "Field row",
  copyButton: "Copy button",
  badge: "Status",
  dot: "Status",
  unopenedName: "Status",
  notice: "Notice",
  receipt: "Receipt",
  emptyState: "Empty state",
  refusal: "Refusal",
  refusalNotice: "Refusal",
  tabs: "Tabs, segmented, chips",
  segmented: "Tabs, segmented, chips",
  chip: "Tabs, segmented, chips",
  row: "Row",
  rows: "Row",
  table: "Table",
  expandingTable: "Expanding table",
  groupedTable: "Grouped table",
  chipMenu: "Chip menu",
  menu: "Menu",
  rowMenu: "Menu",
  menuLink: "Menu",
  menuPost: "Menu",
  menuCopy: "Menu",
  menuNewTab: "Menu",
  menuRule: "Menu",
  facts: "Facts",
  person: "Person and code row",
  codeRow: "Person and code row",
  settingsPanel: "Settings panel",
  pageHeader: "Page header",
  section: "Section",
  settingRow: "Setting row",
  card: "Card",
  dialog: "Dialog",
  disclosure: "Disclosure",
  changeEntry: "Change",
  behindTheScenes: "Change",
  steps: "Steps",
  region: "Region",
  attentionRow: "Attention row",
  usualTiles: "Usual tile",
  directoryCards: "Directory card",
  choiceLinks: "Choice link",
  canList: "Can list",
  flowOutcome: "Flow outcome",
  patchMark: "Marks",
  monogram: "Marks",
  avatar: "Marks",
  agentMark: "Marks",
  productMark: "Product mark",
  computerMark: "Computer mark",
  doorCard: "Door",
  verificationCode: "Verification code",
  meet: "Meet",
  answerPair: "Answer pair",
  indexPage: { page: "index" },
  detailPage: { page: "detail" },
  settingsPage: { page: "settings" },
  flowPage: { page: "flow" },
  doorPage: { page: "door" }
} satisfies Record<
  Exclude<
    keyof typeof Ui | keyof typeof Components | keyof typeof CopyLine,
    (typeof notDrawn)[number]
  >,
  Shown
>;

describe("the field family", () => {
  it("orders label, hint, control and error, and ties the hint and error to the control", () => {
    const html = field({
      id: "handle",
      label: "Name",
      hint: "Patches use this name.",
      error: "Lowercase letters only.",
      control: (aria) => prefixInput(aria, { name: "handle", prefix: "attio/" })
    });
    const order = ["<label", 'id="handle-hint"', "<input", 'id="handle-error"'].map((part) =>
      html.indexOf(part)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('for="handle"');
    expect(html).toContain('aria-describedby="handle-hint handle-error"');
    expect(html).toContain('aria-invalid="true"');
    // The prefix is a second label for the same input.
    expect(html.match(/for="handle"/g)).toHaveLength(2);
  });

  it("describes nothing and refuses nothing when there is no hint or error", () => {
    const html = field({
      id: "name",
      label: "Name",
      control: (aria) => input(aria, { name: "name" })
    });
    expect(html).not.toMatch(/aria-describedby|aria-invalid|field-hint|field-error/);
  });

  it("escapes every text slot", () => {
    const html = field({
      id: "x",
      label: "<b>Name</b>",
      hint: "<i>hint</i>",
      error: "<script>",
      control: (aria) => input(aria, { name: "x", value: '"><img src=x>' })
    });
    expect(html).not.toMatch(/<(b|i|script|img)\b/);
  });

  it("marks a refused choice group invalid, and each choice drawn from it", () => {
    const html = choiceGroup({
      id: "role",
      legend: "Role",
      error: "Pick one.",
      choices: (aria) =>
        `${radio({ name: "role", value: "member", label: "Member", aria })}${radio({ name: "role", value: "admin", label: "Admin", aria })}`
    });
    expect(html).toMatch(
      /<fieldset class="fieldset" id="role" aria-describedby="role-error" aria-invalid="true">/
    );
    expect(
      html.match(/<input[^>]*aria-describedby="role-error" aria-invalid="true">/g)
    ).toHaveLength(2);
  });

  it("draws a hint's live part as what was submitted, or its example, escaped", () => {
    const hint = (value: string) =>
      field({
        id: "handle",
        label: "Name",
        hint: [
          "Patches use it as attio/",
          { value, fallback: "crm" },
          ". It can't change <later>."
        ],
        control: (aria) => prefixInput(aria, { name: "handle", prefix: "attio/", value })
      });
    expect(hint("")).toContain(
      `<p class="field-hint" id="handle-hint">Patches use it as attio/<span data-echo="handle" data-fallback="crm">crm</span>. It can't change &lt;later&gt;.</p>`
    );
    expect(hint("  sales ")).toContain('data-fallback="crm">sales</span>');
    expect(hint('<b>"x"</b>')).toContain(
      'data-fallback="crm">&lt;b&gt;&quot;x&quot;&lt;/b&gt;</span>'
    );
  });

  it("keeps a secret's Show hidden for the enhancer, so without script it stays masked", () => {
    const html = secretInput(
      { id: "key", describedBy: undefined, invalid: false },
      { name: "key" }
    );
    expect(html).toContain('type="password"');
    expect(html).toMatch(/<button[^>]*data-show="key"[^>]*hidden>Show<\/button>/);
  });
});

describe("directory cards", () => {
  it("escapes destination text and URLs while keeping decorative previews out of the link name", () => {
    const html = Ui.directoryCards([
      {
        name: "Design <studio>",
        href: '/teams?name="design"&active=1',
        meta: "4 people & collaborators",
        mark: "<span>mark</span>",
        preview: "<span>AP</span>",
        action: "Open <team>"
      }
    ]);
    expect(html).toContain("Design &lt;studio&gt;");
    expect(html).toContain('href="/teams?name=&quot;design&quot;&amp;active=1"');
    expect(html).toContain("4 people &amp; collaborators");
    expect(html).toContain('class="directory-card-preview" aria-hidden="true"><span>AP</span>');
    expect(html).toContain("Open &lt;team&gt;");
  });
});

describe("buttons", () => {
  it("escapes native submit overrides for a POST save inside a GET search form", () => {
    expect(
      button("Add", { formAction: '/teams/add?name="<studio>"&team=1', formMethod: "post" })
    ).toContain(
      'formaction="/teams/add?name=&quot;&lt;studio&gt;&quot;&amp;team=1" formmethod="post"'
    );
    expect(button("Search")).not.toContain("formmethod");
  });
  it("draw each kind and say a pending press can't be repeated", () => {
    expect(button("Save", { kind: "primary", size: "sm" })).toBe(
      '<button class="btn btn-primary btn-sm" type="submit">Save</button>'
    );
    expect(button("Testing…", { kind: "primary", pending: true })).toContain(
      'aria-disabled="true"'
    );
    // What a submit says once pressed rides along for the enhancer; at rest it is the label.
    expect(button("Test and connect", { kind: "primary", pendingLabel: "Testing…" })).toBe(
      '<button class="btn btn-primary" type="submit" data-pending="Testing…"><span>Test and connect</span></button>'
    );
    expect(linkButton("Cancel", "/x", { kind: "quiet" })).toBe(
      '<a class="btn btn-quiet" href="/x">Cancel</a>'
    );
  });

  it("copy waits hidden for the copy script and names what it copies", () => {
    expect(
      copyButton('https://x.example/a?b="c"', {
        kind: "quiet",
        size: "sm",
        ariaLabel: "Copy the link to Kudos"
      })
    ).toBe(
      '<button class="btn btn-quiet btn-sm copy-button" type="button" data-copy="https://x.example/a?b=&quot;c&quot;" aria-label="Copy the link to Kudos" aria-live="polite" hidden>Copy</button>'
    );
    expect(copyButton("x", { label: "Copy link" })).toBe(
      '<button class="btn copy-button" type="button" data-copy="x" aria-live="polite" hidden>Copy link</button>'
    );
  });

  it("post a switch as a one-button form carrying its state", () => {
    expect(switchForm({ action: "/s", label: "Agents use patches", checked: true })).toBe(
      '<form method="post" action="/s"><button class="switch" type="submit" role="switch" aria-checked="true" aria-label="Agents use patches"></button></form>'
    );
  });
});

describe("structure", () => {
  it("keeps the not-opened-yet dot with a name's last character, inside its link, escaped", () => {
    const dot = '<span class="unseen" role="img" aria-label="Not opened yet"></span>';
    expect(unopenedName("Client onboarding")).toBe(
      `Client onboardin<span class="unopened">g${dot}</span>`
    );
    expect(unopenedName("Office <map> ")).toBe(
      `Office &lt;map<span class="unopened">&gt;${dot}</span>`
    );
    // A last character drawn from several code points stays whole.
    expect(unopenedName("Desk 👩‍💻")).toBe(`Desk <span class="unopened">👩‍💻${dot}</span>`);
    expect(row({ name: "Kudos", href: "/kudos", unopened: true })).toContain(
      `<a class="row-link" href="/kudos">${unopenedName("Kudos")}</a>`
    );
    expect(row({ name: "Kudos", href: "/kudos" })).toContain(
      '<a class="row-link" href="/kudos">Kudos</a>'
    );
  });

  it("gives repeated rows distinct ids, whatever their keys hold", () => {
    expect(idFor("menu", "kudos")).toBe("menu-kudos");
    const keys: ReadonlyArray<ReadonlyArray<string>> = [
      ["menu", "a/b"],
      ["menu", "a-b"],
      ["menu", "A"],
      ["menu", "a"],
      ["a-b", "c"],
      ["a", "b-c"],
      ["menu", ""],
      ["menu", "~"],
      ["menu", "_2f_"]
    ];
    const ids = keys.map((parts) => idFor(...parts));
    expect(new Set(ids).size).toBe(keys.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_~-]+$/);
  });

  it("draws a menu as a native popover of links and buttons, not an ARIA menu", () => {
    const html = menu({
      id: "kudos",
      label: "Kudos",
      items: [
        { kind: "link", label: "Open", href: "/kudos" },
        { kind: "post", label: "Retire", action: "/kudos/retire", danger: true },
        { kind: "rule" }
      ]
    });
    expect(html).toContain('popovertarget="menu-kudos"');
    expect(html).toContain('id="menu-kudos" popover');
    expect(html).not.toMatch(/role="menu/);
    expect(html).toContain('<form method="post" action="/kudos/retire">');
  });

  it("marks the current tab and names the strip", () => {
    const html = tabs({
      label: "Kudos",
      current: "Log",
      items: [
        { label: "Overview", href: "/a" },
        { label: "Log", href: "/b", count: 2 }
      ]
    });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain(
      '<a class="tab" href="/b" aria-current="page">Log<span class="count">2</span></a>'
    );
  });

  it("names a table and hides a menu column's header from sight, not from readers", () => {
    const html = table({
      label: "People",
      columns: [{ label: "Person" }, { label: "Actions", hidden: true }],
      rows: [["Ada", ""]]
    });
    expect(html).toContain('aria-label="People"');
    expect(html).toContain('<span class="sr-only">Actions</span>');
  });

  it("marks a growing column and a column of sentences, which keep their floors", () => {
    const html = table({
      label: "Patches that need attention",
      columns: [
        { label: "Patch", grow: true },
        { label: "Why it’s here", readable: true }
      ],
      rows: [["Kudos", "Its owner is deactivated"]]
    });
    expect(html).toContain('<td class="cell-grow">Kudos</td><td class="cell-readable">');
  });

  it("draws a dialog over its page, closable back to it unless only its actions may close it", () => {
    const html = dialog({
      id: "invite",
      title: "Invite people",
      body: "<p>x</p>",
      closeHref: "/people"
    });
    expect(html).toMatch(
      /role="dialog" aria-modal="true" aria-labelledby="invite-title" data-dialog data-close="\/people"/
    );
    expect(html).toContain('<a class="btn btn-icon" href="/people" aria-label="Close">');
    const final = dialog({ id: "final", title: "Final step", body: "" });
    expect(final).not.toMatch(/data-close|aria-label="Close"/);
  });

  it("numbers setup steps and marks the current one", () => {
    const html = steps([
      { title: "One", state: "done" },
      { title: "Two", state: "current" },
      { title: "Three", state: "later" }
    ]);
    expect(html).toContain(
      '<li class="step step-current" aria-current="step"><span class="step-marker" aria-hidden="true">2</span>'
    );
    expect(html).toContain(
      '<li class="step"><span class="step-marker" aria-hidden="true">3</span>'
    );
  });

  it("gives a notice the role its tone needs", () => {
    expect(notice({ tone: "danger", title: "Refused" })).toContain('role="alert"');
    expect(notice({ tone: "info", title: "Off" })).toContain('role="status"');
  });
});

describe("templates", () => {
  it("draw their own header at their width, so a page passes no heading of its own", () => {
    const index = indexPage({ title: "People", content: "<p>rows</p>" });
    expect(index.heading).toBe("");
    expect(index.body).toMatch(/^<div class="page"><header class="ph">/);
    expect(index.body.match(/<h1\b/g)).toHaveLength(1);
    expect(settingsPage({ title: "Agent access", cards: [] }).body).toMatch(
      /^<div class="page page-settings">/
    );
  });

  it("give a door its kicker and title for the door's own frame", () => {
    const door = doorPage({
      kicker: "Device login",
      title: "Is this your computer?",
      body: "<p>x</p>"
    });
    expect(door.heading).toBe(
      '<p class="kicker">Device login</p><h1 class="page-heading">Is this your computer?</h1>'
    );
    expect(door.body).toBe('<div class="door-body"><p>x</p></div>');
  });
});

describe("the gallery", () => {
  it("draws every page from the system, with no styles or inline style of its own", () => {
    for (const page of galleryPages) {
      const content = galleryPage(page);
      expect(`${content.body}${content.overlay ?? ""}`).not.toMatch(/<style\b|\sstyle="/);
      // One h1 a page: the template's own, or the door's in its heading.
      expect(`${content.heading}${content.body}`.match(/<h1\b/g), page).toHaveLength(1);
    }
    expect(galleryPage("dialog").overlay).toContain("data-dialog");
  });

  it("keeps the type and colour reference, and draws doors and the Final step as they are", () => {
    const system = galleryPage("").body;
    expect(system).toContain('aria-label="Type roles"');
    expect(system).toContain("<code>--danger-solid</code>");
    // A dialog only its own actions close has no close, as the Final step.
    expect(galleryPage("final").overlay).not.toMatch(/data-close|aria-label="Close"/);
    // The doors and the refusal are drawn live from their helpers, each on a page of its own, so
    // the system page's focus never starts on a refusal.
    expect(galleryPage("door").body).toContain('<p class="code-display">WXYZ-1234</p>');
    expect(galleryPage("consent").body).toMatch(/<div class="meet">[\s\S]*<ul class="can">/);
    expect(galleryPage("refused").body).toContain('<div class="refusal" tabindex="-1" autofocus>');
    expect(system).not.toMatch(/<[^>]*\sautofocus[\s>]/);
  });

  it("shows every part core gives pages in a state table or a page of its own", () => {
    const rendered = galleryPages
      .map((page) => {
        const content = galleryPage(page);
        return `${content.body}${content.overlay ?? ""}`;
      })
      .join("");
    const unshown = (shown: Readonly<Record<string, Shown>>) =>
      Object.entries(shown)
        .filter(([, at]) =>
          typeof at === "string"
            ? !rendered.includes(`aria-label="${at} states"`)
            : !galleryPages.includes(at.page)
        )
        .map(([name]) => name);
    expect(unshown(shownAt)).toEqual([]);
    // A part whose table the gallery doesn't draw is caught, wherever else its name appears.
    expect(unshown({ button: "Button", fresh: "Fresh" })).toEqual(["fresh"]);
    // The compiler holds the exports to the inventory; this holds them at run time too.
    expect(
      [...Object.keys(Ui), ...Object.keys(Components), ...Object.keys(CopyLine)].filter(
        (name) => !(name in shownAt) && !notDrawn.some((other) => other === name)
      )
    ).toEqual([]);
  });

  it("draws each state that takes the focus or ends a door, focus where the page puts it", () => {
    const autofocused = (page: (typeof galleryPages)[number]) =>
      [...galleryPage(page).body.matchAll(/<[a-z]+\b[^>]*\sautofocus\b[^>]*>/g)].map(
        ([tag]) => tag
      );
    // A refusal no field owns leads the door and takes the focus; a field's is under the field.
    expect(galleryPage("door-refused").body).toMatch(
      /^<div class="door-body"><div class="refusal" tabindex="-1" autofocus>[\s\S]*code-display/
    );
    const field = autofocused("door-field");
    expect(field).toHaveLength(1);
    expect(field[0]).toMatch(
      /aria-describedby="g-door-name-hint g-door-name-error" aria-invalid="true"/
    );
    expect(galleryPage("door-field").body).toContain(
      '<p class="field-error" id="g-door-name-error">'
    );
    expect(galleryPage("door-outcome").heading).toContain("Go back to your terminal");
    expect(galleryPage("door-unavailable").heading).toContain("Patchy is unavailable");
    // A refused checklist starts on its first box that can be chosen, or on its error.
    const box = autofocused("checklist-refused");
    expect(box).toHaveLength(1);
    expect(box[0]).toMatch(/type="checkbox" name="patch" value="kudos"[^>]* aria-invalid="true"/);
    expect(autofocused("checklist-none")).toEqual([
      '<p class="field-error" id="g-pick-error" tabindex="-1" autofocus>'
    ]);
  });

  it("opens a disclosure in place, its summary escaped", () => {
    expect(disclosure("No <agent>?", "<p>Install one.</p>", { id: "g-d", open: true })).toBe(
      '<details id="g-d" open><summary>No &lt;agent&gt;?</summary><div class="disclosure-body"><p>Install one.</p></div></details>'
    );
  });

  it("uses only classes the stylesheet draws", () => {
    const drawn = new Set(
      [...appStyles.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.([a-z][a-z0-9-]*)/g)].map(
        ([, name]) => name
      )
    );
    const used = new Set(
      galleryPages.flatMap((page) => {
        const content = galleryPage(page);
        return [...`${content.body}${content.overlay ?? ""}`.matchAll(/class="([^"]*)"/g)].flatMap(
          ([, names]) => names!.split(/\s+/).filter((name) => name !== "")
        );
      })
    );
    expect([...used].filter((name) => !drawn.has(name))).toEqual([]);
  });
});
