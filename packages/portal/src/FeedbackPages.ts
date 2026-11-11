/**
 * Requests and feedback from the dashboard: the shell's Tell Patchy panel sends here, and What you
 * sent at `/feedback` lists what the person and their agents sent, with Unlink and Withdraw… in
 * each row's menu. Every route calls `Feedback.Feedback` as the signed-in person with surface
 * `dashboard` and no agent.
 *
 * The panel's script posts its forms with a `patchy-panel` header and gets back the markup to show
 * in place: the receipt and similar requests, or the form drawn again with its field's error. The
 * same forms posted without the script land on What you sent with a receipt, or with the refusal
 * above its table. A refusal never carries the draft back: the person's text stays in their own
 * field, or is gone with the page.
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
  badge,
  button,
  dateLabel,
  dialog,
  emptyState,
  escapeAttribute,
  escapeHtml,
  indexPage,
  linkButton,
  menu,
  notice,
  receipt,
  refusal,
  row,
  rows,
  sentenceList,
  table,
  tellPatchyForm,
  tellPatchyPanel,
  tellPatchyScriptPath
} from "@patchy/core";
import { Feedback } from "@patchy/feedback";
import { errors } from "./shared/handlers.js";

/** A feedback note's 4,000 characters, each up to four UTF-8 bytes percent-encoded, with room. */
const MAX_FORM_BYTES = 64 * 1024;
/** The header the panel's script sends, and every answer meant for the panel carries back. */
const PANEL = "patchy-panel";

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

/** A request's status as a badge: shipped green, planned blue, declined red, open plain. */
const status: Record<RequestStatus, string> = {
  open: badge("Open"),
  planned: badge("Planned", "info"),
  shipped: badge("Shipped", "success"),
  declined: badge("Declined", "danger")
};

const when = (date: Date, now: number) => {
  const iso = date.toISOString();
  return `<time datetime="${escapeAttribute(iso)}" title="${escapeAttribute(dateLabel(iso))}">${escapeHtml(ago(iso, now))}</time>`;
};

const path = (id: string, act: "link" | "unlink" | "withdraw") =>
  `/feedback/${encodeURIComponent(id)}/${act}`;

/** Why nothing was saved or changed, in plain words. */
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
        body: "Nothing was saved. Take it out, or write <token> where it was, and send again."
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

/** A refusal as the danger notice its page or panel shows; `body` is escaped here. */
const refusalNotice = (refused: Refusal) =>
  notice({ tone: "danger", title: refused.title, body: `<p>${escapeHtml(refused.body)}</p>` });

/**
 * What the panel shows once something is sent: a request's receipt naming its title and the
 * similar requests filing it returned, each with its status, its note, Same need and, once
 * linked, Unlink; feedback's receipt alone. Done closes the panel. The script finds each part by
 * its `data-tell`, and a match's controls and its Linked receipt by `data-match`.
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
  const done = button("Done", {
    kind: "primary",
    type: "button",
    block: true,
    popovertarget: tellPatchyPanel,
    popovertargetaction: "hide",
    data: { tell: "done" }
  });
  if (sent.kind === "feedback") return `${receipt("Feedback sent")}${done}`;
  const matches = sent.similar.map((match, index) =>
    row({
      name: match.title,
      ...(match.note === undefined ? {} : { description: match.note }),
      end: `${status[match.status]}<form method="post" action="${escapeAttribute(path(sent.id, "link"))}" data-tell="link" data-match="${index}"><input type="hidden" name="to" value="${escapeAttribute(match.id)}">${button("Same need", { size: "sm", ariaLabel: `Same need as ${match.title}` })}</form><form method="post" action="${escapeAttribute(path(sent.id, "unlink"))}" data-tell="unlink" data-match="${index}" hidden>${button("Unlink", { kind: "quiet", size: "sm", ariaLabel: `Unlink from ${match.title}` })}</form>`
    })
  );
  const linked = sent.similar
    .map(
      (match, index) =>
        `<div data-tell="linked" data-match="${index}" hidden>${receipt(`Linked to ${match.title}`)}</div>`
    )
    .join("");
  const similar =
    matches.length === 0
      ? ""
      : `<p class="shelf-label">Similar requests</p>${rows(matches)}${linked}`;
  return `${receipt(`Request sent: ${sent.title}`)}${similar}${done}`;
};

/** Who sent it and through what: "You · Dashboard", or the agent and "CLI" or "Patchy MCP". */
const from = (sent: Sent, viewer: RequireSession.Viewer["Service"]) => {
  const cell = (mark: string, name: string, surface: string) =>
    `<div class="cell-name">${mark}<span><span class="strong">${escapeHtml(name)}</span><br><span class="meta">${surface}</span></span></div>`;
  return sent.surface === "dashboard"
    ? cell(avatar(viewer.user.email, viewer.user.name), "You", "Dashboard")
    : cell(
        agentMark,
        agentName(sent) ?? "Unknown agent",
        sent.surface === "cli" ? "CLI" : "Patchy MCP"
      );
};

/** How a row names itself, in its menu and its Withdraw dialog. */
const labelOf = (sent: Sent, now: number) =>
  sent.kind === "request" ? sent.title : `Feedback, ${ago(sent.createdAt.toISOString(), now)}`;

/**
 * What you sent: one page of the person's and their agents' submissions, newest first, in the
 * index template, with a refusal from a form sent without the panel's script above the table.
 */
export const renderList = (input: {
  readonly viewer: RequireSession.Viewer["Service"];
  readonly page: Feedback.Page;
  readonly now: number;
  readonly first: boolean;
  readonly refused?: Refusal | undefined;
}) => {
  const refused = input.refused === undefined ? "" : refusal(refusalNotice(input.refused));
  if (input.page.submissions.length === 0 && input.first)
    return indexPage({
      title: "What you sent",
      content: `${refused}<div class="box">${emptyState({
        title: "Nothing sent yet",
        action: button("Tell Patchy", { type: "button", popovertarget: tellPatchyPanel })
      })}</div>`
    });
  const listed = input.page.submissions.map((sent) => {
    const label = labelOf(sent, input.now);
    const what =
      sent.kind === "request"
        ? `<div class="row-main"><span class="row-desc">Request</span><span class="row-name">${escapeHtml(sent.title)}</span>${sent.link === null ? "" : `<span class="row-desc">Same need as ${escapeHtml(sent.link.title)}</span>`}</div>`
        : '<div class="row-main"><span class="row-desc">Feedback</span></div>';
    const actions = menu({
      id: sent.id,
      label,
      items: [
        ...(sent.kind === "request" && sent.link !== null
          ? [
              {
                kind: "post" as const,
                label: `Unlink from ${sent.link.title}`,
                action: path(sent.id, "unlink")
              },
              { kind: "rule" as const }
            ]
          : []),
        { kind: "link" as const, label: "Withdraw…", href: path(sent.id, "withdraw"), danger: true }
      ]
    });
    return [
      when(sent.createdAt, input.now),
      what,
      from(sent, input.viewer),
      sent.kind === "request" ? status[sent.status] : "",
      actions
    ];
  });
  return indexPage({
    title: "What you sent",
    content: `${refused}${table({
      label: "What you sent",
      columns: [
        { label: "Sent", nowrap: true },
        { label: "What", grow: true },
        { label: "From", nowrap: true },
        { label: "Status", nowrap: true },
        { label: "Actions", hidden: true, align: "end" }
      ],
      rows: listed
    })}`,
    ...(input.page.nextCursor === null
      ? {}
      : {
          pagination: linkButton(
            "Older",
            `/feedback?cursor=${encodeURIComponent(input.page.nextCursor)}`
          )
        })
  });
};

/**
 * Withdraw's dialog over What you sent: what goes, with what its sender sent alongside it, Cancel
 * first, then the act.
 */
export const renderWithdraw = (sent: Sent, now: number) => {
  const what =
    sent.kind === "request"
      ? `“${sent.title}”`
      : `feedback sent ${ago(sent.createdAt.toISOString(), now)}`;
  const by = sent.surface === "dashboard" ? "you" : (agentName(sent) ?? "your agent");
  return dialog({
    id: "withdraw",
    title: `Withdraw ${what}?`,
    closeHref: "/feedback",
    form: { action: path(sent.id, "withdraw") },
    body: `<p class="prose">Patchy deletes it and everything ${escapeHtml(by)} sent with it. You can’t undo this.</p>`,
    foot: `${linkButton("Cancel", "/feedback", { kind: "quiet", autofocus: true })}${button(`Withdraw ${sent.kind}`, { kind: "danger-solid" })}`
  });
};

/**
 * The panel's script: it sends each of the panel's forms in place and shows the answer. A
 * request's receipt and matches replace the form; a refused send draws the form again with its
 * field's error, and the script keeps what the person wrote in it; Same need and Unlink swap which
 * of a match's controls show. One form is in flight at a time across the panel, so two links
 * never race, and an answer for a panel reset since it was sent is dropped. An answer that isn't
 * the panel's own, or none at all, may still have been saved, so nothing is ever sent again on
 * its own: the draft stays, and a note points to What you sent. Closing the panel after a send
 * readies it for the next one. It moves only markup the server drew and toggles `hidden`.
 */
const tellScript = `(() => {
  const panel = document.getElementById("${tellPatchyPanel}");
  if (!panel) return;
  const part = (name) => panel.querySelector('[data-tell="' + name + '"]');
  const compose = () => part("compose");
  const answer = part("answer");
  const unsure = part("unsure");
  const unsureNote = part("unsure-note");
  const pristine = compose().cloneNode(true);
  let busy = false;
  let state = 0;
  const drawn = (html) => {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  };
  // Puts \`fresh\` in the form's place, keeping what the person chose and wrote.
  const swap = (fresh, keep) => {
    const old = compose();
    const kind = old.elements.namedItem("kind").value;
    const draft = old.elements.namedItem("text").value;
    old.replaceWith(fresh);
    if (keep) {
      fresh.elements.namedItem("kind").value = kind;
      fresh.elements.namedItem("text").value = draft;
    }
    return fresh;
  };
  document.addEventListener("click", (event) => {
    const opener = event.target instanceof Element && event.target.closest('[popovertarget="${tellPatchyPanel}"][data-kind]');
    if (opener) compose().elements.namedItem("kind").value = opener.dataset.kind;
  });
  const clear = () => {
    panel.querySelectorAll('[data-tell="refused"]').forEach((note) => note.remove());
    unsure.replaceChildren();
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
      if (form === compose()) swap(pristine.cloneNode(true), true);
      unsure.replaceChildren(unsureNote.content.cloneNode(true));
      return;
    }
    if (form === compose()) {
      if (!answered.ok) {
        const fresh = swap(drawn(answered.html).firstElementChild, true);
        return fresh.elements.namedItem("text").focus();
      }
      state++;
      form.hidden = true;
      answer.replaceChildren(drawn(answered.html));
      answer.hidden = false;
      return answer.focus({ preventScroll: true });
    }
    if (!answered.ok) return part("done").before(drawn(answered.html));
    const act = form.dataset.tell;
    const linked = act === "link" ? form.dataset.match : null;
    for (const other of answer.querySelectorAll('[data-tell="link"]')) other.hidden = linked !== null;
    for (const other of answer.querySelectorAll('[data-tell="unlink"], [data-tell="linked"]'))
      other.hidden = other.dataset.match !== linked;
    // The pressed button is gone; focus moves to the one that undoes it.
    const undo = answer.querySelector('[data-tell="' + (act === "link" ? "unlink" : "link") + '"][data-match="' + form.dataset.match + '"] button');
    undo?.focus();
  });
  // On a narrow window, Done also closes the Menu the panel was opened from.
  panel.addEventListener("click", (event) => {
    const menu = document.getElementById("app-menu");
    if (event.target instanceof Element && event.target.closest('[data-tell="done"]') && menu?.matches(":popover-open")) menu.hidePopover();
  });
  panel.addEventListener("toggle", (event) => {
    if (event.newState === "open") {
      if (!compose().hidden) compose().elements.namedItem("text").focus();
      return;
    }
    if (!compose().hidden) return;
    state++;
    clear();
    swap(pristine.cloneNode(true), false);
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

/**
 * What you sent, with what a request puts over or above it: a refusal from a form sent without
 * the panel's script, or the Withdraw dialog over the page.
 */
const listPage = Effect.fn("FeedbackPages.listPage")(function* (
  shown: {
    readonly refused?: Refusal;
    readonly overlay?: string;
    /** The page's `<title>` heading, for a dialog. */
    readonly title?: string;
  } = {}
) {
  const { viewer, session, request, person } = yield* context;
  const feedback = yield* Feedback.Feedback;
  const cursor =
    shown.refused === undefined && shown.overlay === undefined
      ? new URL(request.url, session.publicBaseUrl).searchParams.get("cursor")
      : null;
  const listed = yield* feedback.list(cursor === null ? { person } : { person, cursor }).pipe(
    Effect.map((page) => ({ page, first: cursor === null, refused: shown.refused })),
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
      title: shown.title ?? "What you sent",
      ...renderList({ viewer, now: yield* Clock.currentTimeMillis, ...listed }),
      status: listed.refused?.status ?? 200,
      app: { viewer, section: "feedback", overlay: shown.overlay }
    },
    session
  );
});

/**
 * A refused send: in the panel, its form drawn again with the field's error and the kind as sent;
 * otherwise What you sent with the refusal above it. Never the text.
 */
const refuseSend = Effect.fn("FeedbackPages.refuseSend")(function* (
  refused: Refusal,
  kind: SubmissionKind
) {
  const { panel } = yield* context;
  return panel
    ? panelAnswer(
        tellPatchyForm({ kind, error: `${refused.title}. ${refused.body}` }),
        refused.status
      )
    : yield* listPage({ refused });
});

/** A refused link or unlink: in the panel, the notice before Done; otherwise What you sent with it. */
const refuse = Effect.fn("FeedbackPages.refuse")(function* (refused: Refusal) {
  const { panel } = yield* context;
  return panel
    ? panelAnswer(`<div data-tell="refused">${refusalNotice(refused)}</div>`, refused.status)
    : yield* listPage({ refused });
});

/** A done form: in the panel, `html`; otherwise What you sent, leading with `receipt`. */
const done = Effect.fn("FeedbackPages.done")(function* (receiptText: string, html = "") {
  const { viewer, session, panel } = yield* context;
  if (panel) return panelAnswer(html);
  return Receipt.set(
    HttpServerResponse.redirect("/feedback", {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    }),
    { userId: viewer.user.id, text: receiptText, publicBaseUrl: session.publicBaseUrl }
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
      InvalidText: (error) => refuseSend(sendRefusal(error, kind, text), kind),
      ContainsSecret: (error) => refuseSend(sendRefusal(error, kind, text), kind),
      SendLimited: (error) => refuseSend(sendRefusal(error, kind, text), kind)
    })
  );
}).pipe(
  Effect.catchTags({
    SchemaError: () => refuseSend(brokenForm(422), "request"),
    HttpServerError: () => refuseSend(brokenForm(413), "request")
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

/** GET draws What you sent with the Withdraw dialog over it; POST withdraws and lands back on it. */
const withdraw = Effect.fn("FeedbackPages.withdraw")(
  function* (id: string, method: "GET" | "POST") {
    const { person } = yield* context;
    const feedback = yield* Feedback.Feedback;
    const sent = yield* feedback.get({ person, id });
    if (method === "POST") {
      yield* feedback.withdraw({ person, id });
      return yield* done(`Withdrew your ${sent.kind}`);
    }
    const now = yield* Clock.currentTimeMillis;
    return yield* listPage({
      title: `Withdraw ${labelOf(sent, now)}`,
      overlay: renderWithdraw(sent, now)
    });
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
