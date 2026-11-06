// The attachments the importer saved, each with its stored bytes' sha256 worked out again here,
// so a reader can check a file against the one the sender attached.
import { action, t } from "../patchy/_generated/server.js";

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const savedFiles = action({
  readOnly: true,
  description:
    "Lists the attachments the importer kept: the sender's filename, the size in bytes, the digest Patchy staged with, and the digest of the bytes stored now. A file past 20 MiB is listed without one.",
  args: {},
  result: t.array(
    t.object({
      filename: t.nullable(t.text()),
      size: t.integer(),
      file: t.nullable(t.text()),
      staged: t.nullable(t.text()),
      stored: t.nullable(t.text())
    })
  ),
  handler: async (ctx) => {
    const { rows } = await ctx.tables.attachments.list({ limit: 100 });
    const files = [];
    for (const row of rows) {
      const bytes = row.file === null ? null : await ctx.files.documents.get(row.file);
      files.push({
        filename: row.filename,
        size: row.size,
        file: row.file,
        staged: row.sha256,
        stored:
          bytes === null ? null : hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))
      });
    }
    return files;
  }
});
