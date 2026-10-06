import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "halloween-finance",
  tier: 1,
  tables: {
    entries: table(
      "One costume contest entry per id; name is the entrant, costume is the costume title, category is one of scariest, funniest or group.",
      { name: t.text(), costume: t.text(), category: t.text() },
      { indexes: { byCategory: ["category"] } }
    ),
    votes: table(
      "One vote per id; entry identifies the voted-for entry, voter is the voting viewer's user id. At most one vote per viewer per entry.",
      { entry: t.ref("entries"), voter: t.text() },
      { indexes: { byEntryVoter: { columns: ["entry", "voter"], unique: true } } }
    )
  },
  files: {},
  uses: {}
});
