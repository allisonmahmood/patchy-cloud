import { useQuery, useState } from "patchy/preact";
import type { ComponentChildren } from "preact";
import { patchy, isHandlerError, isPatchyError } from "../patchy/_generated/client.js";

import type { Company, Team } from "../lib/models.js";
export type { Company, Contact, Deal, Team } from "../lib/models.js";
export const stageNames = ["Lead", "Qualified", "Proposal", "Won", "Lost"] as const;
export type Stage = (typeof stageNames)[number];
const currencyFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});
export const money = (cents: number) => currencyFormat.format(cents / 100);
const messages: Record<string, string> = {
  owner_only: "Only the current owner can change this record.",
  not_found: "This record is missing or you no longer have access.",
  duplicate_company: "A company with this name already exists.",
  duplicate_email: "A contact with this email already exists.",
  invalid_email: "Enter a valid email address.",
  invalid_value:
    "Check the field values. Names must be 1–300 characters; deal values must be $0–$20,000,000.",
  company_in_use: "This company still has contacts or deals. Move or delete those records first.",
  unknown_teammate: "That teammate must open this CRM before receiving a record.",
  invalid_filename: "Use a filename without slashes or control characters, up to 180 bytes.",
  too_large: "Files must be no larger than 20 MiB.",
  unknown_outcome:
    "The reply was lost. The write may have succeeded. Check the live records before deliberately retrying; nothing was replayed."
};
export function errorMessage(error: unknown) {
  if (isHandlerError(error) || isPatchyError(error)) {
    const detail = error.details;
    const extra =
      detail &&
      typeof detail === "object" &&
      "message" in detail &&
      typeof detail.message === "string"
        ? ` ${detail.message}`
        : "";
    return (messages[error.code] ?? `${error.code}: ${error.message}`) + extra;
  }
  return error instanceof Error ? error.message : String(error);
}
export function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(task: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
export function ErrorBox({ error }: { error: unknown }) {
  return error ? (
    <p className="error" role="alert">
      {typeof error === "string" ? error : errorMessage(error)}
    </p>
  ) : null;
}
export function Empty({ children }: { children: ComponentChildren }) {
  return <div className="empty">{children}</div>;
}
export function Pager({
  cursor,
  next,
  reset
}: {
  cursor: string | null;
  next: (cursor: string) => void;
  reset: () => void;
}) {
  return (
    <div className="pager">
      <button type="button" className="secondary" onClick={reset}>
        First page
      </button>
      <button
        type="button"
        className="secondary"
        disabled={!cursor}
        onClick={() => cursor && next(cursor)}
      >
        Next page
      </button>
    </div>
  );
}
export function OwnerSelect({
  value,
  onChange,
  team
}: {
  value: string;
  onChange: (value: string) => void;
  team: Team;
}) {
  return (
    <label>
      Owner
      <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {team.members.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.name} · {member.email}
          </option>
        ))}
      </select>
      <small>
        Teammates appear after opening this CRM. Saving a transfer hands over editing rights.
      </small>
    </label>
  );
}
export function OwnerName({ id, team }: { id: string; team: Team }) {
  return (
    <span>
      {id === team.viewerId
        ? "You"
        : (team.members.find((m) => m.userId === id)?.name ?? "Teammate")}
    </span>
  );
}
export function CompanyPicker({
  value,
  onChange
}: {
  value: Company["id"] | "";
  onChange: (id: Company["id"] | "") => void;
}) {
  const [search, setSearch] = useState("");
  const { data, error } = useQuery(patchy.server.companies.list, { search });
  return (
    <label>
      Company
      <input
        aria-label="Find company"
        placeholder="Find company by name…"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      <select
        aria-label="Company"
        required
        value={value}
        onChange={(e) =>
          onChange(data?.rows.find((row) => row.id === e.currentTarget.value)?.id ?? "")
        }
      >
        <option value="">Choose a company</option>
        {value && !data?.rows.some((c) => c.id === value) && (
          <option value={value}>Current company</option>
        )}
        {data?.rows.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {data?.cursor && <small>First 50 matches. Type a more specific name.</small>}
      <ErrorBox error={error} />
    </label>
  );
}
export function Modal({
  title,
  close,
  children
}: {
  title: string;
  close: () => void;
  children: ComponentChildren;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal panel" role="dialog" aria-modal="true" aria-label={title}>
        <header className="section-heading">
          <h2>{title}</h2>
          <button type="button" className="secondary" onClick={close} aria-label="Close dialog">
            Close
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
