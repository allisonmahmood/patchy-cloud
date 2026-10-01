import type { ComponentChildren } from "patchy/preact";
import { checkDeal, type DealDraft, type DealFields } from "../../helpers/dealInput.js";
import { SERVICES, SOURCES } from "../../helpers/pipeline.js";
import { parseMoney } from "../format.js";
import type { Deal } from "../types.js";

/** The editable deal fields exactly as typed. */
export interface DealFormState {
  readonly client: string;
  readonly title: string;
  readonly service: string;
  readonly value: string;
  readonly source: string;
  readonly nextStep: string;
  readonly expectedClose: string;
}

export type FormErrors = Partial<Record<keyof DealFormState, string>>;

export const emptyForm: DealFormState = {
  client: "",
  title: "",
  service: SERVICES[0],
  value: "",
  source: SOURCES[0],
  nextStep: "",
  expectedClose: ""
};

export const formFromDeal = (deal: Deal): DealFormState => ({
  client: deal.client,
  title: deal.title,
  service: deal.service,
  value: deal.value === null ? "" : deal.value.toLocaleString("en-US"),
  source: deal.source,
  nextStep: deal.nextStep ?? "",
  expectedClose: deal.expectedClose ?? ""
});

export const sameForm = (a: DealFormState, b: DealFormState) =>
  (Object.keys(a) as (keyof DealFormState)[]).every((key) => a[key] === b[key]);

/** Checks the form with the same rules as the server; returns fields ready to send. */
export function readForm(
  state: DealFormState
): { ok: true; fields: DealFields } | { ok: false; errors: FormErrors } {
  const value = parseMoney(state.value);
  if (value === "invalid")
    return { ok: false, errors: { value: "Enter a whole number of dollars, like 48,000." } };
  const draft: DealDraft = { ...state, value };
  const result = checkDeal(draft);
  return result.ok
    ? { ok: true, fields: result.fields }
    : { ok: false, errors: { [result.field]: result.message } };
}

function Field({
  label,
  error,
  wide,
  children
}: {
  label: string;
  error?: string;
  wide?: boolean;
  children: ComponentChildren;
}) {
  return (
    <label class={`field ${wide ? "field-wide" : ""} ${error ? "field-invalid" : ""}`}>
      <span class="field-label">{label}</span>
      {children}
      {error && <span class="field-error">{error}</span>}
    </label>
  );
}

interface DealFormFieldsProps {
  readonly state: DealFormState;
  readonly errors: FormErrors;
  readonly disabled?: boolean;
  readonly onChange: (state: DealFormState) => void;
  /** Called on Enter in a single-line field. */
  readonly onSubmit: () => void;
}

/** The deal's editable fields, shared by the New deal dialog and the drawer. */
export function DealFormFields({
  state,
  errors,
  disabled = false,
  onChange,
  onSubmit
}: DealFormFieldsProps) {
  const set = (key: keyof DealFormState) => (event: { currentTarget: { value: string } }) =>
    onChange({ ...state, [key]: event.currentTarget.value });
  // The sandbox blocks native form submission, so Enter submits through the handler instead.
  const enter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div class="form-grid">
      <Field label="Client" error={errors.client}>
        <input
          class="input"
          value={state.client}
          disabled={disabled}
          onInput={set("client")}
          onKeyDown={enter}
          placeholder="Company name"
        />
      </Field>
      <Field label="Project" error={errors.title}>
        <input
          class="input"
          value={state.title}
          disabled={disabled}
          onInput={set("title")}
          onKeyDown={enter}
          placeholder="What we would make for them"
        />
      </Field>
      <Field label="Service" error={errors.service}>
        <select class="input" value={state.service} disabled={disabled} onChange={set("service")}>
          {SERVICES.map((service) => (
            <option key={service} value={service}>
              {service}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Source" error={errors.source}>
        <select class="input" value={state.source} disabled={disabled} onChange={set("source")}>
          {SOURCES.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Value (USD)" error={errors.value}>
        <span class="input-money">
          <span aria-hidden="true">$</span>
          <input
            class="input"
            inputMode="numeric"
            value={state.value}
            disabled={disabled}
            onInput={set("value")}
            onKeyDown={enter}
            placeholder="Not estimated"
          />
        </span>
      </Field>
      <Field label="Expected close" error={errors.expectedClose}>
        <input
          class="input"
          type="date"
          value={state.expectedClose}
          disabled={disabled}
          onInput={set("expectedClose")}
          onKeyDown={enter}
        />
      </Field>
      <Field label="Next step" error={errors.nextStep} wide>
        <input
          class="input"
          value={state.nextStep}
          disabled={disabled}
          onInput={set("nextStep")}
          onKeyDown={enter}
          placeholder="What happens next?"
        />
      </Field>
    </div>
  );
}
