import { NextRequest } from "next/server";
import { expect, it } from "vitest";
import proxy from "./proxy.js";

const answer = (path: string, accept?: string) =>
  proxy(
    new NextRequest(`http://localhost:4477${path}`, {
      headers: { cookie: "__client_uat=1", ...(accept === undefined ? {} : { accept }) }
    })
  );

it("keeps both answers at a page's URL out of shared caches", () => {
  const html = answer("/docs/limits", "text/html");
  expect(html.headers.get("x-middleware-rewrite")).toBeNull();
  expect(html.headers.get("cache-control")).toBe("private, no-store");

  const markdown = answer("/docs/limits", "text/markdown");
  expect(markdown.headers.get("x-middleware-rewrite")).toBe(
    "http://localhost:4477/llms.mdx/docs/limits.md"
  );
  expect(markdown.headers.get("cache-control")).toBe("private, no-store");

  // What Next.js fetches when it carries that rewrite out over HTTP.
  expect(answer("/llms.mdx/docs/limits.md").headers.get("cache-control")).toBe("private, no-store");
});

it("leaves a page's .md address, which has one answer, cacheable", () => {
  const twin = answer("/docs/limits.md", "text/markdown");
  expect(twin.headers.get("x-middleware-rewrite")).toBeNull();
  expect(twin.headers.get("cache-control")).toBeNull();
});

it("sends no request on with its cookies", () => {
  for (const path of ["/docs/limits", "/docs/limits.md", "/llms.txt", "/api/search"]) {
    const response = answer(path);
    expect(response.headers.get("x-middleware-override-headers")?.split(",")).not.toContain(
      "cookie"
    );
    expect(response.headers.get("x-middleware-request-cookie")).toBeNull();
  }
});
