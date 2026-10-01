import { categories, formatMoneyWhole } from "../helpers/spend.js";
import type { SpendRequest } from "./data.js";

const recentDays = 30;

/** The four tiles above the list: what's waiting, approved and paid lately, and where money goes. */
export function Summary({ requests }: { requests: readonly SpendRequest[] }) {
  const since = Date.now() - recentDays * 24 * 60 * 60 * 1000;
  const recent = (iso: string | null) => iso !== null && Date.parse(iso) >= since;
  const sum = (rows: readonly SpendRequest[]) =>
    rows.reduce((total, row) => total + row.amountCents, 0);

  const waiting = requests.filter((row) => row.status === "submitted");
  const approved = requests.filter(
    (row) => (row.status === "approved" || row.status === "paid") && recent(row.decidedAt)
  );
  const paid = requests.filter((row) => row.status === "paid" && recent(row.paidAt));
  const committed = requests.filter((row) => row.status === "approved" || row.status === "paid");
  const byCategory = categories
    .map((category) => ({
      category,
      cents: sum(committed.filter((row) => row.category === category))
    }))
    .filter((entry) => entry.cents > 0)
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 4);
  const largest = byCategory[0]?.cents ?? 1;
  const plural = (count: number) => `${count} request${count === 1 ? "" : "s"}`;

  return (
    <section class="kpis" aria-label="Summary">
      <div class="kpi kpi-hero">
        <div class="kpi-label">Waiting for approval</div>
        <div class="kpi-value">{formatMoneyWhole(sum(waiting))}</div>
        <div class="kpi-sub">{plural(waiting.length)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Approved · last {recentDays} days</div>
        <div class="kpi-value">{formatMoneyWhole(sum(approved))}</div>
        <div class="kpi-sub">{plural(approved.length)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Paid · last {recentDays} days</div>
        <div class="kpi-value">{formatMoneyWhole(sum(paid))}</div>
        <div class="kpi-sub">{plural(paid.length)}</div>
      </div>
      <div class="kpi kpi-categories">
        <div class="kpi-label">Approved spend by category</div>
        {byCategory.length === 0 ? (
          <div class="kpi-sub category-empty">Nothing approved yet</div>
        ) : (
          <ul class="category-bars">
            {byCategory.map((entry) => (
              <li key={entry.category} class={`category-row cat-${entry.category.toLowerCase()}`}>
                <span class="category-name">{entry.category}</span>
                <span class="category-track">
                  <span
                    class="category-fill"
                    style={{ width: `${Math.max(4, (entry.cents / largest) * 100)}%` }}
                  />
                </span>
                <span class="category-amount">{formatMoneyWhole(entry.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
