import { useState, useQuery } from "patchy/preact";
import type { ComponentChildren } from "patchy/preact";
import { patchy } from "../../patchy/_generated/client.js";
import { STAGE_LABELS, isStage, type LostReason, type Stage } from "../../helpers/pipeline.js";
import { describeError } from "../errors.js";
import { useEscape } from "../hooks.js";
import {
  calendarDate,
  daysSince,
  fullMoney,
  longDate,
  relativeTime,
  shortDate
} from "../format.js";
import type { Activity, Deal, Notify, PendingMove, Person, Viewer } from "../types.js";
import { Avatar } from "./Avatar.js";
import {
  DealFormFields,
  formFromDeal,
  readForm,
  sameForm,
  type DealFormState,
  type FormErrors
} from "./DealForm.js";
import { OwnerPicker } from "./OwnerPicker.js";
import { StageMover } from "./StageMover.js";

interface DealDrawerProps {
  readonly deal: Deal;
  readonly people: ReadonlyMap<string, Person>;
  readonly viewer: Viewer | null;
  readonly pending: PendingMove | undefined;
  readonly now: number;
  readonly notify: Notify;
  readonly onMove: (deal: Deal, stage: Stage, reason?: LostReason) => Promise<string | null>;
  readonly onClose: () => void;
}

/** Right-side panel for one deal: stage, owner, details, notes and its timeline. */
export function DealDrawer({
  deal,
  people,
  viewer,
  pending,
  now,
  notify,
  onMove,
  onClose
}: DealDrawerProps) {
  useEscape(onClose);

  const stage = pending?.to ?? deal.stage;
  const days = daysSince(deal.stageEnteredAt, now);
  return (
    <div class="drawer-layer">
      <div class="backdrop" onClick={onClose} />
      <aside class="drawer" role="dialog" aria-modal="true" aria-label={deal.client}>
        <header class="drawer-head">
          <div class="drawer-titles">
            <div class="drawer-stage">
              <span class={`dot stage-dot-${stage}`} aria-hidden="true" />
              {isStage(stage) ? STAGE_LABELS[stage] : stage}
              <span class="drawer-stage-days">
                {"· "}
                {stage === "won" || stage === "lost"
                  ? `closed ${shortDate(deal.stageEnteredAt)}`
                  : days === 0
                    ? "entered today"
                    : `${days} day${days === 1 ? "" : "s"} in stage`}
              </span>
            </div>
            <h2>{deal.client}</h2>
            <p class="drawer-project">{deal.title}</p>
          </div>
          <button type="button" class="icon-button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div class="drawer-facts">
          <Fact label="Value">
            {deal.value === null ? <span class="muted">Not estimated</span> : fullMoney(deal.value)}
          </Fact>
          <Fact label="Expected close">
            {deal.expectedClose === null ? (
              <span class="muted">Not set</span>
            ) : (
              calendarDate(deal.expectedClose)
            )}
          </Fact>
          <Fact label="Opened">{shortDate(deal.openedAt)}</Fact>
        </div>

        <div class="drawer-body">
          <Section title="Stage">
            <StageMover
              deal={deal}
              pendingTo={pending?.to}
              now={now}
              onMove={(target, reason) => onMove(deal, target, reason)}
            />
          </Section>
          <Section title="Owner">
            <OwnerSection deal={deal} people={people} viewer={viewer} notify={notify} />
          </Section>
          <Section title="Details">
            <DetailsForm deal={deal} notify={notify} />
          </Section>
          <Section title="Activity">
            <NoteComposer dealId={deal.id} notify={notify} />
            <Timeline dealId={deal.id} viewerId={viewer?.user.id ?? null} now={now} />
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="fact">
      <span class="fact-label">{label}</span>
      <span class="fact-value">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="drawer-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function OwnerSection({
  deal,
  people,
  viewer,
  notify
}: {
  deal: Deal;
  people: ReadonlyMap<string, Person>;
  viewer: Viewer | null;
  notify: Notify;
}) {
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const owner = deal.owner === null ? null : (people.get(deal.owner) ?? null);

  async function assign(person: Person | null) {
    setSaving(true);
    setRefusal(null);
    try {
      await patchy.server.deals.assign({ deal: deal.id, owner: person?.id ?? null });
      if (person !== null) notify(`${person.name} now owns ${deal.client}.`, { tone: "success" });
    } catch (error) {
      setRefusal(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="owner-section">
      <div class="owner-row">
        <OwnerPicker selected={owner} saving={saving} onPick={(person) => void assign(person)} />
        {viewer !== null && deal.owner !== viewer.user.id && (
          <button
            type="button"
            class="btn btn-ghost btn-small"
            disabled={saving}
            onClick={() =>
              void assign({
                id: viewer.user.id,
                name: viewer.user.name,
                email: viewer.user.email,
                admin: viewer.admin,
                active: true
              })
            }
          >
            Assign to me
          </button>
        )}
      </div>
      {owner !== null && !owner.active && (
        <p class="hint">{owner.name} has left the studio. Hand this deal to someone else.</p>
      )}
      {refusal !== null && (
        <p class="refusal" role="alert">
          {refusal}
        </p>
      )}
    </div>
  );
}

function DetailsForm({ deal, notify }: { deal: Deal; notify: Notify }) {
  const [draft, setDraft] = useState<DealFormState | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = formFromDeal(deal);
  const shown = draft ?? saved;
  const dirty = draft !== null && !sameForm(draft, saved);

  async function save() {
    if (!dirty || saving) return;
    const result = readForm(shown);
    setErrors(result.ok ? {} : result.errors);
    setRefusal(null);
    if (!result.ok) return;
    setSaving(true);
    try {
      await patchy.server.deals.update({ deal: deal.id, ...result.fields });
      setDraft(null);
      notify(`Saved changes to ${result.fields.client}.`, { tone: "success" });
    } catch (error) {
      setRefusal(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="details-form">
      <DealFormFields
        state={shown}
        errors={errors}
        disabled={saving}
        onChange={(next) => {
          setDraft(next);
          setErrors({});
        }}
        onSubmit={() => void save()}
      />
      {refusal !== null && (
        <p class="refusal" role="alert">
          {refusal}
        </p>
      )}
      {dirty && (
        <div class="form-actions">
          <button
            type="button"
            class="btn btn-ghost btn-small"
            disabled={saving}
            onClick={() => {
              setDraft(null);
              setErrors({});
              setRefusal(null);
            }}
          >
            Discard
          </button>
          <button
            type="button"
            class="btn btn-primary btn-small"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </div>
  );
}

function NoteComposer({ dealId, notify }: { dealId: string; notify: Notify }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function add() {
    if (note.trim() === "" || saving) return;
    setSaving(true);
    try {
      await patchy.server.deals.addNote({ deal: dealId, note });
      setNote("");
    } catch (error) {
      notify(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="note-composer">
      <textarea
        class="input"
        rows={2}
        placeholder="Add a note for the team…"
        value={note}
        disabled={saving}
        onInput={(event) => setNote(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void add();
          }
        }}
      />
      <div class="note-actions">
        <span class="note-tip">Ctrl + Enter to post</span>
        <button
          type="button"
          class="btn btn-ghost btn-small"
          disabled={saving || note.trim() === ""}
          onClick={() => void add()}
        >
          {saving ? "Posting…" : "Add note"}
        </button>
      </div>
    </div>
  );
}

function Timeline({
  dealId,
  viewerId,
  now
}: {
  dealId: string;
  viewerId: string | null;
  now: number;
}) {
  const timeline = useQuery(patchy.server.deals.timeline, { deal: dealId });
  if (timeline.data === undefined)
    return (
      <p class="muted timeline-status">
        {timeline.error
          ? "Couldn't load the activity. Reopen the deal to try again."
          : "Loading activity…"}
      </p>
    );

  const people = new Map(timeline.data.people.map((person) => [person.id, person]));
  const name = (id: string | null) => {
    if (id === null) return "Someone";
    if (id === viewerId) return "You";
    return people.get(id)?.name ?? "A former member";
  };
  return (
    <ol class="timeline">
      {timeline.data.events.map((event) => (
        <li key={event.id} class={`event event-${event.kind}`}>
          <Avatar person={people.get(event.actor) ?? null} />
          <div class="event-body">
            <p class="event-text">
              <strong>{name(event.actor)}</strong> {describeEvent(event, name)}
            </p>
            {event.kind === "note" && event.note !== null && (
              <p class="event-quote">{event.note}</p>
            )}
            <time class="event-time" dateTime={event.at} title={longDate(event.at)}>
              {relativeTime(event.at, now)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

function StageName({ stage }: { stage: string | null }) {
  if (stage === null || !isStage(stage)) return <>a new stage</>;
  return (
    <span class="stage-chip">
      <span class={`dot stage-dot-${stage}`} aria-hidden="true" />
      {STAGE_LABELS[stage]}
    </span>
  );
}

function describeEvent(event: Activity, name: (id: string | null) => string): ComponentChildren {
  switch (event.kind) {
    case "created":
      return event.assignee === null || event.assignee === event.actor ? (
        "added this deal"
      ) : (
        <>
          added this deal for <strong>{name(event.assignee)}</strong>
        </>
      );
    case "imported":
      return "imported this lead from a CSV";
    case "moved":
      if (event.toStage === "won" || event.toStage === "lost")
        return (
          <>
            marked it <StageName stage={event.toStage} />
            {event.toStage === "lost" && event.note !== null && (
              <>
                {" "}
                · <strong>{event.note}</strong>
              </>
            )}
          </>
        );
      if (event.fromStage === "won" || event.fromStage === "lost")
        return (
          <>
            reopened it in <StageName stage={event.toStage} />
          </>
        );
      return (
        <>
          moved it from <StageName stage={event.fromStage} /> to <StageName stage={event.toStage} />
        </>
      );
    case "assigned":
      if (event.assignee === null) return "removed the owner";
      if (event.assignee === event.actor) return "took ownership";
      return (
        <>
          assigned it to <strong>{name(event.assignee)}</strong>
        </>
      );
    case "edited":
      return `updated ${event.note ?? "the details"}`;
    case "note":
      return "added a note";
    default:
      return "changed this deal";
  }
}
