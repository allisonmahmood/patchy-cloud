import { STAGE_ODDS, isClosed, isOpen } from "../../helpers/pipeline.js";
import { DAY, compactMoney, quarterStart } from "../format.js";
import type { Deal } from "../types.js";

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The four headline numbers above the board, computed from the deals in view. */
export function Kpis({
  deals,
  now,
  mineOnly
}: {
  deals: readonly Deal[];
  now: number;
  mineOnly: boolean;
}) {
  const open = deals.filter((deal) => isOpen(deal.stage));
  const openTotal = sum(open.map((deal) => deal.value ?? 0));
  const weighted = sum(
    open.map((deal) => (isOpen(deal.stage) ? (deal.value ?? 0) * STAGE_ODDS[deal.stage] : 0))
  );
  const since = quarterStart(now);
  const wonThisQuarter = deals.filter(
    (deal) => deal.stage === "won" && Date.parse(deal.stageEnteredAt) >= since
  );
  const closedRecently = deals.filter(
    (deal) => isClosed(deal.stage) && now - Date.parse(deal.stageEnteredAt) <= 90 * DAY
  );
  const wins = closedRecently.filter((deal) => deal.stage === "won").length;
  const winRate =
    closedRecently.length === 0 ? null : Math.round((wins / closedRecently.length) * 100);

  return (
    <section class="kpis" aria-label="Pipeline summary">
      <div class="kpi kpi-hero">
        <div class="kpi-label">{mineOnly ? "My open pipeline" : "Open pipeline"}</div>
        <div class="kpi-value">{compactMoney(openTotal)}</div>
        <div class="kpi-sub">{plural(open.length, "open deal")}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Weighted forecast</div>
        <div class="kpi-value">{compactMoney(Math.round(weighted))}</div>
        <div class="kpi-sub">by stage odds</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Won this quarter</div>
        <div class="kpi-value">
          {compactMoney(sum(wonThisQuarter.map((deal) => deal.value ?? 0)))}
        </div>
        <div class="kpi-sub">{plural(wonThisQuarter.length, "deal")}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Win rate</div>
        <div class="kpi-value">{winRate === null ? "—" : `${winRate}%`}</div>
        <div class="kpi-sub">
          {closedRecently.length === 0
            ? "no deals closed lately"
            : `${wins} of ${closedRecently.length} closed · last 90 days`}
        </div>
      </div>
    </section>
  );
}
