import { useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";

/** Attio's standard deal stages, in pipeline order. */
const STAGES = ["Lead", "In Progress", "Won 🎉", "Lost"] as const;

type Review = Awaited<ReturnType<typeof patchy.server.review.summary>>;

const usd = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
      }).format(value);

export function App() {
  const [stage, setStage] = useState<string>("In Progress");
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReview(await patchy.server.review.summary({ stage }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="review">
      <header class="bar">
        <h1>Pipeline review</h1>
        <select value={stage} onChange={(event) => setStage(event.currentTarget.value)}>
          {STAGES.map((title) => (
            <option value={title}>{title}</option>
          ))}
        </select>
        <button disabled={busy} onClick={() => void run()}>
          {busy ? "Reading Attio…" : "Review"}
        </button>
      </header>
      {error !== null && <p class="error">{error}</p>}
      {review !== null && (
        <>
          <p class="total">
            {review.deals} deals in {review.stage}, worth {usd(review.value)}
          </p>
          <div class="columns">
            <section>
              <h2>By owner</h2>
              <table>
                <tbody>
                  {review.owners.map((owner) => (
                    <tr key={owner.name}>
                      <td>{owner.name}</td>
                      <td class="num">{owner.deals}</td>
                      <td class="num">{usd(owner.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section>
              <h2>Largest</h2>
              <table>
                <tbody>
                  {review.top.map((deal, index) => (
                    <tr key={index}>
                      <td>{deal.name ?? "Untitled"}</td>
                      <td class="muted">{deal.company ?? "—"}</td>
                      <td class="num">{usd(deal.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
