import { useState } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";

// The model roles are called by server/triage.ts, as the person viewing.
const triage = patchy.server.triage;
type Triaged = Awaited<ReturnType<typeof triage.run>>;

/**
 * How a call can end, for the dev instance's fake provider: each marker in a request asks it for
 * that ending instead of an answer. A real provider would read it as text.
 */
const ENDINGS = [
  ["", "An answer"],
  ["[fake:delay=8000]", "A slow answer"],
  ["[fake:hang]", "No answer: cut off before the deadline"],
  ["[fake:rate]", "Rate limited"],
  ["[fake:quota]", "Out of credit"],
  ["[fake:refuse]", "The model refuses"],
  ["[fake:truncate]", "Stopped at maxOutputTokens"],
  ["[fake:mismatch]", "The wrong shape"],
  ["[fake:overloaded]", "The provider is down"],
  ["[fake:huge]", "Too large an answer"],
  ["[fake:invalid]", "An invalid request"]
] as const;

interface Ended {
  readonly code: string;
  readonly message: string;
  readonly limitId?: string;
  readonly retryAfter?: number;
  readonly sent: string;
}
const ended = (error: unknown): Ended => {
  if (!isPatchyError(error))
    return {
      code: "error",
      message: error instanceof Error ? error.message : String(error),
      sent: "unknown"
    };
  // A model call's refusal says whether a request went out; one whose reply was lost doesn't.
  const sent = "sent" in error.details ? error.details.sent : undefined;
  return {
    code: error.code,
    message: error.message,
    ...(error.limitId === undefined ? {} : { limitId: error.limitId }),
    ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
    sent:
      sent === true
        ? "sent, may be charged"
        : sent === false
          ? "nothing sent"
          : "unknown: the reply was lost"
  };
};
const percent = (probability: number) => `${Math.round(probability * 100)}%`;

export function App() {
  const [request, setRequest] = useState(
    "Hi, I was charged twice for my plan this month. Please refund the extra charge today."
  );
  const [ending, setEnding] = useState("");
  const [answer, setAnswer] = useState<Triaged | null>(null);
  const [failure, setFailure] = useState<Ended | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setAnswer(null);
    setFailure(null);
    try {
      setAnswer(await triage.run({ request: `${request} ${ending}`.trim() }));
    } catch (caught) {
      setFailure(ended(caught));
    } finally {
      setRunning(false);
    }
  };

  return (
    <main class="triage">
      <h1>Request triage</h1>
      <textarea
        rows={5}
        value={request}
        onInput={(event) => setRequest(event.currentTarget.value)}
      />
      <div class="bar">
        <select value={ending} onChange={(event) => setEnding(event.currentTarget.value)}>
          {ENDINGS.map(([marker, label]) => (
            <option value={marker}>{label}</option>
          ))}
        </select>
        <button disabled={running || request.trim() === ""} onClick={() => void run()}>
          {running ? "Asking…" : "Triage"}
        </button>
      </div>
      {answer !== null && (
        <dl class="answer">
          <dt>Team</dt>
          <dd>
            {answer.team === null
              ? "Refused"
              : `${answer.team.choice} (${percent(answer.team.probability)})`}
          </dd>
          <dt>Urgency</dt>
          <dd>
            {answer.urgency === null
              ? "Refused"
              : `${answer.urgency.level} (score ${answer.urgency.score.toFixed(2)})`}
          </dd>
          <dt>Spam</dt>
          <dd>{answer.spam === null ? "Refused" : percent(answer.spam)}</dd>
          <dt>About</dt>
          <dd>{answer.summary}</dd>
          <dt>Reply plan</dt>
          <dd>
            {answer.plan.team}: {answer.plan.reply}
            {answer.plan.followUp ? " · follow up" : ""}
          </dd>
        </dl>
      )}
      {failure !== null && (
        <dl class="failure">
          <dt>Code</dt>
          <dd>
            <code>{failure.code}</code>
          </dd>
          {failure.limitId !== undefined && (
            <>
              <dt>Limit</dt>
              <dd>
                <code>{failure.limitId}</code>
              </dd>
            </>
          )}
          {failure.retryAfter !== undefined && (
            <>
              <dt>Retry after</dt>
              <dd>{failure.retryAfter} s</dd>
            </>
          )}
          <dt>Request</dt>
          <dd>{failure.sent}</dd>
          <dt>Said</dt>
          <dd>{failure.message}</dd>
        </dl>
      )}
    </main>
  );
}
