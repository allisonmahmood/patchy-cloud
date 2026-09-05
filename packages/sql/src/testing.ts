/**
 * Isolated databases on vitest's Postgres cluster, dropped with their layers.
 * Capability tests clone the migrated, seeded template; migrator tests start empty.
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
    postgres: { adminUrl: string; templateDatabase: string };
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

const createDatabase = Effect.fn("Testing.createDatabase")(function* (template?: string) {
  const name = `patchy_test_${(yield* Random.nextInt).toString(36)}`;
  const source = template === undefined ? "" : ` TEMPLATE "${template.replaceAll('"', '""')}"`;
  yield* admin(`CREATE DATABASE "${name}"${source}`);
  const url = new URL(inject("postgres").adminUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() } satisfies TestDatabase;
});

const dropDatabase = (database: TestDatabase) =>
  admin(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`).pipe(Effect.orDie);

/** A clone of the migrated, seeded template, with its own scoped pool and database. */
export const layer = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(
        createDatabase(inject("postgres").templateDatabase),
        dropDatabase
      );
      return layerFromUrl(Redacted.make(database.url));
    })
  );

/** An empty database migrated by `migrations`, reserved for the migrator's own tests. */
export const emptyLayer = (migrations: Migrations) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(createDatabase(), dropDatabase);
      return Layer.effectDiscard(migrate(migrations)).pipe(
        Layer.provideMerge(layerFromUrl(Redacted.make(database.url)))
      );
    })
  );
