import { useEffect, useLayoutEffect, useRef, useState } from "patchy/preact";
import {
  HotkeyScope,
  HotkeySheet,
  formatHotkey,
  prototypeSwitches,
  useHotkey,
  useHotkeys
} from "patchy/hotkeys";

// A prototype of local hotkeys: keys that belong to one element, to a dialog or to the page,
// and the editing keys that always stay with a text field. Every key goes through patchy/hotkeys;
// the one raw handler is the due-date picker, which stands in for a third-party widget.

interface Task {
  readonly id: number;
  readonly title: string;
  readonly done: boolean;
  readonly priority: number;
  readonly assignee: string;
}

const people = ["", "Ana", "Ben", "Cy"] as const;
const priorities = [1, 2, 3, 4, 5] as const;
const digits = ["1", "2", "3", "4", "5"] as const;

const seed: readonly Task[] = [
  { id: 1, title: "Draft the onboarding email", done: false, priority: 2, assignee: "Ana" },
  { id: 2, title: "Fix the CSV export", done: false, priority: 4, assignee: "Ben" },
  { id: 3, title: "Call the Acme team", done: true, priority: 3, assignee: "" },
  { id: 4, title: "Review pricing page copy", done: false, priority: 1, assignee: "Cy" }
];

type DialogKeys = "escape" | "chords" | "sheet";

export function App() {
  const [tasks, setTasks] = useState(seed);
  const [history, setHistory] = useState<readonly (readonly Task[])[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [dialogKeys, setDialogKeys] = useState<DialogKeys>("sheet");
  const [last, setLast] = useState("");
  const [switches, setSwitches] = useState({ ...prototypeSwitches });
  Object.assign(prototypeSwitches, switches);

  const change = (next: readonly Task[], what: string) => {
    setHistory([...history, tasks]);
    setTasks(next);
    setLast(what);
  };
  const add = (title: string) =>
    change(
      [...tasks, { id: Date.now(), title, done: false, priority: 3, assignee: "" }],
      `Added “${title}”`
    );

  useHotkey("C T", () => setCreating(true), { label: "Create task", group: "Tasks" });
  useHotkey(
    "Mod+A",
    () => {
      setSelected(new Set(tasks.map((task) => task.id)));
      setLast("Selected all tasks");
    },
    { label: "Select all tasks", group: "Tasks" }
  );
  useHotkey(
    "Mod+Z",
    () => {
      const previous = history.at(-1);
      if (previous === undefined) return setLast("Nothing to undo");
      setTasks(previous);
      setHistory(history.slice(0, -1));
      setLast("Undid the last change");
    },
    { label: "Undo", group: "Tasks" }
  );
  useHotkey(
    "Escape",
    () => {
      setSelected(new Set());
      setLast("Cleared the selection");
    },
    { label: "Clear selection", group: "Tasks" }
  );

  return (
    <main>
      <header class="bar">
        <h1>Tasks</h1>
        <output aria-live="polite">{last}</output>
        <HotkeySheet />
      </header>
      <Switches
        dialogKeys={dialogKeys}
        setDialogKeys={setDialogKeys}
        switches={switches}
        setSwitches={setSwitches}
      />
      <QuickAdd add={add} />
      <TaskList tasks={tasks} selected={selected} change={change} say={setLast} />
      {creating && (
        <HotkeyScope>
          <CreateTask
            keys={dialogKeys}
            close={() => setCreating(false)}
            create={(task) => {
              change(
                [...tasks, { ...task, id: Date.now(), done: false }],
                `Created “${task.title}”`
              );
              setCreating(false);
            }}
          />
        </HotkeyScope>
      )}
    </main>
  );
}

// Enter adds, from the field itself. The page's ⌘A and ⌘Z stay out of it: they select and undo
// the field's text.
function QuickAdd(props: { add: (title: string) => void }) {
  const field = useRef<HTMLInputElement>(null);
  useHotkey(
    "Enter",
    () => {
      const title = field.current?.value.trim();
      if (!title || !field.current) return;
      props.add(title);
      field.current.value = "";
    },
    { within: field, label: "Add task", group: "Tasks" }
  );
  return <input ref={field} class="quick-add" aria-label="Add a task" placeholder="Add a task" />;
}

// ↑ and ↓ move, Enter renames and X marks done, only while focus is in the list.
function TaskList(props: {
  tasks: readonly Task[];
  selected: ReadonlySet<number>;
  change: (next: readonly Task[], what: string) => void;
  say: (what: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  const [renaming, setRenaming] = useState<number>();
  const current = props.tasks[Math.min(active, props.tasks.length - 1)];
  const move = (by: number) => {
    setActive(Math.max(0, Math.min(props.tasks.length - 1, active + by)));
    props.say(by < 0 ? "Moved up" : "Moved down");
  };
  useHotkeys([
    {
      hotkey: "ArrowUp",
      run: () => move(-1),
      within: list,
      label: "Previous task",
      group: "Task list"
    },
    {
      hotkey: "ArrowDown",
      run: () => move(1),
      within: list,
      label: "Next task",
      group: "Task list"
    },
    {
      hotkey: "Enter",
      run: () => current && setRenaming(current.id),
      within: list,
      label: "Rename",
      group: "Task list"
    },
    {
      hotkey: "X",
      run: () =>
        current &&
        props.change(
          props.tasks.map((task) => (task === current ? { ...task, done: !task.done } : task)),
          `${current.done ? "Reopened" : "Done:"} “${current.title}”`
        ),
      within: list,
      label: "Mark done",
      group: "Task list"
    }
  ]);
  const back = () => {
    setRenaming(undefined);
    list.current?.focus();
  };
  return (
    <ul ref={list} class="tasks" tabIndex={0} aria-label="Tasks">
      {props.tasks.map((task, index) => (
        <li
          key={task.id}
          class={[
            "task",
            task === current && "active",
            props.selected.has(task.id) && "selected",
            task.done && "done"
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => {
            if (renaming === task.id) return;
            setActive(index);
            list.current?.focus();
          }}
        >
          <span class="check" aria-hidden="true">
            {task.done ? "✓" : ""}
          </span>
          {renaming === task.id ? (
            <TitleEditor
              title={task.title}
              save={(title) => {
                props.change(
                  props.tasks.map((other) => (other === task ? { ...task, title } : other)),
                  `Renamed to “${title}”`
                );
                back();
              }}
              cancel={() => {
                props.say("Cancelled the rename");
                back();
              }}
            />
          ) : (
            <span class="title">{task.title}</span>
          )}
          <span class="meta">
            P{task.priority}
            {task.assignee && ` · ${task.assignee}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Inside the list: its Enter and Escape win over the list's Enter and the page's Escape.
function TitleEditor(props: { title: string; save: (title: string) => void; cancel: () => void }) {
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => field.current?.select(), []);
  useHotkey("Enter", () => props.save(field.current?.value.trim() || props.title), {
    within: field,
    label: "Save title",
    group: "Rename"
  });
  useHotkey("Escape", props.cancel, { within: field, label: "Cancel rename", group: "Rename" });
  return <input ref={field} class="rename" aria-label="Title" defaultValue={props.title} />;
}

function CreateTask(props: {
  keys: DialogKeys;
  close: () => void;
  create: (task: Omit<Task, "id" | "done">) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const fields = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const [priority, setPriority] = useState(3);
  const [person, setPerson] = useState(0);
  const assignee = people[person]!;
  const [due, setDue] = useState("");
  // A patch's page runs in a cross-origin frame, where autofocus is ignored.
  useLayoutEffect(() => title.current?.focus(), []);

  const create = () => {
    const name = title.current?.value.trim();
    if (!name) return title.current?.focus();
    props.create({ title: name, priority, assignee });
  };
  const assign = () => setPerson((person + 1) % people.length);
  const group = "Create task";

  useHotkey("Escape", props.close, { label: "Close", group });
  useHotkey("Mod+Enter", create, { label: "Create", group });
  useHotkey("Enter", create, { label: "Create", group });
  useHotkey("Enter", create, { within: title, label: "Create", group });
  useHotkeys(
    priorities.map((level) => ({
      hotkey: `P ${digits[level - 1]!}` as const,
      run: () => setPriority(level),
      label: `Priority ${level}`,
      group
    }))
  );
  useHotkey("A", assign, { label: "Assign", group });

  // Variant: Escape leaves the text field; the dialog's Escape then closes it.
  useHotkey("Escape", () => panel.current?.focus(), {
    within: fields,
    enabled: props.keys === "escape",
    label: "Leave the field",
    group
  });
  // Variant: chords that never type text, straight from the field.
  useHotkeys([
    ...priorities.map((level) => ({
      hotkey: `Mod+Alt+${digits[level - 1]!}` as const,
      run: () => setPriority(level),
      enabled: props.keys === "chords",
      label: `Priority ${level}`,
      group
    })),
    { hotkey: "Mod+Alt+A", run: assign, enabled: props.keys === "chords", label: "Assign", group }
  ]);

  const hint = {
    escape: "Esc leaves the field, then P 1–5 · A · ↵",
    chords: `${formatHotkey("Mod+Alt+1")}–5 · ${formatHotkey("Mod+Alt+A")}`,
    sheet: `${formatHotkey("Mod+/")} shows this dialog's keys`
  }[props.keys];

  return (
    <div class="scrim">
      <div ref={panel} class="dialog" role="dialog" aria-label="Create task" tabIndex={-1}>
        <div class="dialog-head">
          <h2>Create task</h2>
          <span class="hint">{hint}</span>
        </div>
        <div ref={fields} class="fields">
          <input ref={title} aria-label="Title" placeholder="Title" />
          <textarea aria-label="Description" placeholder="Description" rows={4} />
        </div>
        <div class="props">
          <div class="priority" role="group" aria-label="Priority">
            {priorities.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={priority === level}
                onClick={() => setPriority(level)}
              >
                P{level}
              </button>
            ))}
          </div>
          <button type="button" class="assignee" onClick={assign}>
            {assignee || "Unassigned"}
          </button>
          <DuePicker value={due} pick={setDue} />
        </div>
        <div class="dialog-foot">
          <button type="button" onClick={props.close}>
            Cancel
          </button>
          <button type="button" class="primary" onClick={create}>
            Create <kbd>{formatHotkey("Mod+Enter")}</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

const dues = ["Today", "Tomorrow", "Next week"] as const;

// Stands in for a third-party widget: it handles its own keys with a raw listener, and Escape
// closes its list and calls preventDefault, as such widgets do. Whether the dialog's Escape then
// stands down is the "Handled keys" switch.
function DuePicker(props: { value: string; pick: (value: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [option, setOption] = useState(0);
  const state = useRef({ open, option, pick: props.pick });
  state.current = { open, option, pick: props.pick };
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const { open, option, pick } = state.current;
      if (!open) {
        if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
          event.preventDefault();
          setOpen(true);
        }
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOption((option + (event.key === "ArrowDown" ? 1 : dues.length - 1)) % dues.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        pick(dues[option]!);
        setOpen(false);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <div
      ref={box}
      class="due"
      role="combobox"
      tabIndex={0}
      aria-label="Due"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      {props.value || "No due date"} ▾
      {open && (
        <ul class="due-list" role="listbox">
          {dues.map((due, index) => (
            <li
              key={due}
              role="option"
              aria-selected={index === option}
              onClick={(event) => {
                event.stopPropagation();
                props.pick(due);
                setOpen(false);
              }}
            >
              {due}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Switched = typeof prototypeSwitches;

// The prototype's switches. Each first option is the design; the others are for comparing.
function Switches(props: {
  dialogKeys: DialogKeys;
  setDialogKeys: (keys: DialogKeys) => void;
  switches: Switched;
  setSwitches: (switches: Switched) => void;
}) {
  const set = (patch: Partial<Switched>) => props.setSwitches({ ...props.switches, ...patch });
  return (
    <aside class="switches" aria-label="Prototype switches">
      <Choice
        name="Dialog keys from a field"
        value={props.dialogKeys}
        options={[
          ["sheet", `${formatHotkey("Mod+/")} sheet`],
          ["escape", "Esc steps out"],
          ["chords", "Chords"]
        ]}
        choose={props.setDialogKeys}
      />
      <Choice
        name="Sheet lists"
        value={props.switches.sheetLists}
        options={[
          ["here", "What works here"],
          ["everything", "Everything"]
        ]}
        choose={(sheetLists) => set({ sheetLists })}
      />
      <Choice
        name="Editing keys in a field"
        value={props.switches.editingKeysStayInFields ? "field" : "hotkey"}
        options={[
          ["field", "Stay with the field"],
          ["hotkey", "Hotkeys take them"]
        ]}
        choose={(value) => set({ editingKeysStayInFields: value === "field" })}
      />
      <Choice
        name="Keys a widget handled"
        value={props.switches.standDownWhenHandled ? "stand" : "fire"}
        options={[
          ["stand", "Hotkeys stand down"],
          ["fire", "Hotkeys fire anyway"]
        ]}
        choose={(value) => set({ standDownWhenHandled: value === "stand" })}
      />
    </aside>
  );
}

function Choice<T extends string>(props: {
  name: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  choose: (value: T) => void;
}) {
  return (
    <div class="choice" role="group" aria-label={props.name}>
      <span>{props.name}</span>
      {props.options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={props.value === value}
          onClick={() => props.choose(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
