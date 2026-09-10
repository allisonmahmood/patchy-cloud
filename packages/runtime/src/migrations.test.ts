import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { migrate, type Migrations } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import { migrations as authMigrations } from "../../auth/src/migrations.js";
import { migrations as companiesMigrations } from "../../companies/src/migrations.js";
import { migrations as companyDatabaseMigrations } from "../../company-database/src/migrations.js";
import { migrations as patchesMigrations } from "../../patches/src/migrations.js";
import { migrations as integrationsMigrations } from "../../integrations/src/migrations.js";
import { migrations } from "./migrations.js";

const previous: Migrations = {
  ...companiesMigrations,
  ...authMigrations,
  ...patchesMigrations,
  ...companyDatabaseMigrations
};
const withRuntime: Migrations = { ...previous, ...migrations };
const withIntegrations: Migrations = {
  ...withRuntime,
  ...integrationsMigrations
};

const company = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    INSERT INTO companies (id, handle, name)
    VALUES ('cmp_migration', 'migration', 'Existing company')`
);

const useMigratedTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO connections (
      id, company_id, integration, handle, description, mode, status, display,
      credentials, key_id, credential_revision, metadata, metadata_revision, created_by
    ) VALUES (
      'connection_migration', 'cmp_migration', 'postgres', 'warehouse', 'Migration check',
      'company', 'disconnected', '{}', 'encrypted', 'test', 1, '{}', 1, 'usr_migration'
    )`;
  yield* sql`
    INSERT INTO runtime_calls (id, company_id, user_id, credential_kind, op,
      connection_id, correlation_id)
    VALUES ('call_migration', 'cmp_migration', 'usr_migration', 'admin',
      'postgres.query', 'connection_migration', 'correlation_migration')`;
  yield* sql`
    UPDATE runtime_calls SET outcome = 'success', duration_ms = 12, row_count = 1
    WHERE correlation_id = 'correlation_migration'`;
  assert.deepStrictEqual(yield* migrate(withIntegrations), []);
  return yield* sql`
    SELECT c.name AS company, i.id AS connection, r.outcome,
      r.duration_ms AS duration, r.row_count AS rows
    FROM runtime_calls r
    JOIN connections i ON i.id = r.connection_id AND i.company_id = r.company_id
    JOIN companies c ON c.id = i.company_id
    WHERE r.correlation_id = 'correlation_migration'`;
});

it.effect(
  "lands Runtime before Integrations on upgrade and fresh install, then stays idempotent",
  () =>
    Effect.gen(function* () {
      const upgraded = yield* Effect.gen(function* () {
        yield* company;
        assert.deepStrictEqual(yield* migrate(withRuntime), [[6, "runtime_baseline"]]);
        assert.deepStrictEqual(yield* migrate(withIntegrations), [[7, "integrations_baseline"]]);
        return yield* useMigratedTables;
      }).pipe(Effect.provide(Testing.emptyLayer(previous)));
      const fresh = yield* Effect.gen(function* () {
        yield* company;
        return yield* useMigratedTables;
      }).pipe(Effect.provide(Testing.emptyLayer(withIntegrations)));
      assert.deepStrictEqual(upgraded, [
        {
          company: "Existing company",
          connection: "connection_migration",
          outcome: "success",
          duration: 12,
          rows: 1
        }
      ]);
      assert.deepStrictEqual(fresh, upgraded);
    })
);
