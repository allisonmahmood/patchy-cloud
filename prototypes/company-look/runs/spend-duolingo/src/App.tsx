import { useEffect, useMemo, useState, useQuery } from "patchy/preact";
import type { Row, Insert } from "patchy/config";
import type config from "../patchy.config.js";
import { patchy } from "../patchy/_generated/client.js";
import logo from "../patchy/_generated/logo.svg";

type Request = Row<typeof config, "requests">;
type NewRequest = Insert<typeof config, "requests">;
type Status = "pending" | "approved" | "rejected";
type Viewer = { id: string; name: string };

const CATEGORIES = ["Software", "Travel", "Equipment", "Events", "Other"] as const;
const STATUS_LABEL: Record<Status, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected"
};
const FILTERS: readonly ("all" | Status)[] = ["all", "pending", "approved", "rejected"];
const PAGE = 50;
const DAY = 24 * 60 * 60 * 1000;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fullDate = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function dollars(cents: number) {
  return money.format(cents / 100).replace(/\.00$/, "");
}

function when(iso: string, now: number) {
  const then = new Date(iso);
  const days = Math.floor((startOfDay(now) - startOfDay(then.getTime())) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return shortDate.format(then);
}

function startOfDay(ms: number) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function isOwn(request: Request, viewer: Viewer | null) {
  if (!viewer) return true;
  if (request.requestedById) return request.requestedById === viewer.id;
  return request.requestedByName === viewer.name;
}

function sampleRows(): NewRequest[] {
  const now = Date.now();
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  const row = (
    title: string,
    vendor: string,
    amount: number,
    category: string,
    by: string,
    days: number,
    decision?: { status: Status; by: string; note?: string }
  ): NewRequest => ({
    title,
    vendor,
    amountCents: amount * 100,
    category,
    reason: "",
    requestedByName: by,
    requestedAt: ago(days),
    status: decision?.status ?? "pending",
    decidedByName: decision?.by ?? null,
    decidedAt: decision ? ago(Math.max(days - 1, 0)) : null,
    note: decision?.note ?? null
  });
  return [
    row("Customer dinner", "Lucia's", 312, "Other", "Sam Patel", 0),
    row("Flights for the Berlin visit", "Lufthansa", 860, "Travel", "Jordan Lee", 1),
    row("Figma seats renewal", "Figma", 1440, "Software", "Maya Chen", 2),
    row("React Summit tickets", "React Summit", 1180, "Events", "Priya Nair", 3),
    row("Replacement laptop charger", "Apple", 79, "Equipment", "Maya Chen", 5, {
      status: "approved",
      by: "Jordan Lee"
    }),
    row("Offsite venue deposit", "Harbor Hall", 3200, "Events", "Priya Nair", 9, {
      status: "approved",
      by: "Sam Patel",
      note: "Keep the total under $3,500."
    }),
    row("Standing desks for new hires", "Fully", 2150, "Equipment", "Jordan Lee", 12, {
      status: "rejected",
      by: "Sam Patel",
      note: "Wait for the office move."
    }),
    row("Notion team plan", "Notion", 480, "Software", "Sam Patel", 20, {
      status: "approved",
      by: "Maya Chen"
    })
  ];
}

export function App() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [limit, setLimit] = useState(PAGE);
  const [composing, setComposing] = useState(false);
  const [flash, setFlash] = useState("");
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    void patchy
      .me()
      .then((me) => {
        if (active && me) setViewer({ id: me.user.id, name: me.user.name });
      })
      .catch(() => {
        /* Identity stays unknown; deciding is disabled. */
      });
    return () => {
      active = false;
    };
  }, []);

  const listArgs =
    filter === "all"
      ? { index: "byRequestedAt" as const, order: "desc" as const, limit }
      : { index: "byStatus" as const, eq: { status: filter }, order: "desc" as const, limit };
  const list = useQuery(patchy.tables.requests.list, listArgs);
  const any = useQuery(patchy.tables.requests.list, { limit: 1 });

  const isEmpty = any.status === "ready" && any.data?.rows.length === 0;

  return (
    <>
      <header class="page-header">
        <img src={logo} alt="Duolingo" />
        <span class="header-title">Spend requests</span>
      </header>
      <main class="page">
        <div class="page-intro">
          <div>
            <h1>spend requests.</h1>
            <p class="lede">Ask to spend company money. A teammate says yes or no.</p>
          </div>
          {!composing && !isEmpty && (
            <button
              type="button"
              onClick={() => {
                setComposing(true);
                setFlash("");
              }}
            >
              New request
            </button>
          )}
        </div>

        {flash && (
          <p class="flash" role="status">
            {flash}
          </p>
        )}

        {composing && (
          <RequestForm
            viewer={viewer}
            onCancel={() => setComposing(false)}
            onSaved={() => {
              setComposing(false);
              setFlash("Nice work! Your request is in.");
            }}
          />
        )}

        {isEmpty ? (
          !composing && <EmptyState onNew={() => setComposing(true)} />
        ) : (
          <>
            <Summary />
            <section class="requests">
              <div class="requests-bar">
                <h2>All requests</h2>
                <nav class="tabs" aria-label="Filter by status">
                  {FILTERS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      class="tab"
                      aria-pressed={filter === value}
                      onClick={() => {
                        setFilter(value);
                        setLimit(PAGE);
                      }}
                    >
                      {value === "all" ? "All" : STATUS_LABEL[value]}
                    </button>
                  ))}
                </nav>
              </div>
              {list.error && (
                <p class="error" role="alert">
                  That didn't load. {list.error.message}
                </p>
              )}
              {list.data === undefined && !list.error && <p class="muted">Loading requests…</p>}
              {list.data && list.data.rows.length === 0 && (
                <p class="muted panel-empty">
                  No {filter === "all" ? "" : STATUS_LABEL[filter as Status].toLowerCase() + " "}
                  requests right now.
                </p>
              )}
              {list.data && list.data.rows.length > 0 && (
                <RequestTable rows={list.data.rows} viewer={viewer} now={now} />
              )}
              {list.data?.cursor && (
                <div class="more">
                  <button
                    type="button"
                    class="button-secondary"
                    onClick={() => setLimit((l) => Math.min(l + PAGE, 1000))}
                  >
                    Show more
                  </button>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function Summary() {
  const monthStart = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
  }, []);
  const pending = useQuery(patchy.tables.requests.list, {
    index: "byStatus",
    eq: { status: "pending" },
    limit: 1000
  });
  const approved = useQuery(patchy.tables.requests.list, {
    index: "byStatusDecidedAt",
    eq: { status: "approved" },
    range: { column: "decidedAt", gte: monthStart },
    limit: 1000
  });
  const sum = (rows: readonly Request[] | undefined) =>
    rows?.reduce((total, r) => total + r.amountCents, 0);
  const pendingRows = pending.data?.rows;
  const month = new Date().toLocaleString("en-US", { month: "long" });

  return (
    <section class="stats" aria-label="Summary">
      <div class="stat">
        <div class="stat-value">{pendingRows ? pendingRows.length : "–"}</div>
        <div class="stat-label">Waiting for a decision</div>
      </div>
      <div class="stat">
        <div class="stat-value">{pendingRows ? dollars(sum(pendingRows)!) : "–"}</div>
        <div class="stat-label">Pending total</div>
      </div>
      <div class="stat">
        <div class="stat-value">{approved.data ? dollars(sum(approved.data.rows)!) : "–"}</div>
        <div class="stat-label">Approved in {month}</div>
      </div>
      {(pending.error || approved.error) && (
        <p class="error" role="alert">
          Some totals didn't load. {(pending.error ?? approved.error)!.message}
        </p>
      )}
    </section>
  );
}

function RequestTable({
  rows,
  viewer,
  now
}: {
  rows: readonly Request[];
  viewer: Viewer | null;
  now: number;
}) {
  const [deciding, setDeciding] = useState<string | null>(null);
  return (
    <div class="table-panel">
      <table>
        <thead>
          <tr>
            <th>What for</th>
            <th>Vendor</th>
            <th>Category</th>
            <th class="num">Amount</th>
            <th>Requested</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              viewer={viewer}
              now={now}
              open={deciding === r.id}
              onToggle={(open) => setDeciding(open ? r.id : null)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequestRow({
  request: r,
  viewer,
  now,
  open,
  onToggle
}: {
  request: Request;
  viewer: Viewer | null;
  now: number;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const status = (r.status in STATUS_LABEL ? r.status : "pending") as Status;
  const own = isOwn(r, viewer);
  const canDecide = status === "pending" && viewer !== null && !own;
  return (
    <>
      <tr class={open ? "is-open" : undefined}>
        <td class="what">
          <strong>{r.title}</strong>
          {r.reason && <span class="sub">{r.reason}</span>}
        </td>
        <td>{r.vendor}</td>
        <td>{r.category}</td>
        <td class="num amount">{dollars(r.amountCents)}</td>
        <td>
          <span class="who">{r.requestedByName}</span>
          <span class="sub" title={fullDate.format(new Date(r.requestedAt))}>
            {when(r.requestedAt, now)}
          </span>
        </td>
        <td class="status">
          <span class={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
          {status !== "pending" && r.decidedByName && <span class="sub">by {r.decidedByName}</span>}
          {r.note && <span class="note">“{r.note}”</span>}
          {canDecide && !open && (
            <button
              type="button"
              class="button-secondary button-small"
              onClick={() => onToggle(true)}
            >
              Review
            </button>
          )}
          {status === "pending" && own && viewer && (
            <span class="sub">Yours: a teammate decides</span>
          )}
        </td>
      </tr>
      {open && canDecide && viewer && (
        <tr class="decide-row">
          <td colSpan={6}>
            <DecisionForm request={r} viewer={viewer} onDone={() => onToggle(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

function DecisionForm({
  request,
  viewer,
  onDone
}: {
  request: Request;
  viewer: Viewer;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function decide(status: "approved" | "rejected") {
    if (saving) return;
    setSaving(true);
    setError("");
    void (async () => {
      // Tier 1 has no transaction: re-read so a decision someone else just made isn't overwritten.
      const current = await patchy.tables.requests.get(request.id);
      if (!current) throw new Error("This request was removed.");
      if (current.status !== "pending")
        throw new Error(`${current.decidedByName ?? "Someone"} already decided this one.`);
      await patchy.tables.requests.update(request.id, {
        status,
        decidedByName: viewer.name,
        decidedById: viewer.id,
        decidedAt: new Date().toISOString(),
        note: note.trim() || null
      });
    })()
      .then(onDone)
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setSaving(false));
  }

  return (
    <div class="decide">
      <p class="decide-title">
        <strong>{request.requestedByName}</strong> wants{" "}
        <strong>{dollars(request.amountCents)}</strong> for {request.title.toLowerCase()}.
      </p>
      <label>
        Note <span class="optional">(optional)</span>
        <input
          value={note}
          maxLength={500}
          placeholder="Anything they should know?"
          disabled={saving}
          onInput={(e) => setNote(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.isComposing) e.preventDefault();
          }}
        />
      </label>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="decide-actions">
        <button type="button" class="button-text" disabled={saving} onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          class="button-danger"
          disabled={saving}
          onClick={() => decide("rejected")}
        >
          Reject
        </button>
        <button type="button" disabled={saving} onClick={() => decide("approved")}>
          Approve
        </button>
      </div>
    </div>
  );
}

function RequestForm({
  viewer,
  onCancel,
  onSaved
}: {
  viewer: Viewer | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function save(form: HTMLFormElement) {
    if (saving || !form.reportValidity()) return;
    if (!viewer) {
      setError("We couldn't tell who you are. Reload the page and try again.");
      return;
    }
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const amountCents = Math.round(Number(text("amount")) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setError("Enter an amount above $0.");
      return;
    }
    setSaving(true);
    setError("");
    void patchy.tables.requests
      .insert({
        title: text("title"),
        vendor: text("vendor"),
        amountCents,
        category: text("category"),
        reason: text("reason"),
        requestedByName: viewer.name,
        requestedById: viewer.id,
        requestedAt: new Date().toISOString(),
        status: "pending"
      })
      .then(() => {
        form.reset();
        onSaved();
      })
      .catch((cause: unknown) => setError(`That didn't save. ${message(cause)}`))
      .finally(() => setSaving(false));
  }

  // The sandbox blocks native form submission; save through the broker instead.
  return (
    <section class="card compose">
      <h2>New request</h2>
      <form
        class="form"
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.isComposing) {
            e.preventDefault();
            save(e.currentTarget);
          }
        }}
      >
        <label>
          What's it for?
          <input
            name="title"
            required
            maxLength={120}
            placeholder="Team offsite lunch"
            disabled={saving}
          />
        </label>
        <div class="form-pair">
          <label>
            Vendor
            <input
              name="vendor"
              required
              maxLength={80}
              placeholder="Who gets paid"
              disabled={saving}
            />
          </label>
          <label>
            Amount (USD)
            <input
              name="amount"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              required
              placeholder="0.00"
              disabled={saving}
            />
          </label>
        </div>
        <label>
          Category
          <select name="category" required disabled={saving}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Why?
          <textarea
            name="reason"
            required
            maxLength={500}
            rows={3}
            placeholder="A sentence or two is plenty"
            disabled={saving}
          />
        </label>
        <p class="hint">
          Asking as {viewer?.name ?? "…"}. Someone else on the team will approve or reject it.
        </p>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={saving || !viewer}
          onClick={(e) => save(e.currentTarget.form!)}
        >
          {saving ? "Submitting…" : "Submit request"}
        </button>
        <button type="button" class="button-text" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </form>
    </section>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function load() {
    if (loading) return;
    setLoading(true);
    setError("");
    void (async () => {
      // Re-check so a double press or a colleague's load can't insert the set twice.
      const existing = await patchy.tables.requests.list({ limit: 1 });
      if (existing.rows.length > 0) return;
      await patchy.tables.requests.insertMany(sampleRows());
    })()
      .catch((cause: unknown) => setError(`That didn't load. ${message(cause)}`))
      .finally(() => setLoading(false));
  }

  return (
    <section class="empty-state">
      <div class="mark" aria-hidden="true" />
      <h2>No requests yet. Enjoy the quiet!</h2>
      <p>When someone needs to spend company money, it shows up here for a teammate to approve.</p>
      <button type="button" disabled={loading} onClick={load}>
        {loading ? "Loading…" : "Load sample data"}
      </button>
      <button type="button" class="button-text" onClick={onNew}>
        Or make the first request
      </button>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
