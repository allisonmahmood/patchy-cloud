import { useEffect, useRef, useState } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";
import type { Entries, Member, Records } from "../patchy/_generated/uses/crm.js";

type Deal = Records["deals"];
type Entry = Entries["probe_pipeline"];

const crm = patchy.connections.crm;
/** Attio's standard deal stages, in pipeline order. */
const STAGES = ["Lead", "In Progress", "Won 🎉", "Lost"] as const;
const PAGE = 25;

const money = (value: Deal["values"]["value"]) =>
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
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [stage, setStage] = useState<(typeof STAGES)[number]>("Lead");
  const [owner, setOwner] = useState("");
  const [deals, setDeals] = useState<readonly Deal[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [companies, setCompanies] = useState<ReadonlyMap<string, string>>(new Map());
  const [open, setOpen] = useState<Deal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    crm.members.list().then(
      (all) => setMembers(all.filter((member) => member.active)),
      (caught: unknown) => setError(explain(caught))
    );
  }, []);

  /** Which filters the newest request is for: an older request's answer is dropped. */
  const current = useRef(0);

  /** A page of deals, then the companies the page brings, in one getMany. */
  const load = async (from: string | null) => {
    const request = ++current.current;
    setLoading(true);
    setError(null);
    try {
      const page = await crm.objects.deals.list({
        eq: { stage, ...(owner === "" ? {} : { owner }) },
        orderBy: { attribute: "value", direction: "desc" },
        limit: PAGE,
        ...(from === null ? {} : { cursor: from })
      });
      const known = from === null ? new Map<string, string>() : companies;
      const ids = [
        ...new Set(page.rows.flatMap((deal) => deal.values.associated_company?.id ?? []))
      ].filter((id) => !known.has(id));
      const found = await crm.objects.companies.getMany(ids);
      if (request !== current.current) return;
      setDeals(from === null ? page.rows : [...deals, ...page.rows]);
      setCursor(page.cursor);
      setCompanies(
        new Map([
          ...known,
          ...found.flatMap((company) =>
            company === null ? [] : [[company.id, company.values.name ?? "Unnamed"] as const]
          )
        ])
      );
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
          {members.map((member) => (
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
                <td>{deal.values.name ?? "Untitled"}</td>
                <td class="muted">
                  {companies.get(deal.values.associated_company?.id ?? "") ?? "—"}
                </td>
                <td class="num">{money(deal.values.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {open !== null && <DealPanel deal={open} company={companies} />}
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
function DealPanel(props: { deal: Deal; company: ReadonlyMap<string, string> }) {
  const [deal, setDeal] = useState<Deal | null>(props.deal);
  const [entries, setEntries] = useState<readonly Entry[] | null>(null);
  useEffect(() => {
    setEntries(null);
    void crm.objects.deals.get(props.deal.id).then(setDeal);
    void crm.lists.probe_pipeline
      .list({ parent: props.deal.id, orderBy: { attribute: "entered_on", direction: "desc" } })
      .then((page) => setEntries(page.rows));
  }, [props.deal.id]);
  if (deal === null) return <aside class="panel muted">This deal is gone from Attio.</aside>;
  return (
    <aside class="panel">
      <h2>{deal.values.name}</h2>
      <dl>
        <dt>Stage</dt>
        <dd>{deal.values.stage ?? "—"}</dd>
        <dt>Value</dt>
        <dd>{money(deal.values.value)}</dd>
        <dt>Company</dt>
        <dd>{props.company.get(deal.values.associated_company?.id ?? "") ?? "—"}</dd>
      </dl>
      <h3>In the pipeline</h3>
      {entries === null ? (
        <p class="muted">Reading…</p>
      ) : entries.length === 0 ? (
        <p class="muted">Not on the pipeline.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              {entry.values.stage ?? "No stage"}
              <span class="muted"> since {entry.values.entered_on ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}
      <a href={deal.url} target="_blank" rel="noreferrer">
        Open in Attio
      </a>
    </aside>
  );
}
