import { docsLlms } from "@/lib/source";

export const revalidate = false;
// Other paths are 404s, never cached responses.
export const dynamicParams = false;

/**
 * Each page's Markdown twin. `next.config.mjs` rewrites `<page>.md` here, and `proxy.ts` rewrites
 * a page's own URL here when the request prefers `text/markdown`.
 */
export async function GET(_request: Request, { params }: RouteContext<"/llms.mdx/[...path]">) {
  const { path } = await params;
  return (await docsLlms.serve(`/${path.join("/")}`)) ?? new Response(null, { status: 404 });
}

export async function generateStaticParams() {
  const params: { path: string[] }[] = [];
  for (const file of await docsLlms.files()) {
    // `/llms.txt` and `/llms-full.txt` have their own routes.
    if (!/^\/llms(-full)?\.txt$/.test(file))
      params.push({ path: decodeURI(file).slice(1).split("/") });
  }
  return params;
}
