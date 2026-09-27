import { defineConfig, table, files, t } from "patchy/config";

export default defineConfig({
  name: "crm-a-opus",
  tier: 2,
  tables: {
    members: table(
      "One teammate who has opened the CRM, keyed by their Patchy user id; the list of people a record can be handed to.",
      { userId: t.text(), name: t.text(), email: t.text() },
      { indexes: { byUser: { columns: ["userId"], unique: true } } }
    ),
    companies: table(
      "One customer company per id; nameKey is the lower-cased trimmed name and is unique; ownerId is the owning teammate's Patchy user id.",
      { name: t.text(), nameKey: t.text(), website: t.text().optional(), ownerId: t.text() },
      { indexes: { byNameKey: { columns: ["nameKey"], unique: true }, byName: ["name"] } }
    ),
    contacts: table(
      "One person at a customer company per id; emailKey is the lower-cased trimmed email and is unique; ownerId is the owning teammate's Patchy user id.",
      {
        firstName: t.text(),
        lastName: t.text(),
        email: t.text(),
        emailKey: t.text(),
        company: t.ref("companies"),
        title: t.text().optional(),
        phone: t.text().optional(),
        ownerId: t.text()
      },
      { indexes: { byEmailKey: { columns: ["emailKey"], unique: true } } }
    ),
    deals: table(
      "One sales deal per id with a company; valueCents is integer US cents; stage is Lead, Qualified, Proposal, Won or Lost; a private deal is visible only to ownerId, the owning teammate's Patchy user id.",
      {
        title: t.text(),
        company: t.ref("companies"),
        valueCents: t.integer(),
        stage: t.text(),
        private: t.boolean().default(false),
        ownerId: t.text()
      },
      { indexes: { byStage: ["stage"] } }
    ),
    dealFiles: table(
      "One recorded file on a deal per id; name is the file name, stored in the attachments store at <deal id>/<name>; uploadedBy is a Patchy user id.",
      { deal: t.ref("deals"), name: t.text(), uploadedBy: t.text() }
    )
  },
  files: {
    attachments: files(
      "Deal attachments keyed <deal id>/<file name>; any content type (proposal PDFs, screenshots), at most 10 MB each."
    )
  },
  uses: {
    contracts: { kind: "sharedStore", patchId: "bhqb6nld1vtz", store: "documents" },
    finance: { kind: "postgres", handle: "finance" }
  }
});
