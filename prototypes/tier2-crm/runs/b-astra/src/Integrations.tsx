import { useEffect, useFileUrl, useQuery, useState } from "patchy/preact";
import type { FileHandle } from "patchy/client";
import type { Id } from "patchy/config";
import { patchy } from "../patchy/_generated/client.js";
import type {
  ContractFile,
  FinanceReportPage,
  FinanceReportRequest
} from "../server/integrations.js";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function ContractThumbnail({ handle, companyName }: { handle: FileHandle; companyName: string }) {
  const { url, error } = useFileUrl(handle);
  if (error)
    return (
      <p className="error" role="alert">
        Contract thumbnail unavailable: {error.message}
      </p>
    );
  return url ? (
    <img
      className="contract-thumbnail"
      src={url}
      alt={`First page of the ${companyName} contract`}
      width="240"
    />
  ) : (
    <p className="muted">Loading contract thumbnail...</p>
  );
}

function ContractDownload({ file }: { file: ContractFile }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
  }, [file.handle]);
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      await patchy.files.download(file.handle, file.name);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button
        className="button secondary"
        type="button"
        disabled={busy}
        onClick={() => void download()}
      >
        {busy ? "Downloading..." : "Download contract PDF"}
      </button>
      <p className="muted">
        {file.name} · {Math.max(1, Math.ceil(file.size / 1024))} KB
      </p>
      {error && (
        <p className="error" role="alert">
          Download failed: {error}
        </p>
      )}
    </div>
  );
}

export function CompanyContracts({ companyId }: { companyId: Id<"companies"> }) {
  const { data, error, status } = useQuery(patchy.server.integrations.contractsForCompany, {
    companyId
  });
  return (
    <section className="panel" aria-label="Company contract">
      <div className="toolbar">
        <h2>Contract</h2>
        <span className="badge">Shared source</span>
      </div>
      <p className="muted">Contracts tool · documents store · read-only, live updates</p>
      {error ? (
        <p className="error" role="alert">
          Contracts unavailable: {error.message}
        </p>
      ) : data === undefined || data.companyId !== companyId ? (
        <p className="muted">Loading contract...</p>
      ) : (
        <div>
          {status === "resyncing" && (
            <p className="notice" role="status">
              Reconnecting to contracts...
            </p>
          )}
          {data.thumbnail ? (
            <ContractThumbnail handle={data.thumbnail.handle} companyName={data.companyName} />
          ) : (
            <p className="muted">No contract thumbnail available.</p>
          )}
          {data.pdf ? (
            <ContractDownload key={data.companyId} file={data.pdf} />
          ) : (
            <p className="muted">
              No PDF contract found for {data.companyName}. Expected {data.slug}.pdf.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

const wholeDollars = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
function formatCents(value: string): string {
  const cents = BigInt(value);
  const absolute = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}$${wholeDollars.format(absolute / 100n)}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

export function FinanceReport() {
  const [requests, setRequests] = useState<readonly FinanceReportRequest[]>([{}]);
  const [pageIndex, setPageIndex] = useState(0);
  const [data, setData] = useState<FinanceReportPage | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [loadedAt, setLoadedAt] = useState("");

  useEffect(() => {
    let active = true;
    setPending(true);
    setError("");
    setData(null);
    void patchy.server.integrations
      .financeReport(requests[pageIndex]!)
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoadedAt(new Date().toLocaleTimeString());
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [requests, pageIndex]);

  const refresh = () => {
    setRequests([{}]);
    setPageIndex(0);
  };
  const next = () => {
    if (!data?.nextPage) return;
    setRequests([...requests.slice(0, pageIndex + 1), data.nextPage]);
    setPageIndex(pageIndex + 1);
  };

  return (
    <section className="panel" aria-label="Finance report">
      <div className="toolbar">
        <div>
          <h2>Finance report</h2>
          <p className="muted">Finance database · read-only · USD</p>
        </div>
        <button className="button secondary" type="button" disabled={pending} onClick={refresh}>
          {pending ? "Loading..." : "Refresh finance"}
        </button>
      </div>
      <p className="muted">
        Invoiced and paid amounts come from the finance ledger. CRM companies without invoices
        appear with zero totals. Figures update on refresh, not live.
      </p>
      {error ? (
        <p className="error" role="alert">
          Finance report unavailable: {error}
        </p>
      ) : pending ? (
        <p className="muted" role="status">
          Reading finance totals...
        </p>
      ) : (
        data && (
          <>
            <p className="muted">
              Loaded at {loadedAt} · Page {pageIndex + 1}
            </p>
            {data.rows.length === 0 ? (
              <p className="muted">
                No companies on this page.{data.nextPage ? " Continue to the next page." : ""}
              </p>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <caption className="muted">Company balances in US dollars</caption>
                  <thead>
                    <tr>
                      <th scope="col">Company</th>
                      <th scope="col">Invoiced</th>
                      <th scope="col">Paid</th>
                      <th scope="col">Outstanding</th>
                      <th scope="col">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.companyKey}>
                        <th scope="row">{row.companyName}</th>
                        <td>{formatCents(row.invoicedCents)}</td>
                        <td>{formatCents(row.paidCents)}</td>
                        <td>{formatCents(row.outstandingCents)}</td>
                        <td>
                          <span className="badge">
                            {row.source === "finance" ? "Finance ledger" : "CRM · no invoices"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      )}
      <div className="toolbar">
        <button
          className="button secondary"
          type="button"
          disabled={pending || pageIndex === 0}
          onClick={() => setPageIndex(pageIndex - 1)}
        >
          Previous page
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={pending || error !== "" || !data?.nextPage}
          onClick={next}
        >
          Next page
        </button>
      </div>
    </section>
  );
}
