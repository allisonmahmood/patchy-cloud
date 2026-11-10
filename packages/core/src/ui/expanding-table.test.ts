import { describe, expect, it } from "vitest";
import { expandingTable } from "./expanding-table.js";

describe("expandingTable", () => {
  it("draws each row and, under it, a disclosure across every column", () => {
    const html = expandingTable({
      label: "Calls",
      compact: true,
      wide: true,
      columns: [{ label: "When" }, { label: "Took", align: "end", hideOnPhone: true }],
      rows: [
        {
          cells: ["<time>12:00</time>", "8 ms"],
          detail: { summary: "Details", body: "<p>id</p>" }
        },
        { cells: ["<time>12:01</time>", "9 ms"] }
      ]
    });
    expect(html).toContain('<table class="table table-compact table-wide" aria-label="Calls">');
    expect(html).toContain('<th scope="col" class="r hide-sm">Took</th>');
    expect(html).toContain(
      '<tr><td><time>12:00</time></td><td class="r hide-sm">8 ms</td></tr><tr class="table-expand"><td colspan="2"><details><summary>Details</summary><p>id</p></details></td></tr>'
    );
    // A row without more has no disclosure row.
    expect(html).toContain('<td class="r hide-sm">9 ms</td></tr></tbody>');
  });

  it("escapes its label, headers and summaries", () => {
    const html = expandingTable({
      label: '"><b>',
      columns: [{ label: "<i>", hidden: true }],
      rows: [{ cells: ["x"], detail: { summary: "<s>", body: "" } }]
    });
    expect(html).toContain('aria-label="&quot;&gt;&lt;b&gt;"');
    expect(html).toContain('<span class="sr-only">&lt;i&gt;</span>');
    expect(html).toContain("<summary>&lt;s&gt;</summary>");
  });
});
