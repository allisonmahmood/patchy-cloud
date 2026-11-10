import { describe, expect, it } from "vitest";
import { pageFindings, rawValues } from "./ui-report.js";

describe("the UI report", () => {
  it("finds raw type, colour, radius and shadow values, and leaves geometry and tokens alone", () => {
    const css = `
      .a { font-size: 13px; color: #123456; border-radius: 4px; box-shadow: 0 2px 0 var(--ink); height: 37px; }
      .b { font: var(--text-body); color: var(--ink); border: 1px solid var(--border); gap: 8px; width: 240px; }
      /* .c { font-size: 99px; } */`;
    expect(rawValues("demo", css).map((finding) => finding.what)).toEqual([
      "font-size: 13px",
      "color: #123456",
      "border-radius: 4px",
      "box-shadow: 0 2px 0 var(--ink)",
      "height: 37px"
    ]);
  });

  it("finds weights and line heights of any kind, named colours and side border colours", () => {
    const css =
      ".btn { font-weight: 650; line-height: 1.1; color: red; border-top-color: #f00; background: transparent; }";
    expect(rawValues("buttons", css).map((finding) => finding.what)).toEqual([
      "font-weight: 650",
      "line-height: 1.1",
      "color: red",
      "border-top-color: #f00"
    ]);
  });

  it("finds page styles and hand-drawn components, but not hidden protocol inputs", () => {
    const source = `pageResponse({ styles: x }); \`<button class="btn btn-primary">\`; \`<input type="hidden" class="field" name="t">\`; \`<input class="field" name="n">\`;`;
    expect(pageFindings("page.ts", source).map((finding) => finding.what)).toEqual([
      "passes styles to pageResponse ×1",
      "draws a button ×1",
      "draws a field ×1"
    ]);
    // Bare controls with no shared class at all still count.
    expect(
      pageFindings("bare.ts", '<button type="submit">Save</button><input name="x">').map(
        (finding) => finding.what
      )
    ).toEqual(["draws a button ×1", "draws a field ×1"]);
    // A group of buttons lays them out; only the link drawn as a button counts.
    expect(
      pageFindings(
        "group.ts",
        '<div class="btn-group"><a class="btn btn-sm" href="/x">Open</a></div><span class="btn-group-end"></span>'
      ).map((finding) => finding.what)
    ).toEqual(["draws a button ×1"]);
  });
});
