import { useState, useQuery } from "patchy/preact";
import { patchy, isPatchyError } from "../patchy/_generated/client.js";

export function App() {
  const total = useQuery(patchy.server.cheers.total, {});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState<null | (() => Promise<unknown>)>(null);

  async function send(action: () => Promise<unknown>) {
    setPending(true);
    setMessage("");
    try {
      await action();
      setRetry(null);
      setMessage("Your cheer is in. Thank you!");
    } catch (error) {
      if (isPatchyError(error, "unknown_outcome") && error.retry) {
        setRetry(() => error.retry!);
        setMessage("We couldn't confirm your cheer. Check its result before sending another.");
      } else {
        setRetry(null);
        setMessage("Couldn't add your cheer. Please try again in a moment.");
      }
    } finally {
      setPending(false);
    }
  }

  return <main>
    <header class="page-header">
      <span class="eyebrow">A moment for the team</span>
      <h1>Let's cheer the launch.</h1>
      <p>We made it here together. Add your cheer to the celebration.</p>
    </header>
    <section class="panel" aria-label="Launch cheers">
      <div class="stat">
        <span class="stat-label">Cheers from the team</span>
        <strong class="stat-value" aria-live="polite">{total.data === undefined ? "—" : total.data.toLocaleString()}</strong>
        <span class="stat-caption">{total.data === 1 ? "cheer and counting" : "cheers and counting"}</span>
      </div>
      <div class="action-area">
        <button class="button cheer-button" type="button" disabled={pending || !!retry} onClick={() => send(() => patchy.server.cheers.cheer({}))}>{pending ? "Adding your cheer…" : "Cheer the launch"}</button>
        <p class="hint">Every press adds one cheer. Cheer as often as you like.</p>
        {retry && <button class="button button-secondary" type="button" disabled={pending} onClick={() => send(retry)}>Check my cheer</button>}
        {message && <p class="feedback" role="status">{message}</p>}
        {total.error && <p class="error" role="alert">Couldn't refresh the total. Please reload the page if this continues.</p>}
      </div>
    </section>
    <p class="footer">One launch. A whole team behind it.</p>
  </main>;
}
