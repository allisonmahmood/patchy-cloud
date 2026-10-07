import { useEffect, useMemo, useState } from "patchy/preact";
import { useQuery } from "patchy/preact";
import { stringify } from "patchy/csv";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";
import logo from "../patchy/_generated/logo.svg";
import { sampleRequests } from "./sample.js";

export const CATEGORIES = ["Software", "Travel", "Equipment", "Events", "Other"] as const;
type Status = "pending" | "approved" | "rejected";
type Filter = "all" | Status;

const STATUS_LABEL: Record<Status, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected"
};
const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" }
];

type Viewer = { id: string; name: string };

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});
const dollarsAndCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2
});
const formatCents = (cents: number) =>
  (cents % 100 === 0 ? dollars : dollarsAndCents).format(cents / 100);

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0 && new Date().toDateString() === date.toDateString()) return "Today";
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type ListArgs = NonNullable<Parameters<typeof patchy.tables.requests.list.subscribe>[0]>;
type RequestRowData = NonNullable<Awaited<ReturnType<typeof patchy.tables.requests.get>>>;

// The status filter and Mine combine; each pairing reads a matching index, newest first.
function listArgsFor(filter: Filter, mineId: string | null, limit: number): ListArgs {
  const order = "desc" as const;
  if (mineId === null) {
    return filter === "all"
      ? { index: "byRequestedAt", order, limit }
      : { index: "byStatus", eq: { status: filter }, order, limit };
  }
  return filter === "all"
    ? { index: "byRequester", eq: { requesterId: mineId }, order, limit }
    : { index: "byRequesterStatus", eq: { requesterId: mineId, status: filter }, order, limit };
}

const EXPORT_MAX = 10_000;

function csvFor(rows: readonly RequestRowData[]) {
  return stringify([
    [
      "Title",
      "Vendor",
      "Category",
      "Amount (USD)",
      "Status",
      "Requested by",
      "Requested at",
      "Reason",
      "Decided by",
      "Decided at",
      "Decision note"
    ],
    ...rows.map((row) => [
      row.title,
      row.vendor,
      row.category,
      (row.amountCents / 100).toFixed(2),
      row.status,
      row.requesterName,
      row.requestedAt,
      row.reason,
      row.deciderName ?? "",
      row.decidedAt ?? "",
      row.decisionNote ?? ""
    ])
  ]);
}

function monthStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

export function App() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [viewerError, setViewerError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [mine, setMine] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ error: boolean; text: string } | null>(null);
  const [limit, setLimit] = useState(100);
  const [composing, setComposing] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const [sampleError, setSampleError] = useState("");

  useEffect(() => {
    let active = true;
    patchy
      .me()
      .then((me) => {
        if (active && me) setViewer({ id: me.user.id, name: me.user.name || me.user.email });
      })
      .catch((cause: unknown) => {
        if (active) setViewerError(message(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  // Mine is disabled until the viewer is known, so mineId is never a placeholder.
  const mineId = mine && viewer ? viewer.id : null;
  const list = useQuery(patchy.tables.requests.list, listArgsFor(filter, mineId, limit));
  const any = useQuery(patchy.tables.requests.list, { limit: 1 });
  const pending = useQuery(patchy.tables.requests.list, {
    index: "byStatus",
    eq: { status: "pending" },
    limit: 1000
  });
  const monthStart = useMemo(monthStartIso, []);
  const approvedThisMonth = useQuery(patchy.tables.requests.list, {
    index: "byStatusDecided",
    eq: { status: "approved" },
    range: { column: "decidedAt", gte: monthStart },
    limit: 1000
  });

  const pendingRows = pending.data?.rows ?? [];
  const pendingTotal = pendingRows.reduce((sum, row) => sum + row.amountCents, 0);
  const approvedTotal = (approvedThisMonth.data?.rows ?? []).reduce(
    (sum, row) => sum + row.amountCents,
    0
  );
  const isEmpty = any.status === "ready" && any.data?.rows.length === 0;
  const rows = list.data?.rows ?? [];
  const filterLabel = `${mineId !== null ? "of your " : ""}${filter === "all" ? "" : STATUS_LABEL[filter].toLowerCase() + " "}requests`;

  function exportCsv() {
    if (exporting) return;
    setExporting(true);
    setExportNote(null);
    const selected = filter;
    const selectedMine = mineId;
    (async () => {
      // Export every row the filter matches, not just the page on screen.
      const all: RequestRowData[] = [];
      let cursor: string | null = null;
      do {
        const page: { rows: readonly RequestRowData[]; cursor: string | null } =
          await patchy.tables.requests.list({
            ...listArgsFor(selected, selectedMine, 1000),
            ...(cursor ? { cursor } : {})
          });
        all.push(...page.rows);
        cursor = page.cursor;
      } while (cursor && all.length < EXPORT_MAX);
      const name = `spend-requests${selectedMine !== null ? "-mine" : ""}${selected === "all" ? "" : `-${selected}`}-${new Date().toISOString().slice(0, 10)}.csv`;
      await patchy.download(name, new Blob([csvFor(all)], { type: "text/csv" }));
      const capped = cursor ? ` (first ${EXPORT_MAX.toLocaleString("en-US")} only)` : "";
      setExportNote({
        error: false,
        text: `Downloaded ${all.length} ${all.length === 1 ? "request" : "requests"}${capped}.`
      });
    })()
      .catch((cause: unknown) => {
        const discarded =
          isPatchyError(cause) &&
          (cause.details as { reason?: string } | undefined)?.reason === "download_discarded";
        setExportNote(
          discarded ? null : { error: true, text: `Couldn't export. ${message(cause)}` }
        );
      })
      .finally(() => setExporting(false));
  }

  function loadSample() {
    setLoadingSample(true);
    setSampleError("");
    patchy.tables.requests
      .insertMany(sampleRequests(Date.now()))
      .catch((cause: unknown) => setSampleError(`Couldn't load sample data. ${message(cause)}`))
      .finally(() => setLoadingSample(false));
  }

  return (
    <>
      <header class="page-header">
        <img src={logo} alt="" />
        <span class="header-title">Spend requests</span>
        <div class="actions">
          {viewer && <span class="viewer">Signed in as {viewer.name}</span>}
        </div>
      </header>

      <main class="page">
        <div class="title-row">
          <div>
            <h1>Spend requests</h1>
            <p class="lede">Ask to spend company money. A teammate approves or rejects it.</p>
          </div>
          {!isEmpty && !composing && (
            <button type="button" onClick={() => setComposing(true)} disabled={!viewer}>
              New request
            </button>
          )}
        </div>
        {viewerError && (
          <p class="error" role="alert">
            Couldn't identify you. {viewerError}
          </p>
        )}

        <section class="stats" aria-label="Summary">
          <div class="card stat">
            <span class="stat-label">Pending</span>
            <span class="stat-value">{pending.data ? pendingRows.length : "–"}</span>
            <span class="stat-sub">
              {pending.data
                ? pendingRows.length === 1
                  ? "Request waiting for a decision"
                  : "Requests waiting for a decision"
                : "Loading…"}
            </span>
          </div>
          <div class="card stat">
            <span class="stat-label">Pending amount</span>
            <span class="stat-value">{pending.data ? formatCents(pendingTotal) : "–"}</span>
            <span class="stat-sub">Across all pending requests</span>
          </div>
          <div class="card stat">
            <span class="stat-label">Approved this month</span>
            <span class="stat-value">
              {approvedThisMonth.data ? formatCents(approvedTotal) : "–"}
            </span>
            <span class="stat-sub">
              {new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}, by
              decision date
            </span>
          </div>
        </section>
        <CategoryBreakdown
          rows={approvedThisMonth.data?.rows}
          truncated={Boolean(approvedThisMonth.data?.cursor)}
        />
        {(pending.error ?? approvedThisMonth.error) && (
          <p class="error" role="alert">
            Couldn't load the summary. {(pending.error ?? approvedThisMonth.error)?.message}
          </p>
        )}

        {composing && viewer && <NewRequest viewer={viewer} onClose={() => setComposing(false)} />}

        {isEmpty ? (
          <div class="empty">
            <strong>No spend requests yet</strong>
            <span>
              Requests from your team show up here. Start one, or load sample data to look around.
            </span>
            <div class="empty-actions">
              <button type="button" onClick={loadSample} disabled={loadingSample}>
                {loadingSample ? "Loading sample data…" : "Load sample data"}
              </button>
              {!composing && (
                <button
                  type="button"
                  class="button-secondary"
                  onClick={() => setComposing(true)}
                  disabled={!viewer}
                >
                  New request
                </button>
              )}
            </div>
            {sampleError && (
              <p class="error" role="alert">
                {sampleError}
              </p>
            )}
          </div>
        ) : (
          <section class="list-section">
            <div class="toolbar" role="tablist" aria-label="Filter by status">
              {FILTERS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === option.id}
                  class={filter === option.id ? "tab tab-selected" : "tab"}
                  onClick={() => {
                    setFilter(option.id);
                    setLimit(100);
                  }}
                >
                  {option.label}
                </button>
              ))}
              <span class="toolbar-divider" aria-hidden="true" />
              <button
                type="button"
                aria-pressed={mineId !== null}
                class={mineId !== null ? "tab tab-selected" : "tab"}
                title="Only requests you asked for"
                disabled={!viewer}
                onClick={() => {
                  setMine((value) => !value);
                  setLimit(100);
                }}
              >
                Mine
              </button>
              <span class="toolbar-meta">
                {list.data ? `${rows.length}${list.data.cursor ? "+" : ""} shown` : ""}
              </span>
              <button
                type="button"
                class="button-ghost"
                disabled={exporting || rows.length === 0}
                onClick={exportCsv}
              >
                {exporting ? "Exporting…" : "Download CSV"}
              </button>
            </div>
            {exportNote && (
              <p
                class={exportNote.error ? "error" : "muted"}
                role={exportNote.error ? "alert" : "status"}
              >
                {exportNote.text}
              </p>
            )}

            {list.error && (
              <p class="error" role="alert">
                Couldn't load requests. {list.error.message}
              </p>
            )}
            {list.status === "loading" && !list.data && <p class="muted">Loading requests…</p>}
            {list.data && rows.length === 0 && (
              <div class="empty">
                <strong>
                  {mineId !== null ? "None " : "No "}
                  {filterLabel}
                </strong>
                <span>
                  {mineId !== null && filter === "all"
                    ? "Requests you ask for show up here."
                    : "Try another filter."}
                </span>
              </div>
            )}
            {rows.length > 0 && (
              <table class="table-list">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Category</th>
                    <th>Requested by</th>
                    <th>When</th>
                    <th class="num">Amount</th>
                    <th>Status</th>
                    <th>
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <RequestRow key={row.id} row={row} viewer={viewer} />
                  ))}
                </tbody>
              </table>
            )}
            {list.data?.cursor && limit < 1000 && (
              <div class="more">
                <button
                  type="button"
                  class="button-ghost"
                  onClick={() => setLimit((value) => Math.min(value + 100, 1000))}
                >
                  Show more
                </button>
              </div>
            )}
          </section>
        )}
      </main>
    </>
  );
}

function CategoryBreakdown({
  rows,
  truncated
}: {
  rows: readonly RequestRowData[] | undefined;
  truncated: boolean;
}) {
  const totals = new Map(
    CATEGORIES.map((category) => [category as string, { cents: 0, count: 0 }])
  );
  for (const row of rows ?? []) {
    const entry = totals.get(row.category) ?? totals.get("Other")!;
    entry.cents += row.amountCents;
    entry.count += 1;
  }
  const entries = [...totals].sort((a, b) => b[1].cents - a[1].cents);
  const max = Math.max(1, ...entries.map(([, entry]) => entry.cents));
  const month = new Date().toLocaleDateString("en-US", { month: "long" });
  const requests = (count: number) => `${count} ${count === 1 ? "request" : "requests"}`;

  return (
    <section class="card breakdown" aria-label={`Approved spend in ${month} by category`}>
      <div class="breakdown-head">
        <span class="stat-label">Approved this month by category</span>
        {truncated && <span class="stat-sub">First 1,000 approvals</span>}
      </div>
      {!rows ? (
        <p class="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p class="muted">Nothing approved in {month} yet.</p>
      ) : (
        <table class="breakdown-table">
          <thead class="sr-only">
            <tr>
              <th>Category</th>
              <th>Share</th>
              <th>Requests</th>
              <th>Approved</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([category, entry]) => (
              <tr
                key={category}
                class={entry.cents === 0 ? "breakdown-zero" : undefined}
                title={`${category}: ${formatCents(entry.cents)} across ${requests(entry.count)}`}
              >
                <th scope="row">{category}</th>
                <td class="breakdown-bar-cell" aria-hidden="true">
                  <span class="breakdown-bar" style={{ width: `${(entry.cents / max) * 100}%` }} />
                </td>
                <td class="breakdown-count">{entry.count === 0 ? "–" : requests(entry.count)}</td>
                <td class="num">{formatCents(entry.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RequestRow({ row, viewer }: { row: RequestRowData; viewer: Viewer | null }) {
  const [deciding, setDeciding] = useState<null | "approved" | "rejected">(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const status = (row.status in STATUS_LABEL ? row.status : "pending") as Status;
  const own =
    viewer !== null &&
    (row.requesterId ? row.requesterId === viewer.id : row.requesterName === viewer.name);
  const canDecide = status === "pending" && viewer !== null && !own;

  function decide() {
    if (!deciding || !viewer) return;
    setSaving(true);
    setError("");
    patchy.tables.requests
      .update(row.id, {
        status: deciding,
        deciderId: viewer.id,
        deciderName: viewer.name,
        decisionNote: note.trim() || null,
        decidedAt: new Date().toISOString()
      })
      .then(() => {
        setDeciding(null);
        setNote("");
      })
      .catch((cause: unknown) => setError(`Couldn't save the decision. ${message(cause)}`))
      .finally(() => setSaving(false));
  }

  return (
    <>
      <tr class={deciding ? "row-open" : undefined}>
        <td>
          <div class="cell-title">{row.title}</div>
          <div class="cell-meta">
            {row.vendor}
            {row.reason && (
              <>
                <span class="sep"> · </span>
                {row.reason}
              </>
            )}
          </div>
          {status !== "pending" && row.deciderName && (
            <div class="cell-decision">
              {STATUS_LABEL[status]} by {row.deciderName}
              {row.decisionNote && (
                <>
                  : <q>{row.decisionNote}</q>
                </>
              )}
            </div>
          )}
        </td>
        <td class="muted-cell">{row.category}</td>
        <td class="nowrap">{row.requesterName}</td>
        <td class="nowrap muted-cell" title={new Date(row.requestedAt).toLocaleString()}>
          {formatWhen(row.requestedAt)}
        </td>
        <td class="num">{formatCents(row.amountCents)}</td>
        <td>
          <span class={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
        </td>
        <td class="row-actions">
          {canDecide && !deciding && (
            <>
              <button type="button" class="button-ghost" onClick={() => setDeciding("approved")}>
                Approve
              </button>
              <button type="button" class="button-ghost" onClick={() => setDeciding("rejected")}>
                Reject
              </button>
            </>
          )}
          {status === "pending" && own && <span class="cell-meta">Yours</span>}
        </td>
      </tr>
      {deciding && (
        <tr class="decision-row">
          <td colSpan={7}>
            <div class="decision">
              <label>
                {deciding === "approved" ? "Approve" : "Reject"} {formatCents(row.amountCents)} for{" "}
                {row.title}
                <input
                  value={note}
                  placeholder="Add a note (optional)"
                  maxLength={500}
                  disabled={saving}
                  onInput={(event) => setNote(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.isComposing) {
                      event.preventDefault();
                      decide();
                    }
                    if (event.key === "Escape") setDeciding(null);
                  }}
                  ref={(element) => element?.focus()}
                />
              </label>
              <div class="decision-actions">
                <button
                  type="button"
                  class="button-ghost"
                  disabled={saving}
                  onClick={() => {
                    setDeciding(null);
                    setNote("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class={deciding === "approved" ? "button-secondary" : "button-danger"}
                  disabled={saving}
                  onClick={decide}
                >
                  {saving
                    ? "Saving…"
                    : deciding === "approved"
                      ? "Approve request"
                      : "Reject request"}
                </button>
              </div>
            </div>
            {error && (
              <p class="error" role="alert">
                {error}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function NewRequest({ viewer, onClose }: { viewer: Viewer; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function save(form: HTMLFormElement) {
    if (saving || !form.reportValidity()) return;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const amountCents = Math.round(Number(text("amount")) * 100);
    setSaving(true);
    setError("");
    patchy.tables.requests
      .insert({
        title: text("title"),
        vendor: text("vendor"),
        amountCents,
        category: text("category"),
        reason: text("reason"),
        requesterId: viewer.id,
        requesterName: viewer.name,
        requestedAt: new Date().toISOString()
      })
      .then(() => {
        form.reset();
        onClose();
      })
      .catch((cause: unknown) => setError(`Couldn't save the request. ${message(cause)}`))
      .finally(() => setSaving(false));
  }

  // The sandbox blocks native form submission; save through the broker instead.
  return (
    <section class="compose card" aria-label="New request">
      <h2>New request</h2>
      <form
        class="form"
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            event.target instanceof HTMLInputElement &&
            !event.isComposing
          ) {
            event.preventDefault();
            save(event.currentTarget);
          }
          if (event.key === "Escape") onClose();
        }}
      >
        <label>
          What it's for
          <input
            name="title"
            required
            maxLength={120}
            placeholder="Figma seats renewal"
            disabled={saving}
            ref={(element) => element?.focus()}
          />
        </label>
        <div class="form-row">
          <label>
            Vendor
            <input name="vendor" required maxLength={80} placeholder="Figma" disabled={saving} />
          </label>
          <label>
            Amount (USD)
            <input
              name="amount"
              type="number"
              required
              min="0.01"
              step="0.01"
              inputMode="decimal"
              placeholder="0.00"
              disabled={saving}
            />
          </label>
          <label>
            Category
            <select name="category" required disabled={saving}>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Reason
          <textarea
            name="reason"
            required
            rows={2}
            maxLength={500}
            placeholder="Why the team needs it"
            disabled={saving}
          />
        </label>
        <div class="actions">
          <span class="hint">Requested by {viewer.name}</span>
          <button type="button" class="button-ghost" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={(event) => save(event.currentTarget.form!)}
          >
            {saving ? "Submitting…" : "Submit request"}
          </button>
        </div>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
