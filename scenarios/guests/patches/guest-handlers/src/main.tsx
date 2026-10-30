import { render, useState, useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";

function App() {
  const notes = useQuery(patchy.server.notes.list, {});
  const [text, setText] = useState("");
  const [result, setResult] = useState("");
  return (
    <main>
      <h1>Guest handlers</h1>
      <p>Guest-marked reads and writes keep the visitor's real identity.</p>
      <ul>
        {(notes.data ?? []).map((note) => (
          <li key={note.id}>
            {note.text} — {note.author}
          </li>
        ))}
      </ul>
      <input
        aria-label="Note"
        value={text}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <button
        onClick={() =>
          void patchy.server.notes.add({ text }).then(
            () => setText(""),
            (error) => setResult(String(error))
          )
        }
      >
        Add note
      </button>
      <button
        onClick={() =>
          void patchy.server.notes.who({}).then((who) => setResult(`${who.id}: guest ${who.guest}`))
        }
      >
        Who am I?
      </button>
      <button
        onClick={() =>
          void patchy.server.notes.privateCount({}).then(
            (count) => setResult(`Private count: ${count}`),
            (error) => setResult(`Refused: ${String(error)}`)
          )
        }
      >
        Try private handler
      </button>
      <output>{result}</output>
    </main>
  );
}

render(<App />, document.getElementById("root")!);
