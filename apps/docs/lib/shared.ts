import { createGetUrl } from "fumadocs-core/source";

export const appName = "Patchy Cloud";
export const docsRoute = "/docs";
export const docsContentRoute = "/llms.mdx/docs";

const getContentUrl = createGetUrl(docsContentRoute);

/** The internal route serving a page's markdown; `proxy.ts` maps `<page>.md` and `Accept: text/markdown` onto it. */
export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, "content.md"];

  return { segments, url: getContentUrl(segments, page.locale) };
}
