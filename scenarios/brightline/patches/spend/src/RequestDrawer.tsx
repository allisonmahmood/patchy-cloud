import { useEffect, useFileUrl, useQuery, useState } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";
import { adminApprovalCents, formatMoney } from "../helpers/spend.js";
import { byId, type Detail, type Person, type Viewer } from "./data.js";
import {
  asStatus,
  dateTime,
  fileSize,
  firstName,
  messageOf,
  relativeDay,
  shortDate
} from "./format.js";
import { Avatar, Banner, Icon, StatusPill } from "./ui.js";

type Busy = "approve" | "reject" | "pay" | "note" | null;

/** The side panel for one request: receipt, details, the decision a viewer can make, and its audit trail. */
export function RequestDrawer({
  id,
  viewer,
  onClose
}: {
  id: string;
  viewer: Viewer;
  onClose: () => void;
}) {
  const snapshot = useQuery(patchy.server.requests.detail, { id });
  const detail = snapshot.data;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div class="overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <aside class="drawer" aria-label="Request details">
        <button type="button" class="icon-button drawer-close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
        {detail === undefined ? (
          <p class="drawer-loading">
            {snapshot.error ? messageOf(snapshot.error) : "Loading request…"}
          </p>
        ) : detail === null ? (
          <p class="drawer-loading">This request no longer exists.</p>
        ) : (
          <DrawerBody detail={detail} viewer={viewer} />
        )}
      </aside>
    </div>
  );
}

function DrawerBody({ detail, viewer }: { detail: Detail; viewer: Viewer }) {
  const { request, events, receipt } = detail;
  const people = byId(detail.people);
  const status = asStatus(request.status);
  const requester = people.get(request.requester);
  const approver = request.approver === null ? undefined : people.get(request.approver);
  const payer = request.paidBy === null ? undefined : people.get(request.paidBy);

  return (
    <div class="drawer-body">
      <header class="drawer-head">
        <div class="drawer-status">
          <StatusPill status={status} />
          <span class="muted">
            Submitted {relativeDay(request.submittedAt)} by {firstName(requester)}
          </span>
        </div>
        <h2 class="drawer-title">{request.title}</h2>
        <div class="drawer-amount">{formatMoney(request.amountCents)}</div>
        <div class="drawer-project">
          <span class="tag">{request.category}</span>
          <span>{request.project === "Studio" ? "Studio (internal)" : request.project}</span>
        </div>
      </header>

      <Decision detail={detail} viewer={viewer} approver={approver} payer={payer} />

      <section class="drawer-section">
        <h3 class="section-title">Receipt or quote</h3>
        {receipt !== null ? (
          <ReceiptCard receipt={receipt} />
        ) : request.receipt !== null ? (
          <p class="muted">The receipt file is no longer available.</p>
        ) : (
          <p class="muted">No receipt attached. Not needed under $500.</p>
        )}
      </section>

      <section class="drawer-section">
        <h3 class="section-title">Details</h3>
        <dl class="facts">
          <div>
            <dt>Requested by</dt>
            <dd class="fact-person">
              <Avatar person={requester} size="sm" />
              {requester?.name ?? "Unknown member"}
            </dd>
          </div>
          <div>
            <dt>Submitted</dt>
            <dd>{dateTime(request.submittedAt)}</dd>
          </div>
          <div>
            <dt>{status === "rejected" ? "Rejected by" : "Approved by"}</dt>
            <dd class="fact-person">
              {approver ? (
                <>
                  <Avatar person={approver} size="sm" />
                  {approver.name}
                </>
              ) : (
                <span class="muted">Not decided yet</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd>
              {request.paidAt !== null ? (
                `${shortDate(request.paidAt)} by ${firstName(payer)}`
              ) : (
                <span class="muted">Not yet</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <Activity requestId={request.id} events={events} people={people} />
    </div>
  );
}

/** What the viewer can do next. Buttons follow roles, but the server has the final say. */
function Decision({
  detail,
  viewer,
  approver,
  payer
}: {
  detail: Detail;
  viewer: Viewer;
  approver: Person | undefined;
  payer: Person | undefined;
}) {
  const { request } = detail;
  const status = asStatus(request.status);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const mine = request.requester === viewer.user.id;
  const needsAdmin = request.amountCents >= adminApprovalCents;

  async function act(kind: Exclude<Busy, null>, call: () => Promise<unknown>) {
    setBusy(kind);
    setError("");
    try {
      await call();
      setNote("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  if (status === "submitted")
    return (
      <section class="decision">
        <div class="decision-head">
          <h3 class="section-title">Your decision</h3>
          {needsAdmin && <span class="rule-chip">$2,500+ · admin approval</span>}
        </div>
        {mine && <p class="decision-hint">You submitted this, so a teammate needs to review it.</p>}
        <textarea
          class="input textarea"
          rows={2}
          placeholder="Add a note. Required if you reject."
          value={note}
          disabled={busy !== null}
          onInput={(event) => setNote(event.currentTarget.value)}
        />
        {error && <Banner tone="danger">{error}</Banner>}
        <div class="decision-actions">
          <button
            type="button"
            class="button ghost danger"
            disabled={busy !== null}
            onClick={() =>
              void act("reject", () => patchy.server.requests.reject({ id: request.id, note }))
            }
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
          <button
            type="button"
            class="button primary"
            disabled={busy !== null}
            onClick={() =>
              void act("approve", () =>
                patchy.server.requests.approve({ id: request.id, ...(note.trim() ? { note } : {}) })
              )
            }
          >
            <Icon name="check" />
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
        </div>
      </section>
    );

  const decidedBy = approver?.name ?? "Someone";
  return (
    <section class={`decision decision-${status}`}>
      <p class="decision-summary">
        {status === "rejected" ? (
          <>
            <strong>{decidedBy}</strong> rejected this{" "}
            {request.decidedAt ? relativeDay(request.decidedAt) : ""}.
          </>
        ) : status === "paid" ? (
          <>
            Approved by <strong>{decidedBy}</strong>, paid by{" "}
            <strong>{payer?.name ?? "an admin"}</strong>{" "}
            {request.paidAt ? relativeDay(request.paidAt) : ""}.
          </>
        ) : (
          <>
            <strong>{decidedBy}</strong> approved this{" "}
            {request.decidedAt ? relativeDay(request.decidedAt) : ""}.{" "}
            {viewer.admin
              ? "Mark it paid once the money has gone out."
              : "An admin marks it paid once the money goes out."}
          </>
        )}
      </p>
      {request.decisionNote && (
        <blockquote class="decision-note">{request.decisionNote}</blockquote>
      )}
      {error && <Banner tone="danger">{error}</Banner>}
      {status === "approved" && viewer.admin && (
        <div class="decision-actions">
          <button
            type="button"
            class="button primary"
            disabled={busy !== null}
            onClick={() =>
              void act("pay", () => patchy.server.requests.markPaid({ id: request.id }))
            }
          >
            {busy === "pay" ? "Marking as paid…" : "Mark as paid"}
          </button>
        </div>
      )}
    </section>
  );
}

function ReceiptCard({ receipt }: { receipt: NonNullable<Detail["receipt"]> }) {
  const isImage = receipt.contentType.startsWith("image/");
  const preview = useFileUrl(isImage ? receipt.handle : null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const kind =
    receipt.contentType === "application/pdf"
      ? "PDF"
      : receipt.contentType.replace("image/", "").replace("+xml", "").toUpperCase();

  async function download() {
    setDownloading(true);
    setError("");
    try {
      await patchy.files.download(receipt.handle, receipt.name);
    } catch (cause) {
      // "Not now" in Patchy's download card is a choice, not a failure.
      if (!(
        isPatchyError(cause, "invalid_request") && cause.details["reason"] === "download_discarded"
      ))
        setError(messageOf(cause));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div class="receipt">
      {isImage && (
        <div class="receipt-preview">
          {preview.url ? (
            <img src={preview.url} alt={`Receipt: ${receipt.name}`} />
          ) : (
            <span class="muted">
              {preview.error ? "The preview couldn't be loaded." : "Loading preview…"}
            </span>
          )}
        </div>
      )}
      <div class="receipt-file">
        <span class="file-icon">
          <Icon name="file" size={18} />
        </span>
        <span class="file-meta">
          <span class="file-name">{receipt.name}</span>
          <span class="muted">
            {kind} · {fileSize(receipt.size)}
          </span>
        </span>
        <button
          type="button"
          class="button ghost small"
          disabled={downloading}
          onClick={() => void download()}
        >
          <Icon name="download" size={15} />
          {downloading ? "Downloading…" : "Download"}
        </button>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
    </div>
  );
}

const eventVerb: Record<string, string> = {
  submitted: "submitted the request",
  approved: "approved",
  rejected: "rejected",
  paid: "marked it paid",
  note: "added a note"
};

function Activity({
  requestId,
  events,
  people
}: {
  requestId: string;
  events: Detail["events"];
  people: ReadonlyMap<string, Person>;
}) {
  const [note, setNote] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");

  async function post() {
    if (posting) return;
    setPosting(true);
    setError("");
    try {
      await patchy.server.requests.addNote({ id: requestId, note });
      setNote("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPosting(false);
    }
  }

  return (
    <section class="drawer-section">
      <h3 class="section-title">Activity</h3>
      <ol class="timeline">
        {events.map((event) => {
          const actor = people.get(event.actor);
          return (
            <li key={event.id} class={`timeline-item event-${event.kind}`}>
              <Avatar person={actor} size="sm" />
              <div class="timeline-body">
                <div class="timeline-line">
                  <strong>{actor?.name ?? "Someone"}</strong> {eventVerb[event.kind] ?? event.kind}
                  <span class="timeline-time">{dateTime(event.at)}</span>
                </div>
                {event.note && <p class="timeline-note">{event.note}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      <div class="note-composer">
        <input
          class="input"
          placeholder="Add a note for the team"
          value={note}
          disabled={posting}
          onInput={(event) => setNote(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) {
              event.preventDefault();
              void post();
            }
          }}
        />
        <button type="button" class="button ghost" disabled={posting} onClick={() => void post()}>
          {posting ? "Posting…" : "Post"}
        </button>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
    </section>
  );
}
