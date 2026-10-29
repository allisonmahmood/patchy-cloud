import { useEffect, useRef, useState } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";

// Attio is read by server/desk.ts, as the person viewing.
const desk = patchy.server.desk;
type Owner = Awaited<ReturnType<typeof desk.owners>>[number];
type Deal = Awaited<ReturnType<typeof desk.deals>>["deals"][number];
type Opened = NonNullable<Awaited<ReturnType<typeof desk.deal>>>;

/** Attio's standard deal stages, in pipeline order. */
const STAGES = ["Lead", "In Progress", "Won 🎉", "Lost"] as const;

const money = (value: Deal["value"]) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: value.currency ?? "USD",
        maximumFractionDigits: 0
      }).format(value.amount);

const explain = (error: unknown) =>
  isPatchyError(error, "shape_mismatch", "attio")
    ? `The CRM changed: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);

export function App() {
  const [owners, setOwners] = useState<readonly Owner[]>([]);
  const [stage, setStage] = useState<(typeof STAGES)[number]>("Lead");
  const [owner, setOwner] = useState("");
  const [deals, setDeals] = useState<readonly Deal[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<Deal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    desk.owners({}).then(setOwners, (caught: unknown) => setError(explain(caught)));
  }, []);

  /** Which filters the newest request is for: an older request's answer is dropped. */
  const current = useRef(0);

  /** A page of deals, each with its company, read on the server. */
  const load = async (from: string | null) => {
    const request = ++current.current;
    setLoading(true);
    setError(null);
    try {
      const page = await desk.deals({ stage, owner, cursor: from });
      if (request !== current.current) return;
      setDeals(from === null ? page.deals : [...deals, ...page.deals]);
      setCursor(page.cursor);
    } catch (caught) {
      if (request === current.current) setError(explain(caught));
    } finally {
      if (request === current.current) setLoading(false);
    }
  };

  useEffect(() => {
    setOpen(null);
    void load(null);
  }, [stage, owner]);

  return (
    <main class="desk">
      <header class="bar">
        <h1>Deal desk</h1>
        <select
          value={stage}
          onChange={(event) => setStage(event.currentTarget.value as (typeof STAGES)[number])}
        >
          {STAGES.map((title) => (
            <option value={title}>{title}</option>
          ))}
        </select>
        <select value={owner} onChange={(event) => setOwner(event.currentTarget.value)}>
          <option value="">Every owner</option>
          {owners.map((member) => (
            <option value={member.id}>{member.name}</option>
          ))}
        </select>
      </header>
      {error !== null && <p class="error">{error}</p>}
      <div class="split">
        <table class="deals">
          <thead>
            <tr>
              <th>Deal</th>
              <th>Company</th>
              <th class="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {deals.map((deal) => (
              <tr
                key={deal.id}
                class={open?.id === deal.id ? "selected" : undefined}
                onClick={() => setOpen(deal)}
              >
                <td>{deal.name ?? "Untitled"}</td>
                <td class="muted">{deal.company ?? "—"}</td>
                <td class="num">{money(deal.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {open !== null && <DealPanel deal={open} />}
      </div>
      <footer class="more">
        {loading ? (
          <span class="muted">Reading Attio…</span>
        ) : cursor !== null ? (
          <button onClick={() => void load(cursor)}>More deals</button>
        ) : (
          <span class="muted">{deals.length} deals</span>
        )}
      </footer>
    </main>
  );
}

/** One deal, opened afresh, and its entries in the sales pipeline. */
function DealPanel(props: { deal: Deal }) {
  const [opened, setOpened] = useState<Opened | null | undefined>(undefined);
  useEffect(() => {
    setOpened(undefined);
    void desk.deal({ id: props.deal.id }).then(setOpened);
  }, [props.deal.id]);
  if (opened === null) return <aside class="panel muted">This deal is gone from Attio.</aside>;
  return (
    <aside class="panel">
      <h2>{opened?.name ?? props.deal.name}</h2>
      <dl>
        <dt>Stage</dt>
        <dd>{opened?.stage ?? "—"}</dd>
        <dt>Value</dt>
        <dd>{money(opened?.value ?? props.deal.value)}</dd>
        <dt>Company</dt>
        <dd>{props.deal.company ?? "—"}</dd>
      </dl>
      <h3>In the pipeline</h3>
      {opened === undefined ? (
        <p class="muted">Reading…</p>
      ) : opened.entries.length === 0 ? (
        <p class="muted">Not on the pipeline.</p>
      ) : (
        <ul>
          {opened.entries.map((entry) => (
            <li key={entry.id}>
              {entry.stage ?? "No stage"}
              <span class="muted"> since {entry.since ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}
      {opened === undefined ? null : (
        <a href={opened.url} target="_blank" rel="noreferrer">
          Open in Attio
        </a>
      )}
    </aside>
  );
}
