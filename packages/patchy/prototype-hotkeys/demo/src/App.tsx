// PROTOTYPE: a task tracker that leans on patchy/hotkeys, plus a /lab route for stress tests.
import { signal, useEffect, useQuery, useRef, useState } from "patchy/preact";
import {
  HotkeyScope,
  type Chord,
  formatHotkey,
  hotkeyKeys,
  useHotkey,
  useHotkeyList,
  useHotkeys
} from "patchy/hotkeys";
import { patchy } from "../patchy/_generated/client.js";

interface Fired {
  readonly hotkey: string;
  readonly at: number;
  readonly repeat: boolean;
  readonly target: string;
}
const fired = signal<readonly Fired[]>([]);
const record = (hotkey: string, event: KeyboardEvent) => {
  const target = event.target instanceof Element ? event.target.tagName.toLowerCase() : "document";
  fired.value = [{ hotkey, at: Date.now(), repeat: event.repeat, target }, ...fired.value].slice(
    0,
    200
  );
};
declare global {
  interface Window {
    hotkeyLog: () => readonly Fired[];
    clearHotkeyLog: () => void;
    hotkeyList: readonly { hotkey: string; label: string }[];
  }
}

const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("") as ReadonlyArray<"A">;
const prefixes = [
  "Alt+",
  "Alt+Shift+",
  "Control+Alt+",
  "Control+Alt+Shift+",
  "Mod+Alt+",
  "Mod+Alt+Shift+"
] as const;
// 156 chords from data, typed as Chord rather than literals.
const many: ReadonlyArray<Chord> = prefixes.flatMap((prefix) =>
  letters.map((letter): Chord => `${prefix}${letter}`)
);

function ManyHotkeys() {
  useHotkeys(
    many.map((hotkey) => ({ hotkey, run: (event: KeyboardEvent) => record(hotkey, event) }))
  );
  return <p data-testid="many">{many.length} extra hotkeys registered</p>;
}

/** Publishes the shortcuts list for the stress test to read. */
function ListProbe() {
  window.hotkeyList = useHotkeyList();
  return null;
}
window.hotkeyLog = () => fired.value;
window.clearHotkeyLog = () => {
  fired.value = [];
};

const routes = {
  "/": "Home",
  "/timeline": "Timeline",
  "/activity": "Activity",
  "/lab": "Lab"
} as const;
type Path = keyof typeof routes;

function Keys(props: { readonly hotkey: string }) {
  return (
    <span class="keys">
      {hotkeyKeys(props.hotkey).map((step, index) => (
        <span key={index} class="step">
          {index > 0 && <span class="then">then</span>}
          {step.map((key) => (
            <kbd key={key}>{key}</kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

function CreateTask(props: { readonly onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => input.current?.focus(), []);
  const save = () => {
    const title = input.current?.value.trim() ?? "";
    if (title === "" || saving) return;
    setSaving(true);
    void patchy.tables.tasks.insert({ title, done: false }).finally(props.onClose);
  };
  useHotkey(
    "Escape",
    (event) => {
      record("Escape (dialog)", event);
      props.onClose();
    },
    { label: "Close dialog" }
  );
  useHotkey(
    "Mod+Enter",
    (event) => {
      record("Mod+Enter", event);
      save();
    },
    { label: "Create task" }
  );
  return (
    <div class="dialog" role="dialog" aria-label="New task">
      <h2>New task</h2>
      <input ref={input} name="title" aria-label="Task title" placeholder="What needs doing?" />
      <p>
        <Keys hotkey="Mod+Enter" /> to create, <Keys hotkey="Escape" /> to close
      </p>
      <button type="button" onClick={save} disabled={saving}>
        Create
      </button>
    </div>
  );
}

function Shortcuts(props: { readonly onClose: () => void }) {
  const list = useHotkeyList();
  useHotkey("Escape", props.onClose, { label: "Close shortcuts" });
  return (
    <div class="dialog" role="dialog" aria-label="Keyboard shortcuts">
      <h2>Keyboard shortcuts</h2>
      <ul class="sheet">
        {list.map((item) => (
          <li key={item.hotkey + item.label}>
            <span>{item.label}</span> <Keys hotkey={item.hotkey} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Tasks(props: { readonly filter: string }) {
  const snapshot = useQuery(patchy.tables.tasks.list, { limit: 100 });
  const rows = (snapshot.data?.rows ?? []).filter((row) =>
    row.title.toLowerCase().includes(props.filter.toLowerCase())
  );
  const [selected, setSelected] = useState(0);
  const current = rows[Math.min(selected, rows.length - 1)];
  useHotkeys([
    {
      hotkey: "J",
      label: "Next task",
      run: (event) => {
        record("J", event);
        setSelected((index) => Math.min(index + 1, rows.length - 1));
      }
    },
    {
      hotkey: "K",
      label: "Previous task",
      run: (event) => {
        record("K", event);
        setSelected((index) => Math.max(index - 1, 0));
      }
    },
    {
      hotkey: "X",
      label: "Toggle done",
      enabled: current !== undefined,
      run: (event) => {
        record("X", event);
        if (current) void patchy.tables.tasks.update(current.id, { done: !current.done });
      }
    }
  ]);
  if (snapshot.status === "loading") return <p>Loading tasks…</p>;
  return (
    <ul class="tasks" aria-label="Tasks">
      {rows.map((row, index) => (
        <li key={row.id} aria-selected={row === current} class={row === current ? "selected" : ""}>
          <span>{row.done ? "✓" : "○"}</span> {row.title}
        </li>
      ))}
    </ul>
  );
}

/** Every focusable control a single-key hotkey might collide with. */
function Lab() {
  const [duplicate, setDuplicate] = useState(false);
  const [labEnabled, setLabEnabled] = useState(true);
  const [heavy, setHeavy] = useState(false);
  const log = fired.value;
  useHotkey("L", (event) => record("L", event), { label: "Lab: plain L", enabled: labEnabled });
  useHotkey("Shift+L", (event) => record("Shift+L", event), { label: "Lab: Shift+L" });
  useHotkey("Mod+S", (event) => record("Mod+S", event), { label: "Lab: save", repeat: false });
  useHotkey("Mod+Shift+P", (event) => record("Mod+Shift+P", event), { label: "Lab: palette" });
  useHotkey("Alt+ArrowUp", (event) => record("Alt+ArrowUp", event), { label: "Lab: Alt+ArrowUp" });
  useHotkey("Space", (event) => record("Space", event), { label: "Lab: Space" });
  useHotkey("/", (event) => record("/", event), { label: "Lab: slash" });
  useHotkey("1", (event) => record("1", event), { label: "Lab: digit 1" });
  useHotkey("Mod+T", (event) => record("Mod+T", event), { label: "Lab: Mod+T (browser keeps it)" });
  useHotkey("D I W", (event) => record("D I W", event), { label: "Lab: three-step" });
  useHotkey("G", (event) => record("G (alone)", event), {
    label: "Lab: G alone",
    enabled: duplicate
  });
  useHotkey("T", (event) => record("T (typing)", event), {
    label: "Lab: T while typing",
    whileTyping: true
  });
  return (
    <section class="lab">
      <h2>Lab</h2>
      <div class="controls">
        <label>
          Text <input data-testid="text" />
        </label>
        <label>
          Number <input type="number" data-testid="number" />
        </label>
        <label>
          Textarea <textarea data-testid="textarea" />
        </label>
        <label>
          Select{" "}
          <select data-testid="select">
            <option>Alpha</option>
            <option>Lima</option>
          </select>
        </label>
        <label>
          <input type="checkbox" data-testid="checkbox" /> Checkbox
        </label>
        <label>
          Range <input type="range" data-testid="range" />
        </label>
        <div contentEditable data-testid="editable" class="editable">
          Editable
        </div>
        <button type="button" data-testid="button" onClick={() => setDuplicate((value) => !value)}>
          {duplicate ? "Turn off G alone" : "Turn on G alone"}
        </button>
        <button
          type="button"
          data-testid="toggle-l"
          onClick={() => setLabEnabled((value) => !value)}
        >
          {labEnabled ? "Disable L" : "Enable L"}
        </button>
        <button type="button" data-testid="toggle-many" onClick={() => setHeavy((value) => !value)}>
          {heavy ? "Drop extra hotkeys" : "Register extra hotkeys"}
        </button>
        <details>
          <summary data-testid="summary">Details</summary>Inside
        </details>
        {heavy && <ManyHotkeys />}
      </div>
      <p>
        Mod is <Keys hotkey="Mod+K" /> here. Sequence display: {formatHotkey("G H")}
      </p>
      <ol class="log" data-testid="log">
        {log.slice(0, 12).map((entry) => (
          <li key={entry.at + entry.hotkey}>
            {entry.hotkey} on {entry.target}
            {entry.repeat ? " (repeat)" : ""}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function App() {
  const [path, setPath] = useState<Path>("/");
  const [creating, setCreating] = useState(false);
  const [help, setHelp] = useState(false);
  const [filter, setFilter] = useState("");
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const adopt = (next: string) => setPath(next in routes ? (next as Path) : "/");
    void patchy.route.get().then(adopt);
    return patchy.route.subscribe(adopt);
  }, []);
  useEffect(() => {
    void patchy.tables.tasks.list({ limit: 1 }).then(async (page) => {
      if (page.rows.length > 0) return;
      for (const title of [
        "Draft the launch note",
        "Book the offsite",
        "Review Q4 numbers",
        "Call the venue",
        "Ship hotkeys"
      ])
        await patchy.tables.tasks.insert({ title, done: false });
    });
  }, []);

  const go = (to: Path) => (event: KeyboardEvent) => {
    record(`go ${to}`, event);
    void patchy.route.set(to);
  };
  useHotkey("G H", go("/"), { label: "Go home" });
  useHotkey("G T", go("/timeline"), { label: "Go to timeline" });
  useHotkey("G A", go("/activity"), { label: "Go to activity" });
  useHotkey("G L", go("/lab"), { label: "Go to the lab" });
  useHotkey(
    "C T",
    (event) => {
      record("C T", event);
      setCreating(true);
    },
    { label: "Create task" }
  );
  useHotkey(
    "?",
    (event) => {
      record("?", event);
      setHelp(true);
    },
    { label: "Show shortcuts" }
  );
  useHotkey(
    "Mod+K",
    (event) => {
      record("Mod+K", event);
      search.current?.focus();
    },
    { label: "Search tasks" }
  );

  return (
    <main>
      <ListProbe />
      <nav>
        {Object.entries(routes).map(([to, name]) => (
          <a
            key={to}
            href="#"
            aria-current={to === path ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              void patchy.route.set(to);
            }}
          >
            {name}
          </a>
        ))}
        <span class="hint">
          Press <Keys hotkey="?" /> for shortcuts
        </span>
      </nav>
      <h1 data-testid="title">{routes[path]}</h1>
      <input
        ref={search}
        type="search"
        aria-label="Search tasks"
        placeholder="Search"
        value={filter}
        onInput={(event) => setFilter(event.currentTarget.value)}
      />
      {path === "/lab" ? <Lab /> : <Tasks filter={filter} />}
      {creating && (
        <HotkeyScope exclusive>
          <CreateTask onClose={() => setCreating(false)} />
        </HotkeyScope>
      )}
      {help && (
        <HotkeyScope exclusive>
          <Shortcuts onClose={() => setHelp(false)} />
        </HotkeyScope>
      )}
    </main>
  );
}
