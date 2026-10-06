import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "spend-none",
  tier: 1,
  tables: {
    requests: table(
      "One spend request per id. amountCents is integer USD cents. category is one of Software, Travel, Equipment, Events, Other. requestedById is the Patchy user id of the requester when known (null for imported/sample rows), requestedByName their display name, requestedAt when they asked. status is pending, approved or rejected; decidedById/decidedByName/decidedAt/note record the teammate's decision.",
      {
        title: t.text(),
        vendor: t.text(),
        amountCents: t.integer(),
        category: t.text(),
        reason: t.text(),
        requestedById: t.text().optional(),
        requestedByName: t.text(),
        requestedAt: t.timestamp(),
        status: t.text().default("pending"),
        decidedById: t.text().optional(),
        decidedByName: t.text().optional(),
        decidedAt: t.timestamp().optional(),
        note: t.text().optional()
      },
      {
        indexes: {
          byRequestedAt: ["requestedAt"],
          byStatus: ["status", "requestedAt"],
          byStatusDecided: ["status", "decidedAt"]
        }
      }
    )
  },
  files: {},
  uses: {}
});
