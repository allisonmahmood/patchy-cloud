import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { WIRE_VERSION } from "@patchy/api";
import type { PatchInventory } from "@patchy/api";
import { CompanyDatabases, Inventory, PgliteCompanyDatabases } from "@patchy/company-database/dev";
import { FilesystemContentStore } from "@patchy/content-store";
import { sha256 } from "@patchy/core";
import {
  ConnectionStore,
  ConnectionStoreDev,
  PostgresDev,
  PostgresExecution,
  PostgresOperations
} from "@patchy/integrations/dev";
import { Files, TableOperations, Tables } from "@patchy/primitives";
import { LoadedVersions, me } from "@patchy/runtime/core";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FixtureMissing, type Prepared } from "./devPreparation.js";
import { safePath } from "./ManagedProject.js";

export class StateUnavailable extends Schema.TaggedError<StateUnavailable>()(
  "DevStateUnavailable",
  {
    path: Schema.String,
    cause: Schema.Defect()
  }
) {
  override get message() {
    return `Could not prepare local dev state at ${this.path}.`;
  }
}
export class SharedFixtureInvalid extends Schema.TaggedError<SharedFixtureInvalid>()(
  "SharedFixtureInvalid",
  {
    path: Schema.String,
    cause: Schema.Defect()
  }
) {
  override get message() {
    return `Could not load the shared-table fixture at ${this.path}.`;
  }
}

const versionId = "ver_000000000000000000000000";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const epoch = DateTime.toDateUtc(DateTime.makeUnsafe(0));
const SchemaState = Schema.Struct({
  companyId: Schema.String,
  patchId: Schema.String,
  owned: Schema.String,
  shared: Schema.Record(Schema.String, Schema.String)
});
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(SchemaState));
const checkedPath = (root: string, relative: string) =>
  Effect.tryPromise({
    try: () => safePath(root, relative),
    catch: (cause) => new StateUnavailable({ path: relative, cause })
  });

/** Translate the published cumulative metadata into the exact input to Tables.diff. */
const baselineSnapshot = (
  patchId: string,
  baseline: typeof PatchInventory.Type
): Inventory.Snapshot =>
  new Inventory.Snapshot({
    patchId,
    schemaRevision: baseline.schemaRevision,
    createdAt: epoch,
    tables: Object.entries(baseline.tables).map(
      ([name, definition]) =>
        new Inventory.Table({
          patchId,
          name,
          shared: definition.shared === true,
          createdAt: epoch
        })
    ),
    columns: Object.entries(baseline.tables).flatMap(([table, definition]) =>
      Object.entries(definition.columns).map(([name, column]) => {
        const defaultKind = !Object.hasOwn(column, "default")
          ? null
          : column.kind === "timestamp" && column.default === "now"
            ? "now"
            : "constant";
        return new Inventory.Column({
          patchId,
          table,
          name,
          kind: column.kind,
          refTable: column.kind === "ref" ? column.table : null,
          optional: column.optional === true,
          defaultKind,
          defaultValue: defaultKind === "constant" ? column.default : null
        });
      })
    ),
    indexes: Object.entries(baseline.tables).flatMap(([table, definition]) =>
      Object.entries(definition.indexes).map(
        ([name, index]) =>
          new Inventory.Index({
            patchId,
            table,
            name,
            columns: index.columns,
            unique: index.unique === true
          })
      )
    ),
    stores: Object.keys(baseline.files).map((name) => new Inventory.Store({ patchId, name }))
  });

interface LocalState {
  readonly stampPath: string;
  readonly stamp: string;
  readonly initialize: boolean;
  readonly changed: boolean;
  readonly changedSources: ReadonlySet<string>;
  readonly version: LoadedVersions.LoadedVersion;
  readonly versions: ReadonlyMap<string, LoadedVersions.LoadedVersion>;
  readonly fixtures: ReadonlyArray<{
    readonly patchId: string;
    readonly path: string;
    readonly contents: string;
  }>;
}

const make = Effect.fn("DevResources.make")(function* (prepared: Prepared, state: LocalState) {
  const fs = yield* FileSystem.FileSystem;
  const tables = yield* Tables.Tables;
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const inventory = yield* Inventory.Inventory;
  const pglite = yield* PgliteClient.PgliteClient;
  const companyId = prepared.identity.company.id;
  yield* databases.claim(companyId);
  yield* databases.ensureReady(companyId);
  const seeded = new Set<string>();
  for (const version of state.versions.values()) {
    const baseline =
      version.patchId === prepared.patchId && prepared.baseline !== undefined
        ? {
            ...version.manifest,
            tables: prepared.baseline.tables,
            files: prepared.baseline.files,
            uses: Tables.inventoryReferences(prepared.baseline.tables)
          }
        : undefined;
    yield* databases.withCompany(companyId)(
      CompanyDatabases.withPatchLock(version.patchId)(
        Effect.gen(function* () {
          const snapshot = yield* inventory.read(version.patchId);
          const compatible = yield* Effect.gen(function* () {
            if (baseline !== undefined) yield* tables.diff(baseline, snapshot);
            yield* tables.diff(version.manifest, snapshot);
          }).pipe(Effect.as(true), Effect.catchTags({ NotAdditive: () => Effect.succeed(false) }));
          if (snapshot !== null && (!compatible || state.changedSources.has(version.patchId))) {
            const sql = yield* CompanyDatabases.CompanyConnection;
            yield* sql.unsafe(
              `DROP SCHEMA IF EXISTS ${Inventory.quoteIdentifier(Inventory.namespace(version.patchId))} CASCADE`
            );
            yield* sql`DELETE FROM patchy.patches WHERE patch_id = ${version.patchId}`;
            seeded.add(version.patchId);
          }
          if (snapshot === null || state.initialize) seeded.add(version.patchId);
          // Data-dependent refusals from the real provisioner remain refusals, not a reason to erase rows.
          if (baseline !== undefined) yield* tables.provision(version.patchId, baseline);
          yield* tables.provision(version.patchId, version.manifest);
        })
      )
    );
  }
  for (const fixture of state.fixtures) {
    if (!seeded.has(fixture.patchId)) continue;
    yield* Effect.tryPromise({
      try: () =>
        pglite.pglite.transaction(async (sql) => {
          await sql.exec(
            `SET LOCAL search_path TO ${Inventory.quoteIdentifier(Inventory.namespace(fixture.patchId))}, pg_catalog`
          );
          await sql.exec(fixture.contents);
        }),
      catch: (cause) => new SharedFixtureInvalid({ path: fixture.path, cause })
    });
  }
  const postgres = yield* PostgresOperations.makeHandlers;
  const handlers = { me, ...(yield* TableOperations.make), ...(yield* Files.make), ...postgres };
  if (state.changed || state.initialize) yield* fs.writeFileString(state.stampPath, state.stamp);
  return { handlers, version: state.version };
});

/** Local databases and bytes are disposable; the server's published inventory is authority. */
export const prepare = Effect.fn("DevResources.prepare")(function* (
  prepared: Prepared,
  root: string,
  stateDir: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const local = yield* checkedPath(root, path.relative(root, stateDir));
  yield* fs.makeDirectory(local, { recursive: true });
  const companyDir = yield* checkedPath(local, "company");
  const contentDir = yield* checkedPath(local, "content");
  const stampPath = yield* checkedPath(local, "schema.json");
  const tables = yield* Tables.make.pipe(Effect.provide(Inventory.layer));
  yield* tables.diff(
    prepared.manifest,
    prepared.baseline === undefined ? null : baselineSnapshot(prepared.patchId, prepared.baseline)
  );
  const version: LoadedVersions.LoadedVersion = {
    patchId: prepared.patchId,
    versionId,
    companyId: prepared.identity.company.id,
    manifest: prepared.manifest,
    scope: "company",
    wireVersion: WIRE_VERSION
  };
  const versions = new Map<string, LoadedVersions.LoadedVersion>([[prepared.patchId, version]]);
  const fixtures: Array<{ patchId: string; path: string; contents: string }> = [];
  for (const [alias, { declaration, tables }] of Object.entries(prepared.metadata.shared)) {
    const relative = `fixtures/shared-${alias}.sql`;
    const fixturePath = yield* checkedPath(root, relative);
    if (!(yield* fs.exists(fixturePath))) return yield* new FixtureMissing({ path: relative });
    const contents = yield* fs.readFileString(fixturePath);
    fixtures.push({ patchId: declaration.patchId, path: relative, contents });
    const existing = versions.get(declaration.patchId);
    const sourceTables = { ...tables, ...existing?.manifest.tables };
    versions.set(declaration.patchId, {
      ...version,
      patchId: declaration.patchId,
      manifest: {
        ...prepared.manifest,
        tables: sourceTables,
        files: existing?.manifest.files ?? {},
        uses: Tables.inventoryReferences(sourceTables)
      }
    });
  }
  // Check every declared path before opening a database, including declarations sharing a connection.
  for (const { declaration } of Object.values(prepared.metadata.postgres)) {
    const relative = `fixtures/postgres-${declaration.handle}.sql`;
    const fixturePath = yield* checkedPath(root, relative);
    if (!(yield* fs.exists(fixturePath))) return yield* new FixtureMissing({ path: relative });
    yield* checkedPath(local, `postgres-${declaration.id}`);
    yield* checkedPath(local, `postgres-${declaration.id}.json`);
  }
  const shared: Record<string, string> = Object.create(null);
  for (const fixture of fixtures) {
    if (Object.hasOwn(shared, fixture.patchId)) continue;
    shared[fixture.patchId] = sha256(
      encodeJson({
        declarations: Object.values(prepared.metadata.shared).filter(
          (item) => item.declaration.patchId === fixture.patchId
        ),
        fixtures: fixtures.filter((item) => item.patchId === fixture.patchId)
      })
    );
  }
  const stamp = encodeJson({
    companyId: version.companyId,
    patchId: version.patchId,
    owned: sha256(
      encodeJson({
        tables: prepared.manifest.tables,
        files: prepared.manifest.files,
        baseline: prepared.baseline
      })
    ),
    shared
  });
  const previous = yield* fs.readFileString(stampPath).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error)
    })
  );
  const previousState = decodeState(previous);
  const changed = previous !== stamp;
  const initialize =
    Option.isNone(previousState) ||
    previousState.value.companyId !== version.companyId ||
    previousState.value.patchId !== version.patchId ||
    (prepared.baseline === undefined && changed) ||
    !(yield* fs.exists(companyDir));
  const changedSources = new Set(
    Object.keys(shared).filter(
      (patchId) =>
        Option.isNone(previousState) || previousState.value.shared[patchId] !== shared[patchId]
    )
  );
  if (initialize) {
    yield* fs.remove(stampPath, { force: true });
    yield* fs.remove(companyDir, { recursive: true, force: true });
    yield* fs.remove(contentDir, { recursive: true, force: true });
  }
  const loaded = Layer.succeed(
    LoadedVersions.LoadedVersions,
    LoadedVersions.LoadedVersions.of({
      find: (patchId, requestedVersion) => {
        if (requestedVersion !== undefined)
          return Effect.succeed(
            patchId === version.patchId && requestedVersion === version.versionId
              ? Option.some(version)
              : Option.none()
          );
        return Effect.succeed(Option.fromUndefinedOr(versions.get(patchId)));
      }
    })
  );
  const connections = new Map<string, ConnectionStoreDev.DevConnection>();
  const workerInputs = new Map<string, Prepared["metadata"]["postgres"][string]>();
  for (const { declaration, snapshot } of Object.values(prepared.metadata.postgres)) {
    if (connections.has(declaration.id)) continue;
    connections.set(declaration.id, {
      connection: new ConnectionStore.Connection({
        id: declaration.id,
        companyId: version.companyId,
        integration: "postgres",
        handle: declaration.handle,
        description: "Local fixture",
        mode: "company",
        status: "connected",
        display: { host: "local", port: 5432, database: declaration.handle, role: "fixture" },
        credentialRevision: 1,
        metadataRevision: declaration.revision,
        lastTestedAt: null,
        lastDiscoveredAt: null,
        createdBy: prepared.identity.user.id
      }),
      snapshots: [{ revision: declaration.revision, snapshot }]
    });
    workerInputs.set(declaration.id, { declaration, snapshot });
  }
  const postgres = Layer.effect(
    PostgresExecution.Execution,
    Effect.gen(function* () {
      const workers = yield* LayerMap.make((id: string) => {
        const { declaration, snapshot } = workerInputs.get(id)!;
        return PostgresDev.dev(snapshot, {
          connectionId: declaration.id,
          handle: declaration.handle,
          root,
          stateDir: local
        });
      });
      const executions = new Map<string, PostgresExecution.Execution["Service"]>();
      for (const id of workerInputs.keys()) {
        const context = yield* workers.contextEffect(id);
        executions.set(id, Context.get(context, PostgresExecution.Execution));
      }
      return PostgresExecution.Execution.of({
        query: (input) => {
          const execution = executions.get(input.declaration.id);
          return execution === undefined
            ? Effect.fail(new PostgresExecution.AccessDenied({}))
            : execution.query(input);
        }
      });
    })
  );
  const resources = Layer.mergeAll(
    PgliteCompanyDatabases.layer({ companyId: version.companyId, dataDir: companyDir }),
    Inventory.layer,
    loaded,
    ConnectionStoreDev.layer([...connections.values()]),
    postgres,
    FilesystemContentStore.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: contentDir }))
      )
    )
  );
  const context = yield* Layer.build(Tables.layer.pipe(Layer.provideMerge(resources)));
  const preparedResources = yield* make(prepared, {
    stampPath,
    stamp,
    initialize,
    changed,
    changedSources,
    version,
    versions,
    fixtures
  }).pipe(Effect.provideContext(context));
  return { ...preparedResources, context };
});
