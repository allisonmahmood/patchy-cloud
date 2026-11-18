import { useQuery, useState } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";

type Triaged = Awaited<ReturnType<typeof patchy.server.triage.run>>;
type Mode = Parameters<typeof patchy.server.triage.failure>[0]["mode"];

const MODES: ReadonlyArray<readonly [Mode, string]> = [
  ["thinker", "Slow model (about 20 s)"],
  ["stuck", "Never answers (action cut-off)"],
  ["limited", "Rate limited (429, retry-after)"],
  ["refuser", "Model refuses to write"],
  ["picky", "Refuses one decision question"],
  ["sloppy", "Typed output doesn't match"],
  ["rambler", "Output truncated at the cap"],
  ["bouncer", "Provider answers a redirect"],
  ["offline", "Provider unreachable"],
  ["wrongKind", "decide on a text role"],
  ["badOutput", "Unsupported output shape"]
];

/** Everything the page received: a Patchy refusal's fields as they arrived, or the result. */
const received = (value: unknown, ms: number): string => {
  if (isPatchyError(value))
    return JSON.stringify(
      {
        receivedAfterMs: ms,
        code: value.code,
        message: value.message,
        details: value.details,
        retryAfter: value.retryAfter,
        limitId: value.limitId,
        scope: value.scope,
        value: value.value,
        operation: value.operation
      },
      null,
      2
    );
  if (value instanceof Error)
    return JSON.stringify(
      { receivedAfterMs: ms, error: value.name, message: value.message },
      null,
      2
    );
  return JSON.stringify({ receivedAfterMs: ms, result: value }, null, 2);
};

export function App() {
  const recent = useQuery(patchy.server.triage.recent, {});
  const [subject, setSubject] = useState("Laptop won't boot");
  const [body, setBody] = useState(
    "My laptop shows a black screen since this morning and I'm blocked. I need it working today."
  );
  const [result, setResult] = useState<Triaged | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ mode: Mode; text: string } | null>(null);

  const triage = async () => {
    setBusy("triage");
    setError(null);
    const started = performance.now();
    try {
      setResult(await patchy.server.triage.run({ subject, body }));
    } catch (caught) {
      setError(received(caught, Math.round(performance.now() - started)));
    } finally {
      setBusy(null);
    }
  };

  const fail = async (mode: Mode) => {
    setBusy(mode);
    setOutcome(null);
    const started = performance.now();
    let text: string;
    try {
      text = received(
        await patchy.server.triage.failure({ mode }),
        Math.round(performance.now() - started)
      );
    } catch (caught) {
      text = received(caught, Math.round(performance.now() - started));
    }
    setOutcome({ mode, text });
    setBusy(null);
  };

  return (
    <main class="page">
      <h1>Request triage</h1>
      <section class="card">
        <label>
          Subject
          <input value={subject} onInput={(event) => setSubject(event.currentTarget.value)} />
        </label>
        <label>
          Request
          <textarea rows={4} value={body} onInput={(event) => setBody(event.currentTarget.value)} />
        </label>
        <button disabled={busy !== null} onClick={() => void triage()}>
          {busy === "triage" ? "Triaging…" : "Triage"}
        </button>
        {error !== null && <pre class="error">{error}</pre>}
        {result !== null && (
          <dl class="result">
            <dt>Team</dt>
            <dd>{result.team}</dd>
            <dt>Urgency</dt>
            <dd>
              {result.urgency} (score {result.urgencyScore.toFixed(2)})
            </dd>
            <dt>Spam</dt>
            <dd>{Math.round(result.spam * 100)}%</dd>
            <dt>Reply draft</dt>
            <dd class="reply">{result.reply}</dd>
            <dt>Tokens</dt>
            <dd>
              decide in {result.usage.decideTokens ?? "?"}, generate out{" "}
              {result.usage.generateTokens ?? "?"}
            </dd>
          </dl>
        )}
      </section>
      <section class="card">
        <h2>Failure modes</h2>
        <div class="modes">
          {MODES.map(([mode, label]) => (
            <button key={mode} disabled={busy !== null} onClick={() => void fail(mode)}>
              {busy === mode ? "Waiting…" : label}
            </button>
          ))}
        </div>
        {outcome !== null && (
          <>
            <h3>{outcome.mode}: what the page received</h3>
            <pre class="received">{outcome.text}</pre>
          </>
        )}
      </section>
      <section class="card">
        <h2>Recent</h2>
        <table>
          <tbody>
            {(recent.data ?? []).map((row) => (
              <tr key={row.id}>
                <td>{row.subject}</td>
                <td>{row.team}</td>
                <td>{row.urgency}</td>
                <td>{Math.round(row.spam * 100)}%</td>
                <td class="muted">{row.by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
