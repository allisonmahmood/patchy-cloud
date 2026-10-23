import { defineConfig } from "patchy/config";
export default defineConfig({
  name: "activepieces-demo",
  tier: 1,
  uses: { analytics: { kind: "posthog", handle: "analytics" } },
  tables: {},
  files: {}
});
