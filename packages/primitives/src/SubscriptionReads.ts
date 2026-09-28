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
  })
};
type Operation = keyof typeof decoders;
const isOperation = (op: string): op is Operation => Object.hasOwn(decoders, op);
const RevisionRow = Schema.Struct({ key: Schema.String, revision: Schema.String });
const resourceRevisions = SqlSchema.findAll({
  Request: Schema.Array(Schema.String),
  Result: RevisionRow,
  execute: Effect.fn("SubscriptionReads.resourceRevisions")(function* (keys) {
    const sql = yield* CompanyDatabases.CompanyConnection;
    return yield* sql`SELECT 'table:' || patch_id || ':' || name AS key,
        resource_revision::text AS revision FROM patchy.tables
      WHERE ('table:' || patch_id || ':' || name) IN ${sql.in(keys)}
      UNION ALL
      SELECT 'store:' || patch_id || ':' || name AS key,
        resource_revision::text AS revision FROM patchy.stores
      WHERE ('store:' || patch_id || ':' || name) IN ${sql.in(keys)}`;
  })
});

type Lifecycle = (
  companyId: string,
  keys: readonly string[]
) => Effect.Effect<Readonly<Record<string, string>>, Runtime.RuntimeError>;

const makeReader = Effect.fn("SubscriptionReads.makeReader")(function* (lifecycle: Lifecycle) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const handlers = yield* TableOperations.make;
  const access = yield* TableOperations.makeAccess;
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
    return { keys, name, shared, op: input.op };
  });
  const admit = Effect.fn("SubscriptionReads.admit")(function* (input: SubscriptionReads.Input) {
    const dependency = yield* dependencies(input);
    yield* (
      dependency.shared
        ? access.withSharedTable(dependency.name, () => Effect.void)
        : access.withTable(dependency.name, () => Effect.void)
    ).pipe(Effect.provideService(Binding.Binding, input.binding));
    return dependency.keys;
  });
  const companyVector = Effect.fn("SubscriptionReads.companyVector")(function* (
    keys: readonly string[]
  ) {
    const vector: Record<string, string> = Object.fromEntries(keys.map((key) => [key, "-1"]));
    if (keys.length > 0) {
      const rows = yield* resourceRevisions(keys).pipe(
        Effect.catchTags({ SchemaError: Effect.die }),
        Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))
      );
      for (const row of rows) vector[row.key] = row.revision;
    }
    return vector;
  });
  const revisions = Effect.fn("SubscriptionReads.revisions")(function* (
    companyId: string,
    keys: readonly string[]
  ) {
    const patchKeys = keys.filter((key) => key.startsWith("patch:"));
    const resources = keys.filter((key) => !key.startsWith("patch:"));
    const patches = yield* lifecycle(companyId, patchKeys);
    const vector =
      resources.length === 0 ? {} : yield* withCompany(companyId, companyVector(resources));
    return { ...vector, ...patches };
  });
  const read = Effect.fn("SubscriptionReads.read")(function* (input: SubscriptionReads.Input) {
    const dependency = yield* dependencies(input);
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
            const vector = yield* companyVector(resourceKeys);
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
    if (patchKeys.some((key) => before[key] !== after[key]))
      return yield* new Runtime.SourceUnavailable({ cause: { reason: "lifecycle_changed" } });
    return { result: snapshot.result, vector: { ...snapshot.vector, ...before } };
  });
  return SubscriptionReads.SubscriptionReads.of({ admit, read, revisions });
});

type Dependencies =
  | CompanyDatabases.CompanyDatabases
  | Inventory.Inventory
  | LoadedVersions.LoadedVersions
  | Wakes.Wakes;

export const make: Effect.Effect<
  SubscriptionReads.SubscriptionReads["Service"],
  Config.ConfigError,
  Dependencies | SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const find = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, patchIds: Schema.Array(Schema.String) }),
    Result: RevisionRow,
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
