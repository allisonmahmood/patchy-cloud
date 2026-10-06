import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "spend-patchy",
  tier: 1,
  tables: {
    requests: table(
      "One spend request per id. amountCents is the requested amount in integer USD cents. category is Software, Travel, Equipment, Events or Other. requestedByName/requestedById identify who asked (id is null for imported sample rows); requestedAt is when they asked. status is pending, approved or rejected; decidedByName/decidedById, decidedAt and note record the teammate's decision.",
      {
        title: t.text(),
        vendor: t.text(),
        amountCents: t.integer(),
        category: t.text(),
        reason: t.text().optional(),
        requestedByName: t.text(),
        requestedById: t.text().optional(),
        requestedAt: t.timestamp(),
        status: t.text().default("pending"),
        decidedByName: t.text().optional(),
        decidedById: t.text().optional(),
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
