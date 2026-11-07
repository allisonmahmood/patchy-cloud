import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { escapeHtml, htmlPage, SWITCHER_RELAY_SOURCE, switcherRelay, switcherTag } from "./html.js";
import { changesSince, latestRelease } from "./whatsNew.js";

describe("htmlPage app body", () => {
  const viewer = {
    user: { id: "usr_sam", name: "Sam", email: "sam@northwind.example" },
    company: { id: "cmp_northwind", name: "Northwind" },
    whatsNewSeen: latestRelease
  };
  const places = (html: string) =>
    [...html.matchAll(/<a class="app-place" href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(
      ([, href, label]) => [href, label]
    );

  it("keeps the sidebar of places and sign-out outside the page's main content", () => {
    const html = htmlPage({
      title: "Integrations",
      app: { viewer, section: "integrations" },
      body: '<h1 class="page-heading">Integrations</h1>'
    });
    const body = html.slice(html.indexOf("<body>"));
    expect(body).toMatch(/<aside class="app-side">[\s\S]*<\/aside><main\b/);
    expect(body).toContain('<nav class="app-nav" aria-label="Primary">');
    expect(places(body)).toEqual([
      ["/", "Home"],
      ["/patches", "All patches"],
      ["/machines", "Your agents"],
      ["/company", "People"],
      ["/company/connections", "Integrations"],
      ["/company/agent-access", "Agent access"]
    ]);
    expect(body).toContain(
      'aria-labelledby="app-group-company"><p class="app-group-label" id="app-group-company">Company</p>'
    );
    expect(body.match(/aria-current="page"/g)).toHaveLength(1);
    expect(body).toContain('<a class="app-place" href="/company/connections" aria-current="page">');
    expect(body).toContain('id="account-menu" popover');
    expect(body).toContain("sam@northwind.example");
    expect(body).toContain(
      '<form method="post" action="/logout"><button class="menu-item" type="submit">Sign out</button>'
    );
    expect(body.slice(body.indexOf("<main"))).not.toContain("/logout");
  });

  it("searches patches from the sidebar and lights Home on Home", () => {
    const html = htmlPage({ title: "Home", app: { viewer, section: "home" }, body: "<p>Home</p>" });
    const body = html.slice(html.indexOf("<body>"));
    expect(body).toContain('<a class="brand" href="/">');
    expect(body).toContain('<a class="app-place" href="/" aria-current="page">Home</a>');
    expect(body).toMatch(/<form class="app-search" method="get" action="\/" role="search">/);
    expect(body).toContain('aria-label="Search patches"');
  });

  it("opens the same places from a Menu button on a phone, with one nav in the markup", () => {
    const html = htmlPage({ title: "Home", app: { viewer, section: "home" }, body: "<p>Home</p>" });
    expect(html).toContain('popovertarget="app-menu">');
    expect(html).toContain('<div class="app-menu" id="app-menu" popover>');
    expect(html.match(/<nav /g)).toHaveLength(1);
  });

  it("leads the page with the viewer's receipt, escaped", () => {
    const html = htmlPage({
      title: "Your agents",
      app: { viewer: { ...viewer, receipt: "Revoked <b>Mac</b>" }, section: "agents" },
      body: "<h1>Your agents</h1>"
    });
    expect(html).toContain(
      '<main class="app-page"><p class="note note-ok app-receipt" role="status">Revoked &lt;b&gt;Mac&lt;/b&gt;</p><h1>Your agents</h1>'
    );
    const none = htmlPage({ title: "Home", app: { viewer, section: "home" }, body: "" });
    expect(none).not.toContain('class="note note-ok app-receipt"');
  });

  it("escapes viewer and company names without introducing shell markup", () => {
    const html = htmlPage({
      title: "People",
      app: {
        viewer: {
          user: {
            id: 'usr_"><b>',
            name: '<img src=x onerror="alert(1)">',
            email: "<b>x</b>@example.com"
          },
          company: { id: "cmp_'<b>", name: "R&D <script>alert(2)</script>" },
          whatsNewSeen: latestRelease
        },
        section: "people"
      },
      body: "<p>Company details</p>"
    });
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("R&amp;D &lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;@example.com");
    // The switcher's tag names the viewer in attributes, escaped too.
    expect(html).toContain(
      'data-viewer="usr_&quot;&gt;&lt;b&gt;" data-company="cmp_&#39;&lt;b&gt;"'
    );
    expect(
      html
        .replace(switcherRelay, "")
        .replace(/<script defer src="\/~shell\/switcher\.js[^>]*><\/script>/, "")
    ).not.toMatch(/<(img|script|b)\b/);
    expect(html).toContain('<a class="app-place" href="/company" aria-current="page">');
  });

  it("rings the bell for what shipped since the viewer's marker, and loads its script only then", () => {
    const page = (whatsNewSeen: number) =>
      htmlPage({
        title: "Patches",
        app: {
          viewer: { ...viewer, whatsNewSeen },
          section: "patches"
        },
        body: "<p>Patches</p>"
      });
    const unseen = changesSince(0);
    const behind = page(0);
    expect(behind).toContain('class="whats-new-dot"');
    expect(behind).toContain(
      `${unseen.length} ${unseen.length === 1 ? "change" : "changes"} since your last visit`
    );
    for (const change of unseen.slice(0, 6)) expect(behind).toContain(escapeHtml(change.title));
    expect(behind).toContain(`data-through="${latestRelease}"`);
    expect(behind).toContain('<script defer src="/whats-new/bell.js"></script>');

    const caughtUp = page(latestRelease);
    expect(caughtUp).not.toContain('class="whats-new-dot"');
    expect(caughtUp).toContain("You’re all caught up.");
    expect(caughtUp).toContain('href="/whats-new">See all changes</a>');
    expect(
      [...caughtUp.replace(switcherRelay, "").matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag)
    ).toEqual([expect.stringMatching(/^<script defer src="\/~shell\/switcher\.js\?v=/)]);
  });

  it("loads the switcher on app pages, ahead of the session's scripts, and never on doors", () => {
    const session = '<script defer src="/auth/session.js"></script>';
    const app = htmlPage({
      title: "Home",
      app: { viewer, section: "home" },
      head: session,
      body: ""
    });
    const tag = app.match(
      /<script defer src="\/~shell\/switcher\.js\?v=([0-9a-f]{64})"([^>]*)><\/script>/
    );
    expect(tag?.[2]).toBe(' data-viewer="usr_sam" data-company="cmp_northwind"');
    expect(app.indexOf(tag![0])).toBeLessThan(app.indexOf(session));
    // A notice about one patch names it too, escaped like the viewer.
    expect(
      switcherTag({ userId: "usr_sam", companyId: "cmp_northwind", patchId: 'pat_"<b>' })
    ).toMatch(/ data-company="cmp_northwind" data-patch="pat_&quot;&lt;b&gt;"><\/script>$/);
    expect(htmlPage({ title: "Sign in", head: session, body: "<main></main>" })).not.toContain(
      "/~shell/switcher.js"
    );
  });

  it("admits exactly the relay's text by its hash", () => {
    const text = switcherRelay.slice("<script>".length, -"</script>".length);
    expect(`<script>${text}</script>`).toBe(switcherRelay);
    expect(SWITCHER_RELAY_SOURCE).toBe(
      `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`
    );
  });

  it("puts the switcher relay first in every page's head, doors included", () => {
    for (const html of [
      htmlPage({ title: "Home", app: { viewer, section: "home" }, body: "" }),
      htmlPage({ title: "Sign in", body: "<main></main>" })
    ]) {
      expect(html.split(switcherRelay)).toHaveLength(2);
      expect(html).toMatch(
        /^<!doctype html>\s*<html lang="en">\s*<head>\s*<meta charset="utf-8">\s*<script>/
      );
    }
  });

  it("lights What's new, not a place, on the What's new page", () => {
    const html = htmlPage({ title: "What's new", app: { viewer, section: "whats-new" }, body: "" });
    expect(html).toContain(
      'class="app-place whats-new-bell" popovertarget="whats-new" aria-label="What’s new" aria-current="page">'
    );
    expect(html.slice(html.indexOf("<body>")).match(/aria-current="page"/g)).toHaveLength(1);
  });
});
