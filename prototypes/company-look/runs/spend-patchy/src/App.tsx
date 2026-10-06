import { useEffect, useMemo, useState, useQuery } from "patchy/preact";
import type { Row } from "patchy/config";
import type config from "../patchy.config.js";
import { patchy } from "../patchy/_generated/client.js";
import logo from "../patchy/_generated/logo.svg";
import { sampleRequests } from "./sample.js";

type Request = Row<typeof config, "requests">;
type Status = "pending" | "approved" | "rejected";
type Filter = "all" | Status;
type Viewer = { id: string; name: string } | null;

export const CATEGORIES = ["Software", "Travel", "Equipment", "Events", "Other"] as const;
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" }
];
const PAGE = 200;

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function dollars(cents: number) {
  return money.format(cents / 100).replace(/\.00$/, "");
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function whenText(iso: string, now: number) {
  const then = new Date(iso);
  const days = Math.floor((startOfDay(now) - startOfDay(then.getTime())) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return day.format(then);
}

function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonthIso() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

function isOwn(request: Request, viewer: Viewer) {
  if (!viewer) return false;
  if (request.requestedById) return request.requestedById === viewer.id;
  return request.requestedByName.trim().toLowerCase() === viewer.name.trim().toLowerCase();
}

export function App() {
  const [viewer, setViewer] = useState<Viewer>(null);
  const [viewerError, setViewerError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let active = true;
    void patchy
      .me()
      .then((me) => {
        if (active) setViewer(me ? { id: me.user.id, name: me.user.name } : null);
      })
      .catch((cause: unknown) => {
        if (active) setViewerError(message(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  const listArgs =
    filter === "all"
      ? { index: "byRequestedAt" as const, order: "desc" as const, limit: PAGE }
      : { index: "byStatus" as const, eq: { status: filter }, order: "desc" as const, limit: PAGE };
  const list = useQuery(patchy.tables.requests.list, listArgs);
  const pending = useQuery(patchy.tables.requests.list, {
    index: "byStatus",
    eq: { status: "pending" },
    limit: 1000
  });
  const monthStart = useMemo(startOfMonthIso, []);
  const approved = useQuery(patchy.tables.requests.list, {
    index: "byStatusDecided",
    eq: { status: "approved" },
    range: { column: "decidedAt", gte: monthStart },
    limit: 1000
  });
  const anyRow = useQuery(patchy.tables.requests.list, { limit: 1 });

  const pendingRows = pending.data?.rows ?? [];
  const pendingTotal = pendingRows.reduce((sum, r) => sum + r.amountCents, 0);
  const approvedTotal = (approved.data?.rows ?? []).reduce((sum, r) => sum + r.amountCents, 0);
  const isEmpty = anyRow.data !== undefined && anyRow.data.rows.length === 0;
  const monthName = new Date().toLocaleString("en-US", { month: "long" });

  return (
    <main class="page">
      <header class="page-header">
        <div class="page-header-line">
          <img src={logo} alt="Patchy" />
          {viewer && (
            <span class="viewer">
              Signed in as <strong>{viewer.name}</strong>
            </span>
          )}
        </div>
        <h1>Spend requests</h1>
        <p>Ask to spend company money. A teammate approves or rejects it.</p>
      </header>

      {viewerError && (
        <p class="note note-danger" role="alert">
          Couldn't tell who you are: {viewerError}
        </p>
      )}

      <section class="stats" aria-label="Summary">
        <div class="stat">
          <span class="stat-label">Pending</span>
          <span class="stat-value">{pending.data ? pendingRows.length : "–"}</span>
          <span class="stat-sub">{pending.data ? "Waiting on a teammate" : "Loading"}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Pending total</span>
          <span class="stat-value">{pending.data ? dollars(pendingTotal) : "–"}</span>
          <span class="stat-sub">
            Across {pendingRows.length} {pendingRows.length === 1 ? "request" : "requests"}
          </span>
        </div>
        <div class="stat">
          <span class="stat-label">Approved in {monthName}</span>
          <span class="stat-value">{approved.data ? dollars(approvedTotal) : "–"}</span>
          <span class="stat-sub">
            {approved.data
              ? `${approved.data.rows.length} approved since ${day.format(new Date(monthStart))}`
              : "Loading"}
          </span>
        </div>
      </section>

      <div class="layout">
        <section class="panel form-panel" aria-labelledby="new-heading">
          <h2 id="new-heading">New request</h2>
          <RequestForm viewer={viewer} />
        </section>

        <section class="panel list-panel" aria-labelledby="list-heading">
          <div class="list-head">
            <h2 id="list-heading">Requests</h2>
            <div class="tabs" role="group" aria-label="Filter by status">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  class="tab"
                  aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)}
                >
                  {f.label}
                  {f.value === "pending" && pending.data ? (
                    <span class="tab-count">{pendingRows.length}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          {list.error && (
            <p class="note note-danger" role="alert">
              Couldn't load requests. {list.error.message}
            </p>
          )}
          {isEmpty ? (
            <EmptyState />
          ) : list.data === undefined ? (
            <p class="muted" role="status">
              Loading requests...
            </p>
          ) : list.data.rows.length === 0 ? (
            <div class="empty empty-small">
              <p>No {filter} requests.</p>
            </div>
          ) : (
            <RequestTable rows={list.data.rows} viewer={viewer} />
          )}
          {list.data?.cursor && (
            <p class="muted small">Showing the newest {PAGE}. Older requests are not shown.</p>
          )}
        </section>
      </div>
    </main>
  );
}

function RequestForm({ viewer }: { viewer: Viewer }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  function save(form: HTMLFormElement) {
    if (saving || !form.reportValidity()) return;
    if (!viewer) {
      setError("Couldn't save the request. We don't know who you are yet; reload the page.");
      return;
    }
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const amount = Number(text("amount"));
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Couldn't save the request. Amount must be a positive number of dollars.");
      return;
    }
    const title = text("title");
    setSaving(true);
    setError("");
    setDone("");
    void patchy.tables.requests
      .insert({
        title,
        vendor: text("vendor"),
        amountCents: Math.round(amount * 100),
        category: text("category"),
        reason: text("reason") || null,
        requestedByName: viewer.name,
        requestedById: viewer.id,
        requestedAt: new Date().toISOString(),
        status: "pending"
      })
      .then(() => {
        form.reset();
        setDone(`Submitted "${title}". It waits for a teammate to approve it.`);
      })
      .catch((cause: unknown) => setError(`Couldn't save the request. ${message(cause)}`))
      .finally(() => setSaving(false));
  }

  return (
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
      }}
    >
      <div>
        <label for="f-title">What it's for</label>
        <input
          id="f-title"
          name="title"
          required
          maxLength={120}
          placeholder="Figma seats renewal"
          disabled={saving}
        />
      </div>
      <div class="form-row">
        <div>
          <label for="f-vendor">Vendor</label>
          <input
            id="f-vendor"
            name="vendor"
            required
            maxLength={80}
            placeholder="Figma"
            disabled={saving}
          />
        </div>
        <div>
          <label for="f-amount">Amount (USD)</label>
          <div class="amount">
            <span aria-hidden="true">$</span>
            <input
              id="f-amount"
              name="amount"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              required
              placeholder="0"
              disabled={saving}
            />
          </div>
        </div>
      </div>
      <div>
        <label for="f-category">Category</label>
        <select id="f-category" name="category" required disabled={saving}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label for="f-reason">Reason</label>
        <textarea
          id="f-reason"
          name="reason"
          required
          maxLength={500}
          rows={3}
          placeholder="Why the team needs it"
          disabled={saving}
        />
        <p class="form-hint">One or two sentences. Your name and today's date are added for you.</p>
      </div>
      <div class="form-actions">
        <button
          type="button"
          disabled={saving}
          onClick={(event) => save(event.currentTarget.form!)}
        >
          {saving ? "Submitting..." : "Submit request"}
        </button>
      </div>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p class="form-done" role="status">
          {done}
        </p>
      )}
    </form>
  );
}

function RequestTable({ rows, viewer }: { rows: readonly Request[]; viewer: Viewer }) {
  const [now] = useState(() => Date.now());
  return (
    <div class="table-wrap">
      <table class="requests">
        <thead>
          <tr>
            <th scope="col">Request</th>
            <th scope="col">Requested by</th>
            <th scope="col" class="num">
              Amount
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <RequestRow key={r.id} request={r} viewer={viewer} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "approved"
      ? "badge-success"
      : status === "rejected"
        ? "badge-danger"
        : "badge-warning";
  const label = status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Pending";
  return <span class={`badge ${variant}`}>{label}</span>;
}

function RequestRow({
  request: r,
  viewer,
  now
}: {
  request: Request;
  viewer: Viewer;
  now: number;
}) {
  const [deciding, setDeciding] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const own = isOwn(r, viewer);
  const pending = r.status === "pending";

  function decide(status: Status) {
    if (!viewer || saving) return;
    setSaving(true);
    setError("");
    void (async () => {
      // Re-read first: someone else may have decided since this list rendered.
      const current = await patchy.tables.requests.get(r.id);
      if (!current) throw new Error("The request no longer exists.");
      if (current.status !== "pending")
        throw new Error(`${current.decidedByName ?? "Someone"} already decided it.`);
      await patchy.tables.requests.update(r.id, {
        status,
        decidedByName: viewer.name,
        decidedById: viewer.id,
        decidedAt: new Date().toISOString(),
        note: note.trim() || null
      });
      setDeciding(false);
      setNote("");
    })()
      .catch((cause: unknown) => setError(`Couldn't save the decision. ${message(cause)}`))
      .finally(() => setSaving(false));
  }

  return (
    <>
      <tr class={deciding ? "row-open" : undefined}>
        <td>
          <div class="cell-title">{r.title}</div>
          <div class="cell-meta">
            {r.vendor} · <span class="category">{r.category}</span>
          </div>
          {r.reason && <div class="cell-reason">{r.reason}</div>}
        </td>
        <td>
          <div class="cell-person">{r.requestedByName}</div>
          <div class="cell-meta" title={new Date(r.requestedAt).toLocaleString()}>
            {whenText(r.requestedAt, now)}
          </div>
        </td>
        <td class="num cell-amount">{dollars(r.amountCents)}</td>
        <td class="cell-status">
          <StatusBadge status={r.status} />
          {!pending && r.decidedByName && <div class="cell-meta">by {r.decidedByName}</div>}
          {!pending && r.note && <div class="decision-note">“{r.note}”</div>}
          {pending &&
            !deciding &&
            (own ? (
              <div class="cell-meta">Your request. A teammate decides.</div>
            ) : (
              <button
                type="button"
                class="button-secondary button-small"
                disabled={!viewer}
                onClick={() => setDeciding(true)}
              >
                Decide
              </button>
            ))}
        </td>
      </tr>
      {deciding && (
        <tr class="decision-row">
          <td colSpan={4}>
            <div class="decision">
              <div class="decision-field">
                <label for={`note-${r.id}`}>Note for {r.requestedByName} (optional)</label>
                <input
                  id={`note-${r.id}`}
                  value={note}
                  maxLength={300}
                  disabled={saving}
                  placeholder="Keep it under budget"
                  onInput={(e) => setNote(e.currentTarget.value)}
                />
              </div>
              <div class="form-actions">
                <button type="button" disabled={saving} onClick={() => decide("approved")}>
                  Approve request
                </button>
                <button
                  type="button"
                  class="button-danger"
                  disabled={saving}
                  onClick={() => decide("rejected")}
                >
                  Reject
                </button>
                <button
                  type="button"
                  class="button-quiet"
                  disabled={saving}
                  onClick={() => {
                    setDeciding(false);
                    setError("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
            {error && (
              <p class="form-error" role="alert">
                {error}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function EmptyState() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function load() {
    if (loading) return;
    setLoading(true);
    setError("");
    void (async () => {
      // Avoid a double load if someone else filled the table meanwhile.
      const existing = await patchy.tables.requests.list({ limit: 1 });
      if (existing.rows.length > 0) return;
      await patchy.tables.requests.insertMany(sampleRequests(Date.now()));
    })()
      .catch((cause: unknown) => setError(`Couldn't load the sample data. ${message(cause)}`))
      .finally(() => setLoading(false));
  }

  return (
    <div class="empty">
      <h3>No requests yet</h3>
      <p>
        New ones land here when someone submits the form. Load eight invented requests to try it
        out.
      </p>
      <button type="button" class="button-secondary" disabled={loading} onClick={load}>
        {loading ? "Loading..." : "Load sample data"}
      </button>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
