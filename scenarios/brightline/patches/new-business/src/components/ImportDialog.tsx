import { useRef, useState } from "patchy/preact";
import { patchy } from "../../patchy/_generated/client.js";
import { MAX_IMPORT_ROWS } from "../../helpers/pipeline.js";
import { previewImport, templateCsv, type ImportPreview } from "../csv.js";
import { describeError, isDismissedDownload } from "../errors.js";
import { compactMoney, parseMoney } from "../format.js";
import { useEscape } from "../hooks.js";
import type { Notify, Person } from "../types.js";

type PeoplePage = Awaited<ReturnType<typeof patchy.server.team.people>>;

/** Every active member, for matching the CSV's owner emails. */
async function allPeople() {
  const people: Person[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const result: PeoplePage = await patchy.server.team.people({ search: "", cursor });
    people.push(...result.people.filter((person) => person.active));
    cursor = result.cursor;
    if (cursor === null) break;
  }
  return people;
}

/** CSV import of leads: pick a file, preview with bad rows flagged, import the rest in one go. */
export function ImportDialog({ notify, onClose }: { notify: Notify; onClose: () => void }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState<"reading" | "importing" | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEscape(onClose);

  async function read(file: File) {
    setBusy("reading");
    setRefusal(null);
    try {
      const [text, people] = await Promise.all([file.text(), allPeople()]);
      setPreview(
        previewImport(text, new Map(people.map((person) => [person.email.toLowerCase(), person])))
      );
      setFileName(file.name);
    } catch (error) {
      setRefusal(describeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function downloadTemplate() {
    try {
      await patchy.download(
        "new-business-leads-template.csv",
        new Blob([templateCsv(Date.now())], { type: "text/csv" })
      );
    } catch (error) {
      if (!isDismissedDownload(error)) notify(describeError(error));
    }
  }

  const rows = preview?.ok ? preview.rows : [];
  const ready = rows.flatMap((row) => (row.result.ok ? [row.result] : []));
  const skipped = rows.length - ready.length + (preview?.ok ? preview.malformed.length : 0);
  const tooMany = ready.length > MAX_IMPORT_ROWS;

  async function importReady() {
    if (ready.length === 0 || tooMany || busy !== null) return;
    setBusy("importing");
    setRefusal(null);
    try {
      const result = await patchy.server.deals.importLeads({
        rows: ready.map(({ fields, owner }) => ({ ...fields, owner: owner?.id ?? null }))
      });
      notify(`Imported ${result.imported} lead${result.imported === 1 ? "" : "s"} into Lead.`, {
        tone: "success"
      });
      onClose();
    } catch (error) {
      setRefusal(describeError(error));
      setBusy(null);
    }
  }

  const reset = () => {
    setPreview(null);
    setFileName("");
    setRefusal(null);
    if (input.current) input.current.value = "";
  };

  return (
    <div class="dialog-layer">
      <div class="backdrop" onClick={onClose} />
      <div
        class="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
      >
        <header class="dialog-head">
          <div>
            <h2 id="import-title">Import leads</h2>
            <p class="muted">
              {preview?.ok
                ? `From ${fileName}`
                : "Bring in a list of leads from a spreadsheet. They all land in Lead."}
            </p>
          </div>
          <button type="button" class="icon-button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          class="visually-hidden"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void read(file);
          }}
        />

        {!preview?.ok ? (
          <div
            class={`dropzone ${dragOver ? "dropzone-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              const file = event.dataTransfer?.files[0];
              if (file) void read(file);
            }}
          >
            <p class="dropzone-title">
              {busy === "reading" ? "Reading the file…" : "Drop a CSV file here"}
            </p>
            <p class="muted">
              Columns: Client, Project, Service, Value (USD), Source, Owner email, Next step,
              Expected close.
              <br />
              Owner email, value, next step and expected close are optional.
            </p>
            <div class="dropzone-actions">
              <button type="button" class="btn btn-ghost" onClick={() => void downloadTemplate()}>
                Download template
              </button>
              <button
                type="button"
                class="btn btn-primary"
                disabled={busy !== null}
                onClick={() => input.current?.click()}
              >
                Choose CSV file
              </button>
            </div>
            {preview !== null && !preview.ok && (
              <p class="refusal" role="alert">
                {preview.error}
              </p>
            )}
          </div>
        ) : (
          <>
            <p class="import-summary">
              <span class="import-ready">{ready.length} ready to import</span>
              {skipped > 0 && <span class="import-skipped">{skipped} will be skipped</span>}
            </p>
            <div class="preview-scroll">
              <table class="preview">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Client</th>
                    <th>Project</th>
                    <th>Service</th>
                    <th class="num">Value</th>
                    <th>Owner</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const value = parseMoney(row.valueText);
                    return (
                      <tr key={row.index} class={row.result.ok ? "" : "row-bad"}>
                        <td class="muted">{row.index}</td>
                        <td>{row.client || <span class="muted">—</span>}</td>
                        <td>{row.title || <span class="muted">—</span>}</td>
                        <td>{row.service || <span class="muted">—</span>}</td>
                        <td class="num">
                          {typeof value === "number"
                            ? compactMoney(value)
                            : row.valueText || <span class="muted">—</span>}
                        </td>
                        <td>
                          {row.result.ok
                            ? (row.result.owner?.name ?? <span class="muted">Unassigned</span>)
                            : row.ownerEmail || <span class="muted">—</span>}
                        </td>
                        <td>
                          {row.result.ok ? (
                            <span class="status-ok">Ready</span>
                          ) : (
                            <span class="status-bad">{row.result.problem}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {preview.malformed.length > 0 && (
              <ul class="malformed">
                {preview.malformed.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {tooMany && (
              <p class="refusal">
                Import at most {MAX_IMPORT_ROWS} leads at a time. Split the file and try again.
              </p>
            )}
            {refusal !== null && (
              <p class="refusal" role="alert">
                {refusal}
              </p>
            )}
            <footer class="dialog-actions">
              <button type="button" class="btn btn-ghost" disabled={busy !== null} onClick={reset}>
                Choose another file
              </button>
              <button
                type="button"
                class="btn btn-primary"
                disabled={ready.length === 0 || tooMany || busy !== null}
                onClick={() => void importReady()}
              >
                {busy === "importing"
                  ? "Importing…"
                  : ready.length === 0
                    ? "Nothing to import"
                    : `Import ${ready.length} lead${ready.length === 1 ? "" : "s"}`}
              </button>
            </footer>
          </>
        )}
        {!preview?.ok && refusal !== null && (
          <p class="refusal" role="alert">
            {refusal}
          </p>
        )}
      </div>
    </div>
  );
}
