import { useState } from "patchy/preact";
import { patchy, useRunner } from "./lib.js";

type Result = Awaited<ReturnType<typeof patchy.server.importer.contacts>>;

/** Import contacts from a CSV file; shows the count added and every rejected or skipped row. */
export function Import() {
  const [result, setResult] = useState<{ file: string; result: Result } | null>(null);
  const { busy, error, run } = useRunner();
  const load = async (file: File) => {
    setResult(null);
    const text = await file.text();
    const imported = await run(() => patchy.server.importer.contacts({ csv: text }));
    if (imported) setResult({ file: file.name, result: imported });
  };
  const rejected = result?.result.problems.filter((row) => row.outcome === "rejected") ?? [];
  const skipped = result?.result.problems.filter((row) => row.outcome === "skipped") ?? [];
  return (
    <div>
      <h2>Import contacts</h2>
      <p class="muted">
        CSV with a header row: <code>first_name,last_name,email,company,title,phone</code>. Rows
        with an invalid email or no company are rejected; emails already saved or repeated in the
        file are skipped. Missing companies are created. You own everything imported.
      </p>
      <label class="upload">
        {busy ? "Importing…" : "Choose CSV file"}
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void load(file);
          }}
        />
      </label>
      {error && (
        <p class="error" role="alert">
          Nothing was imported: {error}
        </p>
      )}
      {result && (
        <div id="import-result">
          <p class="summary">
            <strong>{result.result.added}</strong> contact{result.result.added === 1 ? "" : "s"}{" "}
            added from {result.file}
            {result.result.companiesCreated > 0 && (
              <>
                {" "}
                · {result.result.companiesCreated} new compan
                {result.result.companiesCreated === 1 ? "y" : "ies"}
              </>
            )}{" "}
            · {rejected.length} rejected · {skipped.length} skipped
          </p>
          {result.result.problems.length > 0 && (
            <table class="grid">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Outcome</th>
                  <th>Reason</th>
                  <th>Name</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {result.result.problems.map((row) => (
                  <tr key={row.line} class={row.outcome}>
                    <td>{row.line}</td>
                    <td>{row.outcome === "rejected" ? "Rejected" : "Skipped"}</td>
                    <td>{row.reason}</td>
                    <td>{row.name}</td>
                    <td>
                      <code>{row.email || "—"}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
