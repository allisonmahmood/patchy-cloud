import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "spend-finance",
  tier: 1,
  tables: {
    requests: table(
      "One spend request per id. title is what the money is for; amountCents is integer USD cents; category is Software, Travel, Equipment, Events or Other. requestedBy is the requester's display name and requestedById their user id (null for sample rows). status is Pending, Approved or Rejected; decidedBy/decidedById/decidedAt/note record the teammate's decision.",
      {
        title: t.text(),
        vendor: t.text(),
        amountCents: t.integer(),
        category: t.text(),
        reason: t.text(),
        requestedBy: t.text(),
        requestedById: t.text().optional(),
        requestedAt: t.timestamp(),
        status: t.text().default("Pending"),
        decidedBy: t.text().optional(),
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
