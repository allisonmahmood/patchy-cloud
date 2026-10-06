import { useEffect, useMemo, useState } from "patchy/preact";
import { useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import {
  CATEGORIES,
  STATUS_LABEL,
  formatCents,
  fullDate,
  monthStartIso,
  parseDollars,
  relativeDay,
  sampleRows,
  type Request,
  type Status
} from "./data.js";

type Viewer = { id: string; name: string };
type Filter = "all" | Status;

const PAGE = 200;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function App() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [viewerError, setViewerError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // Fixed per page load; the "this month" window does not roll over mid-session.
  const now = useMemo(() => Date.now(), []);
  const monthStart = useMemo(() => monthStartIso(now), [now]);

  useEffect(() => {
    let active = true;
    patchy
      .me()
      .then((me) => {
        if (!active) return;
        if (me) setViewer({ id: me.user.id, name: me.user.name });
        else setViewerError("Sign in to submit or decide on requests.");
      })
      .catch((cause: unknown) => {
        if (active) setViewerError(message(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  const all = useQuery(patchy.tables.requests.list, {
    index: "byRequestedAt",
    order: "desc",
    limit: PAGE
  });
  const filtered = useQuery(
    patchy.tables.requests.list,
    filter === "all"
      ? { index: "byRequestedAt", order: "desc", limit: PAGE }
      : { index: "byStatus", eq: { status: filter }, order: "desc", limit: PAGE }
  );
  const pending = useQuery(patchy.tables.requests.list, {
    index: "byStatus",
    eq: { status: "pending" },
    limit: 1000
  });
  const approvedThisMonth = useQuery(patchy.tables.requests.list, {
    index: "byStatusDecided",
    eq: { status: "approved" },
    range: { column: "decidedAt", gte: monthStart },
    limit: 1000
  });

  const isEmpty = all.data !== undefined && all.data.rows.length === 0;

  return (
    <main class="wrap">
      <header class="head">
        <div class="head-line">
          <span class="brand">
            <span class="glyph" aria-hidden="true" />
            Spend requests
          </span>
          <span class="who">
            {viewer ? (
              <>
                Signed in as <strong>{viewer.name}</strong>
              </>
            ) : viewerError ? (
              <span class="error-text">{viewerError}</span>
            ) : (
              "Checking who you are…"
            )}
          </span>
        </div>
        <h1>Ask before you spend.</h1>
        <p class="lede">
          Submit what you want to buy. A teammate other than you approves or rejects it.
        </p>
      </header>

      <Summary pending={pending} approved={approvedThisMonth} />

      {isEmpty ? (
        <EmptyState viewer={viewer} />
      ) : (
        <>
          <NewRequestForm viewer={viewer} />
          <section class="list-section" aria-labelledby="list-title">
            <div class="list-head">
              <h2 id="list-title">All requests</h2>
              <div class="filters" role="group" aria-label="Filter by status">
                {(["all", "pending", "approved", "rejected"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    class={`filter ${filter === value ? "is-on" : ""}`}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {value === "all" ? "All" : STATUS_LABEL[value]}
                  </button>
                ))}
              </div>
            </div>
            {filtered.error && (
              <p class="notice notice-red" role="alert">
                Couldn't load requests: {filtered.error.message}
              </p>
            )}
            {filtered.data === undefined && !filtered.error && (
              <p class="muted">Loading requests…</p>
            )}
            {filtered.data && filtered.data.rows.length === 0 && (
              <p class="muted none">
                No {filter === "all" ? "" : STATUS_LABEL[filter].toLowerCase() + " "}requests.
              </p>
            )}
            {filtered.data && filtered.data.rows.length > 0 && (
              <ol class="requests">
                {filtered.data.rows.map((row) => (
                  <RequestItem key={row.id} row={row} viewer={viewer} now={now} />
                ))}
              </ol>
            )}
            {filtered.data?.cursor && (
              <p class="muted">Showing the newest {PAGE}. Older requests aren't shown.</p>
            )}
          </section>
        </>
      )}
      {all.error && !filtered.error && (
        <p class="notice notice-red" role="alert">
          Couldn't load requests: {all.error.message}
        </p>
      )}
    </main>
  );
}

type ListSnapshot = {
  readonly data?: { readonly rows: readonly Request[] };
  readonly error?: unknown;
};

function Summary({ pending, approved }: { pending: ListSnapshot; approved: ListSnapshot }) {
  const pendingRows = pending.data?.rows;
  const approvedRows = approved.data?.rows;
  const sum = (rows: readonly Request[]) => rows.reduce((total, row) => total + row.amountCents, 0);
  const monthName = new Date().toLocaleString("en-US", { month: "long" });
  return (
    <section class="stats" aria-label="Summary">
      <div class="stat stat-amber">
        <span class="stat-label">Waiting for a decision</span>
        <span class="stat-value">{pendingRows ? pendingRows.length : "–"}</span>
        <span class="stat-sub">
          {pendingRows
            ? `pending request${pendingRows.length === 1 ? "" : "s"}`
            : pending.error
              ? "couldn't load"
              : "loading"}
        </span>
      </div>
      <div class="stat stat-amber">
        <span class="stat-label">Pending total</span>
        <span class="stat-value">{pendingRows ? formatCents(sum(pendingRows)) : "–"}</span>
        <span class="stat-sub">asked for, not yet decided</span>
      </div>
      <div class="stat stat-green">
        <span class="stat-label">Approved in {monthName}</span>
        <span class="stat-value">{approvedRows ? formatCents(sum(approvedRows)) : "–"}</span>
        <span class="stat-sub">
          {approvedRows
            ? `${approvedRows.length} request${approvedRows.length === 1 ? "" : "s"} approved this month`
            : approved.error
              ? "couldn't load"
              : "loading"}
        </span>
      </div>
    </section>
  );
}

function EmptyState({ viewer }: { viewer: Viewer | null }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  function loadSamples() {
    if (loading) return;
    setLoading(true);
    setError("");
    patchy.tables.requests
      .insertMany(sampleRows(Date.now()))
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setLoading(false));
  }

  if (showForm) return <NewRequestForm viewer={viewer} startOpen />;

  return (
    <section class="empty">
      <div class="empty-mark" aria-hidden="true">
        $
      </div>
      <h2>No spend requests yet</h2>
      <p>
        When someone asks to spend company money, it shows up here for a teammate to approve or
        reject.
      </p>
      <div class="actions">
        <button type="button" class="btn btn-primary" disabled={loading} onClick={loadSamples}>
          {loading ? "Loading…" : "Load sample data"}
        </button>
        <button type="button" class="btn" onClick={() => setShowForm(true)}>
          Submit the first request
        </button>
      </div>
      <p class="muted small">
        Sample data adds eight invented requests from four made-up teammates.
      </p>
      {error && (
        <p class="notice notice-red" role="alert">
          Couldn't load sample data: {error}
        </p>
      )}
    </section>
  );
}

function NewRequestForm({
  viewer,
  startOpen = false
}: {
  viewer: Viewer | null;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  function save(form: HTMLFormElement) {
    if (saving || !viewer) return;
    const amountInput = form.elements.namedItem("amount") as HTMLInputElement;
    const data = new FormData(form);
    const cents = parseDollars(String(data.get("amount") ?? ""));
    amountInput.setCustomValidity(
      cents === null ? "Enter a dollar amount above zero, like 120 or 89.99." : ""
    );
    if (!form.reportValidity() || cents === null) return;
    const title = String(data.get("title") ?? "").trim();
    setSaving(true);
    setError("");
    setDone("");
    patchy.tables.requests
      .insert({
        title,
        vendor: String(data.get("vendor") ?? "").trim(),
        amountCents: cents,
        category: String(data.get("category") ?? "Other"),
        reason: String(data.get("reason") ?? "").trim(),
        requestedById: viewer.id,
        requestedByName: viewer.name,
        requestedAt: new Date().toISOString(),
        status: "pending"
      })
      .then(() => {
        form.reset();
        setDone(`Submitted “${title}”. A teammate can now approve it.`);
      })
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setSaving(false));
  }

  if (!open) {
    return (
      <section class="new-bar">
        <button
          type="button"
          class="btn btn-primary"
          disabled={!viewer}
          onClick={() => setOpen(true)}
        >
          New request
        </button>
        {done && (
          <span class="ok-text" role="status">
            {done}
          </span>
        )}
      </section>
    );
  }

  // The sandbox blocks native form submission; save through the broker on click or Enter.
  return (
    <section class="card new-card" aria-labelledby="new-title">
      <div class="card-head">
        <h2 id="new-title">New spend request</h2>
        <button type="button" class="btn btn-ghost" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <form
        class="grid-form"
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            event.target instanceof HTMLInputElement &&
            !event.isComposing
          ) {
            event.preventDefault();
            save(event.currentTarget);
          }
        }}
      >
        <label class="span-2">
          <span>What it's for</span>
          <input
            name="title"
            required
            maxLength={120}
            placeholder="e.g. Figma seats renewal"
            disabled={saving}
          />
        </label>
        <label>
          <span>Vendor</span>
          <input name="vendor" required maxLength={80} placeholder="e.g. Figma" disabled={saving} />
        </label>
        <label>
          <span>Amount (USD)</span>
          <span class="money">
            <span aria-hidden="true">$</span>
            <input
              name="amount"
              required
              inputMode="decimal"
              placeholder="0.00"
              disabled={saving}
              onInput={(event) => event.currentTarget.setCustomValidity("")}
            />
          </span>
        </label>
        <label>
          <span>Category</span>
          <select name="category" required disabled={saving}>
            <option value="">Choose…</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label class="span-2">
          <span>Why</span>
          <textarea
            name="reason"
            required
            maxLength={400}
            rows={2}
            placeholder="One or two sentences"
            disabled={saving}
          />
        </label>
        <div class="span-2 form-foot">
          <span class="muted small">Requested by {viewer ? viewer.name : "…"}, now.</span>
          <button
            type="button"
            class="btn btn-primary"
            disabled={saving || !viewer}
            onClick={(event) => save(event.currentTarget.form!)}
          >
            {saving ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </form>
      {done && (
        <p class="notice notice-green" role="status">
          {done}
        </p>
      )}
      {error && (
        <p class="notice notice-red" role="alert">
          Couldn't submit: {error}
        </p>
      )}
    </section>
  );
}

function isRequester(row: Request, viewer: Viewer): boolean {
  return row.requestedById ? row.requestedById === viewer.id : row.requestedByName === viewer.name;
}

function RequestItem({ row, viewer, now }: { row: Request; viewer: Viewer | null; now: number }) {
  const [deciding, setDeciding] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const status = row.status as Status;
  const own = viewer ? isRequester(row, viewer) : false;
  const canDecide = status === "pending" && viewer !== null && !own;

  function decide(next: "approved" | "rejected") {
    if (!viewer || saving) return;
    setSaving(next);
    setError("");
    const trimmed = note.trim();
    patchy.tables.requests
      .update(row.id, {
        status: next,
        decidedById: viewer.id,
        decidedByName: viewer.name,
        decidedAt: new Date().toISOString(),
        note: trimmed ? trimmed : null
      })
      .then(() => setDeciding(false))
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setSaving(null));
  }

  return (
    <li class={`req req-${status}`}>
      <div class="req-main">
        <div class="req-title">
          <h3>{row.title}</h3>
          <span class="vendor">{row.vendor}</span>
        </div>
        <p class="reason">{row.reason}</p>
        <p class="meta">
          <span class="cat">{row.category}</span>
          <span>
            {row.requestedByName}
            {own && " (you)"}
          </span>
          <span title={fullDate(row.requestedAt)}>{relativeDay(row.requestedAt, now)}</span>
        </p>
      </div>
      <div class="req-side">
        <span class="amount">{formatCents(row.amountCents)}</span>
        <span class={`pill pill-${status}`}>{STATUS_LABEL[status] ?? row.status}</span>
      </div>

      {status !== "pending" && (
        <div class="decision">
          <span>
            {STATUS_LABEL[status]} by <strong>{row.decidedByName ?? "someone"}</strong>
            {row.decidedAt && (
              <span class="muted" title={fullDate(row.decidedAt)}>
                {" "}
                · {relativeDay(row.decidedAt, now)}
              </span>
            )}
          </span>
          {row.note && <q class="note">{row.note}</q>}
        </div>
      )}

      {status === "pending" && (
        <div class="decision decision-pending">
          {own ? (
            <span class="muted small">
              Waiting for a teammate. You can't decide on your own request.
            </span>
          ) : !canDecide ? (
            <span class="muted small">Waiting for a decision.</span>
          ) : deciding ? (
            <div class="decide">
              <label class="decide-note">
                <span>Note (optional)</span>
                <input
                  value={note}
                  maxLength={200}
                  placeholder="e.g. Fine, keep it under budget."
                  disabled={saving !== null}
                  onInput={(event) => setNote(event.currentTarget.value)}
                />
              </label>
              <div class="decide-buttons">
                <button
                  type="button"
                  class="btn btn-approve"
                  disabled={saving !== null}
                  onClick={() => decide("approved")}
                >
                  {saving === "approved" ? "Approving…" : "Approve"}
                </button>
                <button
                  type="button"
                  class="btn btn-reject"
                  disabled={saving !== null}
                  onClick={() => decide("rejected")}
                >
                  {saving === "rejected" ? "Rejecting…" : "Reject"}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost"
                  disabled={saving !== null}
                  onClick={() => setDeciding(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" class="btn btn-small" onClick={() => setDeciding(true)}>
              Approve or reject…
            </button>
          )}
          {error && (
            <p class="notice notice-red" role="alert">
              Couldn't save the decision: {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
