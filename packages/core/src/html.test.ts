import { describe, expect, it } from "vitest";
import { escapeHtml, htmlPage } from "./html.js";
import { changesSince, latestRelease } from "./whatsNew.js";

describe("htmlPage app body", () => {
  it("keeps section navigation and sign-out outside the page's main content", () => {
    const html = htmlPage({
      title: "Connections",
      app: {
        viewer: {
          user: { name: "Sam" },
          company: { name: "Northwind" },
          whatsNewSeen: latestRelease
        },
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
          company: { name: "R&D <script>alert(2)</script>" },
          whatsNewSeen: latestRelease
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

  it("rings the bell for what shipped since the viewer's marker, and loads its script only then", () => {
    const page = (whatsNewSeen: number) =>
      htmlPage({
        title: "Patches",
        app: {
          viewer: { user: { name: "Sam" }, company: { name: "Northwind" }, whatsNewSeen },
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
});
