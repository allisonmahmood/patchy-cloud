import { defineConfig, table, t } from "patchy/config";

// The starter's notes, under the patch's own name, declaring posthog/client-sites.
export default defineConfig({
  name: "holiday-rota",
  tier: 2,
  tables: { notes: table("One note per id, with a title.", { title: t.text() }) },
  files: {},
  uses: { sites: { kind: "posthog", handle: "client-sites" } }
});
