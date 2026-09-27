import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentChildren
} from "patchy/preact";
import { patchy, isHandlerError, isPatchyError } from "../patchy/_generated/client.js";
import type { Me } from "patchy/client";

/** Where the page is. Kept in memory: the frame has no router of its own. */
export type View =
  | { readonly name: "pipeline" | "companies" | "contacts" | "import" | "finance" }
  | { readonly name: "company"; readonly id: CompanyId }
  | { readonly name: "deal"; readonly id: DealId };

type Company = Awaited<ReturnType<typeof patchy.server.companies.list>>[number];
type Deal = Awaited<ReturnType<typeof patchy.server.deals.get>>["deal"];
export type CompanyId = Company["id"];
export type DealId = Deal["id"];

export const App = createContext<{ me: Me; go: (view: View) => void }>(null!);
export const useApp = () => useContext(App);

const messages: Record<string, string> = {
  not_owner: "Only the owner can change this.",
  not_found: "It no longer exists, or you cannot see it.",
  unknown_member: "That teammate has not opened the CRM yet.",
  empty_name: "A name is required.",
  empty_title: "A title is required.",
  duplicate_name: "A company with that name already exists.",
  duplicate_email: "A contact with that email already exists.",
  invalid_email: "That email address is not valid.",
  invalid_value: "The value must be a positive dollar amount.",
  in_use: "Delete or move this company's contacts and deals first.",
  too_large: "The file is larger than 20 MB.",
  unsupported_type: "Only PDF, PNG, JPEG, GIF, WebP and plain text files can be attached.",
  bad_header: "The CSV needs a header row with first_name, last_name, email and company.",
  too_many_rows: "Import at most 1,000 rows at a time.",
  unknown_outcome: "The request left but no reply came back; check the page before trying again.",
  access_denied: "You no longer have access to this."
};

/** A sentence for any failure: a handler's own code, a Patchy refusal, or anything else. */
export function describe(error: unknown): string {
  if (isHandlerError(error) || isPatchyError(error))
    return messages[error.code] ?? `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

/** Runs an event handler's async work, exposing whether it is busy and its last failure. */
export function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      return true;
    } catch (cause) {
      setError(describe(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

export const Alert = ({ children }: { children: ComponentChildren }) =>
  children ? (
    <p class="alert" role="alert">
      {children}
    </p>
  ) : null;

/** A native modal dialog: focus trap, Escape to close and backdrop come from the browser. */
export function Modal({
  title,
  onClose,
  children
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} class="modal" onClose={onClose} aria-labelledby="modal-title">
      <header>
        <h2 id="modal-title">{title}</h2>
        <button type="button" class="ghost" aria-label="Close" onClick={() => ref.current?.close()}>
          ✕
        </button>
      </header>
      {children}
    </dialog>
  );
}

/** Blocks native submission (the frame refuses it) and submits on Enter from a single-line field. */
export function Form({
  onSubmit,
  children
}: {
  onSubmit: () => void;
  children: ComponentChildren;
}) {
  return (
    <form
      class="form"
      onSubmit={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          event.target instanceof HTMLInputElement &&
          event.target.type !== "checkbox"
        ) {
          event.preventDefault();
          if (event.currentTarget.reportValidity()) onSubmit();
        }
      }}
    >
      {children}
    </form>
  );
}

/**
 * Who owns a record, and for the owner a picker to hand it to a teammate. `onHandoff` calls the
 * record's own handoff mutation; the server refuses anyone but the owner either way.
 */
export function Owner({
  ownerId,
  ownerName,
  onHandoff
}: {
  ownerId: string;
  ownerName: string;
  onHandoff: (userId: string) => Promise<unknown>;
}) {
  const { me } = useApp();
  const [picking, setPicking] = useState(false);
  const task = useTask();
  const team = patchy.server.team.list;
  const [members, setMembers] = useState<Awaited<ReturnType<typeof team>>>([]);
  const mine = ownerId === me.user.id;
  useEffect(() => {
    if (picking) void team({}).then(setMembers, (cause: unknown) => task.setError(describe(cause)));
  }, [picking]);
  return (
    <span class="owner">
      <span class="muted">Owner</span> {mine ? "You" : ownerName}
      {mine && !picking && (
        <button type="button" class="link" onClick={() => setPicking(true)}>
          Hand over
        </button>
      )}
      {picking && (
        <select
          aria-label="New owner"
          disabled={task.busy}
          value=""
          onChange={(event) => {
            const userId = event.currentTarget.value;
            if (userId)
              void task.run(() => onHandoff(userId)).then((ok) => ok && setPicking(false));
          }}
        >
          <option value="">Hand to…</option>
          {members
            .filter((m) => m.userId !== me.user.id)
            .map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
        </select>
      )}
      {picking && (
        <button type="button" class="link" onClick={() => setPicking(false)}>
          Cancel
        </button>
      )}
      <Alert>{task.error}</Alert>
    </span>
  );
}

/** A delete button that asks once inline (the sandbox may block window.confirm). */
export function DeleteButton({
  label = "Delete",
  busy,
  onConfirm
}: {
  label?: string;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  return asking ? (
    <span class="confirm">
      <button
        type="button"
        class="danger"
        disabled={busy}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Confirm {label.toLowerCase()}
      </button>
      <button type="button" class="ghost" onClick={() => setAsking(false)}>
        Keep
      </button>
    </span>
  ) : (
    <button type="button" class="ghost danger-text" disabled={busy} onClick={() => setAsking(true)}>
      {label}
    </button>
  );
}
