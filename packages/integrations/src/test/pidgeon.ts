import type { PidgeonSnapshot } from "@patchy/api";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import * as CredentialKeys from "../CredentialKeys.js";
import * as Source from "../pidgeon/Source.js";

/**
 * Offline Pidgeon: a scripted double of the `/v1` email API Patchy calls, under the production
 * source. One account holds inboxes, keys at Pidgeon's access levels, labels, conversations,
 * held mail and drafts, and answers as the probes of the real API recorded it: lists as pages,
 * one thing bare, refusals as `{ error: { code, message } }`, a held message's read `403 held`,
 * a draft sent once and then a message by the same id. A key reaches every inbox of the account,
 * as a dashboard key does, so what keeps a call to one inbox is Patchy's own checks. Faults can be
 * injected at any request: an answer instead, or the work done and its answer lost.
 * What only Pidgeon decides for real, such as threading or the firewall, is the live tier's.
 */

export type Level = "read" | "draft" | "send" | "admin";
const rank: Readonly<Record<Level, number>> = { read: 0, draft: 1, send: 2, admin: 3 };

/** One request the double saw, as Patchy built it. */
export interface Built {
  readonly method: string;
  /** Under `/v1`. */
  readonly path: string;
  readonly authorization: string | undefined;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Matches requests by method and path under `/v1`, such as `POST /email/drafts/msg_3/send`. */
export const route =
  (method: string, path: string | RegExp) =>
  (sent: Pick<Built, "method" | "path">): boolean =>
    sent.method === method &&
    (typeof path === "string" ? sent.path === path : path.test(sent.path));

/**
 * What a fault does to a request it matches: answer `status` and `body` before anything changes,
 * or `lost`, do the work and lose the answer, as a connection that dropped would.
 */
export type Fault = { readonly status: number; readonly body?: unknown } | { readonly lost: true };

interface Inbox {
  readonly id: string;
  readonly address: string;
  readonly kind: "agent" | "events";
  readonly display_name: string | null;
  readonly created_at: string;
}
interface Label {
  readonly id: string;
  readonly inbox_id: string;
  readonly name: string;
  readonly colour: string;
  readonly created_at: string;
}
interface Thread {
  readonly id: string;
  readonly inbox_id: string;
  subject: string | null;
  folder: "inbox" | "archive" | "spam" | "trash";
  status: "open" | "waiting" | "resolved" | "human_review";
  readonly labels: Set<string>;
  readonly created_at: string;
  last_message_at: string | null;
}
interface Message {
  readonly id: string;
  readonly thread_id: string;
  readonly inbox_id: string;
  readonly direction: "in" | "out";
  readonly from: { readonly address: string; readonly name: string | null };
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string | null;
  readonly text: string;
  readonly test: boolean;
  held: boolean;
  seen: boolean;
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly filename: string;
    readonly content_type: string;
    readonly size: number;
  }>;
  readonly signals: ReadonlyArray<string>;
  readonly created_at: string;
}
interface Draft {
  readonly id: string;
  readonly inbox_id: string;
  readonly thread_id: string;
  status: "draft" | "held";
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string | null;
  readonly text: string;
  readonly test: boolean;
}

const json = (status: number, body: unknown) =>
  status === 204 ? new Response(null, { status }) : Response.json(body, { status });
const refuse = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });
const NEEDS: Readonly<Record<Level, string>> = {
  read: "This key cannot do that: it needs `read` access or more.",
  draft: "This key cannot do that: it needs `draft` access or more.",
  send: "This key cannot do that: it needs `send` access or more.",
  admin: "This key cannot do that: it needs `admin` access or more."
};
const NAME = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

/** The double, its account's state, and the helpers a test sets it up and checks it with. */
export const double = () => {
  const requests: Built[] = [];
  const keys = new Map<string, { readonly level: Level }>();
  const inboxes = new Map<string, Inbox>();
  const labels = new Map<string, Label>();
  const threads = new Map<string, Thread>();
  const messages = new Map<string, Message>();
  const drafts = new Map<string, Draft>();
  const faults: Array<{ match: (sent: Built) => boolean; fault: Fault; times: number }> = [];
  const holds: Array<{
    match: (sent: Built) => boolean;
    release: Deferred.Deferred<void>;
    times: number;
  }> = [];
  let flagged = false;
  let serial = 0;
  const next = (prefix: string) => `${prefix}_${++serial}`;
  const now = () => new Date(Date.UTC(2026, 10, 15, 9, 0, serial)).toISOString();

  const inboxRow = (inbox: Inbox) => ({
    id: inbox.id,
    address: inbox.address,
    kind: inbox.kind,
    display_name: inbox.display_name,
    pod_id: "pod_1",
    agent_id: null,
    status: "active",
    hold_suspicious: true,
    created_at: inbox.created_at
  });
  const labelRef = (id: string) => {
    const found = labels.get(id)!;
    return { id: found.id, name: found.name, colour: found.colour };
  };
  const of = (thread: Thread) => [...messages.values()].filter((m) => m.thread_id === thread.id);
  const threadRow = (thread: Thread) => {
    const within = of(thread);
    return {
      id: thread.id,
      inbox_id: thread.inbox_id,
      // While every message in it is held, the list says nothing the held mail says.
      subject: within.length > 0 && within.every((m) => m.held) ? null : thread.subject,
      folder: thread.folder,
      starred: false,
      status: thread.status,
      owner_type: "agent",
      assignee_id: null,
      last_message_at: thread.last_message_at,
      created_at: thread.created_at,
      labels: [...thread.labels].map(labelRef),
      message_count: within.length,
      unread_count: within.filter((m) => !m.seen).length
    };
  };
  const messageRow = (message: Message) => ({
    id: message.id,
    thread_id: message.thread_id,
    inbox_id: message.inbox_id,
    direction: message.direction,
    status: message.direction === "in" ? "received" : "sent",
    from: message.from,
    to: message.to,
    cc: message.cc,
    ...(message.direction === "out" ? { bcc: [] } : {}),
    spam: false,
    seen: message.seen,
    test: message.test,
    created_at: message.created_at,
    sent_at: message.direction === "out" ? message.created_at : null,
    is_held: message.held,
    attachments: message.held ? [] : message.attachments,
    subject: message.held ? null : message.subject,
    text: message.held ? null : message.text,
    html: null,
    firewall:
      message.direction === "out"
        ? null
        : {
            verdict: message.signals.length === 0 ? "clean" : "suspicious",
            signals: message.signals.map((kind) => ({ kind, detail: "quoted", where: "text" })),
            ...(message.held ? {} : { clean_text: message.text }),
            version: 5
          }
  });
  const draftRow = (draft: Draft) => ({
    id: draft.id,
    inbox_id: draft.inbox_id,
    thread_id: draft.thread_id,
    status: draft.status,
    to: draft.to,
    cc: draft.cc,
    bcc: [],
    subject: draft.subject,
    text: draft.text,
    html: null,
    send_at: null
  });
  /** One page of `items` from `query`'s cursor, a position. */
  const paged = <A>(
    items: ReadonlyArray<A>,
    query: Readonly<Record<string, string>>,
    max = 100
  ) => {
    const limit = Math.min(Number(query.limit ?? 50), max);
    const start = Number(query.cursor ?? 0);
    const data = items.slice(start, start + limit);
    const more = start + limit < items.length;
    return { data, has_more: more, next_cursor: more ? String(start + limit) : null };
  };
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const record = (value: unknown): Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  /** Pidgeon's answer to one request, changing the account as Pidgeon would. */
  const answer = (sent: Built): Response => {
    const token = sent.authorization?.replace(/^Bearer /, "") ?? "";
    const key = keys.get(token);
    if (key === undefined) return refuse(401, "unauthenticated", "That API key is not valid.");
    const needs = (level: Level) =>
      rank[key.level] >= rank[level] ? undefined : refuse(403, "forbidden", NEEDS[level]);
    const test = Source.isTestToken(token);
    const parts = sent.path
      .split("/")
      .filter((part) => part !== "")
      .map(decodeURIComponent);
    const [area, kind, id, sub, subId] = parts;
    if (area !== "email") return refuse(404, "not_found", "There is no such thing.");
    const body = record(sent.body);
    const at = `${sent.method} ${kind}${id === undefined ? "" : "/:id"}${sub === undefined ? "" : `/${sub}`}${subId === undefined ? "" : "/:id"}`;
    switch (at) {
      case "GET inboxes":
        return json(200, paged([...inboxes.values()].map(inboxRow), sent.query));
      case "GET inboxes/:id": {
        const inbox = inboxes.get(id!);
        return inbox === undefined
          ? refuse(404, "not_found", "There is no such inbox in this account.")
          : json(200, inboxRow(inbox));
      }
      case "POST inboxes": {
        const refused = needs("admin");
        if (refused !== undefined) return refused;
        const name = typeof body.name === "string" ? body.name : "";
        if (
          !NAME.test(name) ||
          (body.kind !== undefined && body.kind !== "agent" && body.kind !== "events")
        )
          return refuse(400, "invalid", "Send `name`: 1–64 of a-z 0–9 . _ + -.");
        const inbox: Inbox = {
          id: next("inb"),
          address: `${name}@pidgeon.email`,
          kind: body.kind === "events" ? "events" : "agent",
          display_name: typeof body.display_name === "string" ? body.display_name : null,
          created_at: now()
        };
        inboxes.set(inbox.id, inbox);
        return json(201, inboxRow(inbox));
      }
      case "DELETE inboxes/:id": {
        const refused = needs("admin");
        if (refused !== undefined) return refused;
        if (!inboxes.delete(id!))
          return refuse(404, "not_found", "There is no such inbox in this account.");
        return json(204, null);
      }
      case "GET inboxes/:id/labels":
        if (!inboxes.has(id!))
          return refuse(404, "not_found", "There is no such inbox in this account.");
        return json(200, {
          data: [...labels.values()]
            .filter((label) => label.inbox_id === id)
            .sort((a, b) => a.name.localeCompare(b.name))
        });
      case "GET threads": {
        const rows = [...threads.values()]
          .filter((thread) => of(thread).length > 0)
          .filter(
            (thread) =>
              (sent.query.inbox_id === undefined || thread.inbox_id === sent.query.inbox_id) &&
              (sent.query.status === undefined || thread.status === sent.query.status) &&
              (sent.query.folder === undefined || thread.folder === sent.query.folder) &&
              (sent.query.label_id === undefined || thread.labels.has(sent.query.label_id))
          )
          .sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""))
          .map(threadRow);
        return json(200, paged(rows, sent.query));
      }
      case "GET threads/:id": {
        const thread = threads.get(id!);
        if (thread === undefined)
          return refuse(404, "not_found", "There is no such conversation in this account.");
        const within = of(thread).map(messageRow);
        return json(200, { ...threadRow(thread), messages: paged(within, sent.query, 200) });
      }
      case "PATCH threads/:id": {
        const refused = needs("draft");
        if (refused !== undefined) return refused;
        const thread = threads.get(id!);
        if (thread === undefined)
          return refuse(404, "not_found", "There is no such conversation in this account.");
        if (typeof body.status === "string") thread.status = body.status as Thread["status"];
        return json(200, threadRow(thread));
      }
      case "POST threads/:id/labels": {
        const refused = needs("draft");
        if (refused !== undefined) return refused;
        const thread = threads.get(id!);
        if (thread === undefined)
          return refuse(404, "not_found", "There is no such conversation in this account.");
        const label = typeof body.label_id === "string" ? labels.get(body.label_id) : undefined;
        if (label === undefined)
          return refuse(404, "not_found", "There is no such label in this account.");
        if (label.inbox_id !== thread.inbox_id)
          return refuse(400, "invalid", "A label goes only on conversations of its own inbox.");
        thread.labels.add(label.id);
        return json(200, threadRow(thread));
      }
      case "DELETE threads/:id/labels/:id": {
        const refused = needs("draft");
        if (refused !== undefined) return refused;
        const thread = threads.get(id!);
        if (thread === undefined)
          return refuse(404, "not_found", "There is no such conversation in this account.");
        thread.labels.delete(subId!);
        return json(200, threadRow(thread));
      }
      case "GET messages/:id": {
        const message = messages.get(id!);
        if (message === undefined)
          return refuse(404, "not_found", "There is no such message in this account.");
        if (message.held)
          return refuse(
            403,
            "held",
            "This message is held for a person: it reads once a member releases it."
          );
        return json(200, messageRow(message));
      }
      case "GET search": {
        const words = (sent.query.q ?? "")
          .toLowerCase()
          .split(/\s+/)
          .filter((word) => word !== "");
        const rows = [...messages.values()]
          .filter((message) => !message.held)
          .filter(
            (message) =>
              sent.query.inbox_id === undefined || message.inbox_id === sent.query.inbox_id
          )
          .filter((message) => {
            const haystack =
              `${message.subject ?? ""} ${message.text} ${message.from.address}`.toLowerCase();
            return words.every((word) => haystack.includes(word));
          })
          .reverse()
          .map(messageRow);
        return json(200, paged(rows, sent.query));
      }
      case "POST inboxes/:id/drafts": {
        const refused = needs("draft");
        if (refused !== undefined) return refused;
        const inbox = inboxes.get(id!);
        if (inbox === undefined)
          return refuse(404, "not_found", "There is no such inbox in this account.");
        const to = strings(body.to);
        if (to.length === 0) return refuse(400, "invalid", "Send `to`: at least one address.");
        let threadId: string;
        if (body.reply_to !== undefined) {
          const target =
            typeof body.reply_to === "string" ? messages.get(body.reply_to) : undefined;
          if (target === undefined || target.inbox_id !== inbox.id)
            return refuse(404, "not_found", "There is no such message in this inbox to reply to.");
          threadId = target.thread_id;
        } else {
          const thread: Thread = {
            id: next("thr"),
            inbox_id: inbox.id,
            subject: typeof body.subject === "string" ? body.subject : null,
            folder: "inbox",
            status: "open",
            labels: new Set(),
            created_at: now(),
            last_message_at: null
          };
          threads.set(thread.id, thread);
          threadId = thread.id;
        }
        const draft: Draft = {
          id: next("msg"),
          inbox_id: inbox.id,
          thread_id: threadId,
          status: "draft",
          to,
          cc: strings(body.cc),
          subject: typeof body.subject === "string" ? body.subject : null,
          text: typeof body.text === "string" ? body.text : "",
          test
        };
        drafts.set(draft.id, draft);
        return json(201, draftRow(draft));
      }
      case "GET drafts/:id": {
        const draft = drafts.get(id!);
        return draft === undefined
          ? refuse(404, "not_found", "There is no such draft in this account.")
          : json(200, draftRow(draft));
      }
      case "DELETE drafts/:id": {
        const refused = needs("draft");
        if (refused !== undefined) return refused;
        return drafts.delete(id!)
          ? json(204, null)
          : refuse(404, "not_found", "There is no such draft in this account.");
      }
      case "POST drafts/:id/send": {
        const refused = needs("send");
        if (refused !== undefined) return refused;
        const draft = drafts.get(id!);
        if (draft === undefined)
          return refuse(404, "not_found", "There is no such draft in this account.");
        if (draft.status !== "draft")
          return refuse(409, "draft_not_editable", "This draft is no longer a draft.");
        if (flagged) {
          draft.status = "held";
          return json(202, { id: draft.id, thread_id: draft.thread_id, status: "held" });
        }
        leave(draft);
        return json(201, { id: draft.id, thread_id: draft.thread_id, status: "sent" });
      }
      default:
        return refuse(404, "not_found", "There is no such thing.");
    }
  };
  /** A draft leaves as a message by its own id. */
  const leave = (draft: Draft) => {
    drafts.delete(draft.id);
    const inbox = inboxes.get(draft.inbox_id)!;
    const thread = threads.get(draft.thread_id)!;
    const created_at = now();
    messages.set(draft.id, {
      id: draft.id,
      thread_id: draft.thread_id,
      inbox_id: draft.inbox_id,
      direction: "out",
      from: { address: inbox.address, name: inbox.display_name },
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject ?? thread.subject,
      text: draft.text,
      test: draft.test,
      held: false,
      seen: true,
      attachments: [],
      signals: [],
      created_at
    });
    thread.last_message_at = created_at;
  };

  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const sent: Built = {
        method: request.method,
        path: url.pathname.replace(/^\/v1/, ""),
        authorization: request.headers.authorization,
        query: Object.fromEntries(url.searchParams),
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined
      };
      requests.push(sent);
      const held = holds.findIndex((hold) => hold.match(sent));
      if (held !== -1) {
        const hold = holds[held]!;
        if (--hold.times === 0) holds.splice(held, 1);
        yield* Deferred.await(hold.release);
      }
      const found = faults.findIndex((item) => item.match(sent));
      const fault = found === -1 ? undefined : faults[found]!;
      if (fault !== undefined && --fault.times === 0) faults.splice(found, 1);
      const response =
        fault === undefined
          ? answer(sent)
          : "lost" in fault.fault
            ? (answer(sent), new Response("<html>502 Bad Gateway</html>", { status: 502 }))
            : typeof fault.fault.body === "string"
              ? new Response(fault.fault.body, { status: fault.fault.status })
              : json(fault.fault.status, fault.fault.body ?? {});
      return HttpClientResponse.fromWeb(request, response);
    })
  );

  return {
    requests,
    layer: Layer.effect(Source.Source, Source.make).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
    ),
    /** A key of the account at `level`, test unless `live`; `token` registers a seeded one. */
    key: (level: Level, options: { readonly live?: boolean; readonly token?: string } = {}) => {
      const token =
        options.token ?? `pgn_${options.live === true ? "" : "test_"}k${++serial}${"x".repeat(31)}`;
      keys.set(token, { level });
      return token;
    },
    /** Revokes a key: it answers 401 from now on. */
    revoke: (token: string) => keys.delete(token),
    inbox: (
      name: string,
      options: {
        readonly id?: string;
        readonly kind?: "agent" | "events";
        readonly displayName?: string;
      } = {}
    ) => {
      const inbox: Inbox = {
        id: options.id ?? next("inb"),
        address: name.includes("@") ? name : `${name}@pidgeon.email`,
        kind: options.kind ?? "agent",
        display_name: options.displayName ?? null,
        created_at: now()
      };
      inboxes.set(inbox.id, inbox);
      return inbox.id;
    },
    removeInbox: (id: string) => inboxes.delete(id),
    label: (inboxId: string, name: string, colour = "slate") => {
      const label: Label = { id: next("lbl"), inbox_id: inboxId, name, colour, created_at: now() };
      labels.set(label.id, label);
      return label.id;
    },
    /** Mail from outside, into `inboxId`: a new conversation, or `thread`'s; ids may be named. */
    deliver: (
      inboxId: string,
      mail: {
        readonly id?: string;
        readonly threadId?: string;
        readonly from: string;
        readonly name?: string;
        readonly subject: string;
        readonly text: string;
        readonly thread?: string;
        readonly held?: boolean;
        readonly signals?: ReadonlyArray<string>;
        readonly attachments?: ReadonlyArray<{ readonly filename: string; readonly size: number }>;
      }
    ) => {
      const inbox = inboxes.get(inboxId)!;
      const created_at = now();
      let thread = mail.thread === undefined ? undefined : threads.get(mail.thread);
      if (thread === undefined) {
        thread = {
          id: mail.threadId ?? next("thr"),
          inbox_id: inboxId,
          subject: mail.subject,
          folder: "inbox",
          status: "open",
          labels: new Set(),
          created_at,
          last_message_at: null
        };
        threads.set(thread.id, thread);
      }
      thread.last_message_at = created_at;
      const message: Message = {
        id: mail.id ?? next("msg"),
        thread_id: thread.id,
        inbox_id: inboxId,
        direction: "in",
        from: { address: mail.from, name: mail.name ?? null },
        to: [inbox.address],
        cc: [],
        subject: mail.subject,
        text: mail.text,
        test: true,
        held: mail.held ?? false,
        seen: false,
        attachments: (mail.attachments ?? []).map((file) => ({
          id: next("att"),
          filename: file.filename,
          content_type: "application/pdf",
          size: file.size
        })),
        signals: mail.signals ?? (mail.held === true ? ["assistant_directive"] : []),
        created_at
      };
      messages.set(message.id, message);
      return { messageId: message.id, threadId: thread.id };
    },
    /** A draft someone else wrote in `inboxId`, in a new conversation, as Pidgeon keeps it. */
    draft: (
      inboxId: string,
      mail: { readonly to: ReadonlyArray<string>; readonly subject: string; readonly text: string }
    ) => {
      const thread: Thread = {
        id: next("thr"),
        inbox_id: inboxId,
        subject: mail.subject,
        folder: "inbox",
        status: "open",
        labels: new Set(),
        created_at: now(),
        last_message_at: null
      };
      threads.set(thread.id, thread);
      const draft: Draft = {
        id: next("msg"),
        inbox_id: inboxId,
        thread_id: thread.id,
        status: "draft",
        to: mail.to,
        cc: [],
        subject: mail.subject,
        text: mail.text,
        test: true
      };
      drafts.set(draft.id, draft);
      return draft;
    },
    /** A member releases a held message: keys read it from now on. */
    release: (messageId: string) => {
      messages.get(messageId)!.held = false;
    },
    /** Every message sends held for a member, as a flagged account's do. */
    flag: (on = true) => {
      flagged = on;
    },
    /** A member approves a held send: it leaves as a message by its own id. */
    approve: (draftId: string) => leave(drafts.get(draftId)!),
    /** A member rejects a held send: it never leaves. */
    reject: (draftId: string) => drafts.delete(draftId),
    /** Applies `fault` to the next `times` requests that match. */
    fault: (match: (sent: Built) => boolean, fault: Fault, times = 1) => {
      faults.push({ match, fault, times });
    },
    /** Holds the next `times` requests that match until `release` completes. */
    hold: (match: (sent: Built) => boolean, release: Deferred.Deferred<void>, times = 1) => {
      holds.push({ match, release, times });
    },
    /** What the account holds, for a test to check. */
    sentFrom: (inboxId: string) =>
      [...messages.values()].filter((m) => m.inbox_id === inboxId && m.direction === "out"),
    drafts: () => [...drafts.values()],
    thread: (id: string) => threads.get(id),
    message: (id: string) => messages.get(id)
  };
};
export type Double = ReturnType<typeof double>;

/** A double nothing in it reaches yet: for suites that need a Pidgeon source, not Pidgeon. */
export const canned = () => double();

/** A Pidgeon connection as connect saves one, written straight into the database. */
export const seed = Effect.fn("PidgeonTest.seed")(function* (input: {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly handle: string;
  readonly test?: boolean;
  readonly access?: "read" | "send";
  /** The inbox and key the connection holds; by default its own, made up from its id. */
  readonly inboxId?: string;
  readonly email?: string;
  readonly key?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* CredentialKeys.CredentialKeys;
  const test = input.test ?? false;
  const access = input.access ?? "send";
  const email = input.email ?? `${input.handle}@acme.example`;
  const inboxId = input.inboxId ?? `inb-${input.id}`;
  const key =
    input.key ??
    `pgn_${test ? "test_" : ""}seeded${input.id.replace(/[^A-Za-z0-9]/g, "")}`.padEnd(32, "0");
  const display: Source.Display = { email, inboxId, access, test };
  const credentials: Source.Credentials = { inboxId, key };
  const encrypted = yield* keys.encrypt(
    { companyId: input.companyId, id: input.id, integration: "pidgeon" },
    Source.credentials(credentials)
  );
  const snapshot: PidgeonSnapshot = {
    version: 2,
    address: { email, displayName: null },
    access,
    test,
    labels: [
      { id: "lbl-1", name: "Billing", colour: "amber" },
      { id: "lbl-2", name: "Bugs", colour: "red" }
    ]
  };
  yield* sql`INSERT INTO connections
    (id, company_id, integration, handle, description, mode, status, display, credentials, key_id,
     credential_revision, metadata_revision, created_by, last_tested_at, last_discovered_at)
    VALUES (${input.id}, ${input.companyId}, 'pidgeon', ${input.handle}, 'Customer questions',
      'company', 'connected', ${JSON.stringify(display)}::jsonb, ${encrypted.credentials},
      ${encrypted.keyId}, 1, 1, ${input.userId}, now(), now())`;
  yield* sql`INSERT INTO connection_snapshots
    (company_id, connection_id, integration, revision, snapshot, created_at)
    VALUES (${input.companyId}, ${input.id}, 'pidgeon', 1, ${JSON.stringify(snapshot)}::jsonb, now())`;
  return { key, inboxId, email, display, credentials };
});

/**
 * A tier 2 support desk, the same offline and live. `answer` finds the open conversation with
 * `subject`, reads it to the end, replies to its newest message with the draft key the page made,
 * and marks it waiting. `forced` writes through `invoices`, a read connection, and `peek` writes
 * from a read-only action: the host refuses both.
 */
export const desk = {
  source: `import { action, createGuest, t } from "patchy/server";
const answer = action({
  args: { subject: t.text(), draft: t.text(), text: t.text() },
  result: t.json(),
  handler: async (ctx, { subject, draft, text }) => {
    const inbox = ctx.connections.support;
    const { threads } = await inbox.threads.list({ status: "open", cursor: undefined });
    const thread = threads.find((item) => item.subject === subject);
    if (thread === undefined) return { found: false };
    const messages = [];
    let cursor;
    do {
      const page = await inbox.threads.get(thread.id, { cursor });
      messages.push(...page.messages);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    const files = messages.flatMap((message) => message.attachments).map((file) => file.filename);
    const repliedTo = messages.at(-1).id;
    const sent = await inbox.messages.reply(repliedTo, { text, idempotencyKey: draft });
    const after = await inbox.threads.update(thread.id, { status: "waiting" });
    return { found: true, threadId: thread.id, messages: messages.length, files, repliedTo, sent, status: after.status };
  }
});
const forced = action({ args: {}, result: t.json(), handler: async (ctx) =>
  ctx.connections.invoices.messages.reply("msg_1", { text: "Hi", idempotencyKey: "desk-forced-01" })
});
const peek = action({ readOnly: true, args: {}, result: t.json(), handler: async (ctx) =>
  ctx.connections.support.messages.reply("msg_1", { text: "Hi", idempotencyKey: "desk-peek-0001" })
});
export default createGuest({ desk: { answer, forced, peek } }, [], {}, ["support", "invoices"]);
`,
  handlers: {
    "desk.answer": {
      kind: "action",
      args: { subject: { kind: "text" }, draft: { kind: "text" }, text: { kind: "text" } },
      result: { kind: "json" }
    },
    "desk.forced": { kind: "action", args: {}, result: { kind: "json" } },
    "desk.peek": { kind: "action", readOnly: true, args: {}, result: { kind: "json" } }
  }
} as const;
