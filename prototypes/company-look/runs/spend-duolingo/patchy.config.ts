import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "spend-duolingo",
  tier: 1,
  tables: {
    requests: table(
      "One spend request per id. amountCents is integer USD cents. category is Software, Travel, Equipment, Events or Other. requestedByName/requestedById identify who asked (id is the Patchy user id, null for sample rows) at requestedAt. status is pending, approved or rejected; decidedByName/decidedById, decidedAt and the optional note record the decision.",
      {
        title: t.text(),
        vendor: t.text(),
        amountCents: t.integer(),
        category: t.text(),
        reason: t.text(),
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
          byStatusDecidedAt: ["status", "decidedAt"]
        }
      }
    )
  },
  files: {},
  uses: {}
});
