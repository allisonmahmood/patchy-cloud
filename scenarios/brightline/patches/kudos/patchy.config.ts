import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "kudos",
  tier: 2,
  tables: {
    kudos: table(
      "One public shout-out per id: a sender (member or invited guest user id) thanks a studio recipient for one value. value is a key: craft, client-love, teamwork, above-and-beyond or fresh-thinking. message is at most 280 characters. sentAt is when it was sent (ISO timestamp).",
      {
        recipient: t.member(),
        sender: t.text(),
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
      "One emoji reaction per id: viewer (member or invited guest user id) reacted to the kudos row with emoji, one of 👏 🎉 ❤️ 🔥. At most one per kudos, viewer and emoji.",
      {
        kudos: t.ref("kudos"),
        member: t.text(),
        emoji: t.text()
      },
      { indexes: { byKudosMemberEmoji: { columns: ["kudos", "member", "emoji"], unique: true } } }
    )
  },
  files: {},
  uses: { members: { kind: "members" } }
});
