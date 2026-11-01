import { useEffect, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";

export function App() {
  const [row, setRow] = useState<any>(null);

  useEffect(() => {
    patchy.tables.counter.list({ limit: 1 }).then(async (page: any) => {
      if (page.rows.length === 0) setRow(await patchy.tables.counter.insert({ count: 0 }));
      else setRow(page.rows[0]);
    });
  }, []);

  async function cheer() {
    const next = row.count + 1;
    await patchy.tables.counter.update(row.id, { count: next });
    setRow({ ...row, count: next });
  }

  return (
    <div style={{ padding: 40, fontFamily: "Comic Sans MS", color: "#ff00aa", background: "#222" }}>
      <h1>Cheers: {row ? row.count : 0}</h1>
      <button onClick={cheer} style={{ background: "#00ff00", fontSize: 30 }}>CHEER</button>
    </div>
  );
}
