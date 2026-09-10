import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { inject } from "vitest";
import { layerFromUrl } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import * as CompanyDatabases from "./CompanyDatabases.js";
import * as Inventory from "./Inventory.js";
import * as PgCompanyDatabases from "./PgCompanyDatabases.js";

/** Companies remain lazy; every test block owns its platform claims and their random database names. */
export const layer = (options?: {
  readonly maxBackends?: number;
  readonly capacity?: number;
  readonly adminLayer?: typeof PgCompanyDatabases.adminLayer;
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const platform = yield* SqlClient.SqlClient;
      const url = Redacted.make(inject("postgres").adminUrl);
      // Registered before child layers: company pools drain before their databases are dropped.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const placements = yield* platform<{
            database_name: string;
          }>`SELECT database_name FROM company_databases`;
          yield* Effect.gen(function* () {
            const admin = yield* SqlClient.SqlClient;
            for (const placement of placements) {
              yield* admin.unsafe(
                `DROP DATABASE IF EXISTS "${placement.database_name.replaceAll('"', '""')}" WITH (FORCE)`
              );
            }
          }).pipe(Effect.provide(layerFromUrl(url), { local: true }));
        }).pipe(Effect.orDie)
      );
      const settings = Layer.succeed(PgCompanyDatabases.CompanyDatabaseConfig, {
        adminUrl: url,
        dataUrl: url,
        maxBackends: options?.maxBackends ?? 200,
        capacity: options?.capacity ?? 100
      });
      return Layer.mergeAll(
        Layer.effect(CompanyDatabases.CompanyDatabases, PgCompanyDatabases.make).pipe(
          Layer.provide(options?.adminLayer ?? PgCompanyDatabases.adminLayer),
          Layer.provide(Reactivity.layer),
          Layer.provide(settings)
        ),
        Inventory.layer
      );
    })
  ).pipe(Layer.provideMerge(Testing.layer()));
