import { useEffect, useState } from "patchy/preact";
import { patchy, money, useRunner, type Company } from "./lib.js";

type Row = Awaited<ReturnType<typeof patchy.server.finance.report>>[number];

/** Per-company invoiced / paid / outstanding from the finance ledger. Not live: Postgres cannot be subscribed, so it has a Refresh. */
export function Finance({ openCompany }: { openCompany: (id: Company["id"]) => void }) {
  const [rows, setRows] = useState<readonly Row[] | undefined>(undefined);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const { busy, error, run } = useRunner();
  const load = async () => {
    const report = await run(() => patchy.server.finance.report({}));
    if (report) {
      setRows(report);
      setLoadedAt(new Date());
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const total = (key: "invoiced" | "paid" | "outstanding") =>
    (rows ?? []).reduce((sum, row) => sum + row[key], 0);
  return (
    <div>
      <div class="toolbar">
        <h2>Finance</h2>
        <span class="muted small">{loadedAt ? `As of ${loadedAt.toLocaleTimeString()}` : ""}</span>
        <button type="button" disabled={busy} onClick={() => void load()}>
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {rows && (
        <table class="grid numbers" id="finance">
          <thead>
            <tr>
              <th>Company</th>
              <th>Invoiced</th>
              <th>Paid</th>
              <th>Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.company}>
                <td>
                  {row.companyId ? (
                    <button
                      type="button"
                      class="link"
                      onClick={() => openCompany(row.companyId as Company["id"])}
                    >
                      {row.company}
                    </button>
                  ) : (
                    <span title="Not in the CRM">{row.company}</span>
                  )}
                </td>
                <td>{money(row.invoiced, true)}</td>
                <td>{money(row.paid, true)}</td>
                <td class={row.outstanding > 0 ? "owed" : ""}>{money(row.outstanding, true)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              <th>{money(total("invoiced"), true)}</th>
              <th>{money(total("paid"), true)}</th>
              <th>{money(total("outstanding"), true)}</th>
            </tr>
          </tfoot>
        </table>
      )}
      {rows?.length === 0 && <p class="muted">No invoices.</p>}
    </div>
  );
}
