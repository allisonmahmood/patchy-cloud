import { useEffect, useFileUrl, useQuery, useState } from "patchy/preact";
import type { FileHandle } from "patchy/client";
import type { Id } from "patchy/config";
import { patchy } from "../patchy/_generated/client.js";

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "access_denied")
      return "Access is unavailable. The source may no longer be shared with you.";
    if (error.code === "not_found")
      return "This file was replaced or removed. Wait for the live contract to update, then try again.";
    if (error.code === "company_not_found") return "This company no longer exists.";
    if (error.code === "connection_not_connected")
      return "The finance database is disconnected. A company admin must reconnect it.";
  }
  return error instanceof Error ? error.message : "The request failed. Please try again.";
}

function ContractThumbnail({ handle }: { handle: FileHandle }) {
  const { url, error } = useFileUrl(handle);
  if (error)
    return (
      <p className="error" role="alert">
        Thumbnail: {errorMessage(error)}
      </p>
    );
  return url ? (
    <img src={url} alt="First page of the company contract" width="220" />
  ) : (
    <p className="muted">Loading thumbnail…</p>
  );
}

function ContractDownload({
  file
}: {
  file: { readonly name: string; readonly handle: FileHandle };
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    setBusy(true);
    setError(null);
    try {
      await patchy.files.download(file.handle, file.name);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button className="button" type="button" disabled={busy} onClick={download}>
        {busy ? "Downloading…" : "Download contract PDF"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function CompanyContracts({ companyId }: { companyId: string }) {
  const { data, error, status } = useQuery(patchy.server.integrations.companyContracts, {
    companyId: companyId as Id<"companies">
  });
  return (
    <section className="panel" aria-label="Company contract">
      <h3>Contract</h3>
      {error ? (
        <p className="error" role="alert">
          {errorMessage(error)}
        </p>
      ) : data === undefined ? (
        <p className="muted">Loading contract…</p>
      ) : (
        <>
          {status === "resyncing" && <p className="muted">Updating contract…</p>}
          {status === "suspended" && <p className="muted">Live updates are paused.</p>}
          {data.thumbnail ? (
            <ContractThumbnail handle={data.thumbnail.handle} />
          ) : (
            <p className="muted">No thumbnail is available.</p>
          )}
          {data.pdf ? (
            <ContractDownload key={data.pdf.handle} file={data.pdf} />
          ) : (
            <p className="muted">No contract PDF is available for this company.</p>
          )}
        </>
      )}
    </section>
  );
}

interface Report {
  readonly rows: readonly {
    readonly companyId: string;
    readonly companyName: string;
    readonly invoicedCents: string;
    readonly paidCents: string;
    readonly outstandingCents: string;
  }[];
  readonly cursor: string | null;
}
const integerFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function dollars(cents: string | bigint): string {
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}$${integerFormat.format(absolute / 100n)}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function FinanceReport() {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    setReport(null);
    patchy.server.integrations.financeReport(cursor ? { cursor } : {}).then(
      (result) => {
        if (active) {
          setReport(result);
          setBusy(false);
        }
      },
      (failure: unknown) => {
        if (active) {
          setError(errorMessage(failure));
          setBusy(false);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [cursor, refresh]);

  const totals = report?.rows.reduce(
    (sum, row) => ({
      invoiced: sum.invoiced + BigInt(row.invoicedCents),
      paid: sum.paid + BigInt(row.paidCents),
      outstanding: sum.outstanding + BigInt(row.outstandingCents)
    }),
    { invoiced: 0n, paid: 0n, outstanding: 0n }
  );

  return (
    <section className="panel" aria-label="Finance report">
      <h2>Finance report</h2>
      <p className="muted">
        Invoice and payment totals in USD. Refresh to read current finance data. Up to 25 CRM
        companies per page; totals below cover this page only.
      </p>
      <button
        className="button"
        type="button"
        disabled={busy}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh report
      </button>
      {busy && (
        <p className="muted" role="status">
          Loading finance report…
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report && totals && (
        <>
          <dl className="metrics">
            <div>
              <dt>Page invoiced</dt>
              <dd>{dollars(totals.invoiced)}</dd>
            </div>
            <div>
              <dt>Page paid</dt>
              <dd>{dollars(totals.paid)}</dd>
            </div>
            <div>
              <dt>Page outstanding</dt>
              <dd>{dollars(totals.outstanding)}</dd>
            </div>
          </dl>
          {report.rows.length === 0 ? (
            <p className="muted">
              No companies on this page. Create or import companies to include them in the report.
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Company</th>
                    <th scope="col">Invoiced</th>
                    <th scope="col">Paid</th>
                    <th scope="col">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.companyId}>
                      <th scope="row">{row.companyName}</th>
                      <td>{dollars(row.invoicedCents)}</td>
                      <td>{dollars(row.paidCents)}</td>
                      <td>{dollars(row.outstandingCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <nav aria-label="Finance report pages">
        <button
          className="button secondary"
          type="button"
          disabled={busy || cursors.length === 1}
          onClick={() => setCursors((previous) => previous.slice(0, -1))}
        >
          Previous
        </button>
        <span className="muted"> Page {cursors.length} </span>
        <button
          className="button secondary"
          type="button"
          disabled={busy || !report?.cursor}
          onClick={() => {
            if (report?.cursor) setCursors((previous) => [...previous, report.cursor!]);
          }}
        >
          Next
        </button>
        {cursors.length > 1 && (
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => setCursors([undefined])}
          >
            First page
          </button>
        )}
      </nav>
    </section>
  );
}
