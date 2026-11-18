import { NotionId, notionReads, type NotionRead, type NotionSnapshot } from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ConnectionStore from "../ConnectionStore.js";
import { connectionRecheck, ownerCheck, type DevRead, type Target } from "../definition.js";
import * as Reads from "./Reads.js";
import * as Source from "./Source.js";

export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "NotionConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  override get message() {
    return "This Notion connection is not declared by this version.";
  }
}

const refusal = (error: Source.Refusal): Runtime.RuntimeError => {
  if (
    error.code === "invalid_credentials" ||
    error.code === "notion_not_workspace_key" ||
    error.code === "notion_other_workspace"
  )
    return new Runtime.SourceUnavailable({ cause: error });
  const { code, bound, dataSource, missing, retryAfterSeconds } = error;
  return {
    code,
    status: error.status,
    message:
      code === "too_large"
        ? `This Notion read exceeded the Patchy limit${bound ? ` for ${bound.name} (${bound.limit})` : ""}.`
        : code === "shape_mismatch" && missing === undefined
          ? "Notion returned an unexpected read response."
          : code === "timeout"
            ? "Notion did not answer before the read deadline."
            : error.message,
    ...(code === "shape_mismatch" && missing?.kind === "property"
      ? { details: { property: missing.name } }
      : code === "not_found" && dataSource !== undefined
        ? { details: { dataSource } }
        : code === "offset_exhausted"
          ? { details: { maxOffset: 10000 } }
          : {}),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(bound?.name === "bytes" ? { limitId: "notion.read.bytes", value: bound.limit } : {}),
    ...(bound?.name === "property items"
      ? { limitId: "notion.read.propertyItems", value: bound.limit }
      : {})
  };
};

const isNotionRefusal = Schema.is(Source.Refusal);
const isConnectionNotFound = Schema.is(ConnectionStore.ConnectionNotFound);
const isConnectionNotConnected = Schema.is(ConnectionStore.ConnectionNotConnected);

const storedRefusal = (cause: ConnectionStore.ConnectionError) =>
  cause._tag === "ConnectionNotFound" || cause._tag === "ConnectionNotConnected"
    ? cause
    : cause._tag === "ConnectionChanged"
      ? new Runtime.AccessDenied({ cause })
      : new Runtime.SourceUnavailable({ cause });

const connected = Effect.fn("Notion.connected")(function* (
  companyId: string,
  declaration: Target["connection"]
) {
  const connections = yield* ConnectionStore.ConnectionStore;
  const current = yield* connections
    .get(companyId, declaration.id)
    .pipe(Effect.mapError(storedRefusal));
  if (current.integration !== "notion" || current.handle !== declaration.handle)
    return yield* new ConnectionStore.ConnectionNotFound({
      companyId,
      lookup: { id: declaration.id }
    });
  if (current.status !== "connected") return yield* new ConnectionStore.ConnectionNotConnected({});
  return current;
});

type Send = (
  request: HttpClientRequest.HttpClientRequest
) => Effect.Effect<unknown, Source.Refusal>;
type Plan<I, A> = (
  snapshot: NotionSnapshot,
  input: I,
  binding: { readonly id: string; readonly revision: number }
) => Effect.Effect<
  (send: Send) => Effect.Effect<A, Source.Refusal>,
  Source.Refusal,
  Cryptography.Cryptography
>;

const read = Effect.fn("Notion.read")(
  function* <E extends Runtime.RuntimeError, I, A>(target: Target<E>, input: I, plan: Plan<I, A>) {
    const { companyId, connection, deadline, recheck } = target;
    const { revision } = connection;
    if (revision === undefined) return yield* new Runtime.InvalidRequest({});
    const source = yield* Source.Source;
    const store = yield* ConnectionStore.ConnectionStore;
    yield* connected(companyId, connection);
    const metadata = yield* store
      .snapshot(companyId, connection.id, revision)
      .pipe(Effect.mapError(storedRefusal));
    if (metadata.integration !== "notion")
      return yield* new ConnectionStore.ConnectionNotFound({
        companyId,
        lookup: { id: connection.id, revision }
      });
    const execute = yield* plan(metadata.snapshot, input, {
      id: connection.id,
      revision
    });
    const bytes = yield* ContractLimits.get("notion.read.bytes");
    return yield* source.withSlot(
      connection.id,
      () =>
        Effect.gen(function* () {
          yield* recheck;
          const current = yield* connected(companyId, connection);
          const key = yield* store
            .poolCredentials(
              companyId,
              { kind: "notion", id: connection.id, handle: connection.handle, revision },
              current.credentialRevision
            )
            .pipe(Effect.mapError(storedRefusal), Effect.flatMap(Source.parseCredentials));
          if (
            current.display.workspace.id !== metadata.snapshot.workspace.id ||
            key.workspaceId !== metadata.snapshot.workspace.id
          )
            return yield* new Runtime.AccessDenied({});
          const redacted = Redacted.make(key.key);
          const budget = { remaining: bytes };
          return yield* execute((request) => source.send(redacted, request, bytes, budget));
        }),
      deadline
    );
  },
  Effect.mapError((error) => (isNotionRefusal(error) ? refusal(error) : error))
);

export const declarationOf = (alias: string, binding: Binding.Binding["Service"]) => {
  if (!Object.hasOwn(binding.manifest.uses, alias)) return undefined;
  const declaration = binding.manifest.uses[alias];
  return declaration?.kind === "notion" ? declaration : undefined;
};

const safeLabel = /^[\p{L}\p{N}_ -]{1,80}$/u;
const isId = Schema.is(NotionId);
const sourceAndProperties = (args: unknown): string | null => {
  if (!Predicate.isObject(args) || typeof args.source !== "string" || !safeLabel.test(args.source))
    return null;
  const fields = new Set<string>();
  for (const filter of [args.eq, args.contains])
    if (Predicate.isObject(filter)) for (const key of Object.keys(filter)) fields.add(key);
  for (const field of [args.range, args.orderBy])
    if (Predicate.isObject(field) && typeof field.property === "string") fields.add(field.property);
  if (Array.isArray(args.select))
    for (const field of args.select) if (typeof field === "string") fields.add(field);
  const names = [...fields].filter((field) => safeLabel.test(field)).slice(0, 8);
  return names.length === 0 ? args.source : `${args.source} · ${names.join(", ")}`;
};
const identifier = (args: unknown) => (Predicate.isObject(args) && isId(args.id) ? args.id : null);
const nothingNamed = () => null;
const count = (key: "rows" | "results" | "people") => (value: unknown) =>
  Predicate.isObject(value) && Array.isArray(value[key]) ? value[key].length : null;
const oneOrNone = (value: unknown) => (value === null ? 0 : 1);

const recorded = {
  listRows: { resource: sourceAndProperties, rowCount: count("rows") },
  getRow: {
    resource: (args: unknown) => {
      const source = sourceAndProperties(args);
      const id = identifier(args);
      return source !== null && id !== null ? `${source} · ${id}` : (source ?? id);
    },
    rowCount: oneOrNone
  },
  markdown: { resource: identifier, rowCount: oneOrNone },
  search: { resource: nothingNamed, rowCount: count("results") },
  listPeople: { resource: nothingNamed, rowCount: count("people") }
};

const devRead = <I, A>(
  name: NotionRead,
  input: Schema.Decoder<I>,
  plan: Plan<I, A>
): DevRead<Source.Source | Cryptography.Cryptography> => {
  const decode = Schema.decodeUnknownEffect(input, { onExcessProperty: "error" });
  return {
    ...recorded[name],
    run: (target, args) =>
      decode(args).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
        Effect.flatMap((value) => read(target, value, plan))
      )
  };
};
export const devReads = {
  "notion.listRows": devRead("listRows", notionReads.listRows.input, Reads.planList),
  "notion.getRow": devRead("getRow", notionReads.getRow.input, Reads.planGet),
  "notion.markdown": devRead("markdown", notionReads.markdown.input, Reads.planMarkdown),
  "notion.search": devRead("search", notionReads.search.input, Reads.planSearch),
  "notion.listPeople": devRead("listPeople", notionReads.listPeople.input, Reads.planPeople)
};

export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const connections = yield* ConnectionStore.ConnectionStore;
  const cryptography = yield* Cryptography.Cryptography;
  const deadlineMs = yield* ContractLimits.get("integration.deadline");

  const invoke = <I, A>(alias: string, input: I, plan: Plan<I, A>) =>
    Effect.gen(function* () {
      const binding = yield* Binding.Binding;
      const connection = declarationOf(alias, binding);
      if (!connection) return yield* new ConnectionNotDeclared({});
      if (
        binding.scope === "public" ||
        binding.identity?.company.id !== binding.companyId ||
        binding.identity.user.id !== binding.principal?.userId
      )
        return yield* new Runtime.AccessDenied({});
      yield* ownerCheck(binding, connection.id);
      return yield* read(
        {
          companyId: binding.companyId,
          connection,
          deadline: binding.deadline ?? (yield* Clock.currentTimeMillis) + deadlineMs,
          recheck: connectionRecheck(binding, connection.id).pipe(
            Effect.provideService(ConnectionStore.ConnectionStore, connections)
          )
        },
        input,
        plan
      );
    }).pipe(
      Effect.provideService(Source.Source, source),
      Effect.provideService(ConnectionStore.ConnectionStore, connections),
      Effect.provideService(Cryptography.Cryptography, cryptography),
      Effect.mapError((error) => {
        if (isConnectionNotFound(error)) return new Runtime.AccessDenied({ cause: error });
        if (isConnectionNotConnected(error))
          return {
            code: "access_denied" as const,
            status: 403,
            message: "This Notion connection is paused. Ask a company administrator to resume it."
          };
        return error;
      })
    );
  const handler = <
    I extends Schema.Top & Schema.Codec<unknown, unknown>,
    O extends Schema.Top & Schema.Codec<unknown, unknown>
  >(
    name: NotionRead,
    { guest: input, output }: { guest: I; output: O },
    run: (args: I["Type"]) => Effect.Effect<O["Type"], Runtime.RuntimeError, Binding.Binding>
  ) =>
    Runtime.handler(
      {
        kind: "integration",
        input,
        output,
        ...recorded[name],
        connectionId: (args, binding) =>
          Predicate.isObject(args) && typeof args.connection === "string"
            ? (declarationOf(args.connection, binding)?.id ?? null)
            : null
      },
      run
    );

  return {
    [notionReads.listRows.op]: handler(
      "listRows",
      notionReads.listRows,
      ({ connection, ...input }) => invoke(connection, input, Reads.planList)
    ),
    [notionReads.getRow.op]: handler("getRow", notionReads.getRow, ({ connection, ...input }) =>
      invoke(connection, input, Reads.planGet)
    ),
    [notionReads.markdown.op]: handler(
      "markdown",
      notionReads.markdown,
      ({ connection, ...input }) => invoke(connection, input, Reads.planMarkdown)
    ),
    [notionReads.search.op]: handler("search", notionReads.search, ({ connection, ...input }) =>
      invoke(connection, input, Reads.planSearch)
    ),
    [notionReads.listPeople.op]: handler(
      "listPeople",
      notionReads.listPeople,
      ({ connection, ...input }) => invoke(connection, input, Reads.planPeople)
    )
  };
});
