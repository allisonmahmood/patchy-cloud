import { describe, expect, it } from "vitest";
import { commandGroup, commandIcon, commandList, commandRow, kbd } from "./command-list.js";
import { htmlPage, shellStyles } from "./html.js";
import { patchMark } from "./patch-marks.js";

describe("the command list", () => {
  it("is a combobox field over a listbox, with a live line for no matches", () => {
    const html = commandList({ id: "go-list", label: "Go to", placeholder: "Go to…", rows: "" });
    expect(html).toBe(
      '<div class="command"><label class="field field-group command-field"><span class="glyph glyph-sm" aria-hidden="true"></span><input type="text" role="combobox" aria-label="Go to" aria-expanded="true" aria-controls="go-list" aria-autocomplete="list" placeholder="Go to…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"></label><p class="command-empty" id="go-list-empty" role="status"></p><div class="command-list" id="go-list" role="listbox" aria-label="Go to"></div></div>'
    );
  });

  it("draws a row as a link that is an option, the lit one with its ↵ keycap", () => {
    const row = {
      id: "row-0",
      href: "/northsound/sales-hq",
      mark: patchMark("sales-hq", 2),
      title: "Sales HQ",
      detail: "1 h"
    };
    const lit = commandRow(row, true);
    expect(lit).toMatch(
      /^<a class="command-row" role="option" id="row-0" href="\/northsound\/sales-hq" tabindex="-1" aria-selected="true"><span class="mono[^"]*" aria-hidden="true">SH<\/span><span class="command-title">Sales HQ<\/span><span class="command-detail">1 h<\/span><kbd class="kbd kbd-sm" aria-hidden="true"><svg [^>]*>.*<\/svg><\/kbd><\/a>$/
    );
    expect(commandRow(row)).toContain('aria-selected="false"');
    expect(commandRow(row)).not.toContain("<kbd");
    expect(commandRow({ ...row, detail: undefined })).not.toContain("command-detail");
    // What's new's dot is named for assistive tech.
    expect(commandRow({ ...row, dot: "New changes" })).toContain(
      '<span class="command-title">Sales HQ<span class="whats-new-dot" role="img" aria-label="New changes"></span></span>'
    );
  });

  it("groups rows under a label that names the group", () => {
    expect(commandGroup({ id: "g1", label: "This patch", rows: "<a></a>" })).toBe(
      '<div class="command-group" role="group" aria-labelledby="g1"><p class="shelf-label command-head" id="g1" role="presentation">This patch</p><a></a></div>'
    );
    expect(commandGroup({ id: "g2", label: "Patchy", rows: "", patchy: true })).toContain(
      '<p class="shelf-label command-head command-head-patchy" id="g2" role="presentation"><span class="glyph glyph-sm" aria-hidden="true"></span>Patchy</p>'
    );
  });

  it("escapes every title, detail, label, id and address", () => {
    const html = [
      commandRow(
        {
          id: 'r"><b>',
          href: '/x" onclick="alert(1)',
          mark: commandIcon("<svg></svg>"),
          title: "<img src=x onerror=alert(1)>",
          detail: "<b>Pine & Co</b>",
          dot: '"><b>'
        },
        true
      ),
      commandGroup({ id: "g'<b>", label: "<script>alert(2)</script>", rows: "" }),
      commandList({ id: 'l"<b>', label: "<b>Go</b>", placeholder: '"><b>', rows: "" })
    ].join("");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;Pine &amp; Co&lt;/b&gt;");
    expect(html).toContain('href="/x&quot; onclick=&quot;alert(1)"');
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).not.toMatch(/<(img|script|b)\b/);
    expect(html).not.toMatch(/ on\w+="/);
  });

  it("keeps a keycap's glyph as given, hidden from assistive tech", () => {
    expect(kbd("<svg></svg>")).toBe('<kbd class="kbd" aria-hidden="true"><svg></svg></kbd>');
  });

  it("is drawn by the shell's shared styles, on app pages and over a patch alike", () => {
    for (const selector of [
      ".kbd {",
      ".kbd-sm {",
      ".command, .command * { box-sizing: border-box; }",
      ".command-field.field {",
      '.command-row[aria-selected="true"] {',
      ".command-head.shelf-label {",
      ".command-empty {",
      ".switcher[open] {",
      ".mono {",
      ".page-mark {",
      ".shelf-label {",
      ".tag {",
      "mark {",
      ".whats-new-dot {",
      ".field {",
      ".field-group {"
    ])
      expect(shellStyles).toContain(selector);
    expect(htmlPage({ title: "Home", body: "" })).toContain(shellStyles);
  });
});
