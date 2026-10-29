import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "hotkeys-demo",
  tier: 1,
  tables: {
    tasks: table("One task per id: what to do and whether it is done.", {
      title: t.text(),
      done: t.boolean()
    })
  },
  files: {},
  uses: {}
});
