import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "spend-linear",
  tier: 1,
  tables: {
    requests: table(
      "One spend request per id. amountCents is integer USD cents; category is Software, Travel, Equipment, Events or Other; status is pending, approved or rejected. requesterId/deciderId are Patchy user ids (null for sample rows), requesterName/deciderName are display names as recorded. requestedAt is when it was asked, decidedAt when it was approved or rejected.",
      {
        title: t.text(),
        vendor: t.text(),
        amountCents: t.integer(),
        category: t.text(),
        reason: t.text(),
        requesterId: t.text().optional(),
        requesterName: t.text(),
        requestedAt: t.timestamp(),
        status: t.text().default("pending"),
        deciderId: t.text().optional(),
        deciderName: t.text().optional(),
        decisionNote: t.text().optional(),
        decidedAt: t.timestamp().optional()
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
