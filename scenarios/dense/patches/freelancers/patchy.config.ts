import { defineConfig, table, t } from "patchy/config";

// The starter's notes, under the patch's own name, declaring imap/applications.
export default defineConfig({
  name: "freelancers",
  tier: 2,
  tables: { notes: table("One note per id, with a title.", { title: t.text() }) },
  files: {},
  uses: { applications: { kind: "imap", handle: "applications" } }
});
