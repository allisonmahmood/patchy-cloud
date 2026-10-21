import { useEffect, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";

export function App() {
  const [items, setItems] = useState<readonly { title: string; owner: string; blocker: string }[]>([]);
  const [status, setStatus] = useState("Loading blocked launch items…");
  useEffect(() => {
    let active = true;
    void patchy.server.queue.blocked({}).then((result) => {
      if (active) { setItems(result.blocked); setStatus(`${result.total} blocked launch items`); }
    }).catch(() => { if (active) setStatus("Could not load Launch Queue. Reload to try again."); });
    return () => { active = false; };
  }, []);
  return <main>
    <h1>Launch Queue</h1>
    <p role="status">{status}</p>
    <ul>{items.map((item, index) => <li key={index}>
      <strong>{item.title}</strong> — {item.owner}: {item.blocker}
    </li>)}</ul>
  </main>;
}
