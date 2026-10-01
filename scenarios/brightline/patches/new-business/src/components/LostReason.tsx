import { useState } from "patchy/preact";
import { LOST_REASONS, type LostReason } from "../../helpers/pipeline.js";
import { useEscape } from "../hooks.js";
import type { Deal } from "../types.js";

interface PickerProps {
  readonly busy?: boolean;
  readonly onConfirm: (reason: LostReason) => void;
  readonly onCancel: () => void;
}

/** Reason chips plus Cancel / Mark as lost; confirming is disabled until a reason is picked. */
export function LostReasonPicker({ busy = false, onConfirm, onCancel }: PickerProps) {
  const [reason, setReason] = useState<LostReason | null>(null);
  return (
    <div class="lost-reason">
      <p class="lost-reason-label" id="lost-reason-label">
        Why was it lost?
      </p>
      <div class="reason-options" role="radiogroup" aria-labelledby="lost-reason-label">
        {LOST_REASONS.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={reason === option}
            class="reason-option"
            disabled={busy}
            onClick={() => setReason(option)}
          >
            {option}
          </button>
        ))}
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-small" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-small btn-danger"
          disabled={busy || reason === null}
          onClick={() => reason !== null && onConfirm(reason)}
        >
          Mark as lost
        </button>
      </div>
    </div>
  );
}

/** Asks for a reason when a card is dropped on Lost; the move is sent only on confirm. */
export function LostReasonDialog({ deal, onConfirm, onCancel }: { deal: Deal } & PickerProps) {
  useEscape(onCancel);
  return (
    <div class="dialog-layer">
      <div class="backdrop" onClick={onCancel} />
      <div
        class="dialog dialog-narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lost-dialog-title"
      >
        <header class="dialog-head">
          <div>
            <h2 id="lost-dialog-title">Mark {deal.client} as lost</h2>
            <p class="muted">{deal.title}</p>
          </div>
          <button type="button" class="icon-button" aria-label="Close" onClick={onCancel}>
            ×
          </button>
        </header>
        <LostReasonPicker onConfirm={onConfirm} onCancel={onCancel} />
      </div>
    </div>
  );
}
