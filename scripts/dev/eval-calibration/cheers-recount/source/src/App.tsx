import { useEffect, useState, useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";

// The newest page is enough to wake us on every new cheer; the total is counted by paging.
async function countCheers(): Promise<number> {
  let total = 0;
  let cursor: string | null | undefined = undefined;
  do {
    const page: { rows: readonly unknown[]; cursor: string | null } = await patchy.tables.cheers.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    total += page.rows.length;
    cursor = page.cursor;
  } while (cursor);
  return total;
}

export function App() {
  const wake = useQuery(patchy.tables.cheers.list, { limit: 1 });
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [mine, setMine] = useState(0);
  const [burst, setBurst] = useState(0);

  // Recount whenever the subscribed query changes (any viewer's cheer wakes it).
  const marker = wake.data?.rows[0]?.id ?? "none";
  useEffect(() => {
    if (wake.loading && !wake.data) return;
    let active = true;
    countCheers()
      .then((n) => { if (active) setCount(n); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [marker, wake.loading]);

  function cheer() {
    if (sending) return;
    setSending(true);
    setError("");
    void patchy.tables.cheers.insert({})
      .then(() => {
        setMine((n) => n + 1);
        setBurst((n) => n + 1);
        setCount((n) => (n ?? 0) + 1);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSending(false));
  }

  return (
    <main class="cheer">
      <h1>Cheer our launch!</h1>
      <p class="sub">Press the button to cheer. Everyone at the company is counted.</p>
      <div class="total" role="status" aria-live="polite">
        <span class="num" key={count ?? "x"}>{count === null ? "…" : count.toLocaleString()}</span>
        <span class="label">{count === 1 ? "cheer so far" : "cheers so far"}</span>
      </div>
      <div class="stage">
        <button type="button" class="big" disabled={sending} onClick={cheer}>
          <span aria-hidden="true">🎉</span> Cheer!
        </button>
        <span class="pop" key={burst} aria-hidden="true">{burst ? "🎉 +1" : ""}</span>
      </div>
      <p class="mine">{mine > 0 ? `You've cheered ${mine} time${mine === 1 ? "" : "s"} this visit. Thank you!` : "Be the first to cheer today."}</p>
      <p id="error" role="alert">{error}</p>
    </main>
  );
}
