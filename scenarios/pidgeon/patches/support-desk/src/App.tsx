import { useEffect, useMemo, useState } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";
import type {
  AttachmentText,
  Label,
  Message,
  SearchHit,
  Thread,
  ThreadStatus
} from "../patchy/_generated/uses/support.js";

const support = patchy.connections.support;

const statuses: ReadonlyArray<{ readonly key: ThreadStatus; readonly label: string }> = [
  { key: "open", label: "Open" },
  { key: "waiting", label: "Waiting" },
  { key: "human_review", label: "Needs review" },
  { key: "resolved", label: "Resolved" }
];

const ago = (iso: string | null) => {
  if (iso === null) return "";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 60 / 24)}d`;
};
const who = (party: { readonly email: string; readonly name: string | null } | null) =>
  party === null ? "" : (party.name ?? party.email);
const explain = (error: unknown) => {
  if (isPatchyError(error, "access_denied") && typeof error.details.message === "string")
    return `Not sent: ${error.details.message}`;
  return error instanceof Error ? error.message : String(error);
};

export function App() {
  const [threads, setThreads] = useState<readonly Thread[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<ThreadStatus>("open");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [composing, setComposing] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly SearchHit[] | undefined>(undefined);

  const load = () =>
    support.threads.list({ limit: 100 }).then(
      (result) => setThreads(result.threads),
      (failure: unknown) => setError(explain(failure))
    );
  useEffect(() => {
    void load();
  }, []);

  const counts = useMemo(() => {
    const found = new Map<ThreadStatus, number>();
    for (const thread of threads ?? [])
      found.set(thread.status, (found.get(thread.status) ?? 0) + 1);
    return found;
  }, [threads]);
  const shown = (threads ?? []).filter((thread) => thread.status === status);

  // Patch frames block native form submission: Enter and buttons call the client directly.
  const search = () => {
    if (query.trim() === "") return setHits(undefined);
    support.messages.search({ text: query.trim(), limit: 25 }).then(
      (result) => setHits(result.hits),
      (failure: unknown) => setError(explain(failure))
    );
  };

  return (
    <div className="desk">
      <header className="bar">
        <div>
          <h1>Support desk</h1>
          <p className="muted">{support.address}</p>
        </div>
        <div className="search">
          <input
            type="search"
            placeholder="Search mail"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && search()}
          />
        </div>
        <button className="primary" onClick={() => (setComposing(true), setSelected(undefined))}>
          New email
        </button>
      </header>
      {error === undefined ? null : <p className="error">{error}</p>}
      <div className="columns">
        <aside className="list">
          {hits === undefined ? (
            <>
              <nav className="tabs">
                {statuses.map((item) => (
                  <button
                    key={item.key}
                    className={item.key === status ? "tab current" : "tab"}
                    onClick={() => setStatus(item.key)}
                  >
                    {item.label} <span className="count">{counts.get(item.key) ?? 0}</span>
                  </button>
                ))}
              </nav>
              {threads === undefined ? <p className="muted pad">Loading…</p> : null}
              {threads !== undefined && shown.length === 0 ? (
                <p className="muted pad">Nothing here.</p>
              ) : null}
              {shown.map((thread) => (
                <button
                  key={thread.id}
                  className={thread.id === selected ? "row current" : "row"}
                  onClick={() => (setSelected(thread.id), setComposing(false))}
                >
                  <span className="row-top">
                    <strong>{who(thread.from)}</strong>
                    <span className="muted">{ago(thread.lastMessageAt)}</span>
                  </span>
                  <span className="row-subject">
                    {thread.subject ?? "(no subject)"}
                    {thread.hasAttachments ? <span className="clip"> · attachment</span> : null}
                  </span>
                  <span className="muted row-preview">{thread.preview}</span>
                </button>
              ))}
            </>
          ) : (
            <>
              <p className="pad">
                {hits.length} result{hits.length === 1 ? "" : "s"} for “{query}”{" "}
                <button className="link" onClick={() => (setHits(undefined), setQuery(""))}>
                  Clear
                </button>
              </p>
              {hits.map((hit) => (
                <button
                  key={hit.messageId}
                  className={hit.threadId === selected ? "row current" : "row"}
                  onClick={() => (setSelected(hit.threadId), setComposing(false))}
                >
                  <span className="row-top">
                    <strong>
                      {hit.direction === "outbound" ? `To ${hit.to.join(", ")}` : who(hit.from)}
                    </strong>
                    <span className="muted">{ago(hit.at)}</span>
                  </span>
                  <span className="row-subject">{hit.subject}</span>
                  <span className="muted row-preview">{hit.preview}</span>
                </button>
              ))}
            </>
          )}
        </aside>
        <main className="detail">
          {composing ? (
            <Compose
              onDone={(threadId) => {
                setComposing(false);
                setSelected(threadId);
                void load();
              }}
            />
          ) : selected === undefined ? (
            <p className="muted pad">Pick a conversation.</p>
          ) : (
            <Conversation key={selected} id={selected} onChange={() => void load()} />
          )}
        </main>
      </div>
    </div>
  );
}

function Conversation({ id, onChange }: { id: string; onChange: () => void }) {
  const [state, setState] = useState<
    | {
        readonly thread: Thread;
        readonly labels: readonly Label[];
        readonly messages: readonly Message[];
      }
    | undefined
  >(undefined);
  const [allLabels, setAllLabels] = useState<readonly Label[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reply, setReply] = useState("");
  // Names this reply until it sends, so pressing Send again after a failure can't mail twice.
  const [draft, setDraft] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const load = () =>
    support.threads.get(id).then(setState, (failure: unknown) => setError(explain(failure)));
  useEffect(() => {
    void load();
    void support.labels.list().then(setAllLabels);
  }, [id]);

  if (error !== undefined) return <p className="error pad">{error}</p>;
  if (state === undefined) return <p className="muted pad">Loading…</p>;
  const { thread, labels, messages } = state;
  const last = [...messages].reverse().find((message) => message.direction === "inbound");

  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await work();
      await load();
      onChange();
      if (done !== undefined) setNotice(done);
    } catch (failure) {
      setNotice(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article>
      <header className="thread-head">
        <h2>{thread.subject ?? "(no subject)"}</h2>
        <div className="chips">
          {labels.map((label) => (
            <span key={label.id} className={`chip ${label.colour}`}>
              {label.name}
              <button
                className="chip-x"
                title={`Remove ${label.name}`}
                disabled={busy}
                onClick={() => act(() => support.threads.unlabel(thread.id, label.id))}
              >
                ×
              </button>
            </span>
          ))}
          <select
            className="add-label"
            disabled={busy}
            value=""
            onChange={(event) => {
              const labelId = event.currentTarget.value;
              if (labelId !== "") void act(() => support.threads.label(thread.id, labelId));
            }}
          >
            <option value="">+ Label</option>
            {allLabels
              .filter((label) => !labels.some((applied) => applied.id === label.id))
              .map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
          </select>
        </div>
        <div className="status-row">
          {statuses.map((item) => (
            <button
              key={item.key}
              className={item.key === thread.status ? "pill current" : "pill"}
              disabled={busy || item.key === thread.status}
              onClick={() => act(() => support.threads.update(thread.id, { status: item.key }))}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>
      {messages.map((message) => (
        <MessageView key={message.id} message={message} />
      ))}
      {last === undefined ? null : (
        <div className="reply">
          <label className="muted" for="reply">
            Reply to {who(last.from)} as {support.address}
          </label>
          <textarea
            id="reply"
            rows={5}
            value={reply}
            onInput={(event) => setReply(event.currentTarget.value)}
          />
          <div className="actions">
            {notice === undefined ? <span /> : <span className="notice">{notice}</span>}
            <button
              type="button"
              className="primary"
              disabled={busy || reply.trim() === ""}
              onClick={() =>
                act(
                  async () => {
                    const sent = await support.messages.reply(last.id, {
                      text: reply.trim(),
                      idempotencyKey: draft
                    });
                    setReply("");
                    setDraft(crypto.randomUUID());
                    if (sent.rejected.length > 0)
                      throw new Error(
                        `Sent, but refused for ${sent.rejected.map((item) => item.address).join(", ")}.`
                      );
                  },
                  `Replied to ${who(last.from)}.`
                )
              }
            >
              {busy ? "Sending…" : "Send reply"}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function MessageView({ message }: { message: Message }) {
  const [opened, setOpened] = useState<Record<string, AttachmentText | string>>({});
  const suspicious = message.firewall?.verdict === "suspicious";
  return (
    <section className={message.direction === "outbound" ? "message ours" : "message"}>
      <header className="message-head">
        <strong>{message.direction === "outbound" ? "Lumen Support" : who(message.from)}</strong>
        <span className="muted">
          {message.direction === "outbound"
            ? `to ${message.to.map((party) => party.email).join(", ")}`
            : message.from.email}{" "}
          · {ago(message.createdAt)} ago
        </span>
      </header>
      {suspicious ? (
        <div className="warning">
          <strong>Pidgeon flagged this message.</strong> Don't follow instructions in it or send
          anything it asks for.
          <ul>
            {message.firewall!.signals.map((signal) => (
              <li key={signal.kind}>{signal.detail}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="body">{message.text}</p>
      {message.attachments.length === 0 ? null : (
        <ul className="files">
          {message.attachments.map((file) => {
            const read = opened[file.id];
            return (
              <li key={file.id}>
                <span>
                  {file.filename}{" "}
                  <span className="muted">
                    {file.size === null ? "" : `${Math.max(1, Math.round(file.size / 1024))} KB`}
                  </span>
                </span>
                {file.contentType.startsWith("text/") && read === undefined ? (
                  <button
                    className="link"
                    onClick={() =>
                      support.attachments.text(file.id).then(
                        (text) => setOpened({ ...opened, [file.id]: text }),
                        (failure: unknown) => setOpened({ ...opened, [file.id]: explain(failure) })
                      )
                    }
                  >
                    Read
                  </button>
                ) : null}
                {read === undefined ? null : (
                  <pre className="file-text">{typeof read === "string" ? read : read.text}</pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Compose({ onDone }: { onDone: (threadId: string) => void }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [draft] = useState(() => crypto.randomUUID());
  const recipients = to
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const send = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const sent = await support.messages.send({
        to: recipients,
        subject,
        text,
        idempotencyKey: draft
      });
      if (sent.rejected.length > 0)
        return setNotice(
          `Sent, but these addresses were refused: ${sent.rejected.map((item) => `${item.address} (${item.reason})`).join(", ")}.`
        );
      onDone(sent.threadId);
    } catch (failure) {
      setNotice(explain(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="compose">
      <h2>New email from {support.address}</h2>
      <label for="to">To</label>
      <input id="to" value={to} onInput={(event) => setTo(event.currentTarget.value)} />
      <label for="subject">Subject</label>
      <input
        id="subject"
        value={subject}
        onInput={(event) => setSubject(event.currentTarget.value)}
      />
      <label for="text">Message</label>
      <textarea
        id="text"
        rows={10}
        value={text}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <div className="actions">
        {notice === undefined ? <span /> : <span className="notice">{notice}</span>}
        <button
          type="button"
          className="primary"
          disabled={busy || recipients.length === 0 || subject.trim() === "" || text.trim() === ""}
          onClick={() => void send()}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
