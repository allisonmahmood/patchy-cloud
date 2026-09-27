import { defineConfig, table, files, t } from "patchy/config";

// Every company, contact and deal carries its owner: ownerId is the Patchy user id of the
// person who may edit or delete it, ownerName their display name at the time of the last handoff.
export default defineConfig({
  name: "crm-b-opus",
  tier: 2,
  tables: {
    members: table(
      "One teammate per Patchy user who has opened the CRM; userId is their Patchy user id. Used to pick a new owner when handing a record over.",
      { userId: t.text(), name: t.text(), email: t.text() },
      { indexes: { byUser: { columns: ["userId"], unique: true } } }
    ),
    companies: table(
      "One customer company per id; nameKey is the trimmed lower-case name and is unique; ownerId is the owning user's id.",
      { name: t.text(), nameKey: t.text(), ownerId: t.text(), ownerName: t.text() },
      { indexes: { byNameKey: { columns: ["nameKey"], unique: true } } }
    ),
    contacts: table(
      "One person at a customer company per id; email is trimmed lower-case and unique; companyId links the company; ownerId is the owning user's id.",
      {
        firstName: t.text(),
        lastName: t.text(),
        email: t.text(),
        companyId: t.ref("companies"),
        title: t.text().optional(),
        phone: t.text().optional(),
        ownerId: t.text(),
        ownerName: t.text()
      },
      { indexes: { byEmail: { columns: ["email"], unique: true } } }
    ),
    deals: table(
      "One sales opportunity per id; companyId links the company; valueCents is integer USD cents; stage is Lead, Qualified, Proposal, Won or Lost; a private deal is visible only to ownerId.",
      {
        title: t.text(),
        companyId: t.ref("companies"),
        valueCents: t.integer(),
        stage: t.text(),
        private: t.boolean().default(false),
        ownerId: t.text(),
        ownerName: t.text()
      },
      { indexes: { byPrivate: ["private"], byOwnerPrivate: ["ownerId", "private"] } }
    ),
    attachments: table(
      "One file attached to a deal per id; dealId links the deal; key is the file's name in the dealFiles store; size is bytes.",
      {
        dealId: t.ref("deals"),
        key: t.text(),
        name: t.text(),
        contentType: t.text(),
        size: t.integer(),
        uploadedBy: t.text()
      },
      { indexes: { byKey: { columns: ["key"], unique: true } } }
    )
  },
  files: {
    dealFiles: files(
      "Deal attachments keyed by <dealId>/<file name>, such as a proposal PDF or a screenshot."
    )
  },
  uses: {
    contracts: { kind: "sharedStore", patchId: "bhqb6nld1vtz", store: "documents" },
    finance: { kind: "postgres", handle: "finance" }
  }
});
