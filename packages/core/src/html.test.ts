import { describe, expect, it } from "vitest";
import { escapeHtml, htmlPage } from "./html.js";
import { changesSince, latestRelease } from "./whatsNew.js";

describe("htmlPage app body", () => {
  const viewer = {
    user: { name: "Sam", email: "sam@northwind.example" },
    company: { name: "Northwind" },
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

  it("escapes viewer and company names without introducing shell markup", () => {
    const html = htmlPage({
      title: "People",
      app: {
        viewer: {
          user: { name: '<img src=x onerror="alert(1)">', email: "<b>x</b>@example.com" },
          company: { name: "R&D <script>alert(2)</script>" },
          whatsNewSeen: latestRelease
        },
        section: "people"
      },
      body: "<p>Company details</p>"
    });
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("R&amp;D &lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;@example.com");
    expect(html).not.toMatch(/<(img|script|b)\b/);
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
    expect(caughtUp).not.toMatch(/<script\b/);
  });

  it("lights What's new, not a place, on the What's new page", () => {
    const html = htmlPage({ title: "What's new", app: { viewer, section: "whats-new" }, body: "" });
    expect(html).toContain(
      'class="app-place whats-new-bell" popovertarget="whats-new" aria-label="What’s new" aria-current="page">'
    );
    expect(html.slice(html.indexOf("<body>")).match(/aria-current="page"/g)).toHaveLength(1);
  });
});
