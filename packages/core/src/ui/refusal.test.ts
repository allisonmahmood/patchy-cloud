import { describe, expect, it } from "vitest";
import { field, notice, prefixInput, refusal, typedExactly } from "./index.js";

describe("refusals and exact input", () => {
  it("starts the page's focus on a refusal no field owns", () => {
    expect(refusal(notice({ tone: "warning", title: "Changed" }))).toMatch(
      /^<div class="refusal" tabindex="-1" autofocus><div class="notice notice-warning"/
    );
  });

  it("keeps a phone from capitalising what is typed exactly, and only that input", () => {
    const html = field({
      id: "handle",
      label: "Address",
      control: (aria) => typedExactly(prefixInput(aria, { name: "handle", prefix: "acme/" }))
    });
    expect(html.match(/autocapitalize="none" autocorrect="off" spellcheck="false"/g)).toHaveLength(
      1
    );
    expect(html).toContain(
      '<input autocapitalize="none" autocorrect="off" spellcheck="false" class='
    );
  });
});
