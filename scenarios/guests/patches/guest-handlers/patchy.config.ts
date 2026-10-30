import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "guest-handlers",
  tier: 2,
  tables: {
    notes: table("Notes written by visitors; author is the real account id.", {
      text: t.text(),
      author: t.text()
    })
  },
  files: {},
  uses: {}
});
