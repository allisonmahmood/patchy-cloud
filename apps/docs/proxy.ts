import { NextResponse, type NextRequest } from "next/server";
import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import { docsRoute } from "@/lib/shared";

const { rewrite: markdownTwin } = rewritePath(
  `${docsRoute}{/*path}`,
  `/llms.mdx${docsRoute}{/*path}.md`
);

/**
 * A docs page's URL answers HTML, or its Markdown twin when the request prefers
 * `text/markdown`. `next.config.mjs` gives both answers `Vary: Accept`. A `.md` URL is the twin
 * itself, served by that file's rewrites.
 */
export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const markdown =
    !pathname.endsWith(".md") && isMarkdownPreferred(request) && markdownTwin(pathname);
  return markdown ? NextResponse.rewrite(new URL(markdown, request.nextUrl)) : NextResponse.next();
}

export const config = { matcher: ["/docs", "/docs/:path*"] };
