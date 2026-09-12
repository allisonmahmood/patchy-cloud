import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as CompanyDatabases from "./CompanyDatabases.js";
import * as Inventory from "./Inventory.js";

export interface Options {
  readonly companyId: string;
  readonly dataDir: string;
}

/** The directory retains its company binding across clean close/reopen cycles. */
export const make = Effect.fn("PgliteCompanyDatabases.make")(function* (options: Options) {
  const sql = yield* SqlClient.SqlClient;
  const companyContext = Context.make(SqlClient.SqlClient, sql).pipe(
    Context.add(CompanyDatabases.CompanyConnection, sql)
  );
  yield* sql.unsafe('CREATE SCHEMA IF NOT EXISTS "patchy"');
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "patchy"."local_company" (
    "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
    "company_id" text NOT NULL,
    "status" text NOT NULL DEFAULT 'claimed' CHECK ("status" IN ('claimed', 'ready')),
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "ready_at" timestamptz
  )`);

  const findPlacement = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: CompanyDatabases.Placement,
    execute: () => sql`SELECT "company_id" AS "companyId", 'local'::text AS "serverId",
      'local'::text AS "databaseName", 1::integer AS "placementVersion", "status",
      "created_at" AS "createdAt", "ready_at" AS "readyAt" FROM "patchy"."local_company"`
  });

  const checkIdentity = Effect.fn("PgliteCompanyDatabases.checkIdentity")(function* (
    companyId: string,
    expectedCompanyId: string
  ) {
    if (companyId !== expectedCompanyId) {
      return yield* new CompanyDatabases.CompanyIdentityMismatch({
        expectedCompanyId,
        actualCompanyId: companyId
      });
    }
  });

  const claim = Effect.fn("PgliteCompanyDatabases.claim")(function* (companyId: string) {
    yield* checkIdentity(companyId, options.companyId);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO "patchy"."local_company" ("company_id") VALUES (${companyId})
          ON CONFLICT ("singleton") DO NOTHING`;
          const placement = yield* findPlacement(undefined).pipe(
            Effect.catchTags({ SchemaError: Effect.die })
          );
          if (Option.isNone(placement)) return yield* Effect.die("Local company claim disappeared");
          yield* checkIdentity(companyId, placement.value.companyId);
          return placement.value;
        })
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              new CompanyDatabases.CompanyDatabaseError({
                companyId,
                operation: "claim",
                cause
              })
            )
        })
      );
  });

  const ensureReady = Effect.fn("PgliteCompanyDatabases.ensureReady")(function* (
    companyId: string
  ) {
    const placement = yield* claim(companyId);
    if (placement.status === "ready") return placement;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* Inventory.initialize.pipe(
            Effect.mapError(
              (cause) =>
                new CompanyDatabases.CompanyDatabaseError({
                  companyId,
                  operation: "initialize",
                  cause
                })
            )
          );
          yield* sql`UPDATE "patchy"."local_company" SET "status" = 'ready', "ready_at" = now()
          WHERE "company_id" = ${companyId} AND "status" = 'claimed'`.pipe(
            Effect.mapError(
              (cause) =>
                new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "ready", cause })
            )
          );
          return yield* claim(companyId);
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              new CompanyDatabases.CompanyDatabaseError({
                companyId,
                operation: "claim",
                cause
              })
            )
        })
      );
  });

  const withCompany: CompanyDatabases.CompanyDatabases["Service"]["withCompany"] =
    (companyId) => (effect) =>
      Effect.gen(function* () {
        yield* checkIdentity(companyId, options.companyId);
        const placement = yield* findPlacement(undefined).pipe(
          Effect.catchTags({ SchemaError: Effect.die }),
          Effect.mapError(
            (cause) =>
              new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "connect", cause })
          )
        );
        if (Option.isSome(placement)) yield* checkIdentity(companyId, placement.value.companyId);
        if (Option.isNone(placement) || placement.value.status !== "ready") {
          return yield* new CompanyDatabases.CompanyDatabaseNotReady({
            companyId,
            status: Option.isNone(placement) ? null : "claimed"
          });
        }
        return yield* Effect.scoped(effect.pipe(Effect.provideContext(companyContext)));
      });

  const listReady = Effect.gen(function* () {
    const placement = yield* findPlacement(undefined).pipe(
      Effect.catchTags({ SchemaError: Effect.die })
    );
    if (Option.isNone(placement)) return [];
    yield* checkIdentity(options.companyId, placement.value.companyId);
    return placement.value.status === "ready" ? [placement.value] : [];
  }).pipe(
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.fail(
          new CompanyDatabases.CompanyDatabaseError({
            companyId: options.companyId,
            operation: "list",
            cause
          })
        )
    })
  );

  return CompanyDatabases.CompanyDatabases.of({
    claim,
    ensureReady,
    withCompany,
    withPatchLock: CompanyDatabases.withPatchLock,
    listReady
  });
});

/** One PGlite connection; its driver serializes transactions, not production races. */
export const layer = (options: Options) =>
  Layer.effect(CompanyDatabases.CompanyDatabases, make(options)).pipe(
    Layer.provide(
      PgliteClient.layer({
        dataDir: options.dataDir,
        relaxedDurability: true,
        parsers: {
          20: (value) => value,
          1082: (value) => value
        }
      })
    )
  );
