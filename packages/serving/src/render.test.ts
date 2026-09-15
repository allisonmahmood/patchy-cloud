import { describe, expect, it } from "vitest";
import { CURRENT_RELEASE, MANIFEST_VERSION, WIRE_VERSION } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import type { Patches } from "@patchy/patches";
import { sessionScripts } from "@patchy/auth";
import { htmlPage } from "@patchy/core";
import { renderHome } from "./render.js";
import { renderPatchWrapper, renderShellNotice } from "./shell.js";
import { renderAddressNotice } from "./address-notice.js";

describe("renderHome", () => {
  it("keeps markup in the sign-in destination inert", () => {
    const html = renderHome({
      signInUrl: "https://pages.example.com/'><img src=x onerror=alert(1)>"
    });

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("htmlPage app body", () => {
  it("keeps section navigation and sign-out outside the page's main content", () => {
    const html = htmlPage({
      title: "Connections",
      app: {
        viewer: { user: { name: "Sam" }, company: { name: "Northwind" } },
        section: "connections"
      },
      body: '<h1 class="page-heading">Connections</h1>'
    });
    const body = html.slice(html.indexOf("<body>"));
    expect(body).toMatch(/<header\b[\s\S]*<\/header><main\b/);
    expect(body).toContain('<nav class="app-nav" aria-label="Primary">');
    expect(
      [...body.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(([, href, label]) => [
        href,
        label
      ])
    ).toEqual([
      ["/", "Patches"],
      ["/company", "Company"],
      ["/company/connections", "Connections"],
      ["/machines", "Your machines"]
    ]);
    expect(body.match(/aria-current="page"/g)).toHaveLength(1);
    expect(body).toContain('<a href="/company/connections" aria-current="page">');
    expect(body).toContain('<form method="post" action="/logout">');
    expect(body).toContain('type="submit">Sign out</button>');
  });

  it("escapes viewer and company names without introducing header markup", () => {
    const html = htmlPage({
      title: "Company",
      app: {
        viewer: {
          user: { name: '<img src=x onerror="alert(1)">' },
          company: { name: "R&D <script>alert(2)</script>" }
        },
        section: "company"
      },
      body: "<p>Company details</p>"
    });
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("R&amp;D &lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).not.toMatch(/<(img|script)\b/);
    expect(html).toContain('<a href="/company" aria-current="page">');
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
    expect(html).not.toMatch(/<(a|form|iframe|script)\b/);
    expect(html).not.toContain("/acme/tool");
  });
});

describe("patch pages", () => {
  const patch: Patches.Patch = {
    id: "patch12345ab",
    companyId: DEV_SEED.companyId,
    companyHandle: DEV_SEED.companyHandle,
    name: "render-fixture",
    ownerUserId: DEV_SEED.userId,
    scope: "public",
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
    tier: 0,
    release: CURRENT_RELEASE,
    manifestVersion: MANIFEST_VERSION,
    wireVersion: WIRE_VERSION,
    schemaRevision: 0,
    manifest: {
      manifestVersion: MANIFEST_VERSION,
      release: CURRENT_RELEASE,
      tier: 0,
      tables: {},
      files: {},
      uses: {}
    },
    publishKey: "render-fixture",
    payloadDigest: "render-fixture",
    objectKey: "patches/patch12345ab/2.html",
    contentHash: "hash",
    fileSize: 12,
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
        role: "member"
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
        role: "member"
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
        role: "member" as const
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

  it("keeps a public patch in a script-free sandboxed frame", () => {
    const html = renderPatchWrapper({
      patch,
      version,
      html: '<p title="a&b">hi</p><script>alert(1)</script>'
    });

    // The document reaches the frame through the escaped attribute, never raw.
    expect(html).toContain('sandbox=""');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('srcdoc="&lt;p title=&quot;a&amp;b&quot;&gt;hi&lt;/p&gt;');
    expect(html).not.toContain("<script>alert");

    // No chrome around it: no footer, no link out, no form, no script of its own.
    expect(html).not.toContain("<footer");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script");

    expect(html).toContain(`<!-- patch:${patch.id} version:2 -->`);
  });

  it("adds only session scripts outside a company patch's escaped sandbox", () => {
    const html = renderPatchWrapper({
      patch: { ...patch, title: "<b>Company</b>" },
      version,
      html: '<p title="a&b">Private</p><script>alert(1)</script>',
      head: sessionScripts({
        frontendApiHost: "clerk.example.test",
        publishableKey: "pk_test_example"
      })
    });
    expect(
      [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)].map((match) => match[1])
    ).toEqual([
      "https://clerk.example.test/npm/@clerk/clerk-js@5/dist/clerk.headless.browser.js",
      "/auth/session.js"
    ]);
    expect(html).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/);
    expect(html).toContain('sandbox=""');
    expect(html).toContain('title="&lt;b&gt;Company&lt;/b&gt;"');
    expect(html).toContain('srcdoc="&lt;p title=&quot;a&amp;b&quot;&gt;Private&lt;/p&gt;');
    expect(html).not.toContain("<script>alert");
  });

  it("escapes the patch title into both the document and the frame", () => {
    const html = renderPatchWrapper({
      patch: { ...patch, title: "<b>Q3</b> & beyond" },
      version,
      html: "<p>hi</p>"
    });

    expect(html).toContain("<title>&lt;b&gt;Q3&lt;/b&gt; &amp; beyond</title>");
    expect(html).toContain('title="&lt;b&gt;Q3&lt;/b&gt; &amp; beyond"');
    expect(html).not.toContain("<b>Q3</b>");
  });

  it("keeps a scripted historical version bound to its own content and route", () => {
    const html = renderPatchWrapper({
      patch,
      version: { ...version, tier: 1 },
      html: "<script>window.secret = 1</script>",
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
    expect(html).toContain('src="/~shell/broker.js"');
    expect(html).not.toContain("srcdoc=");
    expect(html).not.toContain("window.secret");
  });
});
