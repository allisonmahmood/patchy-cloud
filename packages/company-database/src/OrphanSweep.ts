import { ContentStore } from "@patchy/content-store";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as CompanyDatabases from "./CompanyDatabases.js";
import { quoteIdentifier } from "./Inventory.js";

const DAY = 24 * 60 * 60 * 1_000;
const BATCH_SIZE = 100;
const isBusy = Schema.is(CompanyDatabases.Busy);
const retryBusy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.retry(effect, {
    times: 1,
    schedule: Schedule.spaced("61 seconds"),
    while: isBusy
  });

class NamespaceRow extends Schema.Class<NamespaceRow>("OrphanNamespaceRow")({
  namespace: Schema.String
}) {}

class ExistsRow extends Schema.Class<ExistsRow>("OrphanReferenceRow")({
  exists: Schema.Boolean
}) {}

class FileReference extends Schema.Class<FileReference>("OrphanFileReference")({
  patchId: Schema.String,
  store: Schema.String,
  objectId: Schema.String
}) {}

class PatchOwner extends Schema.Class<PatchOwner>("OrphanPatchOwner")({
  companyId: Schema.String
}) {}

export interface SweepResult {
  readonly namespacesDeleted: number;
  readonly filesDeleted: number;
  /** Failed company scans, namespace operations, file operations, or object listings. */
  readonly failed: number;
}

export class OrphanSweep extends Context.Service<
  OrphanSweep,
  {
    /** One fail-closed pass; scheduling belongs to the server. */
    readonly sweep: Effect.Effect<SweepResult>;
  }
>()("@patchy/company-database/OrphanSweep") {}

export const make = Effect.gen(function* () {
  const platform = yield* SqlClient.SqlClient;
  const companies = yield* CompanyDatabases.CompanyDatabases;
  const store = yield* ContentStore.ContentStore;

  // Foreground leases remain fail-fast. Only this background caller waits for
  // retained idle pools to expire, once, without holding another company lease.
  const withCompany = <A, E, R>(companyId: string, effect: Effect.Effect<A, E, R>) =>
    companies.withCompany(companyId)(effect).pipe(retryBusy);

  const platformPatch = SqlSchema.findAll({
    Request: Schema.String,
    Result: ExistsRow,
    execute: (patchId) =>
      platform`SELECT EXISTS(SELECT 1 FROM patches WHERE id = ${patchId}) AS "exists"`
  });

  const lockPlatformPatch = SqlSchema.findAll({
    Request: Schema.String,
    Result: PatchOwner,
    execute: (patchId) =>
      platform`SELECT company_id AS "companyId" FROM patches WHERE id = ${patchId} FOR UPDATE`
  });

  // These queries resolve the owning company client inside the lease.
  const namespaces = SqlSchema.findAll({
    Request: Schema.String,
    Result: NamespaceRow,
    execute: Effect.fn(function* (after) {
      const sql = yield* CompanyDatabases.CompanyConnection;
      return yield* sql`SELECT nspname AS namespace FROM pg_namespace
        WHERE left(nspname, 2) = 'p_' AND nspname > ${after}
        ORDER BY nspname LIMIT ${BATCH_SIZE}`;
    })
  });

  const agedNamespace = SqlSchema.findAll({
    Request: Schema.Struct({
      namespace: Schema.String,
      patchId: Schema.String,
      cutoff: Schema.String
    }),
    Result: ExistsRow,
    execute: Effect.fn(function* ({ namespace, patchId, cutoff }) {
      const sql = yield* CompanyDatabases.CompanyConnection;
      return yield* sql`SELECT EXISTS(
        SELECT 1 FROM pg_namespace n
        LEFT JOIN patchy.patches p ON p.patch_id = ${patchId}
        LEFT JOIN patchy.orphan_namespaces o ON o.namespace = n.nspname
        WHERE n.nspname = ${namespace}
          AND coalesce(p.created_at, o.first_seen_at) < ${cutoff}::timestamptz
      ) AS "exists"`;
    })
  });

  const reclaimNamespace = Effect.fn("OrphanSweep.reclaimNamespace")(function* (
    namespace: string,
    cutoff: string
  ) {
    const patchId = namespace.slice(2);
    return yield* companies.withPatchLock(patchId)(
      Effect.gen(function* () {
        const { sql } = yield* CompanyDatabases.PatchLock;
        const live = yield* platformPatch(patchId).pipe(
          Effect.catchTags({ SchemaError: Effect.die })
        );
        if (live[0]!.exists) {
          yield* sql`DELETE FROM patchy.orphan_namespaces WHERE namespace = ${namespace}`;
          return false;
        }

        // Postgres records no schema creation time. Untracked namespaces must be
        // observed for a full day, durably across process restarts, before removal.
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO patchy.orphan_namespaces (namespace, first_seen_at)
        SELECT ${namespace}, ${observedAt}::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM patchy.patches WHERE patch_id = ${patchId})
        ON CONFLICT (namespace) DO NOTHING`;
        const aged = yield* agedNamespace({ namespace, patchId, cutoff }).pipe(
          Effect.catchTags({ SchemaError: Effect.die })
        );
        if (!aged[0]!.exists) return false;

        // Recheck after the age query, with the company patch lock still held.
        // Patch IDs are never reused; new publication transactions have a 60s
        // deadline, far below the one-day grace period protecting absent rows.
        const stillLive = yield* platformPatch(patchId).pipe(
          Effect.catchTags({ SchemaError: Effect.die })
        );
        if (stillLive[0]!.exists) return false;
        yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(namespace)} CASCADE`);
        yield* sql`DELETE FROM patchy.patches WHERE patch_id = ${patchId}`;
        yield* sql`DELETE FROM patchy.orphan_namespaces WHERE namespace = ${namespace}`;
        return true;
      })
    );
  });

  const fileReferences = SqlSchema.findAll({
    Request: Schema.Array(FileReference),
    Result: FileReference,
    execute: Effect.fn(function* (objects) {
      const sql = yield* CompanyDatabases.CompanyConnection;
      return yield* sql`SELECT DISTINCT patch_id AS "patchId", store, object_id AS "objectId"
        FROM patchy.files WHERE ${sql.or(
          objects.map(
            (object) =>
              sql`patch_id = ${object.patchId} AND store = ${object.store} AND object_id = ${object.objectId}`
          )
        )}`;
    })
  });

  const reclaimFile = Effect.fn("OrphanSweep.reclaimFile")(
    function* (key: string, reference: FileReference) {
      return yield* platform.withTransaction(
        Effect.gen(function* () {
          const owners = yield* lockPlatformPatch(reference.patchId).pipe(
            Effect.catchTags({ SchemaError: Effect.die })
          );
          if (owners.length === 0) {
            // The batch already checked every ready company's index, fail-closed.
            // An absent row cannot be locked: safety here depends on immutable
            // object keys, never-reused patch IDs, and the one-day object grace
            // exceeding a new publication's 60s deadline. A concurrent create
            // cannot legitimately introduce a reference to this old object.
            yield* store.delete(key);
            return true;
          }
          return yield* companies.withCompany(owners[0]!.companyId)(
            companies.withPatchLock(reference.patchId)(
              Effect.gen(function* () {
                // An existing patch can attach an old object after the batch
                // scan. Serialize this final check and deletion with publishers,
                // holding the platform row before the company patch lock.
                const references = yield* fileReferences([reference]).pipe(
                  Effect.catchTags({ SchemaError: Effect.die })
                );
                if (references.length !== 0) return false;
                yield* store.delete(key);
                return true;
              })
            )
          );
        })
      );
    },
    // Release the platform row as well as the company lease before waiting.
    retryBusy
  );

  const sweep = Effect.gen(function* () {
    const result = { namespacesDeleted: 0, filesDeleted: 0, failed: 0 };
    const now = yield* DateTime.now;
    const cutoffMillis = DateTime.toEpochMillis(now) - DAY;
    const cutoff = DateTime.formatIso(DateTime.subtract(now, { days: 1 }));
    const placements = yield* companies.listReady.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Orphan sweep could not list company placements.", error._tag).pipe(
          Effect.as(undefined)
        )
      )
    );
    if (placements === undefined) return { ...result, failed: 1 };

    for (const placement of placements) {
      yield* withCompany(
        placement.companyId,
        Effect.gen(function* () {
          let after = "";
          while (true) {
            const batch = yield* namespaces(after).pipe(
              Effect.catchTags({ SchemaError: Effect.die })
            );
            for (const row of batch) {
              yield* reclaimNamespace(row.namespace, cutoff).pipe(
                Effect.tap((deleted) =>
                  Effect.sync(() => {
                    if (deleted) result.namespacesDeleted += 1;
                  })
                ),
                Effect.catch((error) =>
                  Effect.logWarning("Orphan sweep could not reclaim a namespace.", error._tag).pipe(
                    Effect.annotateLogs({
                      companyId: placement.companyId,
                      namespace: row.namespace
                    }),
                    Effect.andThen(
                      Effect.sync(() => {
                        result.failed += 1;
                      })
                    )
                  )
                )
              );
            }
            if (batch.length < BATCH_SIZE) break;
            after = batch[batch.length - 1]!.namespace;
          }
        })
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Orphan sweep could not scan a company database.", error._tag).pipe(
            Effect.annotateLogs({ companyId: placement.companyId }),
            Effect.andThen(
              Effect.sync(() => {
                result.failed += 1;
              })
            )
          )
        )
      );
    }

    // A file's patch may have no platform or inventory row. Check every ready
    // company's index before deletion; unavailable indexes preserve the batch.
    // Batch queries keep both memory and pool turnover bounded.
    yield* store.list("files/").pipe(
      Stream.filter(
        (object) => Number.isFinite(object.lastModified) && object.lastModified < cutoffMillis
      ),
      Stream.grouped(BATCH_SIZE),
      Stream.runForEach(
        Effect.fn(function* (batch) {
          const candidates = new Map<string, FileReference>();
          for (const object of batch) {
            const segments = object.key.split("/");
            if (
              segments.length !== 4 ||
              segments[0] !== "files" ||
              segments.some((segment) => segment === "")
            )
              continue;
            candidates.set(
              object.key,
              new FileReference({
                patchId: segments[1]!,
                store: segments[2]!,
                objectId: segments[3]!
              })
            );
          }
          if (candidates.size === 0) return;
          yield* Effect.gen(function* () {
            for (const placement of placements) {
              const rows = yield* withCompany(
                placement.companyId,
                fileReferences([...candidates.values()])
              ).pipe(Effect.catchTags({ SchemaError: Effect.die }));
              for (const row of rows)
                candidates.delete(`files/${row.patchId}/${row.store}/${row.objectId}`);
              if (candidates.size === 0) return;
            }
            for (const [key, reference] of candidates) {
              yield* reclaimFile(key, reference).pipe(
                Effect.tap((deleted) =>
                  Effect.sync(() => {
                    if (deleted) result.filesDeleted += 1;
                  })
                ),
                Effect.catch((error) =>
                  Effect.logWarning(
                    "Orphan sweep could not reclaim a file object.",
                    error._tag
                  ).pipe(
                    Effect.annotateLogs({ objectKey: key }),
                    Effect.andThen(
                      Effect.sync(() => {
                        result.failed += 1;
                      })
                    )
                  )
                )
              );
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Orphan sweep could not check file references.", error._tag).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    result.failed += 1;
                  })
                )
              )
            )
          );
        })
      ),
      Effect.catch((error) =>
        Effect.logWarning("Orphan sweep could not list file objects.", error._tag).pipe(
          Effect.andThen(
            Effect.sync(() => {
              result.failed += 1;
            })
          )
        )
      )
    );
    return result;
  }).pipe(Effect.withSpan("OrphanSweep.sweep"));

  return OrphanSweep.of({ sweep });
});

export const layer = Layer.effect(OrphanSweep, make);
