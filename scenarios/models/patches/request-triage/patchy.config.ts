import { defineConfig, models, table, t } from "patchy/config";

export default defineConfig({
  name: "request-triage",
  tier: 2,
  tables: {
    requests: table(
      "One triaged request per id: what was pasted, the team and urgency the decision role chose, how likely it's spam, and the reply the text role drafted.",
      {
        subject: t.text(),
        body: t.text(),
        team: t.text(),
        urgency: t.text(),
        spam: t.number(),
        reply: t.text(),
        by: t.text()
      }
    )
  },
  files: {},
  uses: {
    triage: models("decisions"),
    writer: models("writer"),
    thinker: models("thinker"),
    stuck: models("stuck"),
    limited: models("limited"),
    refuser: models("refuser"),
    picky: models("picky"),
    sloppy: models("sloppy"),
    rambler: models("rambler"),
    offline: models("offline")
  }
});
