import { useCallback, useEffect, useMemo, useQuery, useState } from "patchy/preact";
import { stringify } from "patchy/csv";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";
import { formatMoney } from "../helpers/spend.js";
import { byId, type Person, type SpendRequest, type Viewer } from "./data.js";
import { asStatus, messageOf, statusLabel } from "./format.js";
import { NewRequest } from "./NewRequest.js";
import { RequestDrawer } from "./RequestDrawer.js";
import { RequestTable } from "./RequestTable.js";
import { Summary } from "./Summary.js";
import { Banner, Icon } from "./ui.js";

type Tab = "approve" | "mine" | "all";

const tabLabels: Record<Tab, string> = {
  approve: "Needs my approval",
  mine: "My requests",
  all: "All"
};

const emptyTab: Record<Tab, string> = {
  approve: "Nothing needs your approval right now.",
  mine: "You haven't asked for anything yet. Use New request when you need to spend.",
  all: "No requests yet."
};

export function App() {
  const board = useQuery(patchy.server.requests.list, {});
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [chosenTab, setTab] = useState<Tab | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    patchy
      .me()
      .then((me) => live && setViewer(me))
      .catch((cause: unknown) => live && setNotice(messageOf(cause)));
    return () => {
      live = false;
    };
  }, []);

  const requests = useMemo(() => board.data?.requests ?? [], [board.data]);
  const people = useMemo(() => byId(board.data?.people ?? []), [board.data]);
  const me = viewer?.user.id;
  const toApprove = requests.filter((row) => row.status === "submitted" && row.requester !== me);
  const tab: Tab = chosenTab ?? (toApprove.length > 0 ? "approve" : "all");
  const visible =
    tab === "approve"
      ? toApprove
      : tab === "mine"
        ? requests.filter((row) => row.requester === me)
        : requests;
  const projects = useMemo(() => [...new Set(requests.map((row) => row.project))], [requests]);
  const closeDrawer = useCallback(() => setSelected(null), []);
  const closeDialog = useCallback(() => setCreating(false), []);

  async function loadSamples() {
    setLoadingSamples(true);
    setNotice("");
    try {
      await patchy.server.samples.load({});
    } catch (cause) {
      setNotice(messageOf(cause));
    } finally {
      setLoadingSamples(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    setNotice("");
    try {
      const csv = stringify([csvHeader, ...visible.map((row) => csvRow(row, people))]);
      const day = new Date().toISOString().slice(0, 10);
      await patchy.download(
        `spend-requests-${tab}-${day}.csv`,
        new Blob([csv], { type: "text/csv" })
      );
    } catch (cause) {
      // "Not now" in Patchy's download card is a choice, not a failure.
      if (!(
        isPatchyError(cause, "invalid_request") && cause.details["reason"] === "download_discarded"
      ))
        setNotice(messageOf(cause));
    } finally {
      setExporting(false);
    }
  }

  const ready = board.data !== undefined && viewer !== null;
  const empty = ready && requests.length === 0;

  return (
    <div class="app">
      <header class="page-head">
        <div>
          <div class="eyebrow">Brightline Studio</div>
          <h1 class="page-title">Spend Requests</h1>
          <p class="page-sub">
            Ask before you spend. Attach the receipt, get a yes, get paid back.
          </p>
        </div>
        <div class="head-actions">
          {ready && !empty && (
            <button
              type="button"
              class="button ghost"
              disabled={exporting}
              onClick={() => void exportCsv()}
            >
              <Icon name="export" size={15} />
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
          )}
          <button
            type="button"
            class="button primary"
            disabled={!ready}
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" size={16} />
            New request
          </button>
        </div>
      </header>

      {notice && <Banner tone="danger">{notice}</Banner>}
      {board.error && <Banner tone="danger">{messageOf(board.error)}</Banner>}

      {!ready ? (
        <p class="loading">Loading requests…</p>
      ) : empty ? (
        <section class="empty">
          <div class="empty-mark">
            <Icon name="clip" size={26} />
          </div>
          <h2 class="empty-title">No spend requests yet</h2>
          <p class="muted">
            Ask for money for a client project or the studio, attach the receipt or quote, and track
            it to paid.
          </p>
          <div class="empty-actions">
            <button
              type="button"
              class="button primary"
              disabled={loadingSamples}
              onClick={() => void loadSamples()}
            >
              {loadingSamples ? "Loading sample data…" : "Load sample data"}
            </button>
            <button
              type="button"
              class="button ghost"
              disabled={loadingSamples}
              onClick={() => setCreating(true)}
            >
              New request
            </button>
          </div>
        </section>
      ) : (
        <>
          <Summary requests={requests} />
          <section class="panel">
            <div class="panel-bar">
              <div class="tabs" role="tablist" aria-label="Show">
                {(Object.keys(tabLabels) as Tab[]).map((key) => (
                  <button
                    type="button"
                    key={key}
                    role="tab"
                    aria-selected={tab === key}
                    class={`tab${tab === key ? " is-active" : ""}`}
                    onClick={() => setTab(key)}
                  >
                    {tabLabels[key]}
                    {key === "approve" && toApprove.length > 0 && (
                      <span class="tab-badge">{toApprove.length}</span>
                    )}
                  </button>
                ))}
              </div>
              <div class="panel-meta">
                {visible.length} {visible.length === 1 ? "request" : "requests"} ·{" "}
                <span class="money">
                  {formatMoney(visible.reduce((sum, row) => sum + row.amountCents, 0))}
                </span>
              </div>
            </div>
            {visible.length === 0 ? (
              <p class="table-empty">{emptyTab[tab]}</p>
            ) : (
              <RequestTable
                rows={visible}
                people={people}
                selected={selected}
                onSelect={setSelected}
              />
            )}
          </section>
        </>
      )}

      {selected !== null && viewer !== null && (
        <RequestDrawer key={selected} id={selected} viewer={viewer} onClose={closeDrawer} />
      )}
      {creating && (
        <NewRequest
          projects={projects}
          onClose={closeDialog}
          onCreated={(id) => {
            setCreating(false);
            setTab("mine");
            setSelected(id);
          }}
        />
      )}
    </div>
  );
}

const csvHeader = [
  "Request",
  "Client or project",
  "Category",
  "Amount (USD)",
  "Status",
  "Requested by",
  "Requester email",
  "Submitted",
  "Decided by",
  "Decided",
  "Decision note",
  "Paid",
  "Receipt"
];

function csvRow(row: SpendRequest, people: ReadonlyMap<string, Person>): string[] {
  const requester = people.get(row.requester);
  const approver = row.approver === null ? undefined : people.get(row.approver);
  const date = (iso: string | null) => iso?.slice(0, 10) ?? "";
  return [
    row.title,
    row.project,
    row.category,
    (row.amountCents / 100).toFixed(2),
    statusLabel[asStatus(row.status)],
    requester?.name ?? row.requester,
    requester?.email ?? "",
    date(row.submittedAt),
    approver?.name ?? "",
    date(row.decidedAt),
    row.decisionNote ?? "",
    date(row.paidAt),
    row.receipt?.split("/").at(-1) ?? ""
  ];
}
