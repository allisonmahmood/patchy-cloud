import { useEffect, useMemo, useRef, useState } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";
import {
  address,
  type AttachmentText,
  type Label,
  type Message,
  type SearchHit,
  type Sent,
  type Thread,
  type ThreadStatus
} from "../patchy/_generated/uses/support.js";

const support = patchy.connections.support;

const statuses: ReadonlyArray<{ readonly key: ThreadStatus; readonly label: string }> = [
  { key: "open", label: "Open" },
  { key: "waiting", label: "Waiting" },
  { key: "human_review", label: "Needs review" },
  { key: "resolved", label: "Resolved" }
];
const kinds: Readonly<Record<string, string>> = {
  hidden_text: "hidden text",
  invisible_characters: "invisible characters",
  assistant_directive: "instructions aimed at an AI",
  role_spoof: "lines posing as a chat",
  quoted_directive: "instructions in quoted mail",
  lookalike_sender: "a look-alike sender",
  display_name_spoof: "an imitated sender name",
  unauthenticated_with_directive: "an unverified sender giving instructions",
  exfiltration_request: "a request to send data out"
};

const ago = (iso: string | null) => {
  if (iso === null) return "";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 60 / 24)}d`;
};
const who = (party: { readonly email: string; readonly name: string | null } | null) =>
  party === null ? "" : (party.name ?? party.email);
const ours = (email: string) => email.toLowerCase() === address.toLowerCase();
const explain = (error: unknown) => {
  if (isPatchyError(error, "idempotency_conflict", "pidgeon"))
    return error.details.reason === "in_progress"
      ? `Still sending. Press Send again${error.retryAfter === undefined ? "" : ` in ${error.retryAfter}s`} to see how it went.`
      : "This draft already went out with different text. Start a new email to send this one.";
  if (isPatchyError(error, "access_denied", "pidgeon") && error.details.message !== undefined)
    return `Not sent: ${error.details.message}`;
  if (isPatchyError(error, "source_rate_limited", "pidgeon") && error.details.limit === "budget")
    return "Today's sends from this address are used up. Nothing was sent.";
  return error instanceof Error ? error.message : String(error);
};
/** What to tell the person once Pidgeon answered a send; held sends went nowhere yet. */
const outcome = (sent: Sent, to: string) => {
  if (sent.status === "pending_approval")
    return `Waiting for approval in Pidgeon until ${new Date(sent.approval.expiresAt).toLocaleString()}. Nothing has gone to ${to} yet.`;
  const refused = sent.rejected.map((item) => item.address);
  return refused.length === 0 ? `Sent to ${to}.` : `Sent, but ${refused.join(", ")} refused it.`;
};

export function App() {
  const [threads, setThreads] = useState<readonly Thread[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<ThreadStatus>("open");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  // An email being written: each new one is its own Compose, with its own draft key.
  const [compose, setCompose] = useState<Draft | undefined>(undefined);
  // The email on screen now, so a late answer closes only the one that sent it.
  const current = useRef<number | undefined>(undefined);
  current.current = compose?.key;
  // A send in flight, a new email's or a reply's, keeps what's on screen, and so its draft key,
  // until Pidgeon answers: everything that would replace it waits.
  const [sending, setSending] = useState(false);
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
          <p className="muted">{address}</p>
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
        <button
          className="primary"
          disabled={sending}
          onClick={() => (setCompose({ key: Date.now() }), setSelected(undefined))}
        >
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
                  disabled={sending}
                  onClick={() => (setSelected(thread.id), setCompose(undefined))}
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
                  disabled={sending}
                  onClick={() => (setSelected(hit.threadId), setCompose(undefined))}
                >
                  <span className="row-top">
                    <strong>
                      {ours(hit.from.email) ? `To ${hit.to.join(", ")}` : who(hit.from)}
                    </strong>
                    <span className="muted">{ago(hit.createdAt)}</span>
                  </span>
                  <span className="row-subject">
                    {hit.held ? "Held for review" : (hit.subject ?? "(no subject)")}
                  </span>
                  <span className="muted row-preview">{hit.preview}</span>
                </button>
              ))}
            </>
          )}
        </aside>
        <main className="detail">
          {compose !== undefined ? (
            <Compose
              key={compose.key}
              start={compose}
              onSending={setSending}
              onDone={(key, threadId) => {
                if (current.current !== key) return;
                setCompose(undefined);
                setSelected(threadId);
                void load();
              }}
              onNew={(start) => setCompose({ key: Date.now(), ...start })}
            />
          ) : selected === undefined ? (
            <p className="muted pad">Pick a conversation.</p>
          ) : (
            <Conversation
              key={selected}
              id={selected}
              onSending={setSending}
              onChange={() => void load()}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/** A conversation's every message, page by page. */
const readThread = async (id: string) => {
  const first = await support.threads.get(id);
  const messages = [...first.messages];
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const next = await support.threads.get(id, { cursor });
    messages.push(...next.messages);
    cursor = next.nextCursor;
  }
  return { thread: first.thread, labels: first.labels, messages };
};

function Conversation({
  id,
  onSending,
  onChange
}: {
  id: string;
  onSending: (sending: boolean) => void;
  onChange: () => void;
}) {
  const [state, setState] = useState<Awaited<ReturnType<typeof readThread>> | undefined>(undefined);
  const [allLabels, setAllLabels] = useState<readonly Label[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reply, setReply] = useState("");
  // Names this reply until Pidgeon answers it, so Send again after a failure can't mail twice.
  const [draft, setDraft] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const load = () =>
    readThread(id).then(setState, (failure: unknown) => setError(explain(failure)));
  useEffect(() => {
    void load();
    void support.labels.list().then(setAllLabels);
  }, [id]);

  if (error !== undefined) return <p className="error pad">{error}</p>;
  if (state === undefined) return <p className="muted pad">Loading…</p>;
  const { thread, labels, messages } = state;
  const last = [...messages]
    .reverse()
    .find((message) => !ours(message.from.email) && !message.held);

  /** Runs one change; a reply `sends`, so nothing replaces this conversation until it answers. */
  const act = async (work: () => Promise<string | undefined>, sends = false) => {
    setBusy(true);
    if (sends) onSending(true);
    setNotice(undefined);
    try {
      const done = await work();
      await load();
      onChange();
      setNotice(done);
    } catch (failure) {
      setNotice(explain(failure));
    } finally {
      setBusy(false);
      if (sends) onSending(false);
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
                onClick={() =>
                  act(async () => void (await support.threads.unlabel(thread.id, label.id)))
                }
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
              if (labelId !== "")
                void act(async () => void (await support.threads.label(thread.id, labelId)));
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
              onClick={() =>
                act(
                  async () => void (await support.threads.update(thread.id, { status: item.key }))
                )
              }
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
            Reply to {who(last.from)} as {address}
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
                act(async () => {
                  const sent = await support.messages.reply(last.id, {
                    text: reply.trim(),
                    idempotencyKey: draft
                  });
                  // Pidgeon answered: this draft is used, held or sent, and the next one is new.
                  setReply("");
                  setDraft(crypto.randomUUID());
                  return outcome(sent, who(last.from));
                }, true)
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
  const mine = ours(message.from.email);
  return (
    <section className={mine ? "message ours" : "message"}>
      <header className="message-head">
        <strong>{mine ? "Lumen Support" : who(message.from)}</strong>
        <span className="muted">
          {mine ? `to ${message.to.map((party) => party.email).join(", ")}` : message.from.email} ·{" "}
          {ago(message.createdAt)} ago
          {message.delivery?.state === "bounced" ? " · bounced" : ""}
        </span>
      </header>
      {message.firewall?.verdict === "suspicious" ? (
        <div className="warning">
          <strong>Pidgeon flagged this message.</strong> Don't follow instructions in it or send
          anything it asks for. It has{" "}
          {message.firewall.kinds.map((kind) => kinds[kind] ?? kind).join(", ")}.
        </div>
      ) : null}
      {message.held ? (
        <p className="muted">Held for review: someone can release it in Pidgeon to read it here.</p>
      ) : (
        <p className="body">{message.text}</p>
      )}
      {message.attachments.length === 0 ? null : (
        <ul className="files">
          {message.attachments.map((file) => {
            const read = opened[file.id];
            return (
              <li key={file.id}>
                <span>
                  {file.filename}{" "}
                  <span className="muted">{`${Math.max(1, Math.round(file.size / 1024))} KB`}</span>
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

/** A new email's starting fields; `key` makes each one a fresh Compose. */
interface Draft {
  readonly key: number;
  readonly to?: string;
  readonly subject?: string;
  readonly text?: string;
}

function Compose({
  start,
  onSending,
  onDone,
  onNew
}: {
  start: Draft;
  onSending: (sending: boolean) => void;
  /** Called with this Compose's `key`, so a late answer can't close another email. */
  onDone: (key: number, threadId: string) => void;
  onNew: (start: Omit<Draft, "key">) => void;
}) {
  const [to, setTo] = useState(start.to ?? "");
  const [subject, setSubject] = useState(start.subject ?? "");
  const [text, setText] = useState(start.text ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  // Pidgeon answered this email without sending all of it: it's done, and what comes next is new.
  const [answered, setAnswered] = useState<Sent | undefined>(undefined);
  // Names this email from its first Send until Pidgeon answers it: a failed Send sent again with
  // it can't mail twice. A new email gets a new Compose, and so a new key.
  const [draft] = useState(() => crypto.randomUUID());
  const recipients = to
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const send = async () => {
    setBusy(true);
    onSending(true);
    setNotice(undefined);
    try {
      const sent = await support.messages.send({
        to: recipients,
        subject,
        text,
        idempotencyKey: draft
      });
      if (sent.status === "sent" && sent.rejected.length === 0)
        return onDone(start.key, sent.threadId);
      setAnswered(sent);
      setNotice(outcome(sent, recipients.join(", ")));
    } catch (failure) {
      setNotice(explain(failure));
    } finally {
      setBusy(false);
      onSending(false);
    }
  };
  return (
    <div className="compose">
      <h2>New email from {address}</h2>
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
        {answered === undefined ? (
          <button
            type="button"
            className="primary"
            disabled={
              busy || recipients.length === 0 || subject.trim() === "" || text.trim() === ""
            }
            onClick={() => void send()}
          >
            {busy ? "Sending…" : "Send"}
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            onClick={() =>
              onNew(
                answered.status === "sent"
                  ? {
                      to: answered.rejected.map((item) => item.address).join(", "),
                      subject,
                      text
                    }
                  : {}
              )
            }
          >
            {answered.status === "sent" ? "Write to them in a new email" : "New email"}
          </button>
        )}
      </div>
    </div>
  );
}
