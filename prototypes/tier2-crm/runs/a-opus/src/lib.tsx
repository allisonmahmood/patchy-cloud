import { createContext, useContext, useState } from "patchy/preact";
import type { ComponentChildren } from "patchy/preact";
import { patchy, isHandlerError, isPatchyError } from "../patchy/_generated/client.js";

export { patchy };
export type Company = Awaited<ReturnType<typeof patchy.server.companies.list>>[number];
export type Contact = Awaited<ReturnType<typeof patchy.server.contacts.list>>[number];
export type Deal = Awaited<ReturnType<typeof patchy.server.deals.list>>[number];
export type Member = Awaited<ReturnType<typeof patchy.server.members.list>>[number];
export { STAGES, OPEN_STAGES, type Stage } from "../lib/stages.js";

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});
const exact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** Whole-dollar display for deal values; `exact` keeps cents for finance figures. */
export const money = (cents: number, precise = false) =>
  (precise ? exact : dollars).format(cents / 100);

/** Handler error codes → what the person should read. Unlisted codes fall back to the error's own text. */
const MESSAGES: Record<string, string> = {
  not_owner: "Only the owner can change this.",
  not_found: "It no longer exists, or you cannot see it.",
  unknown_member: "That teammate has not opened the CRM yet.",
  empty_name: "A name is required.",
  empty_title: "A title is required.",
  duplicate_name: "A company with this name already exists.",
  duplicate_email: "A contact with this email already exists.",
  invalid_email: "That email address is not valid.",
  invalid_value: "The value must be a positive dollar amount.",
  no_company: "Pick a company.",
  in_use: "Remove its contacts and deals first.",
  too_large: "The file is larger than 10 MB.",
  empty_file: "The file is empty.",
  bad_name: "The file name is not usable.",
  missing_columns: "The CSV needs at least email and company columns.",
  too_many_rows: "The CSV has more than 1,000 rows; split it."
};

export function describe(error: unknown): string {
  if (isHandlerError(error)) return MESSAGES[error.code] ?? error.code;
  if (isPatchyError(error, "unknown_outcome"))
    return "The request got no reply; check the page before trying again.";
  return error instanceof Error ? error.message : String(error);
}

type Team = { readonly me: Member["userId"] | undefined; readonly members: readonly Member[] };
const TeamContext = createContext<Team>({ me: undefined, members: [] });
export const TeamProvider = ({ value, children }: { value: Team; children: ComponentChildren }) => (
  <TeamContext.Provider value={value}>{children}</TeamContext.Provider>
);
export const useTeam = () => useContext(TeamContext);

/** "you" for the viewer, the teammate's name otherwise. */
export function useOwnerName(ownerId: string) {
  const { me, members } = useTeam();
  if (ownerId === me) return "you";
  return members.find((member) => member.userId === ownerId)?.name ?? "someone";
}

/** Runs an async handler call, tracking busy state and a readable error. */
export function useRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError("");
    try {
      return await work();
    } catch (cause) {
      setError(describe(cause));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** Owner line with hand-off control for the owner. `transfer` is the record's own transfer mutation. */
export function Ownership({
  ownerId,
  transfer,
  compact = false
}: {
  ownerId: string;
  transfer: (toUserId: string) => Promise<unknown>;
  /** Table cells: just the name and the menu. */
  compact?: boolean;
}) {
  const { me, members } = useTeam();
  const owner = useOwnerName(ownerId);
  const { busy, error, run } = useRunner();
  const others = members.filter((member) => member.userId !== ownerId);
  return (
    <div class={`ownership${compact ? " compact" : ""}`}>
      {compact ? (
        <span>{owner}</span>
      ) : (
        <span class="muted">
          Owner: <strong>{owner}</strong>
        </span>
      )}
      {ownerId === me && others.length > 0 && (
        <select
          disabled={busy}
          value=""
          aria-label="Hand to a teammate"
          onChange={(event) => {
            const to = event.currentTarget.value;
            if (to) void run(() => transfer(to));
          }}
        >
          <option value="">Hand to…</option>
          {others.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </select>
      )}
      {error && (
        <span class="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Enter submits; the frame blocks native form submission. */
export const onEnter = (action: () => void) => (event: KeyboardEvent) => {
  if (event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement)) {
    event.preventDefault();
    action();
  }
};
