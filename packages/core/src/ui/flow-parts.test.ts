import { describe, expect, it } from "vitest";
import { choiceLinks, flowPage, linkButton, productMark } from "./index.js";

describe("a flow's parts", () => {
  it("draws choices as links, the current one marked as the page", () => {
    const html = choiceLinks({
      label: "App",
      current: "Codex",
      items: [
        { label: "Claude", href: "/agents/connect?app=claude", mark: productMark("C") },
        { label: "Codex", href: "/agents/connect?app=codex", mark: productMark("Cx") },
        { label: "<Other>", href: "?app=x&y", mark: productMark("+"), dashed: true }
      ]
    });
    expect(html).toMatch(/^<nav class="choice-links" aria-label="App">/);
    expect(html).toContain('<a class="choice-link" href="/agents/connect?app=claude">');
    expect(html).toContain(
      '<a class="choice-link" href="/agents/connect?app=codex" aria-current="page">'
    );
    expect(html).toContain(
      '<a class="choice-link choice-link-dashed" href="?app=x&amp;y"><span class="im" aria-hidden="true">+</span><span>&lt;Other&gt;</span></a>'
    );
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });

  it("names a link button or a flow's section as a fragment's target", () => {
    expect(linkButton("Add a computer", "/agents/computer", { id: "add-a-computer" })).toBe(
      '<a class="btn" id="add-a-computer" href="/agents/computer">Add a computer</a>'
    );
    expect(linkButton("Done", "/agents")).toBe('<a class="btn" href="/agents">Done</a>');
    const flow = flowPage({
      parent: { label: "Your agents", href: "/agents" },
      title: "Add a computer",
      sections: [
        { id: "add-a-computer", title: "Give your agent this line", body: "" },
        { title: "Confirm it’s you", body: "" }
      ],
      submit: ""
    }).body;
    expect(flow).toContain('<fieldset class="flow-section" id="add-a-computer"><legend');
    expect(flow).toContain('<fieldset class="flow-section"><legend');
  });
});
