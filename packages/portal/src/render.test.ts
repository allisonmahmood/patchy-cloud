import { describe, expect, it } from "vitest";
import type { RequireSession } from "@patchy/auth";
import { renderAgentPanel } from "./render.js";

describe("renderAgentPanel", () => {
  const viewer = (role: "admin" | "member") =>
    ({
      user: { id: "usr_jordan", email: "jordan@brightline.example", name: "Jordan Lee" },
      company: { id: "cmp_brightline", handle: "brightline", name: "Bright & <Co>" },
      role,
      whatsNewSeen: 0
    }) satisfies RequireSession.Viewer["Service"];
  const tools = [
    { name: "findDeals", kind: "read" as const, description: "Search <b>open</b> deals." },
    { name: "moveDeal", kind: "change" as const, description: "Move one deal." }
  ];
  const admins = [
    { id: "usr_allison", name: "Allison <A>" },
    { id: "usr_jordan", name: "Jordan Lee" },
    { id: "usr_priya", name: "Priya Shah" }
  ];

  it("lists each tool with its kind and escaped description, then the connect link", () => {
    const html = renderAgentPanel({ tools, viewer: viewer("member"), admins: null });
    expect(html).toContain(
      '<summary><code>findDeals</code><span class="tag">Reads</span></summary><p class="supporting-text">Search &lt;b&gt;open&lt;/b&gt; deals.</p>'
    );
    expect(html).toContain('<code>moveDeal</code><span class="tag">Changes</span>');
    expect(html).toContain('<a href="/agents/connect?app=claude">Connect your agent</a>');
    expect(html).not.toContain("note-warn");
  });

  it("names every admin while access is off, the viewer first as you", () => {
    const html = renderAgentPanel({ tools, viewer: viewer("admin"), admins });
    expect(html).toContain("Agent access is off at Bright &amp; &lt;Co&gt;");
    expect(html).toContain(
      "At Bright &amp; &lt;Co&gt; that’s you, Allison &lt;A&gt; and Priya Shah."
    );
    expect(html).toContain(
      '<a class="btn" href="/settings/agent-access">Turn it on in Settings</a>'
    );
    expect(html).not.toContain("Connect your agent");
  });

  it("gives a member the admins' names without the way to turn it on", () => {
    const html = renderAgentPanel({
      tools,
      viewer: viewer("member"),
      admins: admins.filter((admin) => admin.id !== "usr_jordan")
    });
    expect(html).toContain("that’s Allison &lt;A&gt; and Priya Shah.");
    expect(html).not.toContain("Turn it on in Settings");
    expect(html).not.toContain("Connect your agent");
  });
});
