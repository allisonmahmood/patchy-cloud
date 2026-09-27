import { useState } from "patchy/preact";
import { useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import { OPEN_STAGES, STAGES, formatDollars, type Stage } from "../shared/rules.js";
import { Attachments } from "./Attachments.js";
import {
  Alert,
  DeleteButton,
  Form,
  Modal,
  Owner,
  describe,
  useApp,
  useTask,
  type CompanyId,
  type DealId
} from "./ui.js";

type Entry = Awaited<ReturnType<typeof patchy.server.deals.pipeline>>[number];
type Deal = Entry["deal"];

/**
 * The live board: open deals by stage, with Won and Lost as drop targets. Every open copy of the
 * board subscribes to the same query, so a move by anyone re-renders here without a reload.
 */
export function Pipeline() {
  const { me, go } = useApp();
  const { data, error, status } = useQuery(patchy.server.deals.pipeline, {});
  const [creating, setCreating] = useState(false);
  const [over, setOver] = useState<Stage | null>(null);
  const move = useTask();

  const drop = (stage: Stage, id: string) => {
    const entry = data?.find((e) => e.deal.id === id);
    if (entry && entry.deal.stage !== stage)
      void move.run(() => patchy.server.deals.move({ id: entry.deal.id, stage }));
    setOver(null);
  };
  const zone = (stage: Stage) => ({
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      setOver(stage);
    },
    onDragLeave: () => setOver(null),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      drop(stage, event.dataTransfer?.getData("text/plain") ?? "");
    }
  });
  const inStage = (stage: Stage) => (data ?? []).filter((e) => e.deal.stage === stage);
  const total = (entries: readonly Entry[]) =>
    formatDollars(entries.reduce((sum, e) => sum + e.deal.valueCents, 0));

  return (
    <section>
      <div class="toolbar">
        <h1>Pipeline</h1>
        <span class="muted" id="live-status">
          {status === "up-to-date" ? "Live" : status}
        </span>
        <button type="button" class="primary" onClick={() => setCreating(true)}>
          New deal
        </button>
      </div>
      {error && <Alert>{describe(error)}</Alert>}
      <Alert>{move.error}</Alert>
      <div class="board">
        {OPEN_STAGES.map((stage) => (
          <div
            key={stage}
            class={`column${over === stage ? " over" : ""}`}
            data-stage={stage}
            {...zone(stage)}
          >
            <h2>
              {stage}{" "}
              <span class="muted">
                {inStage(stage).length} · {total(inStage(stage))}
              </span>
            </h2>
            {inStage(stage).map(({ deal, companyName }) => (
              <article
                key={deal.id}
                class="card"
                data-deal={deal.title}
                draggable={deal.ownerId === me.user.id}
                onDragStart={(event) => event.dataTransfer?.setData("text/plain", deal.id)}
              >
                <button
                  type="button"
                  class="link title"
                  onClick={() => go({ name: "deal", id: deal.id })}
                >
                  {deal.private && (
                    <span class="badge" title="Private: only you can see it">
                      Private
                    </span>
                  )}{" "}
                  {deal.title}
                </button>
                <div class="muted">{companyName}</div>
                <div class="row">
                  <strong>{formatDollars(deal.valueCents)}</strong>
                  <span class="muted">{deal.ownerId === me.user.id ? "You" : deal.ownerName}</span>
                </div>
                {deal.ownerId === me.user.id && (
                  <select
                    aria-label={`Stage of ${deal.title}`}
                    value={deal.stage}
                    disabled={move.busy}
                    onChange={(event) => drop(event.currentTarget.value as Stage, deal.id)}
                  >
                    {STAGES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
              </article>
            ))}
          </div>
        ))}
      </div>
      <div class="closed">
        {(["Won", "Lost"] as const).map((stage) => (
          <div
            key={stage}
            class={`drop${over === stage ? " over" : ""}`}
            data-stage={stage}
            {...zone(stage)}
          >
            <strong>{stage}</strong> {inStage(stage).length} deals · {total(inStage(stage))}
            <span class="muted"> — drop a deal here to close it</span>
          </div>
        ))}
      </div>
      {data === undefined && !error && <p class="muted">Loading…</p>}
      {creating && <DealForm onClose={() => setCreating(false)} />}
    </section>
  );
}

/** Creates a deal, or edits one when `deal` is given. */
export function DealForm({
  deal,
  companyId,
  onClose
}: {
  deal?: Deal;
  companyId?: CompanyId;
  onClose: () => void;
}) {
  const companies = useQuery(patchy.server.companies.list, {});
  const [title, setTitle] = useState(deal?.title ?? "");
  const [company, setCompany] = useState<string>(deal?.companyId ?? companyId ?? "");
  const [dollars, setDollars] = useState(deal ? String(deal.valueCents / 100) : "");
  const [stage, setStage] = useState<Stage>((deal?.stage as Stage | undefined) ?? "Lead");
  const [isPrivate, setPrivate] = useState(deal?.private ?? false);
  const task = useTask();

  const save = () =>
    void task.run(async () => {
      const chosen = companies.data?.find((c) => c.id === company);
      if (!chosen) throw new Error("Choose a company.");
      const valueCents = Math.round(Number(dollars) * 100);
      if (!Number.isFinite(valueCents) || valueCents < 0)
        throw new Error("The value must be a positive dollar amount.");
      const fields = { title, companyId: chosen.id, valueCents, stage, private: isPrivate };
      if (deal) await patchy.server.deals.update({ id: deal.id, ...fields });
      else await patchy.server.deals.create(fields);
      onClose();
    });

  return (
    <Modal title={deal ? "Edit deal" : "New deal"} onClose={onClose}>
      <Form onSubmit={save}>
        <label>
          Title
          <input
            name="title"
            required
            value={title}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </label>
        <label>
          Company
          <select
            name="company"
            required
            value={company}
            onChange={(e) => setCompany(e.currentTarget.value)}
          >
            <option value="">Choose…</option>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Value (USD)
          <input
            name="value"
            required
            type="number"
            min="0"
            step="0.01"
            value={dollars}
            onInput={(e) => setDollars(e.currentTarget.value)}
          />
        </label>
        <label>
          Stage
          <select
            name="stage"
            value={stage}
            onChange={(e) => setStage(e.currentTarget.value as Stage)}
          >
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label class="check">
          <input
            name="private"
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setPrivate(e.currentTarget.checked)}
          />
          Private — only the owner can see this deal
        </label>
        <Alert>{task.error}</Alert>
        <div class="actions">
          <button type="button" class="primary" disabled={task.busy} onClick={save}>
            {deal ? "Save" : "Create deal"}
          </button>
        </div>
      </Form>
    </Modal>
  );
}

/** One deal with its attachments. Someone else's private deal reads as not found. */
export function DealPage({ id }: { id: DealId }) {
  const { me, go } = useApp();
  const { data, error } = useQuery(patchy.server.deals.get, { id });
  const [editing, setEditing] = useState(false);
  const task = useTask();
  if (error) return <Alert>{describe(error)}</Alert>;
  if (data === undefined) return <p class="muted">Loading…</p>;
  const { deal, company } = data;
  const mine = deal.ownerId === me.user.id;
  const remove = () =>
    void task.run(async () => {
      const result = await patchy.server.deals.remove({ id: deal.id });
      if (!result.dealRemoved)
        throw new Error(
          `Deleting stopped partway: ${result.filesRemoved} attachment file(s) were removed but the deal is still here. Try again.`
        );
      go({ name: "pipeline" });
    });
  return (
    <section>
      <div class="toolbar">
        <h1>
          {deal.private && <span class="badge">Private</span>} {deal.title}
        </h1>
        {mine && (
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {mine && <DeleteButton busy={task.busy} onConfirm={remove} />}
      </div>
      <dl class="facts">
        <dt>Company</dt>
        <dd>
          {company ? (
            <button
              type="button"
              class="link"
              onClick={() => go({ name: "company", id: company.id })}
            >
              {company.name}
            </button>
          ) : (
            "(deleted)"
          )}
        </dd>
        <dt>Value</dt>
        <dd>{formatDollars(deal.valueCents)}</dd>
        <dt>Stage</dt>
        <dd>{deal.stage}</dd>
        <dt>Visibility</dt>
        <dd>{deal.private ? "Private: only the owner" : "Everyone on the team"}</dd>
      </dl>
      <Owner
        ownerId={deal.ownerId}
        ownerName={deal.ownerName}
        onHandoff={(userId) => patchy.server.deals.handoff({ id: deal.id, userId })}
      />
      <Alert>{task.error}</Alert>
      <Attachments dealId={deal.id} canEdit={mine} />
      {editing && <DealForm deal={deal} onClose={() => setEditing(false)} />}
    </section>
  );
}
