import { describe, expect, it } from "vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import type { Patches } from "@patchy/patches";
import { renderHome, renderPatchWrapper } from "./render.js";

describe("renderHome", () => {
  it("keeps markup in the configured instance URL inert in the login instructions", () => {
    const html = renderHome({
      publicBaseUrl: "https://pages.example.com/'><img src=x onerror=alert(1)>"
    });

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("renderPatchWrapper", () => {
  const patch: Patches.Patch = {
    id: "patch12345ab",
    companyId: DEV_SEED.companyId,
    ownerUserId: DEV_SEED.userId,
    scope: "public",
    title: "",
    currentVersionId: "ver_1",
    repoOrg: null,
    repoName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-04-01T00:00:00.000Z",
    deletedAt: null,
    disabledAt: null,
    disabledReason: null
  };
  const version: Patches.PatchVersion = {
    id: "ver_1",
    patchId: patch.id,
    versionNumber: 2,
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
    const html = renderPatchWrapper(
      {
        patch: { ...patch, scope: "company", title: "<b>Company</b>" },
        version,
        html: '<p title="a&b">Private</p><script>alert(1)</script>'
      },
      {
        frontendApiHost: "clerk.example.test",
        publishableKey: "pk_test_example"
      }
    );
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
});
