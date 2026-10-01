// Validation for the editable deal fields, shared so the page flags exactly what the server refuses.
import {
  MAX_TEXT,
  MAX_VALUE,
  SERVICES,
  SOURCES,
  isIsoDate,
  type Service,
  type Source
} from "./pipeline.js";

/** Raw editable fields, as typed into a form or read from a CSV row. */
export interface DealDraft {
  readonly client: string;
  readonly title: string;
  readonly service: string;
  readonly value: number | null;
  readonly source: string;
  readonly nextStep: string | null;
  readonly expectedClose: string | null;
}

/** The same fields after trimming and checking. */
export interface DealFields {
  readonly client: string;
  readonly title: string;
  readonly service: Service;
  readonly value: number | null;
  readonly source: Source;
  readonly nextStep: string | null;
  readonly expectedClose: string | null;
}

export type DealProblem = { readonly field: keyof DealDraft; readonly message: string };

const optionalText = (value: string | null) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** Trims a draft and returns its checked fields, or the first problem in plain words. */
export function checkDeal(
  draft: DealDraft
): { ok: true; fields: DealFields } | ({ ok: false } & DealProblem) {
  const client = draft.client.trim();
  const title = draft.title.trim();
  const nextStep = optionalText(draft.nextStep);
  const expectedClose = optionalText(draft.expectedClose);
  const service = SERVICES.find((s) => s.toLowerCase() === draft.service.trim().toLowerCase());
  const source = SOURCES.find((s) => s.toLowerCase() === draft.source.trim().toLowerCase());

  if (client === "") return { ok: false, field: "client", message: "Add the client's name." };
  if (client.length > MAX_TEXT)
    return { ok: false, field: "client", message: "The client name is too long." };
  if (title === "") return { ok: false, field: "title", message: "Add a project title." };
  if (title.length > MAX_TEXT)
    return { ok: false, field: "title", message: "The project title is too long." };
  if (service === undefined)
    return {
      ok: false,
      field: "service",
      message: `Service must be one of: ${SERVICES.join(", ")}.`
    };
  if (source === undefined)
    return { ok: false, field: "source", message: `Source must be one of: ${SOURCES.join(", ")}.` };
  if (
    draft.value !== null &&
    (!Number.isInteger(draft.value) || draft.value < 0 || draft.value > MAX_VALUE)
  )
    return { ok: false, field: "value", message: "Value must be a whole number of dollars." };
  if (nextStep !== null && nextStep.length > MAX_TEXT)
    return { ok: false, field: "nextStep", message: "The next step is too long." };
  if (expectedClose !== null && !isIsoDate(expectedClose))
    return {
      ok: false,
      field: "expectedClose",
      message: "Expected close must be a date like 2026-11-30."
    };

  return {
    ok: true,
    // A zero value means "not estimated yet".
    fields: {
      client,
      title,
      service,
      value: draft.value === 0 ? null : draft.value,
      source,
      nextStep,
      expectedClose
    }
  };
}
