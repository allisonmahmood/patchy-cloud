/**
 * Requests and feedback from the dashboard: the shell's Tell Patchy panel sends here, and What you
 * sent at `/feedback` lists what the person and their agents sent, with Unlink and Withdraw. Every
 * route calls `Feedback.Feedback` as the signed-in person with surface `dashboard` and no agent.
 *
 * The panel's script posts its forms with a `patchy-panel` header and gets back the markup to show
 * in place: the receipt and similar requests, or a refusal. The same forms posted without the
 * script land on What you sent with a receipt. A refusal never carries the draft back: the
 * person's text stays in their own field, or is gone with the page.
 */
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as SqlClient from "effect/sql/SqlClient";
import { CodingAgent, type RequestBrief, type RequestStatus, SubmissionKind } from "@patchy/api";
import { pageResponse, Receipt, RequireSession, Session } from "@patchy/auth";
import type { Companies, Users } from "@patchy/companies";
import {
  agentMark,
  ago,
  avatar,
  dateLabel,
  escapeAttribute,
  escapeHtml,
  menuLink,
  menuPost,
  rowMenu,
  sentenceList,
  tellPatchyScriptPath
} from "@patchy/core";
import { Feedback } from "@patchy/feedback";
import { errors } from "./PortalPages.js";
import { styles as portalStyles } from "./render.js";

/** A feedback note's 4,000 characters, each up to four UTF-8 bytes percent-encoded, with room. */
const MAX_FORM_BYTES = 64 * 1024;
/** The header the panel's script sends, and every answer meant for the panel carries back. */
const PANEL = "patchy-panel";

/** Page layout only; the table, pills, menus and notes are the shell's. */
const styles = `
  .feedback { max-width: 880px; }
  .feedback-table { min-width: 720px; }
  .feedback-table td { vertical-align: middle; }
  .feedback-sent { white-space: nowrap; }
  .feedback-what { display: grid; }
  .feedback-from { display: flex; align-items: center; gap: 10px; white-space: nowrap; }
  .feedback-from > span:last-child { display: grid; }
  .feedback-actions { width: 44px; text-align: right; }
`;

const decodeSend = Schema.decodeUnknownEffect(
  Schema.Struct({ kind: SubmissionKind, text: Schema.String })
);
const decodeLink = Schema.decodeUnknownEffect(Schema.Struct({ to: Schema.String }));

/** The CLI's agents by the names people know them by. */
const codingAgents: Record<Exclude<CodingAgent, "unknown">, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
  "kilo-code": "Kilo Code",
  opencode: "OpenCode",
  "copilot-cli": "Copilot CLI",
  grok: "Grok",
  crush: "Crush",
  "qwen-code": "Qwen Code",
  pi: "Pi",
  augment: "Augment",
  "roo-code": "Roo Code",
  cline: "Cline"
};
const isCodingAgent = Schema.is(CodingAgent);

type Sent = Feedback.SentRequest | Feedback.SentFeedback;

/**
 * The agent that sent it, as people know it: the CLI's detected agent or the name the Patchy MCP
 * connection's client gave. Null from the dashboard or when the CLI detected none.
 */
const agentName = (sent: Sent): string | null => {
  if (sent.agent === null || sent.agent === "unknown") return null;
  return sent.surface === "cli" && isCodingAgent(sent.agent) && sent.agent !== "unknown"
    ? codingAgents[sent.agent]
    : sent.agent;
};

const pills: Record<RequestStatus, string> = {
  open: '<span class="pill">Open</span>',
  planned: '<span class="pill pill-progress">Planned</span>',
  shipped: '<span class="pill pill-done">Shipped</span>',
  declined: '<span class="pill pill-failed">Declined</span>'
};

const when = (date: Date, now: number) => {
  const iso = date.toISOString();
  return `<time datetime="${escapeAttribute(iso)}" title="${escapeAttribute(dateLabel(iso))}">${escapeHtml(ago(iso, now))}</time>`;
};

const path = (id: string, act: "link" | "unlink" | "withdraw") =>
  `/feedback/${encodeURIComponent(id)}/${act}`;

/** Why nothing was saved or changed: a title and a line, both trusted HTML. */
interface Refusal {
  readonly status: number;
  readonly title: string;
  readonly body: string;
}

const unchanged = (status: number, title: string): Refusal => ({
  status,
  title,
  body: "Nothing changed."
});
const withdrawn = unchanged(404, "You already withdrew that");
const brokenForm = (status: number): Refusal => ({
  status,
  title: "Patchy couldn’t read that",
  body: "Nothing was saved. Send it again."
});

/** Text as a title: one line, its whitespace runs collapsed, as the store keeps it. */
const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();
const characters = (text: string) => [...text].length;
const fitsTitle = (text: string) => {
  const length = characters(text);
  return length >= Feedback.TITLE_MIN && length <= Feedback.TITLE_MAX;
};

/** `line` cut to a title: at the last word boundary that leaves room for "…", else mid-word. */
const shortened = (line: string) => {
  const all = [...line];
  const room = all.slice(0, Feedback.TITLE_MAX - 1);
  const boundary = all[room.length] === " " ? room.length : room.lastIndexOf(" ");
  const kept = boundary >= Feedback.TITLE_MIN ? room.slice(0, boundary) : room;
  return `${kept.join("").trimEnd()}…`;
};

/**
 * A request from the panel's one field, as the store's title and why. Text that fits a title is
 * the title alone. Longer text keeps all of itself as the why, which is what Patchy's team reads,
 * and takes its first line as the title when that fits, else its opening words cut with "…".
 * Too short is the store's to refuse; the CLI and Patchy MCP send their title and why as given.
 */
export const requestOf = (
  text: string
): { readonly title: string; readonly why: string | null } => {
  const whole = oneLine(text);
  if (characters(whole) <= Feedback.TITLE_MAX) return { title: whole, why: null };
  const first = oneLine(text.trim().split(/\r?\n/u)[0] ?? "");
  return { title: fitsTitle(first) ? first : shortened(whole), why: text.trim() };
};

/** A send's refusal, naming the kind of credential it held and never the text. */
const sendRefusal = (error: Feedback.SendRefusal, kind: SubmissionKind, text: string): Refusal => {
  const noun = kind === "request" ? "request" : "feedback";
  switch (error._tag) {
    case "ContainsSecret":
      return {
        status: 422,
        title: `Your ${noun} has ${sentenceList([...new Set(error.secrets.map(({ label }) => label))])} in it`,
        body: "Nothing was saved. Take it out, or write <code>&lt;token&gt;</code> where it was, and send again."
      };
    case "InvalidText": {
      // The field holds at most the store's longest text; a request's title is derived to fit.
      const length = characters(text.trim());
      return {
        status: 422,
        title:
          length === 0
            ? `Write your ${noun} first`
            : length > Feedback.TEXT_MAX
              ? `Your ${noun} is longer than ${Feedback.TEXT_MAX.toLocaleString("en-US")} characters`
              : length < error.minimum
                ? `A request is at least ${error.minimum} characters`
                : `Your ${noun} has a control character in it`,
        body: "Nothing was saved."
      };
    }
    case "SendLimited":
      return {
        status: 429,
        title: "That’s a lot in one minute",
        body: `Nothing was saved. Send it again in ${error.retryAfterSeconds} seconds.`
      };
  }
};

/** A refusal as a notice; `callout` points it at the panel's field, which names it by its id. */
const renderRefusal = (refusal: Refusal, callout = false) =>
  `<div ${callout ? 'class="note note-refused field-callout" id="tell-patchy-refused"' : 'class="note note-refused"'} role="alert"><strong class="note-title">${refusal.title}</strong><p>${refusal.body}</p></div>`;

/**
 * What the panel shows once something is sent: a request's receipt with its title and the
 * similar requests filing it returned, each with Same need and, once linked, Unlink; feedback's
 * receipt alone. Done closes the panel.
 */
export const renderSent = (
  sent:
    | {
        readonly kind: "request";
        readonly id: string;
        readonly title: string;
        readonly similar: ReadonlyArray<RequestBrief>;
      }
    | { readonly kind: "feedback" }
): string => {
  const done =
    '<button class="btn btn-primary tell-patchy-done" type="button" popovertarget="tell-patchy" popovertargetaction="hide">Done</button>';
  if (sent.kind === "feedback")
    return `<p class="note note-ok" role="status"><strong class="note-title">Feedback sent</strong></p>${done}`;
  const matches = sent.similar.map(
    (match) =>
      `<li class="list-row tell-patchy-match"><div><p class="tell-patchy-match-title"><strong>${escapeHtml(match.title)}</strong>${pills[match.status]}</p>${match.note === undefined ? "" : `<p class="supporting-text">${escapeHtml(match.note)}</p>`}</div><form class="tell-patchy-same" method="post" action="${escapeAttribute(path(sent.id, "link"))}"><input type="hidden" name="to" value="${escapeAttribute(match.id)}"><button class="btn" type="submit" aria-label="${escapeAttribute(`Same need as ${match.title}`)}">Same need</button></form><form class="tell-patchy-unlink" method="post" action="${escapeAttribute(path(sent.id, "unlink"))}" hidden><button class="btn btn-quiet" type="submit" aria-label="${escapeAttribute(`Unlink from ${match.title}`)}">Unlink</button></form></li>`
  );
  const similar =
    matches.length === 0
      ? ""
      : `<p class="shelf-label">Similar requests</p><ul class="list list-snug">${matches.join("")}</ul><p class="note note-ok tell-patchy-linked" role="status" hidden></p>`;
  return `<p class="note note-ok" role="status"><strong class="note-title">Request sent</strong>${escapeHtml(sent.title)}</p>${similar}${done}`;
};

/** Who sent it and through what: "You · Dashboard", or the agent and "CLI" or "Patchy MCP". */
const from = (sent: Sent, viewer: RequireSession.Viewer["Service"]) => {
  const cell = (mark: string, name: string, surface: string) =>
    `<span class="feedback-from">${mark}<span><strong>${escapeHtml(name)}</strong><span class="supporting-text">${surface}</span></span></span>`;
  return sent.surface === "dashboard"
    ? cell(avatar(viewer.user.email, viewer.user.name), "You", "Dashboard")
    : cell(
        agentMark,
        agentName(sent) ?? "Unknown agent",
        sent.surface === "cli" ? "CLI" : "Patchy MCP"
      );
};

/** What you sent: one page of the person's and their agents' submissions, newest first. */
export const renderList = (input: {
  readonly viewer: RequireSession.Viewer["Service"];
  readonly page: Feedback.Page;
  readonly now: number;
  readonly first: boolean;
  readonly refused?: Refusal | undefined;
}): string => {
  const heading = `<h1 class="page-heading">What you sent</h1>${input.refused === undefined ? "" : renderRefusal(input.refused)}`;
  if (input.page.submissions.length === 0 && input.first)
    return `<article class="feedback">${heading}<p>Nothing yet.</p><div class="actions"><button class="btn" type="button" popovertarget="tell-patchy">Tell Patchy</button></div></article>`;
  const rows = input.page.submissions.map((sent) => {
    const at = when(sent.createdAt, input.now);
    const label =
      sent.kind === "request"
        ? sent.title
        : `Feedback, ${ago(sent.createdAt.toISOString(), input.now)}`;
    const what =
      sent.kind === "request"
        ? `<span class="supporting-text">Request</span><strong>${escapeHtml(sent.title)}</strong>${sent.link === null ? "" : `<span class="supporting-text">Same need as ${escapeHtml(sent.link.title)}</span>`}`
        : '<span class="supporting-text">Feedback</span>';
    const items = [
      ...(sent.kind === "request" && sent.link !== null
        ? [
            menuPost(path(sent.id, "unlink"), `Unlink from ${sent.link.title}`),
            '<hr class="menu-rule">'
          ]
        : []),
      menuLink(path(sent.id, "withdraw"), "Withdraw…", true, label)
    ];
    return `<tr><td class="feedback-sent">${at}</td><td><span class="feedback-what">${what}</span></td><td>${from(sent, input.viewer)}</td><td>${sent.kind === "request" ? pills[sent.status] : ""}</td><td class="feedback-actions">${rowMenu(sent.id, label, items)}</td></tr>`;
  });
  const older =
    input.page.nextCursor === null
      ? ""
      : `<div class="actions"><a class="btn" href="${escapeAttribute(`/feedback?cursor=${encodeURIComponent(input.page.nextCursor)}`)}">Older</a></div>`;
  return `<article class="feedback">${heading}<div class="portal-table"><table class="table feedback-table" aria-label="What you sent"><thead><tr><th scope="col">Sent</th><th scope="col">What</th><th scope="col">From</th><th scope="col">Status</th><th scope="col" aria-label="Actions"></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>${older}</article>`;
};

/** Withdraw's confirmation: what goes, with what its sender sent alongside it. */
export const renderWithdraw = (sent: Sent, now: number): string => {
  const what =
    sent.kind === "request"
      ? `“${escapeHtml(sent.title)}”`
      : `feedback sent ${escapeHtml(ago(sent.createdAt.toISOString(), now))}`;
  const by = sent.surface === "dashboard" ? "you" : (agentName(sent) ?? "your agent");
  return `<article class="feedback"><p><a href="/feedback">Back to What you sent</a></p><h1 class="page-heading">Withdraw ${what}?</h1><form class="confirmation-form" method="post" action="${escapeAttribute(path(sent.id, "withdraw"))}"><p class="confirmation-consequence">Patchy deletes it and everything ${escapeHtml(by)} sent with it. You can’t undo this.</p><div class="confirmation-actions"><button class="btn btn-danger" type="submit">Withdraw ${sent.kind}</button><a class="btn btn-quiet" href="/feedback">Cancel</a></div></form></article>`;
};

/**
 * The panel's script: it sends each of the panel's forms in place and shows the answer. A
 * request's receipt and matches replace the form; a refusal sits under the field; Same need and
 * Unlink swap which buttons show. One form is in flight at a time across the panel, so two links
 * never race, and an answer for a panel reset since it was sent is dropped. An answer that isn't
 * the panel's own, or none at all, may still have been saved, so nothing is ever sent again on
 * its own: the draft stays, and a note points to What you sent. Closing the panel after a send
 * readies it for the next one.
 */
const tellScript = `(() => {
  const panel = document.getElementById("tell-patchy");
  if (!panel) return;
  const compose = panel.querySelector(".tell-patchy-form");
  const answer = panel.querySelector(".tell-patchy-answer");
  const unsure = panel.querySelector(".tell-patchy-unsure");
  const text = compose.elements.namedItem("text");
  answer.tabIndex = -1;
  let busy = false;
  let state = 0;
  document.addEventListener("click", (event) => {
    const opener = event.target instanceof Element && event.target.closest('[popovertarget="tell-patchy"][data-kind]');
    if (opener) compose.elements.namedItem("kind").value = opener.dataset.kind;
  });
  const clear = () => {
    panel.querySelectorAll(".note-refused").forEach((note) => note.remove());
    unsure.hidden = true;
    unsure.removeAttribute("role");
    text.removeAttribute("aria-invalid");
    text.removeAttribute("aria-describedby");
  };
  const post = async (form) => {
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: new URLSearchParams(new FormData(form)),
        headers: { "${PANEL}": "tell" }
      });
      if (response.headers.get("${PANEL}") !== "tell") return null;
      return { ok: response.ok, html: await response.text() };
    } catch {
      return null;
    }
  };
  panel.addEventListener("submit", async (event) => {
    const form = event.target;
    event.preventDefault();
    if (busy) return;
    busy = true;
    panel.setAttribute("aria-busy", "true");
    const sentAt = state;
    const answered = await post(form);
    busy = false;
    panel.removeAttribute("aria-busy");
    if (sentAt !== state) return;
    clear();
    if (answered === null) {
      unsure.setAttribute("role", "alert");
      unsure.hidden = false;
      return;
    }
    if (form === compose) {
      if (!answered.ok) {
        text.insertAdjacentHTML("afterend", answered.html);
        text.setAttribute("aria-invalid", "true");
        text.setAttribute("aria-describedby", "tell-patchy-refused");
        return text.focus();
      }
      state++;
      compose.hidden = true;
      answer.innerHTML = answered.html;
      answer.hidden = false;
      return answer.focus({ preventScroll: true });
    }
    if (!answered.ok) return answer.querySelector(".tell-patchy-done").insertAdjacentHTML("beforebegin", answered.html);
    const linked = form.classList.contains("tell-patchy-same") ? form.closest("li") : null;
    for (const row of answer.querySelectorAll(".tell-patchy-match")) {
      row.querySelector(".tell-patchy-same").hidden = linked !== null;
      row.querySelector(".tell-patchy-unlink").hidden = row !== linked;
    }
    const note = answer.querySelector(".tell-patchy-linked");
    note.textContent = linked === null ? "" : "Linked to " + linked.querySelector("strong").textContent;
    note.hidden = linked === null;
  });
  // On a phone, Done also closes the Menu the panel was opened from.
  panel.addEventListener("click", (event) => {
    const menu = document.getElementById("app-menu");
    if (event.target instanceof Element && event.target.closest(".tell-patchy-done") && menu?.matches(":popover-open")) menu.hidePopover();
  });
  panel.addEventListener("toggle", (event) => {
    if (event.newState === "open") {
      if (!compose.hidden) text.focus();
      return;
    }
    if (!compose.hidden) return;
    state++;
    clear();
    compose.reset();
    compose.hidden = false;
    answer.hidden = true;
    answer.replaceChildren();
  });
})();
`;

const context = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  return {
    viewer,
    session,
    request,
    person: { userId: viewer.user.id, companyId: viewer.company.id },
    panel: request.headers[PANEL] === "tell"
  };
});

const form = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
  request.urlParamsBody.pipe(
    Effect.map((params) => Object.fromEntries(params)),
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_FORM_BYTES))
  )
);

/** Markup for the panel to show, marked so its script knows the answer is the panel's. */
const panelAnswer = (html: string, status = 200) =>
  HttpServerResponse.text(html, {
    contentType: "text/html",
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      [PANEL]: "tell"
    }
  });

/** What you sent, with a refusal at its top when a form posted without the panel's script was refused. */
const listPage = Effect.fn("FeedbackPages.listPage")(function* (refused?: Refusal) {
  const { viewer, session, request, person } = yield* context;
  const feedback = yield* Feedback.Feedback;
  const cursor =
    refused === undefined
      ? new URL(request.url, session.publicBaseUrl).searchParams.get("cursor")
      : null;
  const listed = yield* feedback.list(cursor === null ? { person } : { person, cursor }).pipe(
    Effect.map((page) => ({ page, first: cursor === null, refused })),
    Effect.catchTags({
      InvalidCursor: () =>
        // Without a cursor there is none to refuse.
        Effect.map(
          feedback.list({ person }).pipe(Effect.catchTags({ InvalidCursor: Effect.die })),
          (page) => ({
            page,
            first: true,
            refused: unchanged(400, "That page of What you sent is out of date")
          })
        )
    })
  );
  return pageResponse(
    {
      title: "What you sent",
      heading: "",
      body: renderList({ viewer, now: yield* Clock.currentTimeMillis, ...listed }),
      styles: portalStyles + styles,
      status: listed.refused?.status ?? 200,
      app: { viewer, section: "feedback" }
    },
    session
  );
});

/** A refused form: in the panel, the notice alone; otherwise What you sent with it on top. */
const refuse = Effect.fn("FeedbackPages.refuse")(function* (refusal: Refusal, callout = false) {
  const { panel } = yield* context;
  return panel
    ? panelAnswer(renderRefusal(refusal, callout), refusal.status)
    : yield* listPage(refusal);
});

/** A done form: in the panel, `html`; otherwise What you sent, leading with `receipt`. */
const done = Effect.fn("FeedbackPages.done")(function* (receipt: string, html = "") {
  const { viewer, session, panel } = yield* context;
  if (panel) return panelAnswer(html);
  return Receipt.set(
    HttpServerResponse.redirect("/feedback", {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    }),
    { userId: viewer.user.id, text: receipt, publicBaseUrl: session.publicBaseUrl }
  );
});

const send = Effect.gen(function* () {
  const { person } = yield* context;
  const fields = yield* form;
  const { kind, text } = yield* decodeSend(fields);
  const feedback = yield* Feedback.Feedback;
  const sender = { ...person, surface: "dashboard" } satisfies Feedback.Sender;
  const request = requestOf(text);
  const sent =
    kind === "request"
      ? Effect.map(
          feedback.sendRequest({ sender, text: request.title, why: request.why }),
          (filed) =>
            renderSent({ kind, id: filed.id, title: request.title, similar: filed.similar })
        )
      : Effect.as(feedback.sendFeedback({ sender, text }), renderSent({ kind }));
  return yield* sent.pipe(
    Effect.flatMap((html) => done(kind === "request" ? "Request sent" : "Feedback sent", html)),
    Effect.catchTags({
      InvalidText: (error) => refuse(sendRefusal(error, kind, text), true),
      ContainsSecret: (error) => refuse(sendRefusal(error, kind, text), true),
      SendLimited: (error) => refuse(sendRefusal(error, kind, text), true)
    })
  );
}).pipe(
  Effect.catchTags({
    SchemaError: () => refuse(brokenForm(422), true),
    HttpServerError: () => refuse(brokenForm(413), true)
  })
);

const link = Effect.fn("FeedbackPages.link")(
  function* (id: string) {
    const { person } = yield* context;
    const { to } = yield* decodeLink(yield* form);
    const linked = yield* (yield* Feedback.Feedback).link({
      sender: { ...person, surface: "dashboard" },
      id,
      to
    });
    return yield* done(`Linked to ${linked.link.title}`);
  },
  Effect.catchTags({
    SubmissionNotFound: () => refuse(withdrawn),
    InvalidLink: () => refuse(unchanged(409, "That request was withdrawn")),
    InvalidText: () => refuse(brokenForm(422)),
    ContainsSecret: () => refuse(brokenForm(422)),
    SchemaError: () => refuse(brokenForm(422)),
    HttpServerError: () => refuse(brokenForm(413))
  })
);

const unlink = Effect.fn("FeedbackPages.unlink")(
  function* (id: string) {
    const { person } = yield* context;
    const feedback = yield* Feedback.Feedback;
    const sent = yield* feedback.get({ person, id });
    yield* feedback.unlink({ person, id });
    return yield* done(
      sent.kind === "request" && sent.link !== null
        ? `Unlinked from ${sent.link.title}`
        : "Unlinked"
    );
  },
  Effect.catchTags({ SubmissionNotFound: () => refuse(withdrawn) })
);

/** GET asks, naming what goes; POST withdraws and lands on What you sent. */
const withdraw = Effect.fn("FeedbackPages.withdraw")(
  function* (id: string, method: "GET" | "POST") {
    const { viewer, session, person } = yield* context;
    const feedback = yield* Feedback.Feedback;
    const sent = yield* feedback.get({ person, id });
    if (method === "POST") {
      yield* feedback.withdraw({ person, id });
      return yield* done(`Withdrew your ${sent.kind}`);
    }
    return pageResponse(
      {
        title: "Withdraw",
        heading: "",
        body: renderWithdraw(sent, yield* Clock.currentTimeMillis),
        styles: portalStyles + styles,
        app: { viewer, section: "feedback" }
      },
      session
    );
  },
  Effect.catchTags({ SubmissionNotFound: () => refuse(withdrawn) })
);

const byId = <E, R>(
  handle: (id: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) => Effect.flatMap(HttpRouter.params, (params) => handle(params.id ?? ""));

export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      Session.Session | Companies.Companies | Users.Users | Feedback.Feedback | SqlClient.SqlClient
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const post = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      errors(RequireSession.sameOrigin(RequireSession.withViewer(app)));
    yield* router.add("GET", "/feedback", errors(RequireSession.withViewer(listPage())));
    yield* router.add("POST", "/feedback", post(send));
    yield* router.add("POST", "/feedback/:id/link", post(byId(link)));
    yield* router.add("POST", "/feedback/:id/unlink", post(byId(unlink)));
    yield* router.add(
      "GET",
      "/feedback/:id/withdraw",
      errors(RequireSession.withViewer(byId((id) => withdraw(id, "GET"))))
    );
    yield* router.add("POST", "/feedback/:id/withdraw", post(byId((id) => withdraw(id, "POST"))));
    yield* router.add(
      "GET",
      tellPatchyScriptPath,
      HttpServerResponse.text(tellScript, {
        contentType: "text/javascript",
        headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" }
      })
    );
  })
);
