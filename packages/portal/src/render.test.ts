import { describe, expect, it } from "vitest";
import type { RequireSession } from "@patchy/auth";
import { renderShareDialog } from "./share.js";
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
  const viewer = (role: RequireSession.Viewer["Service"]["role"]) =>
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
    const html = renderAgentPanel({ tools, viewer: viewer("super_admin"), admins });
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

describe("renderShareDialog audiences", () => {
  const person = {
    userId: "guest-old",
    name: "Old guest",
    email: "old@example.test",
    companyName: "Outside"
  };
  const input = (
    audience: import("@patchy/api").PatchAudience
  ): Parameters<typeof renderShareDialog>[0] => ({
    row: {
      patch: {
        id: "abcdefghijkl",
        name: "board",
        companyId: "company",
        companyHandle: "acme",
        ownerUserId: "owner",
        scope: audience.members.kind === "public" ? "public" : "company",
        audience,
        audienceRevision: "7",
        title: "Board",
        currentVersionId: "version",
        repoOrg: null,
        repoName: null,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        lifecycleRevision: "1",
        state: "live",
        retiredAt: null,
        retiredBy: null,
        deletedAt: null,
        deletedBy: null,
        purgeAt: null,
        reassignedAt: null,
        reassignedBy: null,
        description: "",
        descriptionUpdatedAt: null,
        descriptionUpdatedBy: null,
        lastChangedAt: null,
        lastChangedBy: null,
        disabledAt: null,
        disabledReason: null
      },
      owner: { id: "owner", name: "Owner", deactivated: false },
      currentVersion: 1,
      tier: 1,
      publishedAt: "2026-01-01",
      visits: 0,
      reads: [],
      dependants: []
    },
    viewer: {
      user: { id: "owner", name: "Owner", email: "owner@example.test" },
      company: { id: "company", name: "Acme", handle: "acme" },
      role: "member",
      whatsNewSeen: 0
    },
    publicBaseUrl: "https://example.test",
    back: "/patches",
    guests: [],
    suggestions: [],
    teams: [
      { id: "design", companyId: "company", name: "Design", createdAt: new Date(0) },
      { id: "sales", companyId: "company", name: "Sales", createdAt: new Date(0) }
    ]
  });
  it("restores saved teams and specific guests absent from suggestions", () => {
    const state = input({
      members: { kind: "teams", teamIds: ["design"] },
      guests: { kind: "specific", userIds: [person.userId] }
    });
    const html = renderShareDialog({ ...state, guests: [{ ...person, grantedAt: new Date(0) }] });
    expect(html).toContain('name="scope" value="teams" checked data-current');
    expect(html).toContain('name="teamIds" value="design" checked');
    expect(html).toContain('name="teamIds" value="sales">');
    expect(html).toContain('name="guestIds" value="guest-old" checked');
    expect(html).toContain('name="expectedAudienceRevision" value="7"');
  });
  it("restores all-guests exclusions, including ones no longer in suggestions", () => {
    const html = renderShareDialog({
      ...input({
        members: { kind: "company" },
        guests: { kind: "all", excludedUserIds: [person.userId, "removed-guest"] }
      }),
      suggestions: [person]
    });
    expect(html).toContain('name="guestMode" value="all" checked');
    expect(html).toContain('name="excludedGuestIds" value="guest-old" checked');
    expect(html).toContain('type="hidden" name="excludedGuestIds" value="removed-guest"');
    expect(html).not.toContain('name="guestIds" value="guest-old" checked');
  });
  it("requires public confirmation and disables public for tier 2", () => {
    const state = input({
      members: { kind: "company" },
      guests: { kind: "specific", userIds: [] }
    });
    const html = renderShareDialog({ ...state, confirmPublic: true });
    expect(html).toContain('name="scope" value="public" checked');
    expect(html).toContain('name="confirm" value="public">Make public');
    expect(html).toContain("share-change share-public-confirmation");
    const tool = renderShareDialog({ ...state, row: { ...state.row, tier: 2 } });
    expect(tool).toContain('name="scope" value="public" disabled');
    expect(tool).not.toContain('name="confirm"');
  });
});
