import { defineConfig, files, table, t } from "patchy/config";

export default defineConfig({
  name: "invoice-inbox",
  tier: 2,
  tables: {
    messages: table(
      "One imported message per mailbox ref. key is the folder, UIDVALIDITY and UID joined by slashes; subject, sender and received (ISO timestamp) are its summary as imported.",
      {
        key: t.text(),
        folder: t.text(),
        uid: t.integer(),
        subject: t.text().optional(),
        sender: t.text().optional(),
        received: t.timestamp().optional()
      },
      { indexes: { byKey: { columns: ["key"], unique: true } } }
    ),
    attachments: table(
      "One attachment per imported message key and part. size is in bytes; file is its name in the documents store, or null when it was past 20 MiB and kept by filename and size alone. filename is the sender's, display text only.",
      {
        message: t.text(),
        part: t.text(),
        filename: t.text().optional(),
        size: t.integer(),
        sha256: t.text().optional(),
        file: t.text().optional()
      },
      { indexes: { byMessagePart: { columns: ["message", "part"], unique: true } } }
    ),
    imports: table(
      "One per imported folder: the checkpoint of the last page whose rows are all stored.",
      { folder: t.text(), checkpoint: t.text() },
      { indexes: { byFolder: { columns: ["folder"], unique: true } } }
    )
  },
  files: {
    documents: files(
      "Imported attachments keyed by <folder, URI-encoded>.<UIDVALIDITY>/<UID>/<part>; the bytes as the sender attached them."
    )
  },
  uses: { mail: { kind: "imap", handle: "invoices" } }
});
