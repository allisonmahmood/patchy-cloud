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
import { LocalError, WrongPatchState } from "./CliError.js";
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
    return yield* new WrongPatchState({ state: error.state, cause: error });
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
      `${connection.handle}  ${connection.description}  ${connection.status}`,
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
  const lines = [`${connection.handle}  ${connection.description}  ${connection.status}`];
  const snapshot = connection.snapshot;
  if (snapshot === null) return [...lines, "Snapshot: unavailable"];
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
  const top = target === undefined || target === "patches";
  const connections = target === "connections";
  if (top && detail !== undefined)
    return yield* new LocalError({
      message: "Use list <patch> <primitive>, not list patches <primitive>."
    });
  if (!top && Option.isSome(options.mine))
    return yield* new LocalError({ message: "--mine is only valid on list or list patches." });
  if ((!connections || detail !== undefined) && Option.isSome(options.all))
    return yield* new LocalError({ message: "--all is only valid on list connections." });
  if (connections && Option.isSome(options.state))
    return yield* new LocalError({
      message: "--state is only valid when listing patches or their primitives."
    });
  if (detail?.includes("/"))
    return yield* new LocalError({
      message: "Use separate names for list <patch> <primitive>; slashes belong in add targets."
    });
  const client = yield* Api.client(token);
  if (connections) {
    if (detail !== undefined) {
      const result = yield* client
        .getConnection({ params: { handle: detail } })
        .pipe(Effect.catch(refusal));
      return yield* Output.report(encodeConnection(result), connectionDetailLines(result));
    }
    const result = yield* client
      .listConnections({ query: { all: Option.getOrElse(options.all, () => false) } })
      .pipe(Effect.catch(refusal));
    return yield* Output.report(encodeConnections(result), connectionLines(result));
  }
  const state = Option.getOrElse(options.state, () => "live" as const);
  if (top) {
    const [patches, connections] = yield* Effect.all(
      [
        client.list({ query: { state, mine: Option.getOrElse(options.mine, () => false) } }),
        client.listConnections({ query: {} })
      ],
      { concurrency: 2 }
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
    for (const store of result.inventory.stores)
      lines.push(`  ${store.name}: ${store.description}`, `    ${store.hint}`);
  }
  lines.push("Reads:");
  for (const read of result.reads)
    lines.push(
      `  ${read.alias}: ${read.patchId}${read.name === undefined ? "" : ` (${read.name})`} ${read.table}  ${read.state}`
    );
  yield* Output.report(encodePatch(result), lines);
});
