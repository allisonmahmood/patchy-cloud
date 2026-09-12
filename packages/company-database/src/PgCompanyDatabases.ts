import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Pg from "pg";
import { newInternalId } from "@patchy/core";
import * as CompanyDatabases from "./CompanyDatabases.js";
import * as Inventory from "./Inventory.js";

export class CompanyDatabaseConfig extends Context.Service<
  CompanyDatabaseConfig,
  {
    readonly adminUrl: Redacted.Redacted<string>;
    readonly dataUrl: Redacted.Redacted<string>;
    readonly maxBackends: number;
    readonly capacity: number;
  }
>()("@patchy/company-database/PgCompanyDatabases/CompanyDatabaseConfig") {}

/** Separate from the platform and company clients; never inherits their transaction. */
export class AdminClient extends Context.Service<AdminClient, SqlClient.SqlClient>()(
  "@patchy/company-database/PgCompanyDatabases/AdminClient"
) {}

// pg uses the last `user` query value when nonempty, otherwise the authority.
const username = (url: URL): string =>
  url.searchParams.getAll("user").at(-1) || decodeURIComponent(url.username);

const DatabaseUrl = Schema.Redacted(Schema.String).check(
  Schema.makeFilter((secret) => {
    try {
      const url = new URL(Redacted.value(secret));
      decodeURIComponent(url.password);
      decodeURI(url.pathname);
      return (
        (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
        username(url).length > 0 &&
        url.hash === "" &&
        (url.hostname !== "" || Boolean(url.searchParams.getAll("host").at(-1)))
      );
    } catch {
      return false;
    }
  })
);

export const config = Config.all({
  adminUrl: Config.schema(DatabaseUrl, "PATCHY_COMPANY_DB_ADMIN_URL"),
  dataUrl: Config.schema(DatabaseUrl, "PATCHY_COMPANY_DB_URL"),
  maxBackends: Config.schema(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(4)),
    "PATCHY_COMPANY_DB_MAX_BACKENDS"
  ).pipe(Config.withDefault(200)),
  capacity: Config.succeed(100)
});

const databaseUrl = (template: Redacted.Redacted<string>, name: string) => {
  const url = new URL(Redacted.value(template));
  url.pathname = `/${name}`;
  return Redacted.make(url.toString());
};
const duplicateDatabase = Schema.is(Schema.Struct({ code: Schema.Literal("42P04") }));

class PoolKey extends Data.Class<{
  readonly companyId: string;
  readonly serverId: string;
  readonly placementVersion: number;
  readonly databaseName: string;
}> {}

/** Register cleanup before any network I/O, including a failed/interrupted first connection. */
const pool = (url: Redacted.Redacted<string>, max: number) =>
  PgClient.fromPool({
    acquire: Effect.acquireRelease(
      Effect.sync(() => {
        const pool = new Pg.Pool({
          connectionString: Redacted.value(url),
          max,
          min: 0,
          idleTimeoutMillis: 60_000,
          connectionTimeoutMillis: 5_000,
          types: {
            getTypeParser: (oid, format) =>
              oid === 20 || oid === 1082
                ? (value: string) => value
                : Pg.types.getTypeParser(oid, format)
          }
        });
        pool.on("error", () => {});
        return pool;
      }),
      (pool) => Effect.promise(() => pool.end())
    )
  });

export const adminLayer = Layer.effect(
  AdminClient,
  Effect.gen(function* () {
    const settings = yield* CompanyDatabaseConfig;
    return yield* pool(settings.adminUrl, 1);
  })
).pipe(Layer.provide(Reactivity.layer));

export const make = Effect.gen(function* () {
  const platformPool = yield* PgClient.PgClient;
  // Callers hold platform patch-row transactions. Placement work must never
  // borrow from that pool: saturated callers would each wait for a second slot.
  // Clone credentials/options, not connections, and keep claims independently committed.
  const platform = yield* PgClient.make({
    ...platformPool.config,
    maxConnections: 2,
    minConnections: 0,
    idleTimeout: "60 seconds",
    connectTimeout: "5 seconds"
  });
  const admin = yield* AdminClient;
  const settings = yield* CompanyDatabaseConfig;
  const reactivity = yield* Reactivity.Reactivity;
  const columns = platform`company_id AS "companyId", server_id AS "serverId",
    database_name AS "databaseName", placement_version AS "placementVersion", status,
    created_at AS "createdAt", ready_at AS "readyAt"`;
  const placements = SqlSchema.findAll({
    Request: Schema.String,
    Result: CompanyDatabases.Placement,
    execute: (companyId) =>
      platform`SELECT ${columns} FROM company_databases WHERE company_id = ${companyId}`
  });
  const lockedPlacement = SqlSchema.findAll({
    Request: Schema.String,
    Result: CompanyDatabases.Placement,
    execute: (companyId) =>
      platform`SELECT ${columns} FROM company_databases WHERE company_id = ${companyId} FOR UPDATE`
  });
  const readyPlacements = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CompanyDatabases.Placement,
    execute: () => platform`SELECT ${columns} FROM company_databases WHERE status = 'ready'`
  });
  const dieOnSchemaError = { SchemaError: Effect.die } as const;

  const claim = Effect.fn("CompanyDatabases.claim")(
    function* (companyId: string) {
      const existing = yield* placements(companyId).pipe(Effect.catchTags(dieOnSchemaError));
      if (existing[0]) return existing[0];
      yield* platform`INSERT INTO company_databases (company_id, database_name)
        VALUES (${companyId}, ${newInternalId("patchy_company")}) ON CONFLICT (company_id) DO NOTHING`;
      const rows = yield* placements(companyId).pipe(Effect.catchTags(dieOnSchemaError));
      return rows[0]!;
    },
    (effect, companyId) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "claim", cause })
        )
      )
  );

  const upgradeReady = Effect.fn("CompanyDatabases.upgradeReady")(
    function* (placement: CompanyDatabases.Placement) {
      const data = yield* pool(databaseUrl(settings.dataUrl, placement.databaseName), 1);
      yield* Inventory.upgrade.pipe(Effect.provideService(SqlClient.SqlClient, data));
      return placement;
    },
    Effect.scoped,
    (effect, placement) =>
      effect.pipe(
        Effect.provideService(Reactivity.Reactivity, reactivity),
        Effect.mapError(
          (cause) =>
            new CompanyDatabases.CompanyDatabaseError({
              companyId: placement.companyId,
              operation: "upgrade",
              cause
            })
        )
      )
  );

  const ensureReady = Effect.fn("CompanyDatabases.ensureReady")(function* (companyId: string) {
    const placement = yield* claim(companyId);
    if (placement.status === "ready") return yield* upgradeReady(placement);
    return yield* platform
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* lockedPlacement(companyId).pipe(Effect.catchTags(dieOnSchemaError));
          const claimed = rows[0]!;
          if (claimed.status === "ready") return yield* upgradeReady(claimed);
          const name = Inventory.quoteIdentifier(claimed.databaseName);
          const roleUrl = new URL(Redacted.value(settings.dataUrl));
          const dataRole = Inventory.quoteIdentifier(username(roleUrl));
          // The committed claim is the authority. Only this exact claimed name can resume a duplicate CREATE.
          // Keep the row lock until CREATE settles; cancellation must not race a still-running CREATE.
          yield* admin.unsafe(`CREATE DATABASE ${name} OWNER ${dataRole} TEMPLATE template1`).pipe(
            Effect.catchIf(
              (error) => duplicateDatabase(error.reason.cause),
              () => Effect.void
            ),
            Effect.mapError(
              (cause) =>
                new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "create", cause })
            ),
            Effect.uninterruptible
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const data = yield* pool(databaseUrl(settings.dataUrl, claimed.databaseName), 1);
              yield* Effect.gen(function* () {
                yield* data.unsafe(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
                yield* data.unsafe(`GRANT CONNECT, TEMPORARY ON DATABASE ${name} TO ${dataRole}`);
                yield* data.unsafe(`ALTER DATABASE ${name} SET timezone TO 'UTC'`);
                yield* data.unsafe(`ALTER DATABASE ${name} SET statement_timeout TO '30s'`);
                yield* data.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new CompanyDatabases.CompanyDatabaseError({
                      companyId,
                      operation: "configure",
                      cause
                    })
                )
              );
              yield* Inventory.initialize.pipe(
                Effect.provideService(SqlClient.SqlClient, data),
                Effect.mapError(
                  (cause) =>
                    new CompanyDatabases.CompanyDatabaseError({
                      companyId,
                      operation: "initialize",
                      cause
                    })
                )
              );
            })
          ).pipe(
            Effect.provideService(Reactivity.Reactivity, reactivity),
            Effect.catchTags({
              SqlError: (cause) =>
                Effect.fail(
                  new CompanyDatabases.CompanyDatabaseError({
                    companyId,
                    operation: "connect",
                    cause
                  })
                )
            })
          );
          return yield* Effect.gen(function* () {
            yield* platform`UPDATE company_databases SET status = 'ready', ready_at = now() WHERE company_id = ${companyId}`;
            const ready = yield* placements(companyId).pipe(Effect.catchTags(dieOnSchemaError));
            return ready[0]!;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "ready", cause })
            )
          );
        })
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "claim", cause })
            )
        })
      );
  });

  // Reserve retained maxima, not only live operations. The reservation outlives pool.end().
  let reservedBackends = 0;
  const registry = yield* RcMap.make({
    capacity: settings.capacity,
    idleTimeToLive: "60 seconds",
    lookup: Effect.fn("CompanyDatabases.openPool")(function* (key: PoolKey) {
      yield* Effect.acquireRelease(
        Effect.suspend(() => {
          if (reservedBackends + 4 > settings.maxBackends) {
            return Effect.fail(
              new CompanyDatabases.Busy({ resource: "backend budget", limit: settings.maxBackends })
            );
          }
          reservedBackends += 4;
          return Effect.void;
        }),
        () =>
          Effect.sync(() => {
            reservedBackends -= 4;
          })
      );
      const sql = yield* pool(databaseUrl(settings.dataUrl, key.databaseName), 4).pipe(
        Effect.mapError(
          (cause) =>
            new CompanyDatabases.CompanyDatabaseError({
              companyId: key.companyId,
              operation: "connect",
              cause
            })
        )
      );
      return {
        context: Context.make(SqlClient.SqlClient, sql).pipe(
          Context.add(CompanyDatabases.CompanyConnection, sql)
        ),
        permits: yield* Semaphore.make(4)
      };
    })
  });

  const withCompany: CompanyDatabases.CompanyDatabases["Service"]["withCompany"] =
    (companyId) => (effect) =>
      Effect.gen(function* () {
        const rows = yield* placements(companyId).pipe(
          Effect.catchTags(dieOnSchemaError),
          Effect.mapError(
            (cause) =>
              new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "connect", cause })
          )
        );
        const placement = rows[0];
        if (placement?.status !== "ready") {
          return yield* new CompanyDatabases.CompanyDatabaseNotReady({
            companyId,
            status: placement?.status ?? null
          });
        }
        const key = new PoolKey({
          companyId,
          serverId: placement.serverId,
          placementVersion: placement.placementVersion,
          databaseName: placement.databaseName
        });
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const entry = yield* RcMap.get(registry, key).pipe(
              Effect.catchTags({
                ExceededCapacityError: () =>
                  Effect.fail(
                    new CompanyDatabases.Busy({
                      resource: "pool registry",
                      limit: settings.capacity
                    })
                  ),
                Busy: (error) =>
                  RcMap.invalidate(registry, key).pipe(Effect.andThen(Effect.fail(error)))
              })
            );
            const result = yield* effect.pipe(
              Effect.provideContext(entry.context),
              entry.permits.withPermitsIfAvailable(1)
            );
            if (Option.isNone(result)) {
              return yield* new CompanyDatabases.Busy({ resource: "company operations", limit: 4 });
            }
            return result.value;
          })
        );
      });

  return CompanyDatabases.CompanyDatabases.of({
    claim,
    ensureReady,
    withCompany,
    withPatchLock: CompanyDatabases.withPatchLock,
    listReady: readyPlacements(undefined).pipe(
      Effect.catchTags(dieOnSchemaError),
      Effect.mapError(
        (cause) => new CompanyDatabases.CompanyDatabaseError({ operation: "list", cause })
      )
    )
  });
});

export const layer = Layer.effect(CompanyDatabases.CompanyDatabases, make).pipe(
  Layer.provide(adminLayer),
  Layer.provide(Reactivity.layer),
  Layer.provide(Layer.effect(CompanyDatabaseConfig, config))
);
