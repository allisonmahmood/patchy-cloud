import { describe, expect, it } from "vitest";
import { checklist } from "./index.js";

describe("checklist", () => {
  it("labels each box with its row, ties its line and the group's error to it, and escapes", () => {
    const html = checklist({
      id: "retire",
      legend: "Which to retire",
      name: "patch",
      error: "Select at least one.",
      items: [
        { value: "p1", label: "<b>Kudos</b>", description: "Read by Spend", checked: true },
        { value: "p2", label: "Rota", disabled: true }
      ]
    });
    expect(html).toContain("&lt;b&gt;Kudos&lt;/b&gt;");
    // Refused, the group's first box that can be chosen takes the focus.
    expect(html).toMatch(
      /<label class="row checkrow"><input [^>]*name="patch" value="p1" checked aria-describedby="retire-0-description retire-error" aria-invalid="true" autofocus>/
    );
    expect(html).toContain('<span class="row-desc" id="retire-0-description">Read by Spend</span>');
    expect(html).toMatch(/value="p2" disabled aria-describedby="retire-error"/);
    // The order of the field family: legend, the boxes, then the error.
    expect(html.indexOf("<legend")).toBeLessThan(html.indexOf("<input"));
    expect(html.lastIndexOf("<input")).toBeLessThan(html.indexOf('id="retire-error"'));
  });

  it("focuses its error when a refused group has no box left to choose", () => {
    const html = checklist({
      id: "retire",
      legend: "Which to retire",
      name: "patch",
      error: "Select at least one.",
      items: [{ value: "p1", label: "Rota", disabled: true }]
    });
    expect(html).not.toMatch(/<input[^>]*autofocus/);
    expect(html).toContain(
      '<p class="field-error" id="retire-error" tabindex="-1" autofocus>Select at least one.</p>'
    );
  });

  it("describes nothing and refuses nothing without a line, hint or error", () => {
    const html = checklist({
      id: "pick",
      legend: "Pick",
      name: "x",
      items: [{ value: "a", label: "A" }]
    });
    expect(html).not.toMatch(/aria-describedby|aria-invalid|autofocus|field-hint|field-error/);
  });
});
