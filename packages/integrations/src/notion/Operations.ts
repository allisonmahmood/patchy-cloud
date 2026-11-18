import { NotionListRows, notionReads, type NotionListInput } from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
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
  return {
    code: error.code,
    status: error.status,
    message: error.message,
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
    ...(error.bound?.name === "bytes"
      ? { limitId: "notion.read.bytes", value: error.bound.limit }
      : {}),
    ...(error.bound?.name === "property items"
      ? { limitId: "notion.read.propertyItems", value: error.bound.limit }
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

const list = Effect.fn("Notion.listRows")(
  function* <E extends Runtime.RuntimeError>(target: Target<E>, input: NotionListInput) {
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
    const execute = yield* Reads.planList(metadata.snapshot, input, {
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

const declarationOf = (alias: string, binding: Binding.Binding["Service"]) => {
  if (!Object.hasOwn(binding.manifest.uses, alias)) return undefined;
  const declaration = binding.manifest.uses[alias];
  return declaration?.kind === "notion" ? declaration : undefined;
};

const recorded = {
  resource: (args: unknown): string | null => {
    if (
      !Predicate.isObject(args) ||
      typeof args.source !== "string" ||
      !/^[\p{L}\p{N}_ -]{1,80}$/u.test(args.source)
    )
      return null;
    const fields = new Set<string>();
    for (const filter of [args.eq, args.contains])
      if (Predicate.isObject(filter)) for (const key of Object.keys(filter)) fields.add(key);
    for (const field of [args.range, args.orderBy])
      if (Predicate.isObject(field) && typeof field.property === "string")
        fields.add(field.property);
    if (Array.isArray(args.select))
      for (const field of args.select) if (typeof field === "string") fields.add(field);
    const names = [...fields].filter((field) => /^[\p{L}\p{N}_ -]{1,80}$/u.test(field)).slice(0, 8);
    return names.length === 0 ? args.source : `${args.source} · ${names.join(", ")}`;
  },
  rowCount: (value: unknown): number | null =>
    Predicate.isObject(value) && Array.isArray(value.rows) ? value.rows.length : null
};
const decodeList = Schema.decodeUnknownEffect(notionReads.listRows.input, {
  onExcessProperty: "error"
});
const devList: DevRead<Source.Source | Cryptography.Cryptography> = {
  ...recorded,
  run: (target, args) =>
    decodeList(args).pipe(
      Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
      Effect.flatMap((input) => list(target, input))
    )
};
export const devReads = { "notion.listRows": devList };

export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const connections = yield* ConnectionStore.ConnectionStore;
  const cryptography = yield* Cryptography.Cryptography;
  const deadlineMs = yield* ContractLimits.get("integration.deadline");
  return {
    "notion.listRows": Runtime.handler(
      {
        kind: "integration",
        input: NotionListRows,
        output: notionReads.listRows.output,
        ...recorded,
        connectionId: (args, binding) =>
          Predicate.isObject(args) && typeof args.connection === "string"
            ? (declarationOf(args.connection, binding)?.id ?? null)
            : null
      },
      ({ connection: alias, ...input }) =>
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
          return yield* list(
            {
              companyId: binding.companyId,
              connection,
              deadline: binding.deadline ?? (yield* Clock.currentTimeMillis) + deadlineMs,
              recheck: connectionRecheck(binding, connection.id).pipe(
                Effect.provideService(ConnectionStore.ConnectionStore, connections)
              )
            },
            input
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
                message:
                  "This Notion connection is paused. Ask a company administrator to resume it."
              };
            return error;
          })
        )
    )
  };
});
