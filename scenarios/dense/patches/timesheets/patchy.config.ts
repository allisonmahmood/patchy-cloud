import { defineConfig, table, t } from "patchy/config";

// The starter's notes, under the patch's own name, declaring postgres/warehouse.
export default defineConfig({
  name: "timesheets",
  tier: 2,
  tables: { notes: table("One note per id, with a title.", { title: t.text() }) },
  files: {},
  uses: { warehouse: { kind: "postgres", handle: "warehouse" } }
});
