/**
 * The migrated-database test layer: an `it.layer` block gets an empty
 * database on the vitest Postgres cluster (`test/postgres.ts` provides its
 * admin URL), migrated by the given record, and dropped with the layer.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { inject } from "vitest";
import { layerFromUrl, migrate, type Migrations } from "./index.js";

declare module "vitest" {
  export interface ProvidedContext {
    postgres: { adminUrl: string };
  }
}

interface TestDatabase {
  readonly name: string;
  readonly url: string;
}

/** Runs one statement on the cluster's maintenance database, with its own short-lived pool. */
const admin = (statement: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(
    Effect.provide(layerFromUrl(Redacted.make(inject("postgres").adminUrl)), { local: true })
  );

const createEmptyDatabase = Effect.gen(function* () {
  const name = `patchy_test_${(yield* Random.nextInt).toString(36)}`;
  yield* admin(`CREATE DATABASE "${name}"`);
  const url = new URL(inject("postgres").adminUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() } satisfies TestDatabase;
});

const dropDatabase = (database: TestDatabase) =>
  admin(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`).pipe(Effect.orDie);

/** A fresh database migrated by `migrations`, as `SqlClient`; the pool closes and the database drops with the layer. */
export const layer = (migrations: Migrations) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(createEmptyDatabase, dropDatabase);
      return Layer.effectDiscard(migrate(migrations)).pipe(
        Layer.provideMerge(layerFromUrl(Redacted.make(database.url)))
      );
    })
  );
