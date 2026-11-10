import { describe, expect, it } from "vitest";
import { appStyles } from "../styles/index.js";
import {
  button,
  choiceGroup,
  dialog,
  doorPage,
  field,
  galleryPage,
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
  table,
  tabs
} from "./index.js";

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

  it("keeps a secret's Show hidden for the enhancer, so without script it stays masked", () => {
    const html = secretInput(
      { id: "key", describedBy: undefined, invalid: false },
      { name: "key" }
    );
    expect(html).toContain('type="password"');
    expect(html).toMatch(/<button[^>]*data-show="key"[^>]*hidden>Show<\/button>/);
  });
});

describe("buttons", () => {
  it("draw each kind and say a pending press can't be repeated", () => {
    expect(button("Save", { kind: "primary", size: "sm" })).toBe(
      '<button class="btn btn-primary btn-sm" type="submit">Save</button>'
    );
    expect(button("Testing…", { kind: "primary", pending: true })).toContain(
      'aria-disabled="true"'
    );
    expect(linkButton("Cancel", "/x", { kind: "quiet" })).toBe(
      '<a class="btn btn-quiet" href="/x">Cancel</a>'
    );
  });

  it("post a switch as a one-button form carrying its state", () => {
    expect(switchForm({ action: "/s", label: "Agents use patches", checked: true })).toBe(
      '<form method="post" action="/s"><button class="switch" type="submit" role="switch" aria-checked="true" aria-label="Agents use patches"></button></form>'
    );
  });
});

describe("structure", () => {
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

  it("keeps a state table for every component a page composes, and the type and colour reference", () => {
    const system = galleryPage("").body;
    for (const component of [
      "Button",
      "Field",
      "Choice",
      "Switch",
      "Status",
      "Receipt",
      "Empty state",
      "Notice",
      "Tabs, segmented, chips",
      "Row",
      "Table",
      "Menu",
      "Card",
      "Dialog",
      "Disclosure",
      "Marks",
      "Steps",
      "Copy line",
      "Facts",
      "Page header",
      "Section",
      "Setting row"
    ])
      expect(system, component).toContain(`aria-label="${component} states"`);
    expect(system).toContain('aria-label="Type roles"');
    expect(system).toContain("<code>--danger-solid</code>");
    // A dialog only its own actions close has no close, as the Final step.
    expect(galleryPage("final").overlay).not.toMatch(/data-close|aria-label="Close"/);
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
