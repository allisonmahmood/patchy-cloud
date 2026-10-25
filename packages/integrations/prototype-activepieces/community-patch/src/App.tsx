import { useState } from "patchy/preact";
import patchy from "../patchy/_generated/client";
import { action } from "./action";
import "./demo.css";

export function App() {
  const [inputs, setInputs] = useState<Record<string, string>>(action.defaults);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const call = patchy.connections.external[action.name];
      setResult(await call(inputs as Parameters<typeof call>[0]));
    } catch (cause) {
      const failure = cause as { code?: string; message?: string };
      setError(`${failure.code ?? "error"}: ${failure.message ?? "The read failed."}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <p class="badge">LOCAL PROTOTYPE · REAL PROVIDER READ</p>
      <h1>{action.provider} connection reader</h1>
      <p>
        This patch uses Patchy's generated client. Patchy checks the viewer and declared connection,
        then runs the existing community action. Credentials stay on the server.
      </p>
      <section aria-label="Action inputs">
        {action.fields.map((field) => (
          <label key={field.name}>
            {field.displayName}
            <input
              required={field.required}
              value={inputs[field.name] ?? ""}
              onInput={(event) => setInputs({ ...inputs, [field.name]: event.currentTarget.value })}
            />
            <small>{field.description}</small>
          </label>
        ))}
        <button type="button" disabled={busy} onClick={() => void run()}>
          {busy ? "Reading…" : action.displayName}
        </button>
      </section>
      {result !== null && (
        <section role="status">
          <h2>Live result</h2>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </section>
      )}
      {error && (
        <p role="alert" class="error">
          {error}
        </p>
      )}
    </main>
  );
}
