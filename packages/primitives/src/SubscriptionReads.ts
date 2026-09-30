import { runtimeOperations } from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { Binding, LoadedVersions, Runtime, SubscriptionReads, Wakes } from "@patchy/runtime/core";
import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as TableOperations from "./TableOperations.js";
import * as ReadSnapshot from "./ReadSnapshot.js";
import * as ResourceRevisions from "./ResourceRevisions.js";
import * as MemberDirectory from "./MemberDirectory.js";
import * as Members from "./Members.js";

class LifecycleChanged extends Schema.TaggedError<LifecycleChanged>()(
  "SubscriptionLifecycleChanged",
  { resource: Schema.String }
) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "Runtime request refused: source_unavailable.";
  }
}

const decoders = {
  "tables.list": Schema.decodeUnknownEffect(runtimeOperations["tables.list"].request.fields.args, {
    onExcessProperty: "error"
  }),
  "tables.get": Schema.decodeUnknownEffect(runtimeOperations["tables.get"].request.fields.args, {
    onExcessProperty: "error"
  }),
  "shared.list": Schema.decodeUnknownEffect(runtimeOperations["shared.list"].request.fields.args, {
    onExcessProperty: "error"
  }),
  "shared.get": Schema.decodeUnknownEffect(runtimeOperations["shared.get"].request.fields.args, {
    onExcessProperty: "error"
  }),
  "members.list": Schema.decodeUnknownEffect(
    runtimeOperations["members.list"].request.fields.args,
    {
      onExcessProperty: "error"
    }
  ),
  "members.search": Schema.decodeUnknownEffect(
    runtimeOperations["members.search"].request.fields.args,
    {
      onExcessProperty: "error"
    }
  ),
  "members.get": Schema.decodeUnknownEffect(runtimeOperations["members.get"].request.fields.args, {
    onExcessProperty: "error"
  }),
  "members.getMany": Schema.decodeUnknownEffect(
    runtimeOperations["members.getMany"].request.fields.args,
    {
      onExcessProperty: "error"
    }
  )
};
type Operation = keyof typeof decoders;
const isOperation = (op: string): op is Operation => Object.hasOwn(decoders, op);

type Lifecycle = (
  companyId: string,
  keys: readonly string[]
) => Effect.Effect<Readonly<Record<string, string>>, Runtime.RuntimeError>;

const makeReader = Effect.fn("SubscriptionReads.makeReader")(function* (lifecycle: Lifecycle) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const handlers = yield* TableOperations.make;
  const access = yield* TableOperations.makeAccess;
  const directory = yield* MemberDirectory.MemberDirectory;
  const memberHandlers = yield* Members.make;
  const withCompany = <A, R>(
    companyId: string,
    effect: Effect.Effect<A, Runtime.RuntimeError, R>
  ) =>
    databases
      .withCompany(companyId)(effect)
      .pipe(
        Effect.catchTags({
          Busy: (cause) =>
            Effect.fail(
              new TableOperations.Busy({
                cause,
                resource: cause.resource,
                scope: cause.scope,
                limitId: cause.limitId,
                value: cause.value,
                retryAfterSeconds: cause.retryAfterSeconds
              })
            ),
          CompanyDatabaseError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
          CompanyDatabaseNotReady: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
          CompanyIdentityMismatch: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
        })
      );
  const dependencies = Effect.fn("SubscriptionReads.dependencies")(function* (
    input: SubscriptionReads.Input
  ) {
    if (!isOperation(input.op)) return yield* new Runtime.InvalidRequest({});
    const decoded: Effect.Effect<unknown, Schema.SchemaError> = decoders[input.op](input.args);
    yield* decoded.pipe(Effect.mapError((cause) => new Runtime.InvalidRequest({ cause })));
    if (
      input.op === "members.list" ||
      input.op === "members.search" ||
      input.op === "members.get" ||
      input.op === "members.getMany"
    ) {
      const keys = [`members:${input.binding.companyId}`];
      for (const key of keys) input.onDependency?.(key);
      return { keys, op: input.op, members: true as const };
    }
    const shared = input.op.startsWith("shared.");
    const name = shared ? input.args.alias : input.args.table;
    if (typeof name !== "string") return yield* new Runtime.InvalidRequest({});
    const declaration =
      shared && Object.hasOwn(input.binding.manifest.uses, name)
        ? input.binding.manifest.uses[name]
        : undefined;
    if (shared && declaration?.kind !== "sharedTable")
      return yield* new TableOperations.TableNotDeclared({ table: name });
    const patchId =
      declaration?.kind === "sharedTable" ? declaration.patchId : input.binding.patchId;
    const table = declaration?.kind === "sharedTable" ? declaration.table : name;
    const keys = [`table:${patchId}:${table}`, `patch:${patchId}`];
    for (const key of keys) input.onDependency?.(key);
    return { keys, name, shared, op: input.op, members: false as const };
  });
  const admit = Effect.fn("SubscriptionReads.admit")(function* (input: SubscriptionReads.Input) {
    const dependency = yield* dependencies(input);
    if (dependency.members) {
      yield* Members.authorize.pipe(Effect.provideService(Binding.Binding, input.binding));
      return dependency.keys;
    }
    yield* (
      dependency.shared
        ? access.withSharedTable(dependency.name, () => Effect.void)
        : access.withTable(dependency.name, () => Effect.void)
    ).pipe(Effect.provideService(Binding.Binding, input.binding));
    return dependency.keys;
  });
  const revisions = Effect.fn("SubscriptionReads.revisions")(function* (
    companyId: string,
    keys: readonly string[]
  ) {
    const patchKeys = keys.filter((key) => key.startsWith("patch:"));
    const resources = keys.filter(
      (key) => !key.startsWith("patch:") && !key.startsWith("members:")
    );
    const members: Record<string, string> = {};
    for (const key of keys) {
      if (!key.startsWith("members:")) continue;
      if (key !== `members:${companyId}`) return yield* new Runtime.AccessDenied({});
      members[key] = yield* directory.revision(companyId);
    }
    const patches = yield* lifecycle(companyId, patchKeys);
    const vector =
      resources.length === 0
        ? {}
        : yield* withCompany(companyId, ResourceRevisions.read(resources));
    return { ...vector, ...patches, ...members };
  });
  const read = Effect.fn("SubscriptionReads.read")(function* (input: SubscriptionReads.Input) {
    const dependency = yield* dependencies(input);
    if (dependency.members) {
      yield* Members.authorize.pipe(Effect.provideService(Binding.Binding, input.binding));
      const before = yield* directory.revision(input.binding.companyId);
      const result = yield* memberHandlers[dependency.op]
        .run(input.args)
        .pipe(Effect.provideService(Binding.Binding, input.binding));
      const after = yield* directory.revision(input.binding.companyId);
      if (before !== after) return yield* new LifecycleChanged({ resource: dependency.keys[0]! });
      return { result, vector: { [dependency.keys[0]!]: before } };
    }
    const patchKeys = dependency.keys.filter((key) => key.startsWith("patch:"));
    const resourceKeys = dependency.keys.filter((key) => !key.startsWith("patch:"));
    // Platform lifecycle is outside the company snapshot. A changed fence refuses this run.
    const before = yield* lifecycle(input.binding.companyId, patchKeys);
    const snapshot = yield* withCompany(
      input.binding.companyId,
      Effect.gen(function* () {
        const sql = yield* CompanyDatabases.CompanyConnection;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
            const vector = yield* ResourceRevisions.read(resourceKeys);
            const result = yield* handlers[dependency.op].run(input.args).pipe(
              Effect.provideService(Binding.Binding, input.binding),
              Effect.provideService(ReadSnapshot.ReadSnapshot, {
                companyId: input.binding.companyId,
                sql
              })
            );
            return { result, vector };
          })
        );
      }).pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause }))
        })
      )
    );
    const after = yield* lifecycle(input.binding.companyId, patchKeys);
    const changed = patchKeys.find((key) => before[key] !== after[key]);
    if (changed !== undefined) return yield* new LifecycleChanged({ resource: changed });
    return { result: snapshot.result, vector: { ...snapshot.vector, ...before } };
  });
  return SubscriptionReads.SubscriptionReads.of({ admit, read, revisions });
});

type Dependencies =
  | CompanyDatabases.CompanyDatabases
  | Inventory.Inventory
  | LoadedVersions.LoadedVersions
  | MemberDirectory.MemberDirectory
  | Wakes.Wakes;

export const make: Effect.Effect<
  SubscriptionReads.SubscriptionReads["Service"],
  Config.ConfigError,
  Dependencies | SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const find = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, patchIds: Schema.Array(Schema.String) }),
    Result: ResourceRevisions.RevisionRow,
    execute: ({ companyId, patchIds }) => sql`SELECT 'patch:' || id AS key,
      lifecycle_revision::text AS revision FROM patches
      WHERE company_id = ${companyId} AND ${sql.in("id", patchIds)}`
  });
  return yield* makeReader(
    Effect.fn("SubscriptionReads.lifecycle")(function* (
      companyId: string,
      keys: readonly string[]
    ) {
      const vector: Record<string, string> = Object.fromEntries(keys.map((key) => [key, "-1"]));
      if (keys.length > 0) {
        const rows = yield* find({ companyId, patchIds: keys.map((key) => key.slice(6)) }).pipe(
          Effect.catchTags({ SchemaError: Effect.die }),
          Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
        );
        for (const row of rows) vector[row.key] = row.revision;
      }
      return vector;
    })
  );
});

export const layer = Layer.effect(SubscriptionReads.SubscriptionReads, make);

/** Local fixture authority is fixed until restart, unlike production lifecycle state. */
export const makeDev: Effect.Effect<
  SubscriptionReads.SubscriptionReads["Service"],
  Config.ConfigError,
  Dependencies
> = Effect.gen(function* () {
  const versions = yield* LoadedVersions.LoadedVersions;
  return yield* makeReader(
    Effect.fn("SubscriptionReads.devLifecycle")(function* (
      companyId: string,
      keys: readonly string[]
    ) {
      const vector: Record<string, string> = {};
      for (const key of keys) {
        const version = yield* versions
          .find(key.slice(6))
          .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
        vector[key] = Option.isSome(version) && version.value.companyId === companyId ? "0" : "-1";
      }
      return vector;
    })
  );
});

export const layerDev = Layer.effect(SubscriptionReads.SubscriptionReads, makeDev);
