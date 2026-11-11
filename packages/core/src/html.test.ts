import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AppShell,
  escapeHtml,
  htmlPage,
  SWITCHER_RELAY_SOURCE,
  switcherRelay,
  switcherTag
} from "./html.js";
import { changesSince, latestRelease } from "./whatsNew.js";
import { entriesSince, permalink } from "./whatsNewLinks.js";

describe("htmlPage app body", () => {
  const viewer = {
    user: { id: "usr_sam", name: "Sam", email: "sam@northwind.example" },
    company: { id: "cmp_northwind", name: "Northwind" },
    whatsNewSeen: latestRelease
  };
  const places = (html: string) =>
    [
      ...html.matchAll(
        /<a class="app-place[^"]*" href="([^"]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)/g
      )
    ].map(([, href, label]) => [href, label]);

  it("keeps the sidebar of places and sign-out outside the page's main content", () => {
    const html = htmlPage({
      title: "Integrations",
      app: { viewer, section: "integrations" },
      body: '<h1 class="page-heading">Integrations</h1>'
    });
    const body = html.slice(html.indexOf("<body>"));
    expect(body).toMatch(/<aside class="app-side">[\s\S]*<\/aside><main\b/);
    expect(body).toContain('<nav class="app-nav" aria-label="Primary">');
    // A Settings page opens Settings, with its pages under it and this one lit.
    expect(places(body)).toEqual([
      ["/", "Home"],
      ["/patches", "All patches"],
      ["/agents", "Your agents"],
      ["/settings/people", "Settings"],
      ["/settings/people", "People"],
      ["/settings/integrations", "Integrations"],
      ["/settings/agent-access", "Agent access"]
    ]);
    expect(body).toContain('<a class="app-place app-place-open" href="/settings/people">');
    expect(body).toContain('<div class="app-subnav" role="group" aria-label="Settings">');
    expect(body.match(/aria-current="page"/g)).toHaveLength(1);
    expect(body).toContain(
      '<a class="app-place" href="/settings/integrations" aria-current="page">'
    );
    expect(body).toContain('id="account-menu" popover');
    expect(body).toContain("sam@northwind.example");
    expect(body).toMatch(
      /<form method="post" action="\/logout"><button class="menu-item" type="submit"><svg[^>]*>[\s\S]*?<\/svg>Sign out<\/button>/
    );
    expect(body.slice(body.indexOf("<main"))).not.toContain("/logout");
  });

  it("folds Settings away off its pages, and gives every role the same places", () => {
    const html = htmlPage({ title: "Home", app: { viewer, section: "home" }, body: "" });
    const body = html.slice(html.indexOf("<body>"));
    expect(places(body)).toEqual([
      ["/", "Home"],
      ["/patches", "All patches"],
      ["/agents", "Your agents"],
      ["/settings/people", "Settings"]
    ]);
    expect(body).not.toContain("app-subnav");
  });

  it("searches patches from the sidebar, offers New patch under it, and lights Home on Home", () => {
    const html = htmlPage({ title: "Home", app: { viewer, section: "home" }, body: "<p>Home</p>" });
    const body = html.slice(html.indexOf("<body>"));
    expect(body).toContain('<a class="brand" href="/">');
    expect(body).toMatch(/<a class="app-place" href="\/" aria-current="page"><svg[^>]*>/);
    expect(body).toMatch(/<form class="app-search" method="get" action="\/patches" role="search">/);
    expect(body).toContain('aria-label="Search patches"');
    expect(body).toMatch(
      /<a class="btn btn-sm btn-block" href="\/\?new"><svg[^>]*>[\s\S]*?<\/svg>New patch<\/a>/
    );
    expect(body.indexOf("app-search")).toBeLessThan(body.indexOf("New patch"));
  });

  it("opens the same places and New patch from a Menu button on a phone, with one nav in the markup", () => {
    const html = htmlPage({ title: "Home", app: { viewer, section: "home" }, body: "<p>Home</p>" });
    expect(html).toContain('popovertarget="app-menu">');
    expect(html).toMatch(/<div class="app-menu" id="app-menu" popover><a [^>]*href="\/\?new"/);
    expect(html.match(/<nav /g)).toHaveLength(1);
    expect(html.match(/role="search"/g)).toHaveLength(1);
  });

  it("titles a page by its heading, its place and the company, naming each once", () => {
    const title = (heading: string, section: AppShell["section"]) =>
      htmlPage({ title: heading, app: { viewer, section }, body: "" }).match(
        /<title>([^<]*)<\/title>/
      )?.[1];
    expect(title("Home", "home")).toBe("Home – Northwind");
    expect(title("People", "people")).toBe("People – Northwind");
    expect(title("Kudos", "patches")).toBe("Kudos – All patches – Northwind");
    expect(title("attio/crm", "integrations")).toBe("attio/crm – Integrations – Northwind");
    expect(title("What’s new in Patchy", "whats-new")).toBe("What’s new in Patchy – Northwind");
    // A door has no frame, so its title is its own.
    expect(htmlPage({ title: "Sign in", body: "" })).toContain("<title>Sign in</title>");
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
    expect(html).toContain('<a class="app-place" href="/settings/people" aria-current="page">');
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
    const headlines = (html: string) =>
      [
        ...html.matchAll(
          /<li><a class="app-headline" href="([^"]+)"><span class="app-headline-kind">([^<]+)<\/span><span>([^<]*)/g
        )
      ].map(([, href, kind, title]) => [kind, title, href]);
    const unseen = changesSince(0);
    const behind = page(0);
    expect(behind).toContain('class="whats-new-dot"');
    expect(behind).toContain(
      `${unseen.length} ${unseen.length === 1 ? "change" : "changes"} since your last visit`
    );
    // Five headlines at most, the newest first, each its change's permalink; See all changes has
    // the rest. Opening the panel raises the marker, so its links carry the one it was drawn with.
    expect(headlines(behind)).toEqual(
      entriesSince(0)
        .slice(0, 5)
        .map(({ release, n, change }) => [
          change.kind,
          escapeHtml(change.title),
          permalink(release, n, 0)
        ])
    );
    expect(behind).toMatch(/<a class="menu-item" href="\/whats-new\?since=0">See all changes<svg/);
    expect(behind).toContain(`data-through="${latestRelease}"`);
    expect(behind).toContain('<script defer src="/whats-new/bell.js"></script>');

    const caughtUp = page(latestRelease);
    expect(caughtUp).not.toContain('class="whats-new-dot"');
    expect(caughtUp).toContain("You’re all caught up");
    expect(headlines(caughtUp)).toEqual(
      entriesSince(0)
        .slice(0, 5)
        .map(({ release, n, change }) => [
          change.kind,
          escapeHtml(change.title),
          permalink(release, n)
        ])
    );
    expect(caughtUp).toMatch(/<a class="menu-item" href="\/whats-new">See all changes<svg/);
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
      'class="app-place whats-new-bell" popovertarget="whats-new" aria-label="What’s new" aria-current="page"><svg'
    );
    expect(html.slice(html.indexOf("<body>")).match(/aria-current="page"/g)).toHaveLength(1);
  });
});
