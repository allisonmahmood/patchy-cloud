import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE, MANIFEST_VERSION } from "@patchy/api";
import { renderAgentConnect } from "./agentConnect.js";
import { renderAgentAccess } from "./agentAccess.js";
import { firstClause } from "./render.js";

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

describe("agent access", () => {
  it("keeps saved operations in the form when their disclosure is collapsed", () => {
    const html = renderAgentAccess({
      name: "sales",
      patchId: "patch-sales",
      choices: ["sales", "support"],
      access: {
        policy: { mode: "actions", handlers: ["deals.read"], revision: 2 },
        manifest: {
          manifestVersion: MANIFEST_VERSION,
          release: CURRENT_RELEASE,
          tier: 2,
          tables: {},
          files: {},
          uses: {},
          handlers: {
            "deals.read": { kind: "query", args: {}, result: { kind: "json" } },
            "deals.note": { kind: "mutation", args: {}, result: { kind: "json" } }
          }
        },
        connections: []
      }
    });
    const saveForm = html.match(/<form method="post"[^>]*>.*?<\/form>/s)?.[0];
    expect(saveForm).toContain("<details><summary>Allowed operations</summary>");
    expect(saveForm).not.toContain("<details open");
    expect(saveForm).toContain('name="handler" value="deals.read" checked');
    expect(saveForm).toContain('name="handler" value="deals.note">');
    expect(saveForm).toContain('name="revision" value="2"');
  });
});

describe("personal-agent setup", () => {
  it("escapes account and company text inside the copyable message", () => {
    const html = renderAgentConnect({
      publicBaseUrl: "https://patchy.example/",
      viewer: {
        user: { id: "usr-owner", email: "owner@company.example", name: "Owner" },
        company: {
          id: "cmp-owner",
          handle: "company",
          name: "</textarea><script>company</script>"
        },
        role: "member"
      }
    });
    expect(html).toContain("https://patchy.example/agent-setup.txt");
    expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;company&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html.match(/<\/textarea>/g)).toHaveLength(1);
    expect(html).toContain('href="/machines"');
  });
});
