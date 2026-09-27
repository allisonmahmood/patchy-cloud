import { useRef, useState } from "patchy/preact";
import { useFileUrl, useQuery } from "patchy/preact";
import type { FileHandle } from "patchy/client";
import { patchy, isPatchyError } from "../patchy/_generated/client.js";
import { Alert, DeleteButton, describe, useTask, type DealId } from "./ui.js";

type Attachment = Awaited<ReturnType<typeof patchy.server.attachments.list>>[number];

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * A deal's attachments. Attaching is three steps (send the bytes, store them on the deal, record
 * them), and when one fails the notice says exactly which steps finished.
 */
export function Attachments({ dealId, canEdit }: { dealId: DealId; canEdit: boolean }) {
  const { data, error } = useQuery(patchy.server.attachments.list, { dealId });
  const input = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(
    null
  );
  const [busy, setBusy] = useState(false);

  const attach = async (file: File) => {
    setBusy(true);
    setNotice(null);
    let staged: Awaited<ReturnType<typeof patchy.files.stage>>;
    try {
      staged = await patchy.files.stage(file, {
        contentType: file.type || "application/octet-stream"
      });
    } catch (cause) {
      setNotice({
        tone: "error",
        text: `“${file.name}” was not attached: sending the file failed (${describe(cause)}). Nothing was saved.`
      });
      setBusy(false);
      return;
    }
    try {
      const result = await patchy.server.attachments.attach({
        dealId,
        name: file.name,
        file: staged
      });
      setNotice(
        result.recorded
          ? { tone: "ok", text: `Attached “${file.name}”.` }
          : {
              tone: "warn",
              text: `“${file.name}” is stored on the deal, but recording it failed (${result.problem ?? "unknown error"}). It is listed below as “not recorded”: finish it or remove it.`
            }
      );
    } catch (cause) {
      setNotice({
        tone: "error",
        text: isPatchyError(cause, "unknown_outcome")
          ? `No reply came back while storing “${file.name}”: it may or may not be saved. Check the list below before trying again.`
          : `“${file.name}” was sent but not stored on the deal: ${describe(cause)} Nothing was saved to the deal.`
      });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <section class="attachments">
      <div class="toolbar">
        <h2>Attachments</h2>
        {canEdit && (
          <label class="button">
            {busy ? "Attaching…" : "Attach file"}
            <input
              ref={input}
              type="file"
              hidden
              disabled={busy}
              accept="application/pdf,image/png,image/jpeg,image/gif,image/webp,text/plain"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void attach(file);
              }}
            />
          </label>
        )}
      </div>
      {notice && (
        <p class={`notice ${notice.tone}`} role={notice.tone === "ok" ? "status" : "alert"}>
          {notice.text}
        </p>
      )}
      {error && <Alert>{describe(error)}</Alert>}
      {data?.length === 0 && <p class="muted">No attachments yet.</p>}
      <ul class="files">
        {data?.map((file) => (
          <AttachmentRow key={file.key} dealId={dealId} file={file} canEdit={canEdit} />
        ))}
      </ul>
    </section>
  );
}

function AttachmentRow({
  dealId,
  file,
  canEdit
}: {
  dealId: DealId;
  file: Attachment;
  canEdit: boolean;
}) {
  const task = useTask();
  const [note, setNote] = useState("");
  const remove = () =>
    void task.run(async () => {
      const result = await patchy.server.attachments.remove({ dealId, key: file.key });
      if (!result.recordRemoved)
        setNote(
          `The file was deleted but its record was not (${result.problem}). Remove it again to clear it.`
        );
    });
  const finish = () =>
    void task.run(async () => {
      const result = await patchy.server.attachments.recordAgain({ dealId, key: file.key });
      setNote(result.recorded ? "" : `Recording failed again: ${result.problem}`);
    });
  return (
    <li>
      {file.handle && file.contentType.startsWith("image/") && <Preview handle={file.handle} />}
      <div class="grow">
        <strong>{file.name}</strong>{" "}
        <span class="muted">
          {size(file.size)} · {file.uploadedBy ? `added by ${file.uploadedBy}` : ""}
        </span>
        {!file.recorded && <span class="badge warn">not recorded</span>}
        {!file.stored && <span class="badge warn">file missing</span>}
      </div>
      {file.handle && (
        <button
          type="button"
          onClick={() => void task.run(() => patchy.files.download(file.handle!, file.name))}
        >
          Download
        </button>
      )}
      {canEdit && !file.recorded && (
        <button type="button" disabled={task.busy} onClick={finish}>
          Finish attaching
        </button>
      )}
      {canEdit && <DeleteButton label="Remove" busy={task.busy} onConfirm={remove} />}
      <Alert>{task.error || note}</Alert>
    </li>
  );
}

function Preview({ handle }: { handle: FileHandle }) {
  const { url, error } = useFileUrl(handle);
  if (error)
    return (
      <span class="thumb muted">{error.code === "not_found" ? "Replaced" : "Unavailable"}</span>
    );
  return url ? <img class="thumb" src={url} alt="" /> : <span class="thumb" />;
}
