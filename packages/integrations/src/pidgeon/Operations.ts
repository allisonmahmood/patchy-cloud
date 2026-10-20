/**
 * PROTOTYPE (Pidgeon): the operations patch code may call on one address. Each is a fixed
 * Pidgeon request Patchy wrote, with the address filled in by Patchy, so a patch can't read or
 * send as any other address. Message bodies come cleaned by Pidgeon's firewall, with its
 * verdict alongside, so text hidden from a person never reaches a patch as if it were visible.
 */
import {
  type PidgeonCall,
  PidgeonReadCall,
  PidgeonRead,
  PidgeonWrite,
  PidgeonWriteCall
} from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../ConnectionStore.js";
import { operation } from "../definition.js";
import * as Source from "./Source.js";

export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "PidgeonConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  override get message() {
    return "This Pidgeon connection is not declared by this version.";
  }
}
/** The key stopped working after connect: only an admin can fix it. */
export class ConnectionRefused extends Schema.TaggedError<ConnectionRefused>()(
  "PidgeonConnectionRefused",
  {}
) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "Pidgeon refused this connection's key: it was revoked or expired. Ask a company administrator to replace it at /company/connections.";
  }
}

export const Errors = Schema.Union([
  ConnectionNotDeclared,
  ConnectionRefused,
  Source.NotFound,
  Source.Refused,
  Source.RateLimited,
  Source.Unavailable,
  Source.Timeout,
  Source.TooLarge,
  Runtime.InvalidRequest,
  Runtime.AccessDenied,
  Runtime.SourceUnavailable
]);

const DEADLINE_MS = registry["integration.deadline"].default;

/** One call to Pidgeon with the connection's key and deadline already applied. */
export type Api = (request: Source.Request) => Effect.Effect<unknown, Source.CallError>;
/** The connection's one address. */
export interface Mailbox {
  readonly email: string;
  readonly identityId: string;
  /** Namespaces idempotency keys, so two connections' sends never collide. */
  readonly connectionId: string;
}

// --- Pidgeon's shapes to what patches see ----------------------------------------------------

type Json = typeof Schema.Json.Type;
type Node = Readonly<Record<string, unknown>>;
const record = (value: unknown): Node => (Predicate.isObject(value) ? (value as Node) : {});
const list = (value: unknown): ReadonlyArray<Node> =>
  Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const party = (value: unknown) => {
  const found = record(value);
  return { email: text(found.email) ?? "", name: text(found.name) };
};
const label = (node: Node) => ({
  id: text(node.id),
  name: text(node.name),
  colour: text(node.colour)
});
const thread = (node: Node) => ({
  id: text(node.id),
  subject: text(node.subject),
  status: text(node.status),
  messageCount: typeof node.message_count === "number" ? node.message_count : 0,
  from:
    text(node.from) === null ? null : { email: text(node.from) ?? "", name: text(node.from_name) },
  preview: text(node.preview),
  hasAttachments: node.has_attachments === true,
  lastMessageAt: text(node.last_message_at),
  createdAt: text(node.created_at)
});
const firewall = (value: unknown) => {
  if (!Predicate.isObject(value)) return null;
  const found = record(value);
  return {
    verdict: found.verdict === "suspicious" ? ("suspicious" as const) : ("clean" as const),
    signals: list(found.signals).map((signal) => ({
      kind: text(signal.kind),
      detail: text(signal.detail)
    }))
  };
};
const message = (node: Node) => ({
  id: text(node.id),
  threadId: text(node.thread_id),
  direction: node.direction === "outbound" ? ("outbound" as const) : ("inbound" as const),
  from: party(node.from),
  to: list(node.to).map(party),
  cc: list(node.cc).map(party),
  subject: text(node.subject),
  // `body=clean`: the firewall's reading, with hidden text and invisible characters removed.
  text: text(node.text) ?? "",
  attachments: list(node.attachments).map((file) => ({
    id: text(file.id),
    filename: text(file.filename),
    contentType: text(file.content_type),
    size: typeof file.size === "number" ? file.size : null
  })),
  firewall: firewall(node.firewall),
  createdAt: text(node.created_at)
});
const hit = (node: Node) => ({
  messageId: text(node.id),
  threadId: text(node.thread_id),
  direction: node.direction === "outbound" ? ("outbound" as const) : ("inbound" as const),
  from: { email: text(node.from) ?? "", name: text(node.from_name) },
  to: Array.isArray(node.to) ? node.to.filter((item) => typeof item === "string") : [],
  subject: text(node.subject),
  preview: text(node.preview),
  hasAttachments: node.has_attachments === true,
  at: text(node.timestamp)
});
const page = <A>(body: unknown, map: (node: Node) => A) => {
  const found = record(body);
  return {
    items: list(found.data).map(map),
    nextCursor: found.has_more === true ? text(found.next_cursor) : null
  };
};

// --- running one operation -------------------------------------------------------------------

/** Every message on the address carries its id; anything else isn't this connection's. */
const ownMessage = (mailbox: Mailbox, node: Node) =>
  node.identity_id === mailbox.identityId ? Effect.void : Effect.fail(new Source.NotFound({}));

/** The Pidgeon calls one operation makes, and what the patch sees. */
export const run = Effect.fn("PidgeonOperations.run")(function* (
  api: Api,
  mailbox: Mailbox,
  call: PidgeonCall
) {
  const at = mailbox.identityId;
  const idempotency = (key: string) => `patchy-${mailbox.connectionId}-${key}`.slice(0, 200);
  switch (call.operation) {
    case "threads.list": {
      const found = page(
        yield* api({
          method: "GET",
          path: "/threads",
          query: {
            identity_id: at,
            status: call.input.status,
            limit: call.input.limit ?? 25,
            cursor: call.input.cursor
          }
        }),
        thread
      );
      return { threads: found.items, nextCursor: found.nextCursor };
    }
    case "threads.get": {
      const id = encodeURIComponent(call.input.id);
      const found = record(Source.data(yield* api({ method: "GET", path: `/threads/${id}` })));
      if (found.identity !== mailbox.email && found.identity !== mailbox.identityId)
        return yield* new Source.NotFound({});
      const [messages, labels] = yield* Effect.all(
        [
          api({
            method: "GET",
            path: "/messages",
            query: { thread_id: call.input.id, body: "clean", limit: 50 }
          }),
          api({ method: "GET", path: `/threads/${id}/labels` })
        ],
        { concurrency: 2 }
      );
      const read = page(messages, message);
      return {
        thread: thread(found),
        labels: page(labels, label).items,
        messages: read.items,
        moreMessages: read.nextCursor !== null
      };
    }
    case "messages.get": {
      const found = record(
        Source.data(
          yield* api({
            method: "GET",
            path: `/messages/${encodeURIComponent(call.input.id)}`,
            query: { body: "clean" }
          })
        )
      );
      yield* ownMessage(mailbox, found);
      return message(found);
    }
    case "messages.search": {
      const input = call.input;
      const found = page(
        yield* api({
          method: "GET",
          path: "/messages/search",
          query: {
            identity_id: at,
            q: input.text,
            from: input.from,
            to: input.to,
            label_id: input.labelId,
            has_attachment: input.hasAttachment,
            in: input.folder,
            limit: input.limit ?? 25
          }
        }),
        hit
      );
      return { hits: found.items };
    }
    case "labels.list":
      return {
        labels: page(
          yield* api({ method: "GET", path: "/labels", query: { identity_id: at } }),
          label
        ).items
      };
    case "attachments.text": {
      const found = record(
        Source.data(
          yield* api({
            method: "GET",
            path: `/attachments/${encodeURIComponent(call.input.id)}/text`,
            query: { body: "clean" }
          })
        )
      );
      return {
        id: text(found.id),
        filename: text(found.filename),
        contentType: text(found.content_type),
        text: text(found.text) ?? "",
        truncated: found.truncated === true,
        firewall: firewall(found.firewall)
      };
    }
    case "messages.send":
    case "messages.reply": {
      const input = call.input;
      const body =
        call.operation === "messages.send"
          ? {
              from: mailbox.email,
              to: call.input.to,
              ...(call.input.cc === undefined ? {} : { cc: call.input.cc }),
              subject: call.input.subject,
              text: call.input.text
            }
          : { text: input.text, ...(input.cc === undefined ? {} : { cc: input.cc }) };
      const found = record(
        Source.data(
          yield* api({
            method: "POST",
            path:
              call.operation === "messages.send"
                ? "/messages"
                : `/messages/${encodeURIComponent(call.input.id)}/reply`,
            body,
            idempotencyKey: idempotency(input.idempotencyKey)
          })
        )
      );
      return {
        messageId: text(found.id),
        threadId: text(found.thread_id),
        rejected: list(found.rejected).map((item) => ({
          address: text(item.address),
          reason: text(item.reason)
        }))
      };
    }
    case "threads.update":
      return thread(
        record(
          Source.data(
            yield* api({
              method: "PATCH",
              path: `/threads/${encodeURIComponent(call.input.id)}`,
              body: { status: call.input.status }
            })
          )
        )
      );
    case "threads.label":
    case "threads.unlabel": {
      const id = encodeURIComponent(call.input.id);
      const answer =
        call.operation === "threads.label"
          ? yield* api({
              method: "POST",
              path: `/threads/${id}/labels`,
              body: { label_id: call.input.labelId }
            })
          : yield* api({
              method: "DELETE",
              path: `/threads/${id}/labels`,
              query: { label_id: call.input.labelId }
            });
      return { labels: page(answer, label).items };
    }
  }
});

// --- the published runtime's handlers --------------------------------------------------------

const connect = Effect.fn("PidgeonOperations.connect")(function* (
  companyId: string,
  declared: { readonly id: string; readonly handle: string }
) {
  const connections = yield* ConnectionStore.ConnectionStore;
  const connection = yield* connections
    .get(companyId, declared.id)
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ConnectionNotFound" ? cause : new Runtime.SourceUnavailable({ cause })
      )
    );
  if (
    connection.companyId !== companyId ||
    connection.id !== declared.id ||
    connection.integration !== "pidgeon" ||
    connection.handle !== declared.handle
  )
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId,
      lookup: { id: declared.id }
    });
  if (connection.status !== "connected")
    return yield* new ConnectionStore.ConnectionNotConnected({});
  const secret = yield* connections
    .poolCredentials(
      companyId,
      {
        kind: "pidgeon",
        id: connection.id,
        handle: connection.handle,
        revision: connection.metadataRevision
      },
      connection.credentialRevision
    )
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ConnectionNotConnected" || cause._tag === "ConnectionNotFound"
          ? cause
          : new Runtime.SourceUnavailable({ cause })
      )
    );
  const credentials = yield* Source.parseCredentials(secret).pipe(
    Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
  );
  return { credentials, display: connection.display };
});

const perform = Effect.fn("PidgeonOperations.perform")(function* (
  call: PidgeonCall & {
    readonly connection: string;
  }
) {
  const binding = yield* Binding.Binding;
  const declaration = binding.manifest.uses[call.connection];
  if (!Object.hasOwn(binding.manifest.uses, call.connection) || declaration?.kind !== "pidgeon")
    return yield* new ConnectionNotDeclared({});
  if (
    binding.scope !== "company" ||
    binding.identity === null ||
    binding.principal === null ||
    binding.identity.company.id !== binding.companyId ||
    binding.identity.user.id !== binding.principal.userId
  )
    return yield* new Runtime.AccessDenied({});
  const deadline = binding.deadline ?? (yield* Clock.currentTimeMillis) + DEADLINE_MS;
  const source = yield* Source.Source;
  const found = yield* connect(binding.companyId, declaration).pipe(
    Effect.catchTags({
      ConnectionNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
      ConnectionNotConnected: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
    })
  );
  const api: Api = (request) => source.call(found.credentials, request, deadline);
  const result = yield* run(
    api,
    {
      email: found.display.email,
      identityId: found.display.identityId,
      connectionId: declaration.id
    },
    { operation: call.operation, input: call.input } as PidgeonCall
  ).pipe(Effect.catchTags({ PidgeonKeyRejected: () => Effect.fail(new ConnectionRefused({})) }));
  return result as Json;
});

const read = operation({
  input: PidgeonRead,
  output: Schema.Json,
  errors: Errors,
  run: Effect.fn("PidgeonOperations.read")(function* (args: typeof PidgeonRead.Type) {
    return yield* perform(args);
  })
});
const write = operation({
  input: PidgeonWrite,
  output: Schema.Json,
  errors: Errors,
  run: Effect.fn("PidgeonOperations.write")(function* (args: typeof PidgeonWrite.Type) {
    return yield* perform(args);
  })
});

export const operations = { read, write };

const connectionId = (args: unknown, binding: Binding.Binding["Service"]): string | null => {
  if (
    !Predicate.isObject(args) ||
    typeof args.connection !== "string" ||
    !Object.hasOwn(binding.manifest.uses, args.connection)
  )
    return null;
  const declaration = binding.manifest.uses[args.connection];
  return declaration?.kind === "pidgeon" ? declaration.id : null;
};

/**
 * Recent calls name each operation. A send or reply also names its recipients and subject, so
 * an admin can see who mailed whom from the company's address; bodies are never kept.
 */
export const recorded = {
  resource: (args: unknown) => {
    if (!Predicate.isObject(args) || typeof args.operation !== "string") return null;
    const input = record(args.input);
    const operation = args.operation.slice(0, 40);
    if (operation === "messages.send") {
      const to = Array.isArray(input.to) ? input.to.join(", ") : "";
      return `${operation} to ${to}: ${text(input.subject) ?? ""}`.slice(0, 300);
    }
    if (operation === "messages.reply") return `${operation} on ${text(input.id) ?? ""}`;
    if (operation === "threads.update")
      return `${operation} ${text(input.id) ?? ""} to ${text(input.status) ?? ""}`;
    return operation;
  },
  rowCount: (value: unknown) => {
    const found = record(value);
    for (const key of ["threads", "messages", "hits", "labels"])
      if (Array.isArray(found[key])) return (found[key] as ReadonlyArray<unknown>).length;
    return null;
  }
};

export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const connections = yield* ConnectionStore.ConnectionStore;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Source.Source, source),
      Effect.provideService(ConnectionStore.ConnectionStore, connections)
    );
  return {
    "pidgeon.read": Runtime.handler(
      { kind: "integration", ...read, ...recorded, connectionId },
      (args) => provide(read.run(args))
    ),
    "pidgeon.write": Runtime.handler(
      { kind: "integration", ...write, ...recorded, connectionId },
      (args) => provide(write.run(args))
    )
  };
});

/** Reads and writes, decoded without a connection alias: what `patchy dev`'s fake runs. */
export const decodeRead = Schema.decodeUnknownEffect(PidgeonReadCall, {
  onExcessProperty: "error"
});
export const decodeWrite = Schema.decodeUnknownEffect(PidgeonWriteCall, {
  onExcessProperty: "error"
});
