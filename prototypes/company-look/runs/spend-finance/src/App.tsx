import { useEffect, useMemo, useState } from "patchy/preact";
import { useQuery } from "patchy/preact";
import type { Row } from "patchy/config";
import type config from "../patchy.config.js";
import { patchy } from "../patchy/_generated/client.js";
import logo from "../patchy/_generated/logo.svg";
import { sampleRequests } from "./sample.js";
import "./app.css";

type Request = Row<typeof config, "requests">;
type Status = "Pending" | "Approved" | "Rejected";
type Viewer = { id: string; name: string };

const CATEGORIES = ["Software", "Travel", "Equipment", "Events", "Other"] as const;
const FILTERS = ["All", "Pending", "Approved", "Rejected"] as const;
type Filter = (typeof FILTERS)[number];

const LIST_LIMIT = 200;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const moneyWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric"
});
const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const asOfFormat = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "numeric"
});
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long" });

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatCents(cents: number): string {
  return cents % 100 === 0 ? moneyWhole.format(cents / 100) : money.format(cents / 100);
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `Today, ${timeFormat.format(date)}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return `Yesterday, ${timeFormat.format(date)}`;
  return dateFormat.format(date);
}

function isRequester(request: Request, viewer: Viewer | null): boolean {
  if (!viewer) return true;
  if (request.requestedById) return request.requestedById === viewer.id;
  return request.requestedBy === viewer.name;
}

export function App() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [viewerError, setViewerError] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [now] = useState(() => new Date());
  const monthStart = useMemo(
    () => new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    [now]
  );

  useEffect(() => {
    let active = true;
    patchy
      .me()
      .then((me) => {
        if (!active) return;
        if (me) setViewer({ id: me.user.id, name: me.user.name });
        else setViewerError("This page is open without a company sign-in.");
      })
      .catch((cause: unknown) => {
        if (active) setViewerError(message(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  const any = useQuery(patchy.tables.requests.list, {
    index: "byRequestedAt",
    order: "desc",
    limit: 1
  });
  const list = useQuery(
    patchy.tables.requests.list,
    filter === "All"
      ? { index: "byRequestedAt", order: "desc", limit: LIST_LIMIT }
      : { index: "byStatus", eq: { status: filter }, order: "desc", limit: LIST_LIMIT }
  );
  const pending = useQuery(patchy.tables.requests.list, {
    index: "byStatus",
    eq: { status: "Pending" },
    limit: 1000
  });
  const approved = useQuery(patchy.tables.requests.list, {
    index: "byStatusDecided",
    eq: { status: "Approved" },
    range: { column: "decidedAt", gte: monthStart },
    limit: 1000
  });

  const isEmpty = any.data !== undefined && any.data.rows.length === 0;

  return (
    <>
      <header class="page-header">
        <img src={logo} alt="Vanguard" />
        <span class="tool-name">Spend requests</span>
        <span class="actions">
          {viewer && (
            <span class="viewer">
              Signed in as <strong>{viewer.name}</strong>
            </span>
          )}
        </span>
      </header>
      <main class="page">
        <p class="eyebrow">Finance</p>
        <h1>Spend requests</h1>
        <p class="lede">
          Ask to spend company money. A teammate approves or rejects it — never the person who
          asked.
        </p>
        {viewerError && (
          <p class="field-error" role="alert">
            We couldn't tell who you are: {viewerError}
          </p>
        )}

        <Stats pending={pending.data?.rows} approved={approved.data?.rows} now={now} />

        {any.error && (
          <p class="field-error" role="alert">
            We couldn't load requests. {any.error.message}
          </p>
        )}
        {any.loading && any.data === undefined && <p class="quiet">Loading requests…</p>}

        {isEmpty && <EmptyState viewer={viewer} />}

        {any.data !== undefined && !isEmpty && (
          <div class="workspace">
            <section class="list-section" aria-labelledby="list-heading">
              <div class="list-head">
                <h2 id="list-heading">All requests</h2>
                <div class="segmented" role="tablist" aria-label="Filter by status">
                  {FILTERS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="tab"
                      aria-selected={filter === option}
                      onClick={() => setFilter(option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
              {list.error && (
                <p class="field-error" role="alert">
                  We couldn't load this list. {list.error.message}
                </p>
              )}
              {list.data && (
                <RequestTable
                  rows={list.data.rows}
                  viewer={viewer}
                  filter={filter}
                  truncated={list.data.cursor !== null}
                />
              )}
            </section>
            <aside class="form-section">
              <NewRequest viewer={viewer} />
            </aside>
          </div>
        )}
      </main>
    </>
  );
}

function Stats(props: {
  pending: readonly Request[] | undefined;
  approved: readonly Request[] | undefined;
  now: Date;
}) {
  const pendingTotal = props.pending?.reduce((sum, row) => sum + row.amountCents, 0);
  const approvedTotal = props.approved?.reduce((sum, row) => sum + row.amountCents, 0);
  const asOf = asOfFormat.format(props.now);
  return (
    <section class="stats section-ruled" aria-label="Summary">
      <div>
        <div class="stat-label">Pending requests</div>
        <div class="stat-value">{props.pending ? props.pending.length : "—"}</div>
        <div class="stat-asof">Waiting for a decision, as of {asOf}</div>
      </div>
      <div>
        <div class="stat-label">Pending amount</div>
        <div class="stat-value">{pendingTotal === undefined ? "—" : formatCents(pendingTotal)}</div>
        <div class="stat-asof">Total of pending requests, as of {asOf}</div>
      </div>
      <div>
        <div class="stat-label">Approved in {monthFormat.format(props.now)}</div>
        <div class="stat-value">
          {approvedTotal === undefined ? "—" : formatCents(approvedTotal)}
        </div>
        <div class="stat-asof">
          {props.approved
            ? `${props.approved.length} ${props.approved.length === 1 ? "request" : "requests"}`
            : ""}{" "}
          by decision date, as of {asOf}
        </div>
      </div>
    </section>
  );
}

function EmptyState(props: { viewer: Viewer | null }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function load() {
    if (loading) return;
    setLoading(true);
    setError("");
    patchy.tables.requests
      .insertMany(sampleRequests(Date.now()))
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setLoading(false));
  }

  return (
    <section class="empty-state">
      <h3>No spend requests yet</h3>
      <p>
        New requests appear here as soon as they're submitted. You can start with eight invented
        requests to see how it works.
      </p>
      <div class="form-actions">
        <button type="button" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Load sample data"}
        </button>
        <NewRequestToggle viewer={props.viewer} />
      </div>
      {error && (
        <p class="field-error" role="alert">
          We couldn't load the sample data. {error}
        </p>
      )}
    </section>
  );
}

function NewRequestToggle(props: { viewer: Viewer | null }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" class="button-secondary" onClick={() => setOpen(true)}>
        Make a request
      </button>
    );
  }
  return (
    <div class="empty-form">
      <NewRequest viewer={props.viewer} />
    </div>
  );
}

function RequestTable(props: {
  rows: readonly Request[];
  viewer: Viewer | null;
  filter: Filter;
  truncated: boolean;
}) {
  const [reviewing, setReviewing] = useState<string | null>(null);

  if (props.rows.length === 0) {
    return <p class="quiet table-empty">No {props.filter.toLowerCase()} requests right now.</p>;
  }

  return (
    <>
      <table class="table-data">
        <thead>
          <tr>
            <th>Requested</th>
            <th>For</th>
            <th>Vendor</th>
            <th>Category</th>
            <th class="num">Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <RequestRow
              key={row.id}
              row={row}
              viewer={props.viewer}
              open={reviewing === row.id}
              onToggle={() => setReviewing((current) => (current === row.id ? null : row.id))}
            />
          ))}
        </tbody>
      </table>
      {props.truncated && <p class="stat-asof">Showing the newest {LIST_LIMIT} requests.</p>}
    </>
  );
}

function StatusBadge(props: { status: string }) {
  const kind =
    props.status === "Approved"
      ? "badge-approved"
      : props.status === "Rejected"
        ? "badge-danger"
        : "badge-pending";
  return <span class={`badge ${kind}`}>{props.status}</span>;
}

function RequestRow(props: {
  row: Request;
  viewer: Viewer | null;
  open: boolean;
  onToggle: () => void;
}) {
  const { row, viewer } = props;
  const own = isRequester(row, viewer);
  const canDecide = row.status === "Pending" && viewer !== null && !own;

  return (
    <>
      <tr class={props.open ? "is-open" : undefined}>
        <td class="when">
          <div class="who">{row.requestedBy}</div>
          <div class="meta">{formatWhen(row.requestedAt)}</div>
        </td>
        <td>
          <div class="title">{row.title}</div>
          {row.reason && <div class="meta">{row.reason}</div>}
        </td>
        <td>{row.vendor}</td>
        <td>{row.category}</td>
        <td class="num amount">{formatCents(row.amountCents)}</td>
        <td class="status">
          <StatusBadge status={row.status} />
          {row.decidedBy && (
            <div class="meta">
              by {row.decidedBy}
              {row.decidedAt && <>, {formatWhen(row.decidedAt)}</>}
            </div>
          )}
          {row.note && <div class="note">“{row.note}”</div>}
          {canDecide && !props.open && (
            <div class="row-action">
              <button type="button" class="button-secondary button-small" onClick={props.onToggle}>
                Review
              </button>
            </div>
          )}
          {row.status === "Pending" && own && viewer && (
            <div class="meta">Waiting for a teammate</div>
          )}
        </td>
      </tr>
      {canDecide && props.open && (
        <tr class="review-row">
          <td colSpan={6}>
            <Decision row={row} viewer={viewer} onDone={props.onToggle} />
          </td>
        </tr>
      )}
    </>
  );
}

function Decision(props: { row: Request; viewer: Viewer; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState<Status | null>(null);
  const [error, setError] = useState("");

  function decide(status: "Approved" | "Rejected") {
    if (saving) return;
    setSaving(status);
    setError("");
    void (async () => {
      // Re-read first: someone else may have decided since this screen rendered.
      const current = await patchy.tables.requests.get(props.row.id);
      if (!current || current.status !== "Pending") {
        throw new Error(
          current
            ? `It was already ${current.status.toLowerCase()} by ${current.decidedBy ?? "someone else"}.`
            : "It was removed."
        );
      }
      await patchy.tables.requests.update(props.row.id, {
        status,
        decidedBy: props.viewer.name,
        decidedById: props.viewer.id,
        decidedAt: new Date().toISOString(),
        note: note.trim() || null
      });
    })()
      .then(() => props.onDone())
      .catch((cause: unknown) => {
        setError(message(cause));
        setSaving(null);
      });
  }

  return (
    <div class="decision">
      <div class="decision-summary">
        <h4>Review {props.row.requestedBy}'s request</h4>
        <p>
          {props.row.title} from {props.row.vendor} for{" "}
          <strong>{formatCents(props.row.amountCents)}</strong>.
        </p>
      </div>
      <div class="decision-note">
        <label for={`note-${props.row.id}`}>Note (optional)</label>
        <input
          id={`note-${props.row.id}`}
          value={note}
          maxLength={500}
          placeholder="Anything the requester should know"
          disabled={saving !== null}
          onInput={(event) => setNote(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onDone();
          }}
        />
      </div>
      <div class="form-actions">
        <button
          type="button"
          class="button-commit"
          disabled={saving !== null}
          onClick={() => decide("Approved")}
        >
          {saving === "Approved" ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          class="button-danger"
          disabled={saving !== null}
          onClick={() => decide("Rejected")}
        >
          {saving === "Rejected" ? "Rejecting…" : "Reject"}
        </button>
        <button type="button" class="link-button" disabled={saving !== null} onClick={props.onDone}>
          Cancel
        </button>
      </div>
      {error && (
        <p class="field-error" role="alert">
          We couldn't save this decision. {error}
        </p>
      )}
    </div>
  );
}

function NewRequest(props: { viewer: Viewer | null }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  function submit(form: HTMLFormElement) {
    if (saving || !props.viewer || !form.reportValidity()) return;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const amountCents = Math.round(Number(text("amount")) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    const viewer = props.viewer;
    setSaving(true);
    setError("");
    setDone("");
    patchy.tables.requests
      .insert({
        title: text("title"),
        vendor: text("vendor"),
        amountCents,
        category: text("category"),
        reason: text("reason"),
        requestedBy: viewer.name,
        requestedById: viewer.id,
        requestedAt: new Date().toISOString(),
        status: "Pending"
      })
      .then(() => {
        form.reset();
        setDone("Your request was submitted. A teammate can approve it from the list.");
      })
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setSaving(false));
  }

  const disabled = saving || !props.viewer;

  // The sandbox blocks native form submission; submit through the broker instead.
  return (
    <form
      class="panel form"
      aria-labelledby="new-heading"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          event.target instanceof HTMLInputElement &&
          !event.isComposing
        ) {
          event.preventDefault();
          submit(event.currentTarget);
        }
      }}
    >
      <h3 id="new-heading">New request</h3>
      <div>
        <label for="f-title">What it's for</label>
        <input id="f-title" name="title" required maxLength={120} disabled={disabled} />
      </div>
      <div>
        <label for="f-vendor">Vendor</label>
        <input id="f-vendor" name="vendor" required maxLength={120} disabled={disabled} />
      </div>
      <div class="form-pair">
        <div>
          <label for="f-amount">Amount (USD)</label>
          <input
            id="f-amount"
            name="amount"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            required
            disabled={disabled}
          />
        </div>
        <div>
          <label for="f-category">Category</label>
          <select id="f-category" name="category" required disabled={disabled}>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label for="f-reason">Reason</label>
        <textarea
          id="f-reason"
          name="reason"
          required
          maxLength={500}
          rows={3}
          disabled={disabled}
        />
        <div class="field-hint">A sentence or two on why it's needed.</div>
      </div>
      <div class="form-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={(event) => submit(event.currentTarget.form!)}
        >
          {saving ? "Submitting…" : "Submit request"}
        </button>
      </div>
      <p class="sr-status" role="status">
        {done}
      </p>
      {error && (
        <p class="field-error" role="alert">
          We couldn't submit this request. {error}
        </p>
      )}
    </form>
  );
}
