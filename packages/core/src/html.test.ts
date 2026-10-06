import { describe, expect, it } from "vitest";
import { htmlPage } from "./html.js";

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

// Session doors and old standalone sketches omit the viewer id and get no bell.
it("escapes the signed-in viewer id and keeps the bell accessible without inline script", () => {
  const html = htmlPage({
    title: "Updates",
    app: {
      viewer: {
        user: { name: "Sam", id: '" onclick="alert(1)' },
        company: { name: "Northwind" }
      },
      section: "updates"
    },
    body: "<p>History</p>"
  });
  expect(html).toContain('data-viewer-id="&quot; onclick=&quot;alert(1)"');
  expect(html).toContain('popovertarget="updates-popover" aria-label="Updates"');
  expect(html).toContain('href="/updates">View all updates');
  expect(html.slice(html.indexOf("<body>"))).not.toContain('aria-current="page"');
  expect(html).not.toMatch(/<script\b/);
});
