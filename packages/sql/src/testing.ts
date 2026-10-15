/**
 * Isolated databases on vitest's Postgres cluster, dropped with their layers.
 * Capability tests clone the migrated, seeded template; migrator tests start empty.
 */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { inject } from "vitest";
import { ddl, layerFromUrl, migrate, type Migrations } from "./index.js";

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

/**
 * Runs `change` and interrupts it during its COMMIT, the moment a client
 * disconnect can land after a change committed. A deferred trigger makes
 * committing an insert into `table` take a second; the interrupt arrives once
 * a COMMIT is sleeping in that trigger, never during an earlier transaction of
 * `change`, and waits for `change` to settle. Checks that a change reports with
 * its commit (`withReportedCommit`) end to end.
 */
export const interruptDuringCommit = <A, E, R>(table: string, change: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const trigger = `slow_commit_${table}`;
    yield* Effect.acquireRelease(
      ddl(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NULL; END $$`,
        `CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`
      ),
      () =>
        ddl(`DROP TRIGGER ${trigger} ON ${table}`, `DROP FUNCTION ${trigger}()`).pipe(Effect.orDie)
    );
    const fiber = yield* Effect.forkChild(change);
    yield* sql`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND query ILIKE 'commit%'
        AND wait_event = 'PgSleep'`.pipe(
      Effect.repeat({ until: (rows) => rows.length === 1 }),
      Effect.timeout("10 seconds"),
      TestClock.withLive
    );
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.scoped);
