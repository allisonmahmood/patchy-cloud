import { useState } from "patchy/preact";
import patchy from "../patchy/_generated/client";
import "./demo.css";

export function App() {
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(refuse = false) {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await patchy.connections.analytics.query({
        name: "activepieces-local-demo",
        query: "SELECT project_id, company, events FROM prototype_usage LIMIT 1",
        shape: {
          project_id: { kind: "integer" },
          company: { kind: "text" },
          events: { kind: "integer" }
        },
        ...(refuse ? { values: { unsupported: true } } : {})
      });
      setResult(response.rows);
    } catch (cause) {
      const failure = cause as { code?: string; message?: string };
      setError(`${failure.code ?? "error"}: ${failure.message ?? "The call failed."}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <p class="badge">SIMULATED PROVIDER · LOCAL ONLY</p>
      <h1>Try the Activepieces action</h1>
      <p>
        This patch calls the existing community PostHog action. Patchy selects this company's
        encrypted connection. No real PostHog account is contacted.
      </p>
      <div class="actions">
        <button disabled={busy} onClick={() => void run()}>
          {busy ? "Running…" : "Run action"}
        </button>
        <button class="secondary" disabled={busy} onClick={() => void run(true)}>
          Try unsupported input
        </button>
      </div>
      {result !== null && (
        <section role="status">
          <h2>Company result</h2>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </section>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <aside>
        <h2>What to try</h2>
        <ol>
          <li>
            Run the action: Customer A returns project 101 and 12 events; Customer B returns project
            202 and 34 events.
          </li>
          <li>Try unsupported input: the adapter refuses it before the provider call.</li>
          <li>
            In another tab, open the local Patchy home page, choose Connections, then analytics, and
            inspect recent calls. Disconnect it, then return here and run again. Reconnect to
            restore access.
          </li>
          <li>
            While signed in to one company, open the other company's patch address. Patchy must
            refuse access.
          </li>
        </ol>
      </aside>
    </main>
  );
}
