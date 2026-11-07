/**
 * The one-time flip that came with sharing by default (#1259): every existing
 * table and file store becomes shared unless its patch's newest version says
 * `shared: false`. `bun dist/fleet.js share-by-default` runs it for each ready
 * company database, once the release is live; docs/OPERATIONS.md has the runbook.
 * It trusts config as sharing's only writer, so it goes before the patch settings
 * can change sharing (#1261).
 *
 * It only ever turns sharing on, so it needs neither the company dependency lock
 * nor the dependant guard that unsharing takes. A flag already on whose newest
 * version says `shared: false` (company provisioning committed, then the platform
 * publish failed; ADR-0009) stays on, since consumers may already read it, and is
 * reported. Each patch commits on its own; a rerun writes nothing and sends no wakes.
 */
import { isShared } from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export const Resource = Schema.Struct({
  patchId: Schema.String,
  kind: Schema.Literals(["table", "store"]),
  name: Schema.String
});
export type Resource = typeof Resource.Type;

/** One company's pass. */
export interface CompanyReport {
  readonly companyId: string;
  /** Patches with inventory and a platform row. */
  readonly patches: number;
  /** Patches with inventory but no platform row, left to the reclamation sweep. */
  readonly skipped: number;
  /** What this pass shared. */
  readonly shared: readonly Resource[];
  /** Shared already, though the newest version says `shared: false`. */
  readonly leftShared: readonly Resource[];
}

/** The closing check found resources meant to be shared that are still unshared. */
export class UnsharedRemain extends Schema.TaggedError<UnsharedRemain>()("UnsharedRemain", {
  companyId: Schema.String,
  resources: Schema.Array(Resource)
}) {
  override get message() {
    return `${this.resources.length} resources in company ${this.companyId} are still unshared: ${this.resources
      .map((resource) => `${resource.patchId}/${resource.name}`)
      .join(", ")}.`;
  }
}

// Only the sharing flags of the newest version's definitions; anything it omits is shared.
const Definitions = Schema.Record(
  Schema.String,
  Schema.Struct({ shared: Schema.optionalKey(Schema.Boolean) })
);
const NewestVersion = Schema.Struct({
  manifest: Schema.Struct({
    tables: Schema.optionalKey(Definitions),
    files: Schema.optionalKey(Definitions)
  })
});

/** Flips one ready company database, then checks that nothing meant to be shared is unshared. */
export const company = Effect.fn("ShareByDefault.company")(function* (companyId: string) {
  // The platform client; inside `withCompany`, SqlClient is the company's.
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const inventory = yield* Inventory.Inventory;

  const inventoried = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ patchId: Schema.String }),
    execute: Effect.fn("ShareByDefault.inventoried")(function* () {
      const company = yield* CompanyDatabases.CompanyConnection;
      return yield* company`SELECT patch_id AS "patchId" FROM patchy.patches ORDER BY patch_id`;
    })
  });
  const lockRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (patchId) => sql`SELECT id FROM patches
      WHERE id = ${patchId} AND company_id = ${companyId} FOR UPDATE`
  });
  const newestVersion = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: NewestVersion,
    execute: (patchId) => sql`SELECT manifest FROM patch_versions
      WHERE patch_id = ${patchId} ORDER BY version_number DESC LIMIT 1`
  });

  /**
   * One patch under its platform row lock, then its company patch lock (ADR-0009's
   * order). None when the platform row is gone. `apply: false` only looks.
   */
  const visit = (patchId: string, apply: boolean) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (Option.isNone(yield* lockRow(patchId))) return Option.none();
          const manifest = Option.getOrUndefined(yield* newestVersion(patchId))?.manifest;
          // What the newest version says, where it defines the resource at all.
          const meantShared = (kind: Resource["kind"], name: string) => {
            const definitions = manifest?.[kind === "table" ? "tables" : "files"];
            return (
              definitions === undefined ||
              !Object.hasOwn(definitions, name) ||
              isShared(definitions[name]!)
            );
          };
          return Option.some(
            yield* databases.withCompany(companyId)(
              databases.withPatchLock(patchId)(
                Effect.gen(function* () {
                  const snapshot = yield* inventory.read(patchId);
                  const shared: Resource[] = [];
                  const leftShared: Resource[] = [];
                  const rows = [
                    ...(snapshot?.tables ?? []).map((row) => ({ kind: "table" as const, row })),
                    ...(snapshot?.stores ?? []).map((row) => ({ kind: "store" as const, row }))
                  ];
                  for (const { kind, row } of rows) {
                    const resource = { patchId, kind, name: row.name };
                    const meant = meantShared(kind, row.name);
                    if (row.shared && !meant) leftShared.push(resource);
                    if (row.shared || !meant) continue;
                    shared.push(resource);
                    // Each upsert bumps the resource revision and wakes its readers after commit.
                    if (apply)
                      yield* (kind === "table" ? inventory.putTable : inventory.putStore)({
                        patchId,
                        name: row.name,
                        description: row.description,
                        shared: true
                      });
                  }
                  if (apply && shared.length > 0) yield* inventory.bumpRevision(patchId);
                  return { shared, leftShared };
                })
              )
            )
          );
        })
      )
      .pipe(Effect.catchTags({ SchemaError: Effect.die }));

  const patchIds = (yield* databases
    .withCompany(companyId)(inventoried(undefined))
    .pipe(Effect.catchTags({ SchemaError: Effect.die }))).map((row) => row.patchId);
  let patches = 0;
  const shared: Resource[] = [];
  const leftShared: Resource[] = [];
  for (const patchId of patchIds) {
    const visited = yield* visit(patchId, true);
    if (Option.isNone(visited)) continue;
    patches += 1;
    shared.push(...visited.value.shared);
    leftShared.push(...visited.value.leftShared);
  }
  const remaining: Resource[] = [];
  for (const patchId of patchIds) {
    const visited = yield* visit(patchId, false);
    if (Option.isSome(visited)) remaining.push(...visited.value.shared);
  }
  if (remaining.length > 0) return yield* new UnsharedRemain({ companyId, resources: remaining });
  return {
    companyId,
    patches,
    skipped: patchIds.length - patches,
    shared,
    leftShared
  } satisfies CompanyReport;
});
