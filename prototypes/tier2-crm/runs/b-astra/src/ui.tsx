import { useId, useState } from "patchy/preact";
import type { ComponentChildren } from "preact";
import type { Id } from "patchy/config";
import * as dialog from "@zag-js/dialog";
import { useMachine, normalizeProps } from "@zag-js/preact";
import { useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";

export const stageNames = ["Lead", "Qualified", "Proposal", "Won", "Lost"] as const;
export type Stage = (typeof stageNames)[number];
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});
export const dollars = (cents: number) => currency.format(cents / 100);
const messages: Record<string, string> = {
  not_owner: "Only the current owner can change this record.",
  not_found: "This record is unavailable or private.",
  unknown_teammate: "That teammate has not opened the CRM yet.",
  company_in_use:
    "This company still has linked contacts or deals. Move or delete those records first.",
  duplicate_company: "A company with this name already exists.",
  duplicate_email: "This email is already saved.",
  invalid_email: "Enter a valid email address.",
  invalid_input: "Check the required fields and use a nonnegative dollar value.",
  company_not_found: "Select an existing company.",
  unknown_outcome:
    "The reply was lost. The change may have saved. Check the live record before deliberately trying again."
};
export function errorText(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    return (
      messages[error.code] ??
      `${error.code}: ${"message" in error ? String(error.message) : "Request refused"}`
    );
  return error instanceof Error ? error.message : String(error);
}
export function ErrorNotice({ error }: { error: unknown }) {
  return error ? (
    <p className="error" role="alert">
      {errorText(error)}
    </p>
  ) : null;
}
export function Modal({
  title,
  children,
  onClose
}: {
  title: string;
  children: ComponentChildren;
  onClose: () => void;
}) {
  const service = useMachine(dialog.machine, {
    id: useId(),
    open: true,
    onOpenChange: ({ open }) => {
      if (!open) onClose();
    }
  });
  const api = dialog.connect(service, normalizeProps);
  return (
    <>
      <div {...api.getBackdropProps()} className="modal-backdrop" />
      <div {...api.getPositionerProps()} className="modal-positioner">
        <section {...api.getContentProps()} className="modal">
          <header className="modal-heading">
            <h2 {...api.getTitleProps()}>{title}</h2>
            <button
              {...api.getCloseTriggerProps()}
              className="icon-button"
              aria-label="Close dialog"
            >
              ×
            </button>
          </header>
          {children}
        </section>
      </div>
    </>
  );
}
export function useOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (work: () => Promise<unknown>, done?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      done?.();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}
export function CompanyPicker({
  value,
  initialName,
  onChange
}: {
  value: Id<"companies"> | "";
  initialName?: string;
  onChange: (id: Id<"companies"> | "") => void;
}) {
  const [search, setSearch] = useState("");
  const { data, error } = useQuery(patchy.server.records.companies, { search });
  return (
    <div className="field">
      <label>
        Find company
        <input
          aria-label="Find company"
          placeholder="Search company name…"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
      </label>
      <label>
        Company
        <select
          aria-label="Company"
          value={value}
          onChange={(e) =>
            onChange(data?.rows.find((row) => row.id === e.currentTarget.value)?.id ?? "")
          }
          required
        >
          <option value="">Choose a company</option>
          {value && !data?.rows.some((r) => r.id === value) && (
            <option value={value}>{initialName ?? "Selected company"}</option>
          )}
          {data?.rows.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
      </label>
      {data?.cursor && (
        <small className="muted">Showing the first 50 matches. Narrow the company name.</small>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
export function Pager({
  next,
  previous,
  page
}: {
  next?: () => void;
  previous?: () => void;
  page: number;
}) {
  return (
    <div className="pager">
      <button type="button" className="secondary" disabled={!previous} onClick={previous}>
        Previous
      </button>
      <span>Page {page}</span>
      <button type="button" className="secondary" disabled={!next} onClick={next}>
        Next
      </button>
    </div>
  );
}
