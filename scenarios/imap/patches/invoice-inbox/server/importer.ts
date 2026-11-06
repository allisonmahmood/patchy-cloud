// Imports a folder's mail from a day on into `messages` and `attachments`, and the files into the
// `documents` store. Each page's rows go in before its checkpoint, so a run that stops anywhere
// resumes from the last page it finished; files are named by ref and part, so a page read again
// writes the same rows and files rather than duplicates.
import { action, t } from "../patchy/_generated/server.js";

type Ref = {
  readonly connection: string;
  readonly folder: string;
  readonly uidValidity: number;
  readonly uid: number;
};
/** The code Patchy refused a call with, such as `too_large`; undefined for anything else. */
const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
const keyOf = (ref: Ref) => `${ref.folder}/${ref.uidValidity}/${ref.uid}`;
/** A store name from the ref and part alone: the sender's filename is display text. */
const fileOf = (ref: Ref, part: string) =>
  `${encodeURIComponent(ref.folder)}.${ref.uidValidity}/${ref.uid}/${part}`;

export const importFolder = action({
  description:
    "Imports a folder's mail received since a day (YYYY-MM-DD) into the patch's messages and attachments, saving each attachment's file, and carries on from where the last run stopped.",
  args: { folder: t.text(), since: t.text() },
  result: t.object({ imported: t.integer(), done: t.boolean(), stopped: t.nullable(t.text()) }),
  handler: async (ctx, { folder, since }) => {
    const mail = ctx.connections.mail;
    const state = (await ctx.tables.imports.list({ index: "byFolder", eq: { folder } })).rows[0];
    let stateId = state?.id;
    // From the stored checkpoint, or from `since` the first time. A cursor goes back with the
    // same arguments its scan started with.
    const start = state === undefined ? { folder, since } : { folder, after: state.checkpoint };
    let cursor: string | undefined;
    let imported = 0;
    do {
      const page = await mail.scanMessages({
        ...start,
        ...(cursor === undefined ? {} : { cursor })
      });
      const read =
        page.messages.length === 0 ? [] : await mail.getMessages(page.messages.map((m) => m.ref));
      for (const message of read) {
        // Gone since the page was read: deleted or moved, so nothing to keep.
        if ("error" in message) continue;
        const key = keyOf(message.ref);
        for (const part of message.parts) {
          // What a person reading the mail calls an attachment, a forwarded message's included.
          if (!part.attachment) continue;
          const file = fileOf(message.ref, part.part);
          let stored: { readonly size: number; readonly sha256: string } | null = null;
          try {
            const staged = await mail.stageAttachment({ ref: message.ref, part: part.part });
            // Adopt each upload at once: staged ones count against the viewer until adopted.
            await ctx.files.documents.put(file, staged.upload);
            stored = staged;
          } catch (error) {
            // Staged uploads are full: stop before this page's checkpoint, and pick the page up
            // again on the next run.
            if (codeOf(error) === "limit_exceeded")
              return { imported, done: false, stopped: "limit_exceeded" };
            // Past 20 MiB: kept below by its filename and its size on the wire, without the file.
            if (codeOf(error) !== "too_large") throw error;
          }
          const kept = {
            message: key,
            part: part.part,
            filename: part.filename,
            size: stored?.size ?? part.encodedSize,
            sha256: stored?.sha256 ?? null,
            file: stored === null ? null : file
          };
          const found = (
            await ctx.tables.attachments.list({
              index: "byMessagePart",
              eq: { message: key, part: part.part }
            })
          ).rows[0];
          if (found === undefined) await ctx.tables.attachments.insert(kept);
          else await ctx.tables.attachments.update(found.id, kept);
        }
        const row = {
          key,
          folder,
          uid: message.ref.uid,
          subject: message.subject,
          sender: message.from[0]?.address ?? null,
          received: message.internalDate
        };
        const found = (await ctx.tables.messages.list({ index: "byKey", eq: { key } })).rows[0];
        if (found === undefined) await ctx.tables.messages.insert(row);
        else await ctx.tables.messages.update(found.id, row);
        imported++;
      }
      // Every row of this page is stored: only now does the checkpoint cover it.
      if (stateId === undefined)
        stateId = (await ctx.tables.imports.insert({ folder, checkpoint: page.checkpoint })).id;
      else await ctx.tables.imports.update(stateId, { checkpoint: page.checkpoint });
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    return { imported, done: true, stopped: null };
  }
});
