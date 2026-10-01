import { useEffect, useId, useRef, useState, useQuery } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";
import { writeFailure } from "./errors.js";
import { MESSAGE_MAX, VALUES, firstName } from "./model.js";
import type { Member, ValueKey } from "./model.js";
import { Avatar } from "./people.js";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; text: string }
  | { kind: "invalid"; text: string }
  | { kind: "error"; text: string };

/** The "Give kudos" card: pick a colleague and a value, write a message, send. */
export function Composer({ meId }: { meId: string | undefined }) {
  const [recipient, setRecipient] = useState<Member | null>(null);
  const [value, setValue] = useState<ValueKey | null>(null);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const pickerRef = useRef<HTMLInputElement>(null);
  const valuesRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const sending = status.kind === "sending";

  useEffect(() => {
    if (status.kind !== "sent") return;
    const timer = setTimeout(() => setStatus({ kind: "idle" }), 5000);
    return () => clearTimeout(timer);
  }, [status]);

  function invalid(text: string, focus: HTMLElement | null | undefined) {
    setStatus({ kind: "invalid", text });
    focus?.focus();
  }

  async function send() {
    if (sending || meId === undefined) return;
    const text = message.trim();
    if (!recipient) return invalid("Pick a colleague to thank.", pickerRef.current);
    if (recipient.id === meId)
      return invalid("Kudos are for thanking someone else. Pick a colleague.", pickerRef.current);
    if (!value)
      return invalid("Pick the value they showed.", valuesRef.current?.querySelector("button"));
    if (!text) return invalid("Add a short message about what they did.", messageRef.current);

    setStatus({ kind: "sending" });
    try {
      await patchy.tables.kudos.insert({
        recipient: recipient.id,
        sender: meId,
        message: text.slice(0, MESSAGE_MAX),
        value,
        sentAt: new Date().toISOString()
      });
      setRecipient(null);
      setValue(null);
      setMessage("");
      setStatus({
        kind: "sent",
        text: `Kudos sent to ${firstName(recipient)}. The whole studio can see it now.`
      });
    } catch (cause) {
      setStatus({
        kind: "error",
        text: isPatchyError(cause, "invalid_row")
          ? `${recipient.name} can't receive kudos right now. They may no longer be at the studio.`
          : writeFailure(cause, "kudos")
      });
    }
  }

  const remaining = MESSAGE_MAX - message.length;
  const clearInvalid = () => {
    if (status.kind === "invalid" || status.kind === "error") setStatus({ kind: "idle" });
  };

  return (
    <section className="panel composer" aria-labelledby="composer-title">
      <div className="composer__head">
        <h2 id="composer-title" className="section-title">
          Give kudos
        </h2>
        <p className="composer__hint">
          Thank someone for something specific. It lands on the wall for everyone.
        </p>
      </div>

      <div className="composer__row">
        <div className="field field--to">
          <span className="field__label" id="to-label">
            To
          </span>
          <MemberPicker
            selected={recipient}
            excludeId={meId}
            inputRef={pickerRef}
            disabled={sending}
            onSelect={(member) => {
              setRecipient(member);
              clearInvalid();
              if (member) messageRef.current?.focus();
            }}
          />
        </div>

        <div className="field field--values">
          <span className="field__label" id="value-label">
            For
          </span>
          <div className="value-picker" role="group" aria-labelledby="value-label" ref={valuesRef}>
            {VALUES.map((option) => (
              <button
                key={option.key}
                type="button"
                className="value-option"
                data-value={option.key}
                aria-pressed={value === option.key}
                title={option.hint}
                disabled={sending}
                onClick={() => {
                  setValue(value === option.key ? null : option.key);
                  clearInvalid();
                }}
              >
                <span className="value-dot" aria-hidden="true" />
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <label className="field">
        <span className="field__label">Message</span>
        <textarea
          ref={messageRef}
          className="input composer__message"
          rows={3}
          maxLength={MESSAGE_MAX}
          placeholder="What did they do, and why did it matter? Specific beats generic."
          value={message}
          disabled={sending}
          onInput={(event) => {
            setMessage(event.currentTarget.value);
            clearInvalid();
          }}
          onKeyDown={(event) => {
            // The sandbox blocks native form submission, so Enter sends directly; Shift+Enter keeps a newline.
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
      </label>

      <div className="composer__foot">
        <p
          className={`composer__status composer__status--${status.kind}`}
          role={status.kind === "invalid" || status.kind === "error" ? "alert" : "status"}
        >
          {status.kind === "sending"
            ? "Sending…"
            : status.kind === "idle"
              ? "Enter to send · Shift+Enter for a new line"
              : status.text}
        </p>
        <span className={`composer__count${remaining <= 20 ? " is-low" : ""}`} aria-live="polite">
          {message.length}/{MESSAGE_MAX}
        </span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={sending || meId === undefined}
          onClick={() => void send()}
        >
          {sending ? "Sending…" : "Send kudos"}
        </button>
      </div>
    </section>
  );
}

/** Debounces a fast-changing value so typing does not open a subscription per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Colleague search by name or email prefix. Shows the picked person as a removable pill. */
function MemberPicker({
  selected,
  excludeId,
  inputRef,
  disabled,
  onSelect
}: {
  selected: Member | null;
  excludeId: string | undefined;
  inputRef: { readonly current: HTMLInputElement | null };
  disabled: boolean;
  onSelect: (member: Member | null) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const query = useDebounced(text.trim(), 120);
  const search = useQuery(patchy.members.search, { text: query });
  const options = (search.data?.rows ?? []).filter(
    (member) => member.id !== excludeId && member.active
  );
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  function pick(member: Member) {
    onSelect(member);
    setText("");
    setOpen(false);
    setActive(0);
  }

  if (selected) {
    return (
      <div className="picked">
        <Avatar id={selected.id} person={selected} size="sm" />
        <span className="picked__name">{selected.name}</span>
        <button
          type="button"
          className="picked__clear"
          aria-label={`Remove ${selected.name}`}
          disabled={disabled}
          onClick={() => {
            onSelect(null);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="picker">
      <input
        ref={inputRef}
        className="input"
        type="text"
        role="combobox"
        aria-labelledby="to-label"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && options[activeIndex] ? `${listId}-${activeIndex}` : undefined
        }
        placeholder="Search by name…"
        autoComplete="off"
        value={text}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onInput={(event) => {
          setText(event.currentTarget.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((activeIndex + step + options.length) % Math.max(options.length, 1));
          } else if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            const option = options[activeIndex];
            if (open && option) pick(option);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul className="picker__list" id={listId} role="listbox" aria-labelledby="to-label">
          {options.map((member, index) => (
            <li
              key={member.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className="picker__option"
              // Keep focus in the input so blur doesn't close the list before the pick lands.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(member)}
            >
              <Avatar id={member.id} person={member} size="sm" />
              <span className="picker__name">{member.name}</span>
              <span className="picker__email">{member.email}</span>
            </li>
          ))}
          {options.length === 0 && (
            <li className="picker__empty" role="presentation">
              {search.data === undefined || query !== text.trim()
                ? "Searching…"
                : query
                  ? `No one found starting with “${query}”. Try a first name or email.`
                  : "No colleagues to thank yet."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
