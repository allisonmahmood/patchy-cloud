import { useState, useQuery } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";

export function App() {
  const notes = useQuery(patchy.server.notes.list, {});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function run(change: () => Promise<unknown>) {
    setSaving(true);
    setError("");
    void change()
      .catch((cause: unknown) =>
        setError(
          isPatchyError(cause, "access_denied")
            ? "Only Harbor Works can clear the log."
            : cause instanceof Error
              ? cause.message
              : String(cause)
        )
      )
      .finally(() => setSaving(false));
  }

  function log(form: HTMLFormElement) {
    if (saving || !form.reportValidity()) return;
    const title = String(new FormData(form).get("title") ?? "").trim();
    if (title) run(() => patchy.server.notes.create({ title }).then(() => form.reset()));
  }

  // The sandbox blocks native form submission; save through the broker instead.
  return (
    <main>
      <h1>Visit log</h1>
      <form
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            log(event.currentTarget);
          }
        }}
      >
        <label>
          Visit <input name="title" required disabled={saving} />
        </label>
        <button type="button" disabled={saving} onClick={(event) => log(event.currentTarget.form!)}>
          Log visit
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => run(() => patchy.server.notes.clear({}))}
        >
          Clear log
        </button>
      </form>
      <p role="alert">{error}</p>
      <ul>
        {(notes.data ?? []).map((note) => (
          <li key={note.id}>
            {note.title} · {note.by}
          </li>
        ))}
      </ul>
    </main>
  );
}
