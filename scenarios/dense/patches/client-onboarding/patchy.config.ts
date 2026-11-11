import { defineConfig, table, t } from "patchy/config";

// The starter's notes, under the patch's own name, declaring pidgeon/hello.
export default defineConfig({
  name: "client-onboarding",
  tier: 2,
  tables: { notes: table("One note per id, with a title.", { title: t.text() }) },
  files: {},
  uses: { hello: { kind: "pidgeon", handle: "hello" } }
});
