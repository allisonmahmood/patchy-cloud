import { useQuery, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import { Empty, ErrorBox, OwnerName, Pager, money, stageNames, useTask } from "./ui.js";
import type { Company, Deal, Stage, Team } from "./ui.js";

interface LaneData {
  readonly stage: Stage;
  readonly rows: readonly Deal[];
  readonly cursor: string | null;
}

function Lane({
  lane,
  companies,
  team,
  open,
  next,
  reset,
  paged
}: {
  lane: LaneData;
  companies: readonly Company[];
  team: Team;
  open: (id: Deal["id"]) => void;
  next: (cursor: string) => void;
  reset: () => void;
  paged: boolean;
}) {
  const task = useTask();
  const { stage, rows, cursor } = lane;
  const total = rows.reduce((sum, row) => sum + row.valueCents, 0);
  return (
    <section
      className={`lane stage-${stage.toLowerCase()}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer?.getData("text/plain") as Deal["id"] | undefined;
        if (id) void task.run(() => patchy.server.deals.move({ id, stage }));
      }}
    >
      <header className="lane-heading">
        <div>
          <span className="stage-dot" />
          <h2>{stage}</h2>
          <span className="count">{rows.length}</span>
        </div>
        <span className="lane-total">{money(total)}</span>
      </header>
      <ErrorBox error={task.error} />
      <div className="deal-stack">
        {rows.map((deal) => (
          <article
            className="deal-card"
            key={deal.id}
            draggable={deal.ownerId === team.viewerId && !task.busy}
            onDragStart={(e) => e.dataTransfer?.setData("text/plain", deal.id)}
          >
            <div className="card-top">
              <span className="eyebrow">
                {companies.find((c) => c.id === deal.companyId)?.name ?? "Company unavailable"}
              </span>
              {deal.private && (
                <span className="private" title="Only you can see this deal">
                  Private
                </span>
              )}
            </div>
            <button type="button" className="deal-title" onClick={() => open(deal.id)}>
              {deal.title}
            </button>
            <strong className="deal-value">{money(deal.valueCents)}</strong>
            <footer>
              <span className="owner">
                <span className="avatar small">
                  {(team.members.find((m) => m.userId === deal.ownerId)?.name ?? "T").slice(0, 1)}
                </span>
                <OwnerName id={deal.ownerId} team={team} />
              </span>
              {deal.ownerId === team.viewerId ? (
                <select
                  aria-label={`Stage for ${deal.title}`}
                  disabled={task.busy}
                  value={deal.stage}
                  onChange={(e) => {
                    const nextStage = e.currentTarget.value as Stage;
                    void task.run(() =>
                      patchy.server.deals.move({ id: deal.id, stage: nextStage })
                    );
                  }}
                >
                  {stageNames.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              ) : (
                <span className="muted">View only</span>
              )}
            </footer>
          </article>
        ))}
      </div>
      {!rows.length && <Empty>No visible deals on this page.</Empty>}
      {(paged || cursor) && <Pager cursor={cursor} next={next} reset={reset} />}
      {cursor && <small className="muted">Totals cover this page only.</small>}
    </section>
  );
}

export function Pipeline({
  team,
  create,
  open
}: {
  team: Team;
  create: () => void;
  open: (id: Deal["id"]) => void;
}) {
  const [closed, setClosed] = useState(false);
  const [cursors, setCursors] = useState<Partial<Record<Stage, string>>>({});
  const { data, error, status } = useQuery(patchy.server.deals.pipeline, {
    view: closed ? "closed" : "open",
    cursors
  });
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">SALES WORKSPACE</div>
          <h1>Pipeline</h1>
          <p>Move your next opportunity forward.</p>
        </div>
        <button type="button" onClick={create}>
          + New deal
        </button>
      </header>
      <div className="toolbar">
        <div className="segmented">
          <button
            type="button"
            className={!closed ? "active" : ""}
            onClick={() => setClosed(false)}
          >
            Open deals
          </button>
          <button type="button" className={closed ? "active" : ""} onClick={() => setClosed(true)}>
            Won & lost
          </button>
        </div>
        <span className="live-indicator">
          <span />
          {error
            ? "Updates unavailable"
            : status === "up-to-date"
              ? "Live updates"
              : "Reconnecting…"}
        </span>
      </div>
      <ErrorBox error={error} />
      {!error && data && (
        <div className={`pipeline ${closed ? "closed" : ""}`}>
          {data.lanes.map((lane) => (
            <Lane
              key={lane.stage}
              lane={lane}
              companies={data.companies}
              team={team}
              open={open}
              paged={Boolean(cursors[lane.stage])}
              next={(cursor) => setCursors((previous) => ({ ...previous, [lane.stage]: cursor }))}
              reset={() =>
                setCursors((previous) => {
                  const next = { ...previous };
                  delete next[lane.stage];
                  return next;
                })
              }
            />
          ))}
        </div>
      )}
      {!data && !error && <p className="muted">Loading pipeline…</p>}
      <p className="board-help">
        Drag your cards between stages, or use a card's stage menu. Teammates can view shared deals;
        only the owner can change them.
      </p>
    </>
  );
}
