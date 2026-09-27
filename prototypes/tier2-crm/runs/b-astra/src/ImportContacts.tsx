import { useRef, useState } from "patchy/preact";
import { patchy, isHandlerError, isPatchyError } from "../patchy/_generated/client.js";
import { CSV_MAX_BYTES, CSV_MAX_ROWS, parseContactsCsv } from "../lib/csv.js";

import type { ContactImportResult, ImportReconciliation } from "../server/imports.js";
type Selection = { name: string; csv: string; rows: number };

function errorMessage(cause: unknown): string {
  if (isHandlerError(cause, "invalid_csv")) {
    const details = cause.details;
    if (
      details &&
      typeof details === "object" &&
      "message" in details &&
      typeof details.message === "string"
    ) {
      return details.message;
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export function ImportContacts() {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [phase, setPhase] = useState<"idle" | "reading" | "importing" | "checking">("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ContactImportResult | null>(null);
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const [reconciliation, setReconciliation] = useState<ImportReconciliation | null>(null);
  const running = useRef(false);
  const busy = phase !== "idle";

  const chooseFile = async (file: File | undefined) => {
    if (running.current || unknownOutcome) return;
    setSelection(null);
    setResult(null);
    setReconciliation(null);
    setError("");
    if (!file) return;
    running.current = true;
    setPhase("reading");
    try {
      if (file.size > CSV_MAX_BYTES)
        throw new Error("The file exceeds 256 KiB. Split it into smaller files before importing.");
      const csv = await file.text();
      const rows = parseContactsCsv(csv);
      setSelection({ name: file.name, csv, rows: rows.length });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      running.current = false;
      setPhase("idle");
    }
  };

  const importContacts = async () => {
    if (!selection || running.current || unknownOutcome) return;
    running.current = true;
    setPhase("importing");
    setResult(null);
    setReconciliation(null);
    setError("");
    try {
      setResult(await patchy.server.imports.contacts({ csv: selection.csv }));
    } catch (cause) {
      if (isPatchyError(cause, "unknown_outcome")) {
        setUnknownOutcome(true);
        setError(
          "The import reply was lost. Some or all valid contacts may have been saved. Nothing will be retried automatically. Check saved contacts below before choosing whether to import again."
        );
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      running.current = false;
      setPhase("idle");
    }
  };

  const checkSaved = async () => {
    if (!selection || running.current) return;
    running.current = true;
    setPhase("checking");
    setError("");
    try {
      setReconciliation(await patchy.server.imports.check({ csv: selection.csv }));
      setUnknownOutcome(false);
    } catch (cause) {
      setError(
        `Could not check saved contacts: ${errorMessage(cause)}. The import has not been retried.`
      );
    } finally {
      running.current = false;
      setPhase("idle");
    }
  };

  return (
    <section className="panel" aria-labelledby="import-contacts-heading" aria-busy={busy}>
      <h2 id="import-contacts-heading">Import contacts</h2>
      <p className="muted">
        Upload a CSV with first_name, last_name, email, company, title and phone columns. Maximum{" "}
        {CSV_MAX_ROWS} contact rows and 256 KiB.
      </p>
      <p className="muted">
        Invalid emails and missing companies are rejected. Duplicate emails are skipped. New
        contacts and companies belong to you; existing records stay unchanged.
      </p>
      <div className="toolbar">
        <label className="field">
          Contacts CSV
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy || unknownOutcome}
            onChange={(event) => void chooseFile(event.currentTarget.files?.[0])}
          />
        </label>
        <button
          className="button"
          type="button"
          disabled={!selection || busy || unknownOutcome}
          onClick={() => void importContacts()}
        >
          {phase === "importing"
            ? "Importing..."
            : reconciliation
              ? "Import again"
              : "Import contacts"}
        </button>
      </div>
      {phase === "reading" && (
        <p className="muted" role="status">
          Reading CSV...
        </p>
      )}
      {selection && (
        <p>
          Selected <strong>{selection.name}</strong>: {selection.rows} contact rows.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {unknownOutcome && (
        <button
          className="button secondary"
          type="button"
          disabled={busy}
          onClick={() => void checkSaved()}
        >
          {phase === "checking" ? "Checking saved contacts..." : "Check saved contacts"}
        </button>
      )}
      {reconciliation && (
        <p className="notice" role="status">
          Check complete: {reconciliation.saved} unique valid emails from this file are saved;{" "}
          {reconciliation.missing} are not saved. The original added count cannot be recovered from
          the lost reply. Choose Import again only if you want to retry; saved emails will be
          skipped.
        </p>
      )}
      {result && (
        <div>
          <p className="notice" role="status">
            {result.added} added; {result.rejected} rejected; {result.skipped} skipped.{" "}
            {result.companiesCreated} companies created. {result.total} rows processed.
          </p>
          {result.issues.length > 0 ? (
            <div>
              <h3>Rejected and skipped rows</h3>
              <p className="muted">
                CSV row numbers include the header as row 1. A quoted multiline field still counts
                as one row.
              </p>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">CSV row</th>
                    <th scope="col">Email</th>
                    <th scope="col">Status</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.issues.map((issue) => (
                    <tr key={issue.row}>
                      <td>{issue.row}</td>
                      <td>{issue.email || "(empty)"}</td>
                      <td>
                        <span className="badge">{issue.status}</span>
                      </td>
                      <td>{issue.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Every row was imported. No rows were rejected or skipped.</p>
          )}
        </div>
      )}
    </section>
  );
}
