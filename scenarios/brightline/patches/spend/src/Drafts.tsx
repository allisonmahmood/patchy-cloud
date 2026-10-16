import { formatMoney } from "../helpers/spend.js";
import type { Draft } from "./data.js";

/**
 * Requests the viewer's agents drafted through Patchy's MCP. Nothing is requested until the
 * viewer finishes one (the New request dialog, prefilled) or discards it.
 */
export function Drafts({
  drafts,
  busy,
  onFinish,
  onDiscard
}: {
  drafts: readonly Draft[];
  busy: string | null;
  onFinish: (draft: Draft) => void;
  onDiscard: (draft: Draft) => void;
}) {
  return (
    <section class="panel drafts" aria-label="Drafts from your agent">
      <div class="panel-bar">
        <div>
          <h2 class="section-title">Drafted by your agent</h2>
          <p class="muted">
            Nothing is requested until you check it, attach the receipt if it needs one, and submit
            it.
          </p>
        </div>
      </div>
      <div class="table">
        {drafts.map((draft) => (
          <div key={draft.id} class="table-row draft-row">
            <span class="cell-request">
              <span class="row-title">{draft.title}</span>
              <span class="row-project">
                {draft.project} · {draft.category} · drafted by {draft.agent}
              </span>
            </span>
            <span class="money">{formatMoney(draft.amountCents)}</span>
            <span class="draft-actions">
              <button
                type="button"
                class="button ghost small"
                disabled={busy === draft.id}
                onClick={() => onDiscard(draft)}
              >
                {busy === draft.id ? "Discarding…" : "Discard"}
              </button>
              <button
                type="button"
                class="button primary small"
                disabled={busy === draft.id}
                onClick={() => onFinish(draft)}
              >
                Finish and submit
              </button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
