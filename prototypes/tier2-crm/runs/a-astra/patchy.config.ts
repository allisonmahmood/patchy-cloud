import { defineConfig, table, files, t } from "patchy/config";

export default defineConfig({
  name: "crm-a-astra",
  tier: 2,
  tables: {
    members: table(
      "Authenticated CRM teammates, keyed by userId; populated when each teammate opens the CRM.",
      {
        userId: t.text(),
        name: t.text(),
        email: t.text()
      },
      { indexes: { byUser: { columns: ["userId"], unique: true } } }
    ),
    companies: table(
      "One customer company; nameKey is its normalized unique name, ownerId is the responsible team member.",
      {
        name: t.text(),
        nameKey: t.text(),
        ownerId: t.text()
      },
      { indexes: { byName: { columns: ["nameKey"], unique: true } } }
    ),
    contacts: table(
      "One contact; email is lowercase and unique, companyId links a company, ownerId identifies its owner.",
      {
        firstName: t.text(),
        lastName: t.text(),
        email: t.text(),
        companyId: t.ref("companies"),
        title: t.text(),
        phone: t.text(),
        ownerId: t.text()
      },
      { indexes: { byEmail: { columns: ["email"], unique: true }, byCompany: ["companyId"] } }
    ),
    deals: table(
      "One sales opportunity belonging to companyId; valueCents is integer USD cents; private deals are owner-only.",
      {
        title: t.text(),
        companyId: t.ref("companies"),
        valueCents: t.integer(),
        stage: t.text(),
        private: t.boolean().default(false),
        ownerId: t.text()
      },
      { indexes: { byStage: ["stage"], byCompany: ["companyId"] } }
    )
  },
  files: {
    attachments: files(
      "Deal attachments keyed by dealId/uploadToken/filename. Private; handlers authorize against the deal before returning file handles."
    )
  },
  uses: {
    contracts: { kind: "sharedStore", patchId: "bhqb6nld1vtz", store: "documents" },
    finance: { kind: "postgres", handle: "finance" }
  }
});
