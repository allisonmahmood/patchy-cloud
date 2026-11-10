import { describe, expect, it } from "vitest";
import { chipMenu, codeRow, groupedTable, person, refusalNotice, settingsPanel } from "./detail.js";

describe("chipMenu", () => {
  it("opens a popover of links, the current one marked, its key and value escaped", () => {
    const html = chipMenu({
      id: "log-outcome",
      key: "Outcome",
      value: "<Failed>",
      on: true,
      choices: [
        { label: "Any", href: "/log" },
        { label: "<Failed>", href: "/log?outcome=failed&x=1", current: true }
      ]
    });
    expect(html).toContain(
      '<button class="chip chip-menu chip-on" type="button" popovertarget="menu-log-outcome"><span class="chip-key">Outcome</span>&lt;Failed&gt;'
    );
    expect(html).toContain('<div class="menu" id="menu-log-outcome" popover aria-label="Outcome">');
    expect(html).toContain('<a class="menu-item" href="/log">Any</a>');
    expect(html).toContain(
      '<a class="menu-item" href="/log?outcome=failed&amp;x=1" aria-current="true">&lt;Failed&gt;</a>'
    );
  });
});

describe("groupedTable", () => {
  const html = groupedTable({
    label: "Log entries",
    compact: true,
    columns: [{ label: "Time" }, { label: "Duration", align: "end", hideOnPhone: true }],
    groups: [
      {
        label: "Today",
        rows: [
          {
            id: "entry-1",
            cells: ["14:02", "12 ms"],
            expand: { summary: "2 calls", body: "<ol></ol>", open: true }
          },
          { id: "entry-2", cells: ["13:00", "8 ms"] }
        ]
      },
      { label: "Yesterday", rows: [{ cells: ["09:00", "1 s"] }] }
    ]
  });

  it("puts each group in its own row group under a heading cell", () => {
    expect(html).toContain(
      '<table class="table table-grouped table-compact" aria-label="Log entries">'
    );
    expect(html.match(/<tbody>/g)).toHaveLength(2);
    expect(html).toContain(
      '<tr class="group-row"><th scope="rowgroup" colspan="2">Today</th></tr>'
    );
    expect(html).toContain('<td class="r hide-sm">12 ms</td>');
  });

  it("names an expanding row's disclosure, so a permalink opens it, and a plain row itself", () => {
    expect(html).toContain(
      '<tr><td>14:02</td><td class="r hide-sm">12 ms</td></tr><tr class="table-expand"><td colspan="2"><details id="entry-1" open><summary>2 calls</summary><ol></ol></details></td></tr>'
    );
    expect(html).toContain('<tr id="entry-2"><td>13:00</td>');
    expect(html).toContain("<tr><td>09:00</td>");
  });
});

describe("settingsPanel", () => {
  it("holds its cards, the danger zone set apart last", () => {
    expect(settingsPanel({ cards: ["<a>", "<b>"], danger: "<c>" })).toBe(
      '<div class="settings-panel"><a><b><div class="card-gap"><c></div></div>'
    );
    expect(settingsPanel({ cards: ["<a>"] })).toBe('<div class="settings-panel"><a></div>');
  });
});

describe("refusalNotice", () => {
  it("is a danger notice in a frame that takes focus, escaped", () => {
    expect(refusalNotice("Nothing <was> done.")).toMatch(
      /^<div class="refusal" tabindex="-1" autofocus><div class="notice notice-danger" role="alert">.*<p class="notice-title">Nothing &lt;was&gt; done\.<\/p><\/div><\/div>$/
    );
  });
});

describe("person", () => {
  it("puts a small mark before the escaped name", () => {
    expect(person("usr_1", "Ada & Co")).toMatch(
      /^<span class="person"><span class="avatar av-sm[^"]*" aria-hidden="true">AC<\/span>Ada &amp; Co<\/span>$/
    );
  });
});

describe("codeRow", () => {
  it("sets its name in the code face, escaped, with its description and end", () => {
    expect(codeRow({ name: "<moveDeal>", description: "Moves a deal", end: "<b>x</b>" })).toBe(
      '<div class="row row-plain"><div class="row-main"><span class="row-name code">&lt;moveDeal&gt;</span><span class="row-desc">Moves a deal</span></div><div class="row-end"><b>x</b></div></div>'
    );
  });
});
