import { NotionId, notionReads, type NotionRead } from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../ConnectionStore.js";
import { connectionRecheck, type DevRead, type Target } from "../definition.js";
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

/** A Notion refusal as the wire carries it: its code, status and message, and what it names. */
const refusal = (error: Source.Refusal): Runtime.RuntimeError => {
  const { code, dataSource, property, retryAfterSeconds } = error;
  // Only the token check refuses these; a stored token that no longer parses is Patchy's side.
  if (
    code === "invalid_credentials" ||
    code === "notion_not_workspace_key" ||
    code === "notion_other_workspace"
  )
    return new Runtime.SourceUnavailable({ cause: error });
  const details: Readonly<Record<string, string>> | undefined =
    dataSource !== undefined ? { dataSource } : property !== undefined ? { property } : undefined;
  return {
    code,
    status: error.status,
    message: error.message,
    ...(details === undefined ? {} : { details }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  };
};
const isRefusal = Schema.is(Source.Refusal);

const storedRefusal = (cause: ConnectionStore.ConnectionError) =>
  cause._tag === "ConnectionNotFound" || cause._tag === "ConnectionNotConnected"
    ? cause
    : cause._tag === "ConnectionChanged"
      ? new Runtime.AccessDenied({ cause })
      : new Runtime.SourceUnavailable({ cause });

/**
 * One call as its door admitted it. Its arguments are checked against the version's snapshot
 * first, with nothing sent. Then, holding one of the bot's slots: the door's recheck of the caller,
 * the connection still connected and still this integration and handle, and the token decrypted
 * right before sending. The connection's absence and the door's refusal come back as they are,
 * for the door to say.
 */
const run = Effect.fn("Notion.run")(
  function* <E extends Runtime.RuntimeError, I, A>(
    target: Target<E>,
    input: I,
    plan: Reads.Plan<I, A>
  ) {
    const { companyId, connection, deadline, recheck } = target;
    const revision = connection.revision;
    if (revision === undefined) return yield* new Runtime.InvalidRequest({});
    const store = yield* ConnectionStore.ConnectionStore;
    const source = yield* Source.Source;
    const stored = yield* store
      .snapshot(companyId, connection.id, revision)
      .pipe(Effect.mapError(storedRefusal));
    if (stored.integration !== "notion")
      return yield* new ConnectionStore.ConnectionNotFound({
        companyId,
        lookup: { id: connection.id, revision }
      });
    const execute = yield* plan(stored.snapshot, input);
    // The slot is the snapshot's bot's, which needs no read of the connection before it.
    return yield* source.withSlot(
      stored.snapshot.botId,
      deadline
    )(
      Effect.gen(function* () {
        yield* recheck;
        const current = yield* store
          .get(companyId, connection.id)
          .pipe(Effect.mapError(storedRefusal));
        if (current.integration !== "notion" || current.handle !== connection.handle)
          return yield* new ConnectionStore.ConnectionNotFound({
            companyId,
            lookup: { id: connection.id }
          });
        if (current.status !== "connected")
          return yield* new ConnectionStore.ConnectionNotConnected({});
        const { key } = yield* store
          .poolCredentials(
            companyId,
            { kind: "notion", id: connection.id, handle: connection.handle, revision },
            current.credentialRevision
          )
          .pipe(Effect.mapError(storedRefusal), Effect.flatMap(Source.parseCredentials));
        const token = Redacted.make(key);
        const budget = { remaining: yield* ContractLimits.get("notion.response.bytes") };
        return yield* execute((request) => source.send(token, request, { budget }));
      })
    );
  },
  Effect.mapError((error) => (isRefusal(error) ? refusal(error) : error))
);

export const declarationOf = (alias: string, binding: Binding.Binding["Service"]) => {
  if (!Object.hasOwn(binding.manifest.uses, alias)) return undefined;
  const declaration = binding.manifest.uses[alias];
  return declaration?.kind === "notion" ? declaration : undefined;
};

/** A data source key or property name as recent calls may show it; anything else is left out. */
const label = /^[\p{L}\p{N}_ -]{1,80}$/u;
const isLabel = (value: unknown): value is string => typeof value === "string" && label.test(value);
const isId = Schema.is(NotionId);
/** The data source and the property names a list filters, orders or selects by, never a value. */
const sourceAndProperties = (args: unknown): string | null => {
  if (!Predicate.isObject(args) || !isLabel(args.source)) return null;
  const names = new Set<string>();
  for (const filter of [args.eq, args.contains])
    if (Predicate.isObject(filter)) for (const name of Object.keys(filter)) names.add(name);
  for (const field of [args.range, args.orderBy])
    if (Predicate.isObject(field) && typeof field.property === "string") names.add(field.property);
  if (Array.isArray(args.select)) for (const name of args.select) names.add(name);
  const shown = [...names].filter(isLabel).slice(0, 8);
  return shown.length === 0 ? args.source : `${args.source} · ${shown.join(", ")}`;
};
const idOf = (args: unknown) => (Predicate.isObject(args) && isId(args.id) ? args.id : null);
const count = (key: "rows" | "results" | "people") => (value: unknown) =>
  Predicate.isObject(value) && Array.isArray(value[key]) ? value[key].length : null;
const oneOrNone = (value: unknown) => (value === null ? 0 : 1);

/**
 * How each call reads in recent calls: the data source, the property names and the ids it
 * named, and how many rows came back. Never a filter value, search text, row value or page text.
 */
export const recorded: {
  readonly [K in NotionRead]: {
    readonly resource: (args: unknown) => string | null;
    readonly rowCount: (value: unknown) => number | null;
  };
} = {
  listRows: { resource: sourceAndProperties, rowCount: count("rows") },
  getRow: {
    resource: (args: unknown) =>
      [sourceAndProperties(args), idOf(args)].filter((part) => part !== null).join(" · ") || null,
    rowCount: oneOrNone
  },
  markdown: { resource: idOf, rowCount: oneOrNone },
  search: { resource: () => null, rowCount: count("results") },
  listPeople: { resource: () => null, rowCount: count("people") }
};

/**
 * One read for `patchy dev` through the instance's dev door (ADR-0013): the caller is the
 * door's, the alias stays in the repo, and the declaration's revision picks the snapshot.
 */
const devRead = <I, A>(
  name: NotionRead,
  input: Schema.Decoder<I>,
  plan: Reads.Plan<I, A>
): DevRead<Source.Source> => {
  const decode = Schema.decodeUnknownEffect(input, { onExcessProperty: "error" });
  return {
    ...recorded[name],
    run: (target, args) =>
      decode(args).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })),
        Effect.flatMap((value) => run(target, value, plan))
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

/**
 * Published patches' handlers. They share the server's one Source with the dev door and
 * connection administration, so a bot's slots span them all.
 */
export const makeHandlers = Effect.gen(function* () {
  const source = yield* Source.Source;
  const connections = yield* ConnectionStore.ConnectionStore;
  const deadlineMs = yield* ContractLimits.get("integration.deadline");

  const invoke = <I, A>(alias: string, input: I, plan: Reads.Plan<I, A>) =>
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
      return yield* run(
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
      Effect.catchTags({
        ConnectionNotFound: (cause) => Effect.fail(new Runtime.AccessDenied({ cause })),
        ConnectionNotConnected: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
      })
    );
  const handler = <
    I extends Schema.Top & Schema.Codec<unknown, unknown>,
    O extends Schema.Top & Schema.Codec<unknown, unknown>
  >(
    name: NotionRead,
    { guest, output }: { readonly guest: I; readonly output: O },
    run: (args: I["Type"]) => Effect.Effect<O["Type"], Runtime.RuntimeError, Binding.Binding>
  ) =>
    Runtime.handler(
      {
        kind: "integration",
        input: guest,
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
