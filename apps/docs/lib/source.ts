import { llms, loader } from "fumadocs-core/source";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { docsRoute } from "./shared";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    // Keeps each page's Markdown for its twin, `llms-full.txt` and copy-as-Markdown, without
    // Fumadocs' `[#id]` heading markers.
    postprocess: { includeProcessedMarkdown: { headingIds: false } }
  },
  meta: { schema: metaSchema }
});

/** Every page under `content/docs`, at `/docs/<slug>`, in the sidebar order `meta.json` sets. */
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource()
});

/** Serves `/llms.txt`, `/llms-full.txt` and each page's `.md` twin. */
export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText("processed")}`
});
