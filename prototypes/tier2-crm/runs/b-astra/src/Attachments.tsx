import { useFileUrl, useQuery, useRef, useState } from "patchy/preact";
import type { Upload } from "patchy/client";
import type { Id } from "patchy/config";
import type { FileEntry as Entry } from "patchy/server";
import { patchy, isHandlerError, isPatchyError } from "../patchy/_generated/client.js";

type Attempt = {
  uploadId: string;
  name: string;
  key: string;
  state: "staging" | "staged" | "attaching" | "stored" | "not_stored" | "unknown";
  detail: string;
  upload: Upload | null;
};
const maxBytes = 20 * 1024 * 1024;
const stateLabels = {
  staging: "Not stored. Staging in progress.",
  staged: "Staged only.",
  attaching: "Storage outcome pending.",
  stored: "Stored.",
  not_stored: "Not stored.",
  unknown: "Storage outcome unknown."
};

function formatBytes(size: number) {
  return `${size.toLocaleString()} bytes (${(size / 1024 / 1024).toFixed(2)} MiB)`;
}

function safeName(name: string) {
  const clean = name.normalize("NFC").trim();
  if (
    !clean ||
    clean === "." ||
    clean === ".." ||
    /[/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)
  ) {
    throw new Error(
      "Choose a file with a nonempty filename and no path separators or control characters."
    );
  }
  const sanitized = clean.replace(/[<>:"|?*]/g, "_");
  if (new TextEncoder().encode(sanitized).byteLength > 255)
    throw new Error("The filename must fit within 255 UTF-8 bytes.");
  return sanitized;
}

function failure(cause: unknown) {
  if (isHandlerError(cause) || isPatchyError(cause)) return `${cause.code}: ${cause.message}`;
  return cause instanceof Error ? cause.message : "The request did not return a usable response.";
}

function AttachmentImage({ entry }: { entry: Entry }) {
  const { url, error } = useFileUrl(entry.handle);
  const [failedUrl, setFailedUrl] = useState<string | undefined>();
  if (error) return <p className="error">Preview unavailable: {failure(error)}</p>;
  if (url && failedUrl === url)
    return (
      <p className="muted">
        This file could not be displayed as an image. You can still download it.
      </p>
    );
  return url ? (
    <img
      className="attachment-preview"
      src={url}
      alt={entry.name.split("/").at(-1)}
      onError={() => setFailedUrl(url)}
      style={{ maxWidth: "100%", maxHeight: "180px", objectFit: "contain" }}
    />
  ) : (
    <p className="muted">Loading preview...</p>
  );
}

function AttachmentCard({
  entry,
  canEdit,
  busy,
  onRemove
}: {
  entry: Entry;
  canEdit: boolean;
  busy: boolean;
  onRemove: (entry: Entry) => void;
}) {
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const name = entry.name.split("/").at(-1) ?? entry.name;
  const image = /^(image\/(png|jpeg|gif|webp|avif|bmp))$/i.test(entry.contentType);
  const download = async () => {
    setError("");
    setDownloading(true);
    try {
      await patchy.files.download(entry.handle, name);
    } catch (cause) {
      setError(`Download failed. ${failure(cause)}`);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <li className="panel attachment-card">
      <strong>{name}</strong>
      <p className="muted">
        {formatBytes(entry.size)} · {entry.contentType || "application/octet-stream"}
      </p>
      <p className="muted">Stored {new Date(entry.updatedAt).toLocaleString()}</p>
      {image && <AttachmentImage entry={entry} />}
      <div className="toolbar">
        <button
          type="button"
          className="button secondary"
          disabled={downloading}
          onClick={() => void download()}
        >
          {downloading ? "Downloading..." : "Download"}
        </button>
        {canEdit && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => onRemove(entry)}
          >
            Remove
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <details>
        <summary className="muted">File key</summary>
        <code style={{ overflowWrap: "anywhere" }}>{entry.name}</code>
      </details>
    </li>
  );
}

function AttachmentPanel({ dealId, canEdit }: { dealId: Id<"deals">; canEdit: boolean }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const query = useQuery(patchy.server.attachments.list, { dealId, ...(cursor ? { cursor } : {}) });
  const [selected, setSelected] = useState<File | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [reconcileKey, setReconcileKey] = useState("");
  const [reconcileNotice, setReconcileNotice] = useState("");
  const unresolved = attempt?.state === "unknown" || attempt?.state === "attaching";
  const begin = () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  };
  const finish = () => {
    busyRef.current = false;
    setBusy(false);
  };

  const stage = async () => {
    if (!selected || !canEdit || unresolved || !begin()) return;
    setNotice("");
    let next: Attempt | null = null;
    try {
      const name = safeName(selected.name);
      if (selected.size > maxBytes)
        throw new Error(
          "The selected file exceeds the 20 MiB limit. No staging or attach request was sent."
        );
      const uploadId = crypto.randomUUID();
      const key = `${dealId}/${uploadId}/${name}`;
      if (new TextEncoder().encode(key).byteLength > 512)
        throw new Error("The file key exceeds 512 UTF-8 bytes. Choose a shorter filename.");
      next = {
        uploadId,
        name,
        key,
        state: "staging",
        detail: "No attach action has been sent.",
        upload: null
      };
      setAttempt(next);
      setReconcileKey(key);
      setReconcileNotice("");
      const upload = await patchy.files.stage(selected, {
        contentType: selected.type || "application/octet-stream"
      });
      if (upload.size > maxBytes) {
        setAttempt({
          ...next,
          state: "staged",
          detail: `Patchy measured ${formatBytes(upload.size)}, over the 20 MiB limit. These bytes were staged but not attached. Choose a smaller file.`,
          upload: null
        });
      } else {
        setAttempt({
          ...next,
          state: "staged",
          detail: `Patchy measured ${formatBytes(upload.size)}. Nothing is attached to the deal yet. Choose Attach staged file to store it.`,
          upload
        });
      }
    } catch (cause) {
      if (next) {
        const staging = isPatchyError(cause, "unknown_outcome")
          ? "The temporary staging outcome is unknown; no upload token was received."
          : "No usable staged upload was returned; temporary staging availability is unconfirmed.";
        setAttempt({
          ...next,
          state: "not_stored",
          detail: `Staging failed. ${staging} No attach action was sent, so this file was not stored on the deal. ${failure(cause)}`
        });
      } else setNotice(`Not stored. ${failure(cause)}`);
    } finally {
      finish();
    }
  };

  const attach = async () => {
    if (!attempt?.upload || !canEdit || !begin()) return;
    const current = attempt;
    const upload = attempt.upload;
    setAttempt({
      ...current,
      state: "attaching",
      upload: null,
      detail:
        "The attach action was sent once. Waiting for its outcome; it will not be replayed automatically."
    });
    try {
      await patchy.server.attachments.upload({
        dealId,
        uploadId: current.uploadId,
        name: current.name,
        file: upload
      });
      setAttempt({
        ...current,
        state: "stored",
        upload: null,
        detail:
          "The file store confirmed the write. The live list will show it on its filename-ordered page. There is no separate attachment record to save."
      });
    } catch (cause) {
      if (isHandlerError(cause, "already_exists")) {
        setAttempt({
          ...current,
          state: "stored",
          upload: null,
          detail:
            "A file already existed at this key. This action did not overwrite it or adopt the staged bytes. Reconcile the key to check the stored file."
        });
      } else if (
        isHandlerError(cause) &&
        ["not_found", "not_owner", "invalid_key", "invalid_name", "too_large"].includes(cause.code)
      ) {
        setAttempt({
          ...current,
          state: "staged",
          upload: null,
          detail: `The action was rejected before writing. The staged bytes were not adopted. ${failure(cause)} To try again, deliberately stage a new upload; this upload will not be replayed.`
        });
      } else {
        setAttempt({
          ...current,
          state: "unknown",
          upload: null,
          detail: `The action failed without a confirmed storage outcome. The file may be stored. ${failure(cause)} Reconcile this key before deciding what to do next. No upload will be replayed automatically.`
        });
      }
    } finally {
      finish();
    }
  };

  const reconcile = async () => {
    const key = reconcileKey.trim();
    if (!key || !begin()) return;
    setReconcileNotice("Checking this exact file key...");
    try {
      const entry = await patchy.server.attachments.stat({ dealId, key });
      const detail = entry
        ? `Stored at the last check. ${formatBytes(entry.size)}; ${entry.contentType}. No upload was replayed.`
        : "Not stored at the last check. No upload was replayed. A request whose response was lost may still finish; check again before deliberately staging another upload.";
      setReconcileNotice(detail);
      setAttempt((previous) =>
        previous?.key === key
          ? { ...previous, state: entry ? "stored" : "not_stored", detail, upload: null }
          : previous
      );
    } catch (cause) {
      const detail = `Storage state remains unknown because reconciliation failed. ${failure(cause)} No upload or removal was replayed.`;
      setReconcileNotice(detail);
      setAttempt((previous) =>
        previous?.key === key ? { ...previous, state: "unknown", detail, upload: null } : previous
      );
    } finally {
      finish();
    }
  };

  const remove = async (entry: Entry) => {
    if (!canEdit || !begin()) return;
    setReconcileKey(entry.name);
    setReconcileNotice("");
    setNotice(`Removal pending for ${entry.name}.`);
    try {
      const result = await patchy.server.attachments.remove({ dealId, key: entry.name });
      setNotice(
        result.removed
          ? `Not stored. Removal confirmed for ${entry.name}.`
          : `Not stored. ${entry.name} was already absent when removal ran.`
      );
      setAttempt((previous) =>
        previous?.key === entry.name
          ? {
              ...previous,
              state: "not_stored",
              detail: "Removal confirmed. No file remains at this key as of the completed removal.",
              upload: null
            }
          : previous
      );
    } catch (cause) {
      if (
        isHandlerError(cause) &&
        ["not_found", "not_owner", "invalid_key", "invalid_name"].includes(cause.code)
      ) {
        setNotice(
          `This removal was rejected before deleting anything. ${failure(cause)} Reconcile the key to check its current storage state.`
        );
      } else {
        setNotice(
          `Removal outcome unknown for ${entry.name}. The file may or may not remain stored. ${failure(cause)} Reconcile this key; the removal will not be replayed automatically.`
        );
      }
    } finally {
      finish();
    }
  };

  return (
    <section className="panel attachments">
      <div className="toolbar">
        <h3>Attachments</h3>
        <span className="badge">{query.status === "up-to-date" ? "Live" : query.status}</span>
      </div>
      {query.error ? (
        <div>
          <p role="alert" className="error">
            Attachments unavailable. {failure(query.error)} Previously returned files are hidden.
          </p>
          {cursors.length > 1 && (
            <button
              type="button"
              className="button secondary"
              onClick={() => setCursors([undefined])}
            >
              Return to first page
            </button>
          )}
        </div>
      ) : query.data === undefined ? (
        <p className="muted">Loading attachments...</p>
      ) : (
        <>
          {canEdit ? (
            <div className="panel">
              <label className="field">
                Choose an attachment
                <input
                  type="file"
                  disabled={busy || unresolved}
                  onChange={(event) => {
                    setSelected(event.currentTarget.files?.[0] ?? null);
                    setNotice(
                      attempt?.state === "staged"
                        ? "The previous staged upload was not attached. Stage the newly selected file to continue."
                        : ""
                    );
                    setAttempt(null);
                  }}
                />
              </label>
              <p className="muted">
                Maximum 20 MiB (20,971,520 bytes). Staging does not attach a file. The server checks
                Patchy's measured size before storing it.
              </p>
              {selected && (
                <p className="muted">
                  Selected: {selected.name}, {formatBytes(selected.size)}
                </p>
              )}
              <div className="toolbar">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || !selected || unresolved}
                  onClick={() => void stage()}
                >
                  {attempt?.state === "staging" ? "Staging..." : "Stage selected file"}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy || !attempt?.upload}
                  onClick={() => void attach()}
                >
                  {attempt?.state === "attaching" ? "Attaching..." : "Attach staged file"}
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">Only the current deal owner can add or remove attachments.</p>
          )}
          {query.data.files.length === 0 ? (
            <p className="muted">No attachments on this page.</p>
          ) : (
            <ul className="attachment-list" style={{ listStyle: "none", padding: 0 }}>
              {query.data.files.map((entry) => (
                <AttachmentCard
                  key={entry.name}
                  entry={entry}
                  canEdit={canEdit}
                  busy={busy}
                  onRemove={(file) => void remove(file)}
                />
              ))}
            </ul>
          )}
          <div className="toolbar">
            <button
              type="button"
              className="button secondary"
              disabled={cursors.length === 1}
              onClick={() => setCursors((pages) => pages.slice(0, -1))}
            >
              Previous files
            </button>
            <span className="muted">Page {cursors.length}, up to 100 files per page</span>
            <button
              type="button"
              className="button secondary"
              disabled={!query.data.cursor}
              onClick={() => {
                const next = query.data?.cursor;
                if (next) setCursors((pages) => [...pages, next]);
              }}
            >
              Next files
            </button>
          </div>
        </>
      )}
      {attempt && (
        <div
          className={attempt.state === "unknown" ? "error" : "notice"}
          role="status"
          aria-live="polite"
        >
          <strong>{stateLabels[attempt.state]}</strong> {attempt.detail}
          <p>
            File key: <code style={{ overflowWrap: "anywhere" }}>{attempt.key}</code>
          </p>
        </div>
      )}
      {notice && (
        <p className="notice" role="status" aria-live="polite">
          {notice}
        </p>
      )}
      <div className="panel">
        <label className="field">
          Reconcile a file key
          <input
            type="text"
            value={reconcileKey}
            disabled={busy}
            placeholder={`${dealId}/upload-id/filename`}
            onChange={(event) => setReconcileKey(event.currentTarget.value)}
          />
        </label>
        <p className="muted">
          Checks the file store without uploading or deleting. Keep the key if you need to check
          again after leaving this page.
        </p>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !reconcileKey.trim()}
          onClick={() => void reconcile()}
        >
          Check storage by key
        </button>
        {reconcileNotice && (
          <p className="notice" role="status" aria-live="polite">
            {reconcileNotice}
          </p>
        )}
      </div>
    </section>
  );
}

export function Attachments({ dealId, canEdit }: { dealId: Id<"deals">; canEdit: boolean }) {
  return <AttachmentPanel key={dealId} dealId={dealId} canEdit={canEdit} />;
}
