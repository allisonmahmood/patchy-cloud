import { defineConfig, models } from "patchy/config";

export default defineConfig({
  name: "request-triage",
  tier: 2,
  tables: {},
  files: {},
  uses: { triage: models("triage"), writer: models("writer") }
});
