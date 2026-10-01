import { useState } from "patchy/preact";
import type { ComponentChildren, JSX } from "patchy/preact";
import { BOARD_STAGES, STAGE_LABELS, isClosed, type Stage } from "../../helpers/pipeline.js";
import { compactMoney, dayLabel, daysSince, firstName } from "../format.js";
import type { Deal, PendingMove, Person } from "../types.js";
import { Avatar } from "./Avatar.js";

interface BoardProps {
  readonly deals: readonly Deal[];
  readonly people: ReadonlyMap<string, Person>;
  readonly pending: ReadonlyMap<string, PendingMove>;
  readonly now: number;
  readonly showLost: boolean;
  readonly onToggleLost: () => void;
  readonly onOpen: (id: string) => void;
  readonly onMove: (deal: Deal, stage: Stage) => void;
}

/** Highest value first; deals without a value sink to the bottom. */
const byValue = (a: Deal, b: Deal) =>
  (b.value ?? -1) - (a.value ?? -1) || a.client.localeCompare(b.client);

/** The kanban board. Cards drag between columns; a move in flight shows where it is going. */
export function Board({
  deals,
  people,
  pending,
  now,
  showLost,
  onToggleLost,
  onOpen,
  onMove
}: BoardProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Stage | null>(null);

  const stageOf = (deal: Deal) => pending.get(deal.id)?.to ?? deal.stage;
  const inStage = (stage: Stage) => deals.filter((deal) => stageOf(deal) === stage).sort(byValue);

  const drop = (stage: Stage) => (event: JSX.TargetedDragEvent<HTMLElement>) => {
    event.preventDefault();
    const id = event.dataTransfer?.getData("text/plain");
    const deal = deals.find((candidate) => candidate.id === id);
    setOver(null);
    setDragging(null);
    if (deal !== undefined && stageOf(deal) !== stage) onMove(deal, stage);
  };
  const dropTarget = (stage: Stage) => ({
    onDragOver: (event: JSX.TargetedDragEvent<HTMLElement>) => {
      if (dragging === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      if (over !== stage) setOver(stage);
    },
    onDragLeave: (event: JSX.TargetedDragEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !event.currentTarget.contains(next))
        setOver((current) => (current === stage ? null : current));
    },
    onDrop: drop(stage)
  });

  const card = (deal: Deal) => (
    <DealCard
      key={deal.id}
      deal={deal}
      owner={deal.owner === null ? null : (people.get(deal.owner) ?? null)}
      move={pending.get(deal.id)}
      now={now}
      dragging={dragging === deal.id}
      onOpen={() => onOpen(deal.id)}
      onDragStart={(event) => {
        event.dataTransfer?.setData("text/plain", deal.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        setDragging(deal.id);
      }}
      onDragEnd={() => {
        setDragging(null);
        setOver(null);
      }}
    />
  );

  const lost = inStage("lost");
  return (
    <div
      class={`board ${showLost ? "board-lost-open" : ""} ${dragging === null ? "" : "board-dragging"}`}
    >
      {BOARD_STAGES.map((stage) => {
        const cards = inStage(stage);
        return (
          <section
            key={stage}
            class={`column stage-${stage} ${over === stage ? "column-over" : ""}`}
            {...dropTarget(stage)}
          >
            <ColumnHead stage={stage} deals={cards} />
            <div class="column-cards">
              {cards.map(card)}
              {cards.length === 0 && (
                <div class="column-empty">{dragging === null ? "No deals" : "Drop here"}</div>
              )}
            </div>
          </section>
        );
      })}
      {showLost ? (
        <section
          class={`column stage-lost ${over === "lost" ? "column-over" : ""}`}
          {...dropTarget("lost")}
        >
          <ColumnHead stage="lost" deals={lost}>
            <button
              type="button"
              class="column-toggle"
              onClick={onToggleLost}
              aria-label="Hide lost deals"
            >
              Hide
            </button>
          </ColumnHead>
          <div class="column-cards">
            {lost.map(card)}
            {lost.length === 0 && (
              <div class="column-empty">{dragging === null ? "No lost deals" : "Drop here"}</div>
            )}
          </div>
        </section>
      ) : (
        <button
          type="button"
          class={`lost-strip ${over === "lost" ? "column-over" : ""}`}
          onClick={onToggleLost}
          aria-label={`Show ${lost.length} lost deals`}
          {...dropTarget("lost")}
        >
          <span class="dot stage-dot-lost" aria-hidden="true" />
          <span class="lost-strip-label">Lost</span>
          <span class="lost-strip-count">{lost.length}</span>
        </button>
      )}
    </div>
  );
}

function ColumnHead({
  stage,
  deals,
  children
}: {
  stage: Stage;
  deals: readonly Deal[];
  children?: ComponentChildren;
}) {
  const total = deals.reduce((sum, deal) => sum + (deal.value ?? 0), 0);
  return (
    <header class="column-head">
      <span class={`dot stage-dot-${stage}`} aria-hidden="true" />
      <h2 class="column-name">{STAGE_LABELS[stage]}</h2>
      <span class="column-count">{deals.length}</span>
      <span class="column-total">{compactMoney(total)}</span>
      {children}
    </header>
  );
}

interface CardProps {
  readonly deal: Deal;
  readonly owner: Person | null;
  readonly move: PendingMove | undefined;
  readonly now: number;
  readonly dragging: boolean;
  readonly onOpen: () => void;
  readonly onDragStart: (event: JSX.TargetedDragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}

function DealCard({ deal, owner, move, now, dragging, onOpen, onDragStart, onDragEnd }: CardProps) {
  const stage = move?.to ?? deal.stage;
  const age =
    move !== undefined
      ? "Saving…"
      : isClosed(stage)
        ? dayLabel(deal.stageEnteredAt, now)
        : daysLabel(deal, now);
  return (
    <article
      class={`card ${move === undefined ? "" : "card-pending"} ${dragging ? "card-dragging" : ""}`}
      tabIndex={0}
      draggable={move === undefined}
      aria-label={`${deal.client}, ${deal.title}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div class="card-client">{deal.client}</div>
      <div class="card-project">{deal.title}</div>
      {stage === "lost" && deal.lostReason !== null && (
        <div class="card-reason">{deal.lostReason}</div>
      )}
      <div class="card-meta">
        <span class="tag">{deal.service}</span>
        {deal.value === null ? (
          <span class="card-value card-value-none">No value</span>
        ) : (
          <span class="card-value">{compactMoney(deal.value)}</span>
        )}
      </div>
      <div class="card-foot">
        <Avatar person={owner} />
        {owner === null ? (
          <span class="card-owner card-owner-none">Unassigned</span>
        ) : (
          <span class="card-owner">{firstName(owner.name)}</span>
        )}
        <span class="card-age">{age}</span>
      </div>
    </article>
  );
}

function daysLabel(deal: Deal, now: number) {
  const days = daysSince(deal.stageEnteredAt, now);
  return days === 0 ? "Today" : `${days}d`;
}
