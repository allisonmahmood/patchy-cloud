import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "kudos",
  tier: 1,
  tables: {
    kudos: table(
      "One public shout-out per id: sender thanks recipient (both member ids) for one studio value. value is a key: craft, client-love, teamwork, above-and-beyond or fresh-thinking. message is at most 280 characters. sentAt is when it was sent (ISO timestamp).",
      {
        recipient: t.member(),
        sender: t.member(),
        message: t.text(),
        value: t.text(),
        sentAt: t.timestamp()
      },
      {
        indexes: {
          bySentAt: ["sentAt"],
          byRecipient: ["recipient", "sentAt"],
          byValue: ["value", "sentAt"],
          byRecipientValue: ["recipient", "value", "sentAt"]
        }
      }
    ),
    reactions: table(
      "One emoji reaction per id: member reacted to the kudos row with emoji, one of 👏 🎉 ❤️ 🔥. At most one per kudos, member and emoji.",
      {
        kudos: t.ref("kudos"),
        member: t.member(),
        emoji: t.text()
      },
      { indexes: { byKudosMemberEmoji: { columns: ["kudos", "member", "emoji"], unique: true } } }
    )
  },
  files: {},
  uses: { members: { kind: "members" } }
});
