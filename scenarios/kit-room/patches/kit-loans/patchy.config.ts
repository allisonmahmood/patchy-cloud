import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "kit-loans",
  tier: 2,
  tables: {
    loans: table(
      "One piece of studio kit lent out per id: what it is, who has it (a member), when it is due back (empty for an open-ended loan) and whether it has come back.",
      {
        item: t.text(),
        borrower: t.member(),
        due: t.timestamp().optional(),
        returned: t.boolean()
      }
    )
  },
  files: {},
  uses: { members: { kind: "members" } }
});
