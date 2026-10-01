import { useState } from "patchy/preact";
import {
  BOARD_STAGES,
  STAGE_LABELS,
  missingFor,
  type LostReason,
  type Stage
} from "../../helpers/pipeline.js";
import { dayLabel } from "../format.js";
import type { Deal } from "../types.js";
import { LostReasonPicker } from "./LostReason.js";

interface StageMoverProps {
  readonly deal: Deal;
  /** Stage of a move still in flight, if any. */
  readonly pendingTo: Stage | undefined;
  readonly now: number;
  /** Sends the move (deals.move); resolves to a refusal message or null. Lost needs a reason. */
  readonly onMove: (stage: Stage, reason?: LostReason) => Promise<string | null>;
}

/**
 * The drawer's stage controls: a stepper for the board's stages plus "Mark as lost", which
 * asks for a reason inline before sending the move.
 * Every stage change made here goes through `onMove`, the same path as drag and drop.
 */
export function StageMover({ deal, pendingTo, now, onMove }: StageMoverProps) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [choosingReason, setChoosingReason] = useState(false);
  const current = pendingTo ?? deal.stage;
  const reached = BOARD_STAGES.indexOf(current as (typeof BOARD_STAGES)[number]);
  const busy = pendingTo !== undefined;

  async function move(stage: Stage, reason?: LostReason) {
    if (busy || stage === current) return;
    setChoosingReason(false);
    setRefusal(null);
    setRefusal(await onMove(stage, reason));
  }

  const needs = missingFor("proposal", deal);
  return (
    <div class="stage-mover">
      <ol class={`stepper ${current === "lost" ? "stepper-lost" : ""}`}>
        {BOARD_STAGES.map((stage, index) => (
          <li key={stage}>
            <button
              type="button"
              class={`step ${index < reached ? "step-done" : ""} ${index === reached ? "step-current" : ""}`}
              aria-current={index === reached ? "step" : undefined}
              disabled={busy}
              onClick={() => void move(stage)}
            >
              {STAGE_LABELS[stage]}
            </button>
          </li>
        ))}
      </ol>
      <div class="stage-actions">
        {current === "lost" ? (
          <span class="lost-badge">
            <span class="dot stage-dot-lost" aria-hidden="true" />
            <span>
              Lost
              {deal.lostReason !== null && (
                <>
                  {" "}
                  · <strong class="lost-badge-reason">{deal.lostReason}</strong>
                </>
              )}{" "}
              · {dayLabel(deal.stageEnteredAt, now)}. Pick a stage above to reopen it.
            </span>
          </span>
        ) : choosingReason ? (
          <LostReasonPicker
            busy={busy}
            onConfirm={(reason) => void move("lost", reason)}
            onCancel={() => setChoosingReason(false)}
          />
        ) : (
          <button
            type="button"
            class="btn btn-ghost btn-small btn-danger"
            disabled={busy}
            onClick={() => setChoosingReason(true)}
          >
            Mark as lost
          </button>
        )}
        {busy && <span class="saving">Saving…</span>}
      </div>
      {refusal !== null && (
        <p class="refusal" role="alert">
          {refusal}
        </p>
      )}
      {refusal === null && (current === "lead" || current === "discovery") && needs.length > 0 && (
        <p class="hint">Proposal and later stages need a value and an owner.</p>
      )}
    </div>
  );
}
