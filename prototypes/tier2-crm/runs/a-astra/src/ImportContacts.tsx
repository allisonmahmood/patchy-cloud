import { useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import { ErrorBox, useTask } from "./ui.js";

interface ImportResult {
  readonly added: number;
  readonly companiesCreated: number;
  readonly issues: readonly {
    row: number;
    email: string;
    reason: string;
    status: "rejected" | "skipped";
  }[];
}

export function ImportContacts() {
  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState("");
  const [result, setResult] = useState<ImportResult>();
  const task = useTask();
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">BRING YOUR CONTACTS</div>
          <h1>Import contacts</h1>
          <p>A checked import, with a result for every row that needs attention.</p>
        </div>
      </header>
      <div className="import-layout">
        <section className="panel import-panel">
          <h2>Upload a CSV</h2>
          <p>Choose a UTF-8 CSV with these headers in this order.</p>
          <code className="csv-header">first_name,last_name,email,company,title,phone</code>
          <label className="dropzone">
            Choose contact file
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Contact CSV"
              disabled={task.busy}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (file)
                  void task.run(async () => {
                    setCsv("");
                    setFilename(file.name);
                    setResult(undefined);
                    if (file.size > 524288)
                      throw new Error("Choose a file no larger than 512 KiB.");
                    setCsv(await file.text());
                  });
              }}
            />
            <span>{filename || "CSV · up to 500 rows / 512 KiB"}</span>
          </label>
          <ErrorBox error={task.error} />
          <button
            type="button"
            disabled={task.busy || !csv}
            onClick={() =>
              void task.run(async () => {
                setResult(undefined);
                setResult(await patchy.server.imports.importCsv({ csv }));
              })
            }
          >
            {task.busy ? "Working…" : "Import contacts"}
          </button>
        </section>
        <aside className="panel import-rules">
          <h2>What gets imported</h2>
          <ul>
            <li>Invalid emails and missing companies are rejected.</li>
            <li>Emails already saved or repeated in this file are skipped.</li>
            <li>Companies are created only for valid, new contacts.</li>
            <li>You own the contacts and companies you create.</li>
          </ul>
          <p className="muted">
            Quoted fields and line breaks are supported. A malformed file stops the whole import
            without saving rows.
          </p>
        </aside>
      </div>
      {result && (
        <section className="import-result">
          <header className="section-heading">
            <h2>Import complete</h2>
            <span className="badge">{filename}</span>
          </header>
          <div className="metrics">
            <div>
              <span>Contacts added</span>
              <strong>{result.added}</strong>
            </div>
            <div>
              <span>Companies created</span>
              <strong>{result.companiesCreated}</strong>
            </div>
            <div>
              <span>Rejected</span>
              <strong>{result.issues.filter((i) => i.status === "rejected").length}</strong>
            </div>
            <div>
              <span>Duplicates skipped</span>
              <strong>{result.issues.filter((i) => i.status === "skipped").length}</strong>
            </div>
          </div>
          {result.issues.length ? (
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Source line</th>
                    <th>Email</th>
                    <th>Result</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.issues.map((issue) => (
                    <tr key={issue.row}>
                      <td>{issue.row}</td>
                      <td>{issue.email || "Empty email"}</td>
                      <td>
                        <span className={`badge ${issue.status}`}>{issue.status}</span>
                      </td>
                      <td>{issue.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="notice">Every contact row was added.</p>
          )}
        </section>
      )}
    </>
  );
}
