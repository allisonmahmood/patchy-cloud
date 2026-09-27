import { useEffect } from "patchy/preact";
import { useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import { formatDollars } from "../shared/rules.js";
import { Alert, useApp, useTask } from "./ui.js";

type Row = Awaited<ReturnType<typeof patchy.server.finance.report>>[number];

/** Invoiced, paid and outstanding per company from the finance ledger. Not live: Refresh re-reads it. */
export function Finance() {
  const { go } = useApp();
  const [rows, setRows] = useState<readonly Row[] | null>(null);
  const [at, setAt] = useState("");
  const task = useTask();
  const load = () =>
    void task.run(async () => {
      setRows(await patchy.server.finance.report({}));
      setAt(new Date().toLocaleTimeString());
    });
  useEffect(load, []);
  const sum = (key: "invoiced" | "paid" | "outstanding") =>
    (rows ?? []).reduce((total, row) => total + row[key], 0);
  return (
    <section>
      <div class="toolbar">
        <h1>Finance</h1>
        {at && <span class="muted">as of {at}</span>}
        <button type="button" disabled={task.busy} onClick={load}>
          {task.busy ? "Loading…" : "Refresh"}
        </button>
      </div>
      <Alert>{task.error}</Alert>
      {rows && (
        <table class="grid" id="finance">
          <thead>
            <tr>
              <th>Company</th>
              <th class="num">Invoiced</th>
              <th class="num">Paid</th>
              <th class="num">Outstanding</th>
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
                      onClick={() => go({ name: "company", id: row.companyId! })}
                    >
                      {row.company}
                    </button>
                  ) : (
                    row.company
                  )}
                </td>
                <td class="num">{formatDollars(row.invoiced)}</td>
                <td class="num">{formatDollars(row.paid)}</td>
                <td class={`num${row.outstanding > 0 ? " owed" : ""}`}>
                  {formatDollars(row.outstanding)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              <th class="num">{formatDollars(sum("invoiced"))}</th>
              <th class="num">{formatDollars(sum("paid"))}</th>
              <th class="num">{formatDollars(sum("outstanding"))}</th>
            </tr>
          </tfoot>
        </table>
      )}
      {rows?.length === 0 && <p class="muted">The ledger has no invoices.</p>}
    </section>
  );
}
