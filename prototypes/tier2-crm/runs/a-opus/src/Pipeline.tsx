import { useState } from "patchy/preact";
import { useQuery } from "patchy/preact";
import {
  patchy,
  money,
  useTeam,
  useOwnerName,
  useRunner,
  OPEN_STAGES,
  STAGES,
  type Deal,
  type Stage,
  type Company
} from "./lib.js";
import { DealForm } from "./Deal.js";

/** The live board: open deals by stage. Owners drag cards (or use the stage menu); everyone sees moves live. */
export function Pipeline({
  companies,
  openDeal
}: {
  companies: readonly Company[];
  openDeal: (id: Deal["id"]) => void;
}) {
  const { data, error, status } = useQuery(patchy.server.deals.pipeline, {});
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<Deal["id"] | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const mover = useRunner();
  const move = (id: Deal["id"], stage: Stage) =>
    void mover.run(() => patchy.server.deals.move({ id, stage }));
  const companyName = (id: Company["id"]) =>
    companies.find((company) => company.id === id)?.name ?? "—";

  const column = (stage: Stage, deals: readonly Deal[], closed = false) => (
    <section
      key={stage}
      class={`column${closed ? " closed" : ""}${over === stage ? " over" : ""}`}
      data-stage={stage}
      onDragOver={(event) => {
        if (dragging) {
          event.preventDefault();
          setOver(stage);
        }
      }}
      onDragLeave={() => setOver((current) => (current === stage ? null : current))}
      onDrop={(event) => {
        event.preventDefault();
        setOver(null);
        if (dragging) move(dragging, stage);
        setDragging(null);
      }}
    >
      <header>
        <h3>{stage}</h3>
        {!closed && (
          <span class="muted">
            {deals.length} · {money(deals.reduce((sum, deal) => sum + deal.valueCents, 0))}
          </span>
        )}
      </header>
      {closed ? (
        <p class="muted small">Drop here to close as {stage}</p>
      ) : (
        deals.map((deal) => (
          <Card
            key={deal.id}
            deal={deal}
            company={companyName(deal.company)}
            open={() => openDeal(deal.id)}
            move={move}
            onDragStart={() => setDragging(deal.id)}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
          />
        ))
      )}
    </section>
  );

  return (
    <div>
      <div class="toolbar">
        <h2>Pipeline</h2>
        <span class={`status ${status}`} title="Live updates">
          {status === "up-to-date" ? "● live" : status}
        </span>
        <button type="button" class="primary" onClick={() => setAdding(!adding)}>
          {adding ? "Cancel" : "New deal"}
        </button>
      </div>
      {adding && <DealForm companies={companies} done={() => setAdding(false)} />}
      {error && (
        <p class="error" role="alert">
          {error.message}
        </p>
      )}
      {mover.error && (
        <p class="error" role="alert">
          {mover.error}
        </p>
      )}
      {data === undefined ? (
        <p class="muted">Loading…</p>
      ) : (
        <div class="board">
          {OPEN_STAGES.map((stage) =>
            column(
              stage,
              data.filter((deal) => deal.stage === stage)
            )
          )}
          <div class="closers">
            {column("Won", [], true)}
            {column("Lost", [], true)}
          </div>
        </div>
      )}
    </div>
  );
}

function Card({
  deal,
  company,
  open,
  move,
  onDragStart,
  onDragEnd
}: {
  deal: Deal;
  company: string;
  open: () => void;
  move: (id: Deal["id"], stage: Stage) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const { me } = useTeam();
  const owner = useOwnerName(deal.ownerId);
  const mine = deal.ownerId === me;
  return (
    <article
      class={`card${mine ? " mine" : ""}`}
      data-deal={deal.title}
      draggable={mine}
      onDragStart={(event) => {
        event.dataTransfer?.setData("text/plain", deal.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <button type="button" class="link title" onClick={open}>
        {deal.title}
      </button>
      {deal.private && (
        <span class="badge" title="Only you can see this deal">
          Private
        </span>
      )}
      <div class="muted small">{company}</div>
      <div class="row">
        <strong>{money(deal.valueCents)}</strong>
        <span class="muted small">{owner}</span>
      </div>
      {mine && (
        <select
          class="small"
          aria-label="Stage"
          value={deal.stage}
          onChange={(event) => move(deal.id, event.currentTarget.value as Stage)}
        >
          {STAGES.map((stage) => (
            <option key={stage}>{stage}</option>
          ))}
        </select>
      )}
    </article>
  );
}
