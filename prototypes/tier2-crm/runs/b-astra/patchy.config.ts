import { defineConfig, table, files, t } from "patchy/config";

export default defineConfig({
  name: "crm-b-astra",
  tier: 2,
  tables: {
    members: table(
      "Authenticated CRM visitors, keyed by userId, used for ownership handoffs.",
      {
        userId: t.text(),
        name: t.text(),
        email: t.text()
      },
      { indexes: { byUser: { columns: ["userId"], unique: true } } }
    ),
    companies: table(
      "One customer company per id; nameKey is its normalized unique name; ownerId is its owning user.",
      {
        name: t.text(),
        nameKey: t.text(),
        website: t.text().default(""),
        notes: t.text().default(""),
        ownerId: t.text()
      },
      { indexes: { byName: { columns: ["nameKey"], unique: true } } }
    ),
    contacts: table(
      "One contact per id; email is normalized and unique; companyId links its company and ownerId its owner.",
      {
        firstName: t.text(),
        lastName: t.text(),
        email: t.text(),
        title: t.text().default(""),
        phone: t.text().default(""),
        companyId: t.ref("companies"),
        ownerId: t.text()
      },
      { indexes: { byEmail: { columns: ["email"], unique: true }, byCompany: ["companyId"] } }
    ),
    deals: table(
      "One sales deal per id; companyId links its company, valueCents is integer USD cents; private deals are selected only for ownerId.",
      {
        title: t.text(),
        companyId: t.ref("companies"),
        valueCents: t.integer(),
        stage: t.text(),
        private: t.boolean().default(false),
        ownerId: t.text(),
        notes: t.text().default("")
      },
      {
        indexes: {
          byPublicStage: ["private", "stage"],
          byOwnerStage: ["ownerId", "stage"],
          byCompany: ["companyId"]
        }
      }
    )
  },
  files: {
    attachments: files(
      "Deal attachments keyed by deal id / unique upload id / original filename; private and ownership access is enforced by server handlers."
    )
  },
  uses: {
    contracts: { kind: "sharedStore", patchId: "bhqb6nld1vtz", store: "documents" },
    finance: { kind: "postgres", handle: "finance" }
  }
});
