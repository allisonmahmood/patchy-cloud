import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE, MANIFEST_VERSION, WIRE_VERSION } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import type { Patches } from "@patchy/patches";
import { sessionScripts } from "@patchy/auth";
import { switcherRelay, switcherTag } from "@patchy/core/html";
import { renderPatchWrapper, renderShellNotice, withSwitcherRelay } from "./shell.js";
import { renderAddressNotice } from "./address-notice.js";
import { renderNotFound } from "./render.js";

/** A page's inline scripts, which its CSP admits by hash: the relay alone. */
const inlineScripts = (html: string) => html.match(/<script>[\s\S]*?<\/script>/g) ?? [];
/** The page as it would be without the relay that leads its head. */
const withoutRelay = (html: string) => {
  expect(inlineScripts(html)).toEqual([switcherRelay]);
  return html.replace(switcherRelay, "");
};

describe("withSwitcherRelay", () => {
  it.each([
    [
      "after an explicit head, keeping its attributes",
      '<!doctype html><html lang="en"><head data-theme="dark">',
      "<title>Report</title></head><body></body></html>"
    ],
    [
      "past a byte order mark, comments and the doctype, where the head is implied",
      "\u{FEFF}<!-- Built by Acme -->\n<!doctype html>\n",
      "<title>Report</title><script>start()</script>"
    ],
    ["where the body implies the head", "<!doctype html>", "<p>No head at all</p>"],
    ["at the start, when there is no doctype to keep", "", "<p>Quirks</p>"]
  ])("inserts the relay first in the head, %s", (_, before, after) => {
    expect(withSwitcherRelay(before + after)).toBe(before + switcherRelay + after);
  });
});

describe("renderNotFound", () => {
  it("is the shared notice card with one link home and nothing that needs a form or script", () => {
    const html = renderNotFound();
    expect(html).toContain('<main class="auth-card"><div class="brand">');
    expect(html).toContain(`<h1 class="page-heading">This page isn't available</h1>`);
    expect(html.match(/<a\b[^>]*>[^<]*<\/a>/g)).toEqual([
      '<a class="btn btn-primary" href="/">Go to Patchy</a>'
    ]);
    expect(withoutRelay(html)).not.toMatch(/<(form|script|iframe)\b|data-notice/);
  });
});

describe("renderShellNotice", () => {
  it("preserves a deep return address without allowing it to become notice markup", () => {
    const returnTo = '/acme/tool/items/2?filter="><img src=x onerror=alert(1)>&q=ready#last';
    const html = renderShellNotice("principal_changed", returnTo);
    expect(html).not.toContain("<img");
    const href = html.match(/href="(\/login\?return=[^"]+)"/)?.[1];
    expect(new URL(href!, "https://patchy.example").searchParams.get("return")).toBe(returnTo);
  });

  it("cannot turn access revocation into a reload or patch-controlled continuation", () => {
    const html = renderShellNotice("access_denied", "/acme/tool?reload=1");
    expect(withoutRelay(html)).not.toMatch(/<(a|form|iframe|script)\b/);
    expect(html).not.toContain("/acme/tool");
  });

  it("loads a signed-in viewer's switcher, then the session's scripts, and adds no inline script", () => {
    const viewer = {
      userId: "usr_notice",
      companyId: "cmp_notice",
      session: sessionScripts({
        clerk: { frontendApiHost: "clerk.example.test", publishableKey: "pk_test_example" }
      })
    };
    const html = renderShellNotice("revoked", "/", viewer);
    expect(withoutRelay(html)).toContain(`${switcherTag(viewer)}${viewer.session}`);
    expect(html.indexOf(switcherRelay)).toBeLessThan(html.indexOf(switcherTag(viewer)));
    expect(renderShellNotice("revoked", "/")).not.toContain("<script defer");
  });
});

describe("patch pages", () => {
  const patch: Patches.Patch = {
    id: "patch12345ab",
    lifecycleRevision: "1",
    companyId: DEV_SEED.companyId,
    companyHandle: DEV_SEED.companyHandle,
    name: "render-fixture",
    ownerUserId: DEV_SEED.userId,
    scope: "public",
    audience: { members: { kind: "public" } },
    title: "",
    currentVersionId: "ver_1",
    repoOrg: null,
    repoName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: "live",
    retiredAt: null,
    retiredBy: null,
    deletedBy: null,
    reassignedAt: null,
    reassignedBy: null,
    description: "",
    descriptionUpdatedAt: null,
    descriptionUpdatedBy: null,
    lastChangedAt: null,
    lastChangedBy: null,
    purgeAt: null,
    deletedAt: null,
    disabledAt: null,
    disabledReason: null
  };
  const version: Patches.PatchVersion = {
    id: "ver_1",
    patchId: patch.id,
    versionNumber: 2,
    tier: 1,
    release: CURRENT_RELEASE,
    manifestVersion: MANIFEST_VERSION,
    wireVersion: WIRE_VERSION,
    schemaRevision: 0,
    manifest: {
      manifestVersion: MANIFEST_VERSION,
      release: CURRENT_RELEASE,
      tier: 1,
      tables: {},
      files: {},
      uses: {}
    },
    publishKey: "render-fixture",
    payloadDigest: "render-fixture",
    objectKey: "patches/patch12345ab/2.html",
    contentHash: "hash",
    fileSize: 12,
    server: null,
    repo: null,
    createdByMachineTokenId: DEV_SEED.tokenId,
    sourceIp: null,
    userAgent: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null,
    originalFilename: null,
    createdAt: "2026-01-01T00:00:00.000Z"
  };

  it("keeps address notice names and actor markup inert", () => {
    const markup = '<img src=x onerror="alert(1)">';
    const html = renderAddressNotice({
      patch: { ...patch, name: markup, state: "retired", retiredAt: "2026-01-01T00:00:00.000Z" },
      actorName: markup,
      sourcesOff: false,
      viewer: {
        user: { id: DEV_SEED.userId, email: "dev@patchy.local", name: "Owner" },
        company: { id: DEV_SEED.companyId, handle: DEV_SEED.companyHandle, name: "Company" },
        role: "member",
        whatsNewSeen: 0
      },
      now: Date.UTC(2026, 0, 1)
    });
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain(`action="/patches/${encodeURIComponent(markup)}/restore"`);
  });

  it("formats off-state dates in UTC with stable month labels", () => {
    const retiredAt = "2026-08-31T23:30:00.000-02:00";
    const html = renderAddressNotice({
      patch: { ...patch, state: "retired", retiredAt },
      actorName: null,
      sourcesOff: false,
      viewer: {
        user: { id: DEV_SEED.userId, email: "dev@patchy.local", name: "Owner" },
        company: { id: DEV_SEED.companyId, handle: DEV_SEED.companyHandle, name: "Company" },
        role: "member",
        whatsNewSeen: 0
      },
      now: Date.UTC(2026, 8, 1, 2)
    });
    expect(html).toContain(`<time datetime="${retiredAt}">1 Sep 2026</time>`);
  });

  it("removes source-review restore controls and hints at the recovery deadline", () => {
    const purgeAt = "2026-10-01T00:00:00.000Z";
    const input = {
      patch: {
        ...patch,
        state: "deleted" as const,
        deletedAt: "2026-09-01T00:00:00.000Z",
        purgeAt
      },
      actorName: null,
      sourcesOff: true,
      viewer: {
        user: { id: DEV_SEED.userId, email: "dev@patchy.local", name: "Owner" },
        company: { id: DEV_SEED.companyId, handle: DEV_SEED.companyHandle, name: "Company" },
        role: "member" as const,
        whatsNewSeen: 0
      }
    };
    const before = renderAddressNotice({ ...input, now: Date.parse(purgeAt) - 1 });
    expect(before).toContain('href="/patches/render-fixture/restore"');
    expect(before).toContain("Gone for good in 1 days");
    expect(before).toContain("Review those sources before restoring it.");

    const ended = renderAddressNotice({ ...input, now: Date.parse(purgeAt) });
    expect(ended).not.toContain("/patches/render-fixture/restore");
    expect(ended).not.toContain("Review those sources before restoring it.");
    expect(ended).toContain("Gone for good in 0 days");
    expect(ended).toContain("This patch can no longer be restored.");
    expect(ended).toContain('href="/patches/render-fixture"');
  });

  it("frames a public page's content URL, with no chrome and no script but the relay and broker", () => {
    const html = renderPatchWrapper({
      patch,
      version,
      scope: "public",
      nonce: "document-nonce",
      base: "/acme/render-fixture"
    });

    expect(html).toContain('sandbox="allow-scripts allow-modals"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain(
      `data-content-src="/~content/${patch.id}/${version.id}?n=document-nonce"`
    );
    expect(html).not.toContain("srcdoc");

    // No chrome around it: no footer, no link out, no form.
    expect(html).not.toContain("<footer");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<form");
    expect(
      [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)].map((match) => match[1])
    ).toEqual([expect.stringMatching(/^\/~shell\/broker\.js\?v=/)]);
    expect(withoutRelay(html)).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/);
    expect(html).toMatch(/<head>\s*<meta charset="utf-8">\s*<script>/);
    // Out of reach until its document can claim the switcher key; the relay above shows it.
    expect(html).toMatch(/<iframe id="patch"[^>]* data-waiting[\s>]/);
    expect(html).toContain(".patch-frame[data-waiting] { visibility: hidden; }");

    expect(html).toContain(`<!-- patch:${patch.id} version:2 -->`);
  });

  it("adds only the relay, the switcher, session scripts and the broker outside a company patch's frame", () => {
    const html = renderPatchWrapper({
      patch: { ...patch, title: "<b>Company</b>" },
      version,
      scope: "company",
      viewerId: "viewer-1",
      companyId: "company-1",
      nonce: "document-nonce",
      base: "/acme/render-fixture",
      head: sessionScripts({
        clerk: { frontendApiHost: "clerk.example.test", publishableKey: "pk_test_example" }
      })
    });
    expect(
      [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)].map((match) => match[1])
    ).toEqual([
      // Ahead of Clerk, so the menu never waits on it.
      expect.stringMatching(/^\/~shell\/switcher\.js\?v=[0-9a-f]{64}$/),
      "https://clerk.example.test/npm/@clerk/clerk-js@5/dist/clerk.headless.browser.js",
      "/auth/session.js",
      expect.stringMatching(/^\/~shell\/broker\.js\?v=/)
    ]);
    expect(html).toContain('data-viewer="viewer-1" data-company="company-1"></script>');
    // The menu draws with the shell's own components: the command list, keycap and marks.
    for (const rule of [
      '.command-row[aria-selected="true"] {',
      ".switcher[open] {",
      ".kbd {",
      ".mono {"
    ])
      expect(html).toContain(rule);
    expect(withoutRelay(html)).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/);
    expect(html).toContain('title="&lt;b&gt;Company&lt;/b&gt;"');
  });

  it("escapes the patch title into both the document and the frame", () => {
    const html = renderPatchWrapper({
      patch: { ...patch, title: "<b>Q3</b> & beyond" },
      version,
      scope: "public",
      nonce: "document-nonce",
      base: "/acme/render-fixture"
    });

    expect(html).toContain("<title>&lt;b&gt;Q3&lt;/b&gt; &amp; beyond</title>");
    expect(html).toContain('title="&lt;b&gt;Q3&lt;/b&gt; &amp; beyond"');
    expect(html).not.toContain("<b>Q3</b>");
  });

  it("keeps a scripted historical version bound to its own content and route", () => {
    const html = renderPatchWrapper({
      patch,
      version: { ...version, tier: 1 },
      scope: "company",
      viewerId: "viewer-1",
      companyId: "company-1",
      nonce: "document-nonce",
      base: "/acme/report/~v/2",
      route: "/items/first"
    });
    expect(html).toContain('sandbox="allow-scripts allow-modals"');
    expect(html).toContain('allow="clipboard-write *"');
    expect(html).toContain(
      `data-content-src="/~content/${patch.id}/${version.id}?n=document-nonce"`
    );
    expect(html).toContain('data-route="/items/first"');
    expect(html).toContain('data-base="/acme/report/~v/2"');
    expect(html).toMatch(/src="\/~shell\/broker\.js\?v=[0-9a-f]{64}"/);
    expect(html).not.toContain("srcdoc=");
  });

  it("keeps handler-kind metadata inside its tier-two attribute, never executable markup", () => {
    const options = {
      patch,
      version: { ...version, tier: 2 },
      scope: "company" as const,
      viewerId: "viewer-1",
      companyId: "company-1",
      nonce: "document-nonce",
      base: "/acme/report",
      handlerKinds: { ['demo."><img src=x onerror=alert(1)>']: "query" as const }
    };
    const html = renderPatchWrapper(options);
    const metadata = html.match(/data-handler-kinds="([^"]*)"/)?.[1];
    expect(metadata).toContain("&quot;");
    expect(metadata).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(renderPatchWrapper({ ...options, version: { ...version, tier: 1 } })).not.toContain(
      "data-handler-kinds"
    );
  });

  it.each(["company", "local"] as const)(
    "requires an admitted viewer for a scripted %s shell",
    (scope) => {
      const options = {
        patch,
        version: { ...version, tier: 1 },
        scope,
        nonce: "document-nonce",
        base: "/acme/report"
      };
      expect(() => renderPatchWrapper(options)).toThrow();
      const viewer = { ...options, viewerId: 'viewer"><img src=x>' };
      // A company shell's switcher needs the viewer's company too; a local one has none.
      if (scope === "company") expect(() => renderPatchWrapper(viewer)).toThrow();
      const html = renderPatchWrapper({ ...viewer, companyId: 'company"><img src=x>' });
      expect(html).toContain('data-viewer-id="viewer&quot;&gt;&lt;img src=x&gt;"');
      expect(html).not.toContain("<img");
      expect(html.includes("/~shell/switcher.js")).toBe(scope === "company");
    }
  );

  it("keeps a scripted public shell anonymous even when the host knows the viewer", () => {
    const html = renderPatchWrapper({
      patch,
      version: { ...version, tier: 1 },
      scope: "public",
      viewerId: "private-viewer",
      nonce: "document-nonce",
      base: "/acme/report"
    });
    expect(html).not.toContain("data-viewer-id");
    expect(html).not.toContain("private-viewer");
    expect(html).not.toContain("/~shell/switcher.js");
  });

  it("loads a member's switcher on a public shell without pinning them, and says so on its frame", () => {
    const options = {
      patch,
      version: { ...version, tier: 1 },
      nonce: "document-nonce",
      base: "/acme/report",
      viewerId: "usr_member"
    };
    const member = renderPatchWrapper({ ...options, scope: "public", companyId: "cmp_acme" });
    expect(member).toContain(switcherTag({ userId: "usr_member", companyId: "cmp_acme" }));
    expect(member).toMatch(/<iframe id="patch"[^>]* data-scope="public" data-switcher /);
    expect(member).not.toContain("data-viewer-id");
    expect(renderPatchWrapper({ ...options, scope: "company", companyId: "cmp_acme" })).toContain(
      " data-switcher "
    );
    for (const shell of [
      renderPatchWrapper({ ...options, scope: "public" }),
      renderPatchWrapper({ ...options, scope: "local", companyId: "cmp_acme" })
    ]) {
      expect(shell).not.toContain("/~shell/switcher.js");
      expect(shell).not.toContain("data-switcher");
    }
  });
});
