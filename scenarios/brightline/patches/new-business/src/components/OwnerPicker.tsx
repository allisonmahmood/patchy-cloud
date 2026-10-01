import { useEffect, useRef, useState, useQuery } from "patchy/preact";
import { patchy } from "../../patchy/_generated/client.js";
import type { Person } from "../types.js";
import { Avatar } from "./Avatar.js";

interface OwnerPickerProps {
  readonly selected: Person | null;
  /** Shown instead of the name while a change is saving. */
  readonly saving?: boolean;
  readonly disabled?: boolean;
  readonly onPick: (person: Person | null) => void;
}

/** Owner field; opening it searches the studio's members by name or email prefix. */
export function OwnerPicker({
  selected,
  saving = false,
  disabled = false,
  onPick
}: OwnerPickerProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div class="owner-picker" ref={root}>
      <button
        type="button"
        class="owner-current"
        disabled={disabled || saving}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Avatar person={selected} size="md" />
        <span class={selected === null ? "owner-name owner-none" : "owner-name"}>
          {saving ? "Saving…" : (selected?.name ?? "Unassigned")}
        </span>
        <span class="owner-change">{selected === null ? "Assign" : "Change"}</span>
      </button>
      {open && (
        <OwnerMenu
          canClear={selected !== null}
          onClose={() => setOpen(false)}
          onPick={(person) => {
            setOpen(false);
            onPick(person);
          }}
        />
      )}
    </div>
  );
}

/** The open search list; mounted only while open so it subscribes only then. */
function OwnerMenu({
  canClear,
  onClose,
  onPick
}: {
  canClear: boolean;
  onClose: () => void;
  onPick: (person: Person | null) => void;
}) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // The autofocus attribute is blocked in a cross-origin frame; focus after a click instead.
  useEffect(() => input.current?.focus(), []);

  // Debounce typing so each pause, not each keystroke, asks the directory.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(text.trim()), 150);
    return () => clearTimeout(timer);
  }, [text]);

  const results = useQuery(patchy.server.team.people, { search, cursor: null });
  const people = (results.data?.people ?? []).filter((person) => person.active).slice(0, 8);
  const options: readonly (Person | null)[] = [...people, ...(canClear ? [null] : [])];

  return (
    <div class="owner-menu">
      <input
        class="input"
        placeholder="Search by name or email"
        ref={input}
        value={text}
        onInput={(event) => {
          setText(event.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, options.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const option = options[active];
            if (option !== undefined) onPick(option);
          } else if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <ul class="owner-options" role="listbox">
        {options.map((person, index) => (
          <li key={person?.id ?? "none"}>
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              class={`owner-option ${index === active ? "owner-option-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => onPick(person)}
            >
              <Avatar person={person} />
              {person === null ? (
                <span class="owner-option-name">Remove owner</span>
              ) : (
                <>
                  <span class="owner-option-name">{person.name}</span>
                  <span class="owner-option-email">{person.email}</span>
                </>
              )}
            </button>
          </li>
        ))}
        {people.length === 0 && (
          <li class="owner-empty">
            {results.data === undefined || search !== text.trim()
              ? "Searching…"
              : `No one matches "${search}".`}
          </li>
        )}
      </ul>
    </div>
  );
}
