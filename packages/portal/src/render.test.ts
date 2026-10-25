import { describe, expect, it } from "vitest";
import type { RequireSession } from "@patchy/auth";
import { firstClause, renderAgentPanel } from "./render.js";

describe("firstClause", () => {
  it.each([
    ["Find a desk. Keep the second sentence on the card.", "Find a desk"],
    ["Choose lunch; keep this detail on the card.", "Choose lunch"],
    ["Book a room – keep this detail on the card.", "Book a room"],
    ["Plan the day; next clause. Last clause – still later", "Plan the day"],
    ["Wait for it... then keep this detail on the card.", "Wait for it"],
    ["a".repeat(81), `${"a".repeat(79)}…`],
    [".NET release health and deployment notes", ".NET release health and deployment notes"],
    ["Track release 1.2 rollouts", "Track release 1.2 rollouts"]
  ])("cuts %j to %j", (description, clause) => {
    expect(firstClause(description)).toBe(clause);
  });
});

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
    expect(html).toContain(
      '<a href="/machines?agent=claude#connect-an-agent">Connect your agent</a>'
    );
    expect(html).not.toContain("note-warn");
  });

  it("names every admin while access is off, the viewer first as you", () => {
    const html = renderAgentPanel({ tools, viewer: viewer("admin"), admins });
    expect(html).toContain("Agent access is off at Bright &amp; &lt;Co&gt;");
    expect(html).toContain(
      "At Bright &amp; &lt;Co&gt; that’s you, Allison &lt;A&gt; and Priya Shah."
    );
    expect(html).toContain('<a class="btn" href="/company/agent-access">Turn it on at Company</a>');
    expect(html).not.toContain("Connect your agent");
  });

  it("gives a member the admins' names without the way to turn it on", () => {
    const html = renderAgentPanel({
      tools,
      viewer: viewer("member"),
      admins: admins.filter((admin) => admin.id !== "usr_jordan")
    });
    expect(html).toContain("that’s Allison &lt;A&gt; and Priya Shah.");
    expect(html).not.toContain("Turn it on at Company");
    expect(html).not.toContain("Connect your agent");
  });
});
