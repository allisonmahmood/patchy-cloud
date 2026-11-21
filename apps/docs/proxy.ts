import { NextResponse, type NextRequest } from "next/server";
import { rewritePath } from "fumadocs-core/negotiation";
import { prefersMarkdown } from "./lib/accept";
import { docsRoute } from "./lib/shared";

// The route that serves every Markdown twin (`app/llms.mdx`).
const twinRoute = "/llms.mdx";

const { rewrite: markdownTwin } = rewritePath(
  `${docsRoute}{/*path}`,
  `${twinRoute}${docsRoute}{/*path}.md`
);

/**
 * Every request but Next.js' own assets passes through here.
 *
 * The site is anonymous, so the request goes on without its `Cookie` header: no cookie, such as
 * a sign-in marker set for the parent domain, reaches a route or a rewritten request.
 *
 * A docs page's URL answers HTML, or its Markdown twin when `Accept` prefers it
 * (`lib/accept.ts`). Both answers are `Cache-Control: private, no-store`, so no shared cache can
 * hand one reader the other's: a self-hosted Next.js drops `Accept` from the HTML's `Vary`,
 * whatever `next.config.mjs` asks. A `.md` URL is the twin itself, from that file's rewrites,
 * and stays cacheable.
 *
 * Next.js sometimes carries the rewrite out as an HTTP fetch of the twin route's own path, as
 * when it is started with `--hostname 127.0.0.1`, and then answers with that fetch's headers,
 * not the ones set here. So a request for the twin route's own path is `no-store` too.
 */
export default function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  const { pathname } = request.nextUrl;
  const twin = !pathname.endsWith(".md") && markdownTwin(pathname);

  const response =
    twin !== false && prefersMarkdown(request.headers.get("accept"))
      ? NextResponse.rewrite(new URL(twin, request.nextUrl), { request: { headers } })
      : NextResponse.next({ request: { headers } });
  if (twin !== false || pathname.startsWith(`${twinRoute}/`))
    response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
