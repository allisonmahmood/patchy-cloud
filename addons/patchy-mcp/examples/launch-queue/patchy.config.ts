import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "launch-queue", tier: 2,
  tables: {
    items: table("Launch work and its current blocker, owned by the Launch Queue Tool.", {
      title: t.text(), owner: t.text(), status: t.text(), blocker: t.text()
    }, { indexes: { byStatus: ["status"] } })
  },
  files: {}, uses: {}
});
