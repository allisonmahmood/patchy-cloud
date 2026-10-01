import { useState } from "patchy/preact";
import { patchy } from "../../patchy/_generated/client.js";
import { describeError } from "../errors.js";
import { useEscape } from "../hooks.js";
import type { Notify, Person } from "../types.js";
import {
  DealFormFields,
  emptyForm,
  readForm,
  type DealFormState,
  type FormErrors
} from "./DealForm.js";
import { OwnerPicker } from "./OwnerPicker.js";

/** Modal for adding a deal; new deals start in Lead. */
export function NewDealDialog({
  notify,
  onClose,
  onCreated
}: {
  notify: Notify;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState<DealFormState>(emptyForm);
  const [owner, setOwner] = useState<Person | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEscape(onClose);

  async function create() {
    if (saving) return;
    const result = readForm(form);
    setErrors(result.ok ? {} : result.errors);
    setRefusal(null);
    if (!result.ok) return;
    setSaving(true);
    try {
      const deal = await patchy.server.deals.create({ ...result.fields, owner: owner?.id ?? null });
      notify(`Added ${deal.client} to Lead.`, { tone: "success" });
      onCreated(deal.id);
    } catch (error) {
      setRefusal(describeError(error));
      setSaving(false);
    }
  }

  return (
    <div class="dialog-layer">
      <div class="backdrop" onClick={onClose} />
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="new-deal-title">
        <header class="dialog-head">
          <div>
            <h2 id="new-deal-title">New deal</h2>
            <p class="muted">
              It starts in Lead. Add a value and an owner before it moves to Proposal.
            </p>
          </div>
          <button type="button" class="icon-button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <DealFormFields
          state={form}
          errors={errors}
          disabled={saving}
          onChange={(next) => {
            setForm(next);
            setErrors({});
          }}
          onSubmit={() => void create()}
        />
        <div class="field field-wide">
          <span class="field-label">Owner</span>
          <OwnerPicker selected={owner} disabled={saving} onPick={setOwner} />
        </div>
        {refusal !== null && (
          <p class="refusal" role="alert">
            {refusal}
          </p>
        )}
        <footer class="dialog-actions">
          <button type="button" class="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-primary"
            disabled={saving}
            onClick={() => void create()}
          >
            {saving ? "Adding…" : "Add deal"}
          </button>
        </footer>
      </div>
    </div>
  );
}
