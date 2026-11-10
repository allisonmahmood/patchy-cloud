import { describe, expect, it } from "vitest";
import type { RequireSession } from "@patchy/auth";
import { renderAgentAside } from "./render.js";

const viewer = (role: "admin" | "member") =>
  ({
    user: { id: "usr_jordan", email: "jordan@brightline.example", name: "Jordan Lee" },
    company: { id: "cmp_brightline", handle: "brightline", name: "Bright & <Co>" },
    role,
    whatsNewSeen: 0
  }) satisfies RequireSession.Viewer["Service"];

describe("renderAgentAside", () => {
  const tools = [
    { name: "findDeals", kind: "read" as const, description: "Search <b>open</b> deals." },
    { name: "moveDeal", kind: "change" as const, description: "Move one deal." }
  ];
  const admins = [
    { id: "usr_allison", name: "Allison <A>" },
    { id: "usr_jordan", name: "Jordan Lee" },
    { id: "usr_priya", name: "Priya Shah" }
  ];

  it("lists each tool with the first clause of what it does, escaped, then the way to use them", () => {
    const html = renderAgentAside({ tools, viewer: viewer("member"), admins: null, apps: [] });
    expect(html).toContain('<h2 class="section-title">Your agent can, as you</h2>');
    expect(html).toContain(
      '<span class="row-name code">findDeals</span><span class="row-desc">Search &lt;b&gt;open&lt;/b&gt; deals</span></div><div class="row-end"><span class="meta">Reads</span>'
    );
    expect(html).toContain('<span class="row-name code">moveDeal</span>');
    expect(html).toContain('<span class="meta">Changes</span>');
    expect(html).toContain('href="/agents/connect">Use with your agent</a>');
  });

  it("says which of the viewer's own apps are connected in place of the way to connect one", () => {
    const html = renderAgentAside({
      tools,
      viewer: viewer("member"),
      admins: null,
      apps: ["Claude <Code>", "Codex", "Claude <Code>"]
    });
    expect(html).toContain(
      '<span class="dot dot-success">Claude &lt;Code&gt; and Codex are connected</span> · <a href="/agents">Your agents</a>'
    );
    expect(html).not.toContain("Use with your agent");
  });

  it("names every admin while access is off, the viewer first as you, and lets an admin turn it on", () => {
    const html = renderAgentAside({ tools, viewer: viewer("admin"), admins, apps: [] });
    expect(html).toContain(
      "Agent access is off at Bright &amp; &lt;Co&gt;, so no agent can use these yet. Only admins can turn it on: you, Allison &lt;A&gt; and Priya Shah."
    );
    expect(html).toContain('href="/settings/agent-access">Turn it on</a>');
    expect(html).not.toContain("Use with your agent");
  });

  it("gives a member the admins' names without the way to turn it on", () => {
    const html = renderAgentAside({
      tools,
      viewer: viewer("member"),
      admins: admins.filter((admin) => admin.id !== "usr_jordan"),
      apps: []
    });
    expect(html).toContain("Only admins can turn it on: Allison &lt;A&gt; and Priya Shah.");
    expect(html).not.toContain("Turn it on</a>");
    expect(html).not.toContain("Use with your agent");
  });
});
