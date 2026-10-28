import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  ConnectionDetail,
  Connections,
  PatchDetail,
  PatchSummary,
  type PatchStateFilter,
  PrimitiveDetail,
  WrongState
} from "@patchy/api";
import * as Api from "./Api.js";
import { LocalError, RejectedError } from "./CliError.js";
import * as Output from "./Output.js";

const encodeList = Schema.encodeSync(
  Schema.Struct({
    patches: Schema.Array(PatchSummary),
    connections: Connections.fields.connections
  })
);
const encodePatch = Schema.encodeSync(PatchDetail);
const encodePrimitive = Schema.encodeSync(PrimitiveDetail);
const encodeConnections = Schema.encodeSync(Connections);
const encodeConnection = Schema.encodeSync(ConnectionDetail);
const isWrongState = Schema.is(WrongState);
const decodePatchReference = Schema.decodeUnknownEffect(
  Schema.String.check(Schema.isPattern(/^[^/]+$/))
);

const refusal = Effect.fn("Discovery.refusal")(function* (error: Api.ClientFailure) {
  if (isWrongState(error)) {
    return yield* new RejectedError({
      refusal: error,
      hint: `Patch is ${error.state}; pass --state ${error.state === "deleted" ? "all" : error.state}.`,
      cause: error
    });
  }
  return yield* Api.classify(error, "Could not read discovery.");
});

const patchRow = (patch: PatchSummary, now: number) => {
  const state =
    patch.state === "deleted" && patch.purgeAt !== null
      ? `deleted · gone in ${Math.max(0, Math.ceil((DateTime.toEpochMillis(DateTime.makeUnsafe(patch.purgeAt)) - now) / 86_400_000))} days`
      : patch.state;
  return `${patch.id}  ${patch.name}  ${state}  ${patch.owner.name}${patch.owner.deactivated ? " · deactivated" : ""}  v${patch.currentVersion}  ${patch.description.split(/\r?\n/, 1)[0] || "(no description)"}`;
};

const connectionLines = (result: typeof Connections.Type) => {
  const lines: string[] = [];
  for (const connection of result.connections) {
    lines.push(
      `${connection.integration}/${connection.handle}  ${connection.description}  ${connection.status}${connection.test === true ? " · test, mail stays in Pidgeon" : ""}`,
      `  ${connection.hint}`
    );
  }
  for (const offered of result.offered ?? []) {
    lines.push(`${offered.integration}: ${offered.connected ? "connected" : "not connected"}`);
  }
  return lines;
};

const primitiveLines = (primitive: PrimitiveDetail) => [
  `${primitive.name}  ${primitive.kind}`,
  primitive.description,
  `Shared: ${primitive.shared}`,
  `Declarable: ${primitive.declarable}`,
  ...(primitive.hint === undefined ? [] : [primitive.hint]),
  `Schema revision: ${primitive.schemaRevision}`,
  "Columns:",
  ...primitive.columns.map(
    (column) =>
      `  ${column.name}: ${column.kind}${column.optional ? " optional" : " required"}${Object.hasOwn(column, "default") ? ` default ${Output.toJson(column.default)}` : ""}${column.ref === undefined ? "" : ` ref ${column.ref}`}`
  ),
  "Indexes:",
  ...primitive.indexes.map(
    (index) => `  ${index.name} (${index.columns.join(", ")})${index.unique ? " unique" : ""}`
  )
];

const connectionDetailLines = (connection: typeof ConnectionDetail.Type) => {
  const lines = [
    `${connection.integration}/${connection.handle}  ${connection.description}  ${connection.status}`
  ];
  if (connection.snapshot === null) return [...lines, "Snapshot: unavailable"];
  if (connection.integration === "pidgeon") {
    const snapshot = connection.snapshot;
    return [
      ...lines,
      `Address: ${snapshot.address.email}${snapshot.address.displayName === null ? "" : ` (${snapshot.address.displayName})`}`,
      `Access: ${snapshot.access === "send" ? "read and send" : "read"}`,
      `Send policy: ${snapshot.address.sendPolicy}`,
      ...(snapshot.test ? ["Mode: test · mail stays in Pidgeon"] : []),
      `Plan: ${snapshot.plan}`,
      `Labels: ${snapshot.labels.length === 0 ? "none" : snapshot.labels.map((label) => label.name).join(", ")}`,
      `Snapshot revision: ${snapshot.revision}`,
      `Taken at: ${snapshot.takenAt}`
    ];
  }
  if (connection.integration === "attio") {
    const snapshot = connection.snapshot;
    const attributes = (items: (typeof snapshot.objects)[number]["attributes"]) =>
      items.map(
        (item) =>
          `    ${item.slug}: ${item.type}${item.multiselect ? " multiselect" : ""}${item.targets === undefined ? "" : ` to ${item.targets.map((target) => target.slug).join(", ") || "nothing Patchy reads"}`}${item.optionsSkipped === true ? " options not read" : item.options === undefined ? "" : ` options ${item.options.map((option) => Output.toJson(option)).join(", ")}`}`
      );
    return [
      ...lines,
      `Workspace: ${snapshot.workspace.name} (${snapshot.workspace.slug})`,
      `Snapshot revision: ${snapshot.revision}`,
      `Taken at: ${snapshot.takenAt}`,
      "Objects:",
      ...snapshot.objects.flatMap((object) => [
        `  ${object.slug} (${object.name})`,
        ...attributes(object.attributes)
      ]),
      "Lists:",
      ...snapshot.lists.flatMap((list) => [
        `  ${list.slug} (${list.name}) of ${list.parents.map((parent) => parent.slug).join(", ")}`,
        ...attributes(list.attributes)
      ]),
      ...snapshot.excluded.map(
        (item) =>
          `Excluded ${item.kind} ${item.name}${item.in === undefined ? "" : ` on ${item.in.kind} ${item.in.slug}`}: ${item.reason}`
      )
    ];
  }
  if (connection.integration === "posthog") {
    const snapshot = connection.snapshot;
    const described = (description: string | undefined) =>
      description === undefined ? "" : `  ${description.split(/\r?\n/, 1)[0]}`;
    const properties = (title: string, items: typeof snapshot.eventProperties) => [
      `${title}:`,
      ...items.map(
        (item) =>
          `  ${item.name}${item.type === null ? "" : ` (${item.type})`}${described(item.description)}`
      )
    ];
    return [
      ...lines,
      `Events revision: ${snapshot.revision}`,
      `Taken at: ${snapshot.takenAt}`,
      "Events:",
      ...snapshot.events.map((event) => `  ${event.name}${described(event.description)}`),
      ...properties("Event properties", snapshot.eventProperties),
      ...properties("Person properties", snapshot.personProperties)
    ];
  }
  const snapshot = connection.snapshot;
  lines.push(
    `Schema revision: ${snapshot.revision}`,
    `Taken at: ${snapshot.takenAt}`,
    "Relations:"
  );
  for (const relation of snapshot.relations) {
    lines.push(`  ${relation.schema}.${relation.name} (${relation.kind})`);
    for (const column of relation.columns) {
      lines.push(
        `    ${column.name}: ${column.type.sql}${column.nullable ? " optional" : " required"}`
      );
    }
    if (relation.primaryKey !== null) {
      lines.push(
        `    Primary key: ${relation.primaryKey.name} (${relation.primaryKey.columns.join(", ")})`
      );
    }
    for (const key of relation.foreignKeys) {
      lines.push(
        `    ${key.name} (${key.columns.join(", ")}) ref ${key.target.schema}.${key.target.relation} (${key.target.columns.join(", ")})`
      );
    }
  }
  for (const value of snapshot.enums)
    lines.push(
      `Enum ${value.schema}.${value.name}: ${value.labels.map((label) => Output.toJson(label)).join(", ")}`
    );
  for (const exclusion of snapshot.exclusions) {
    lines.push(
      `Excluded ${exclusion.schema}.${exclusion.relation}${exclusion.column === undefined ? "" : `.${exclusion.column}`}: ${exclusion.reason}`
    );
  }
  return lines;
};

/**
 * `postgres/warehouse` names one connection. A bare handle names the only connection with it; with
 * none, it is asked for as Postgres, as before other integrations, so the instance answers.
 */
const connectionName = Effect.fn("Discovery.connectionName")(function* (
  client: Api.Client,
  name: string
) {
  const parts = name.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) return [parts[0], parts[1]] as const;
  if (parts.length !== 1)
    return yield* new LocalError({
      message: "Use list connections <integration>/<handle>, such as postgres/warehouse."
    });
  const listed = yield* client
    .listConnections({ query: { integrations: Api.decodable } })
    .pipe(Effect.catch(refusal));
  const named = listed.connections.filter((connection) => connection.handle === name);
  if (named.length > 1)
    return yield* new LocalError({
      message: `Several connections are named ${name}; name one:\n${named.map((connection) => `  patchy list connections ${connection.integration}/${name}`).join("\n")}`
    });
  return [named[0]?.integration ?? "postgres", name] as const;
});

/** Discovery uses the saved instance, never a patch repo's configuration. */
export const list = Effect.fn("Discovery.list")(function* (
  token: Redacted.Redacted,
  options: {
    readonly target: Option.Option<string>;
    readonly detail: Option.Option<string>;
    readonly state: Option.Option<typeof PatchStateFilter.Type>;
    readonly mine: Option.Option<boolean>;
    readonly all: Option.Option<boolean>;
  }
) {
  const target = Option.getOrUndefined(options.target);
  const detail = Option.getOrUndefined(options.detail);
  const isPatchList = target === undefined || target === "patches";
  const isConnectionPath = target === "connections";
  if (isPatchList && detail !== undefined)
    return yield* new LocalError({
      message: "Use list <patch> <primitive>, not list patches <primitive>."
    });
  if (!isPatchList && Option.isSome(options.mine))
    return yield* new LocalError({ message: "--mine is only valid on list or list patches." });
  if ((!isConnectionPath || detail !== undefined) && Option.isSome(options.all))
    return yield* new LocalError({ message: "--all is only valid on list connections." });
  if (isConnectionPath && Option.isSome(options.state))
    return yield* new LocalError({
      message: "--state is only valid when listing patches or their primitives."
    });
  if (!isConnectionPath && detail?.includes("/"))
    return yield* new LocalError({
      message: "Use separate names for list <patch> <primitive>; slashes belong in add targets."
    });
  const client = yield* Api.client(token);
  if (isConnectionPath) {
    if (detail !== undefined) {
      const [integration, handle] = yield* connectionName(client, detail);
      const result = yield* client
        .getIntegrationConnection({ params: { integration, handle } })
        .pipe(Effect.catch(refusal));
      return yield* Output.report(encodeConnection(result), connectionDetailLines(result));
    }
    const result = yield* client
      .listConnections({
        query: { all: Option.getOrElse(options.all, () => false), integrations: Api.decodable }
      })
      .pipe(Effect.catch(refusal));
    return yield* Output.report(encodeConnections(result), connectionLines(result));
  }
  const state = Option.getOrElse(options.state, () => "live" as const);
  if (isPatchList) {
    const [patches, connections] = yield* Effect.zip(
      client.list({ query: { state, mine: Option.getOrElse(options.mine, () => false) } }),
      client.listConnections({ query: { integrations: Api.decodable } }),
      { concurrent: true }
    ).pipe(Effect.catch(refusal));
    const now = yield* Clock.currentTimeMillis;
    const yours: string[] = ["Yours:"];
    const company: string[] = ["Company:"];
    for (const patch of patches.patches) (patch.mine ? yours : company).push(patchRow(patch, now));
    return yield* Output.report(
      encodeList({ patches: patches.patches, connections: connections.connections }),
      [...yours, ...company, "Connections:", ...connectionLines(connections)]
    );
  }
  const reference = yield* Effect.try({
    try: () =>
      /^https?:\/\//i.test(target)
        ? decodeURIComponent(new URL(target).pathname.replace(/\/+$/, "").split("/").at(-1) ?? "")
        : target,
    catch: (cause) => new LocalError({ message: "Could not read the patch address.", cause })
  });
  const patchRef = yield* decodePatchReference(reference).pipe(
    Effect.mapError(
      (cause) =>
        new LocalError({
          message:
            "Use a patch id, name, or full patch address; list paths use separate arguments.",
          cause
        })
    )
  );
  if (detail !== undefined) {
    const result = yield* client
      .primitive({ params: { patchRef, name: detail }, query: { state } })
      .pipe(Effect.catch(refusal));
    return yield* Output.report(encodePrimitive(result), primitiveLines(result));
  }
  const result = yield* client
    .detail({ params: { patchRef }, query: { state } })
    .pipe(Effect.catch(refusal));
  const now = yield* Clock.currentTimeMillis;
  const lines = [patchRow(result, now), result.description || "(no description)"];
  if (result.inventory === null) {
    lines.push("Tables: unavailable", "Stores: unavailable");
  } else {
    lines.push("Tables:");
    for (const table of result.inventory.tables) {
      lines.push(`  ${table.name}: ${table.description}`);
      const hint = table.hint ?? table.reason;
      if (hint !== undefined) lines.push(`    ${hint}`);
    }
    lines.push("Stores:");
    for (const store of result.inventory.stores) {
      lines.push(`  ${store.name}: ${store.description}`);
      const hint = store.hint ?? store.reason;
      if (hint !== undefined) lines.push(`    ${hint}`);
    }
  }
  lines.push("Reads:");
  for (const read of result.reads)
    lines.push(
      `  ${read.alias}: ${read.patchId}${read.name === undefined ? "" : ` (${read.name})`} ${"store" in read ? read.store : read.table}  ${read.state}`
    );
  yield* Output.report(encodePatch(result), lines);
});
