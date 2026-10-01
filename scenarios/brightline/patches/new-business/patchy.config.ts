import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "new-business",
  tier: 2,
  tables: {
    deals: table(
      "One pitch per id, from first lead to signed or lost work. client is the company, title the project; " +
        "service, stage and source are fixed labels (see helpers/pipeline.ts); value is the estimated fee in whole USD, " +
        "null until estimated; owner is the accountable member; expectedClose is a YYYY-MM-DD date. " +
        "lostReason is why a lost deal was lost (one of LOST_REASONS), null on every other stage. " +
        "openedAt, stageEnteredAt and lastActivityAt are display timestamps owned by the patch.",
      {
        client: t.text(),
        title: t.text(),
        service: t.text(),
        value: t.integer().optional(),
        stage: t.text(),
        owner: t.member().optional(),
        source: t.text(),
        nextStep: t.text().optional(),
        expectedClose: t.text().optional(),
        lostReason: t.text().optional(),
        openedAt: t.timestamp(),
        stageEnteredAt: t.timestamp(),
        lastActivityAt: t.timestamp()
      }
    ),
    activity: table(
      "One event on a deal's timeline; deal links the deal. kind is created, moved, assigned, edited, note or imported; " +
        "actor is the member who acted; fromStage/toStage are set on moves; assignee is the new owner on assignments " +
        "(null when unassigned); note holds note text, an edit summary, or the lost reason on a move to lost; " +
        "at is when it happened.",
      {
        deal: t.ref("deals"),
        kind: t.text(),
        actor: t.member(),
        fromStage: t.text().optional(),
        toStage: t.text().optional(),
        assignee: t.member().optional(),
        note: t.text().optional(),
        at: t.timestamp()
      },
      { indexes: { timeline: ["deal", "at"] } }
    )
  },
  files: {},
  uses: { members: { kind: "members" } }
});
