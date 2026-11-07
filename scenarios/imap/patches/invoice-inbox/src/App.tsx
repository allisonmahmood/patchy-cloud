import { useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";

type Overview = Awaited<ReturnType<typeof patchy.server.desk.overview>>;
type Search = Awaited<ReturnType<typeof patchy.server.desk.search>>;
type Saved = Awaited<ReturnType<typeof patchy.server.saved.savedFiles>>;

const day = (iso: string | null) => (iso === null ? "—" : iso.slice(0, 10));

export function App() {
  const [since, setSince] = useState("2026-10-25");
  const [text, setText] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [found, setFound] = useState<Search | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="review">
      <header class="bar">
        <h1>Invoice inbox</h1>
        <input type="date" value={since} onInput={(event) => setSince(event.currentTarget.value)} />
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => setOverview(await patchy.server.desk.overview({ since })))
          }
        >
          {busy ? "Reading…" : "Read INBOX"}
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await patchy.server.importer.importFolder({ folder: "INBOX", since });
              setSaved(await patchy.server.saved.savedFiles({}));
            })
          }
        >
          Save attachments
        </button>
      </header>
      {error !== null && <p class="error">{error}</p>}
      {overview !== null && (
        <section>
          <p class="muted">Folders: {overview.folders.join(", ")}</p>
          <table>
            <tbody>
              {overview.messages.map((message) => (
                <tr key={message.uid}>
                  <td>{day(message.received)}</td>
                  <td>{message.from ?? "—"}</td>
                  <td>{message.subject ?? "(no subject)"}</td>
                  <td class="muted">{message.attachments ? "attachment" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {saved !== null && (
        <section>
          <p class="muted">{saved.length} attachments saved</p>
          <table>
            <tbody>
              {saved.map((file) => (
                <tr key={file.file ?? file.filename ?? ""}>
                  <td>{file.filename ?? "(unnamed)"}</td>
                  <td>{file.size} bytes</td>
                  <td class="muted">
                    {file.stored === null
                      ? "kept by name and size"
                      : file.stored === file.staged
                        ? `sha256 ${file.stored.slice(0, 12)}…`
                        : "stored bytes differ"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <section class="bar">
        <input
          value={text}
          placeholder="Search"
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <button
          disabled={busy || text === ""}
          onClick={() => void run(async () => setFound(await patchy.server.desk.search({ text })))}
        >
          Search
        </button>
      </section>
      {found !== null && (
        <section>
          <p class="muted">{found.matches.length} found</p>
          {found.first !== null && (
            <article>
              <h2>{found.first.subject ?? "(no subject)"}</h2>
              <pre>{found.first.text}</pre>
              <p class="muted">{found.first.parts.join(", ")}</p>
            </article>
          )}
        </section>
      )}
    </main>
  );
}
