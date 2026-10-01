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
import { migrations as limitsMigrations } from "../../limits/src/migrations.js";
import * as InvocationLog from "./InvocationLog.js";
import * as RuntimeLog from "./RuntimeLog.js";
import { migrations } from "./migrations.js";

const previous: Migrations = {
  ...companiesMigrations,
  ...authMigrations,
  "0003_patches_baseline": patchesMigrations["0003_patches_baseline"]!,
  ...companyDatabaseMigrations
};
const withRuntime: Migrations = {
  ...previous,
  "0006_runtime_baseline": migrations["0006_runtime_baseline"]!
};
const withIntegrations: Migrations = {
  ...withRuntime,
  ...integrationsMigrations
};
const withLifecycle: Migrations = {
  ...withIntegrations,
  "0008_patches_lifecycle": patchesMigrations["0008_patches_lifecycle"]!
};
const withInvocations: Migrations = {
  ...withLifecycle,
  ...patchesMigrations,
  ...limitsMigrations,
  "0011_runtime_invocations": migrations["0011_runtime_invocations"]!
};
const current: Migrations = { ...withInvocations, ...migrations };

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
      credentials, key_id, credential_revision, metadata_revision, created_by
    ) VALUES (
      'connection_migration', 'cmp_migration', 'postgres', 'warehouse', 'Migration check',
      'company', 'disconnected', '{}', 'encrypted', 'test', 1, 1, 'usr_migration'
    )`;
  yield* sql`
    INSERT INTO runtime_calls (id, company_id, user_id, credential_kind, op,
      connection_id, correlation_id)
    VALUES ('call_migration', 'cmp_migration', 'usr_migration', 'admin',
      'postgres.query', 'connection_migration', 'correlation_migration')`;
  yield* sql`
    UPDATE runtime_calls SET outcome = 'success', duration_ms = 12, row_count = 1
    WHERE correlation_id = 'correlation_migration'`;
  assert.deepStrictEqual(yield* migrate(withLifecycle), []);
  return yield* sql`
    SELECT c.name AS company, i.id AS connection, r.outcome,
      r.duration_ms AS duration, r.row_count AS rows
    FROM runtime_calls r
    JOIN connections i ON i.id = r.connection_id AND i.company_id = r.company_id
    JOIN companies c ON c.id = i.company_id
    WHERE r.correlation_id = 'correlation_migration'`;
});

it.effect(
  "lands Runtime, Integrations and the patch lifecycle in order, then stays idempotent",
  () =>
    Effect.gen(function* () {
      const upgraded = yield* Effect.gen(function* () {
        yield* company;
        assert.deepStrictEqual(yield* migrate(withRuntime), [[6, "runtime_baseline"]]);
        assert.deepStrictEqual(yield* migrate(withIntegrations), [[7, "integrations_baseline"]]);
        assert.deepStrictEqual(yield* migrate(withLifecycle), [[8, "patches_lifecycle"]]);
        return yield* useMigratedTables;
      }).pipe(Effect.provide(Testing.emptyLayer(previous)));
      const fresh = yield* Effect.gen(function* () {
        yield* company;
        return yield* useMigratedTables;
      }).pipe(Effect.provide(Testing.emptyLayer(withLifecycle)));
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

it.effect("upgrades retained calls with attribution and adds durable invocation records", () =>
  Effect.gen(function* () {
    yield* company;
    yield* useMigratedTables;
    assert.deepStrictEqual(yield* migrate(current), [
      [9, "limits_overrides"],
      [10, "patches_lifecycle_revision"],
      [11, "runtime_invocations"],
      [12, "runtime_mutation_commit_proof"]
    ]);
    assert.deepStrictEqual(yield* migrate(current), []);

    const log = yield* RuntimeLog.make;
    const recent = yield* log.recent({
      companyId: "cmp_migration",
      connectionId: "connection_migration"
    });
    assert.strictEqual(recent.length, 1);
    assert.strictEqual(recent[0]?.userId, "usr_migration");
    assert.strictEqual(recent[0]?.effectivePrincipal, "usr_migration");
    assert.strictEqual(recent[0]?.invocationId, null);
    assert.strictEqual(recent[0]?.outcome, "success");
    assert.strictEqual(recent[0]?.durationMs, 12);
    assert.strictEqual(recent[0]?.rowCount, 1);

    const invocations = yield* InvocationLog.make;
    const startedAt = Date.UTC(2026, 0, 1);
    yield* invocations.begin({
      id: "invocation_migration",
      companyId: "cmp_migration",
      patchId: "patch_migration",
      versionId: "version_migration",
      handler: "leads.approve",
      kind: "mutation",
      initiatingViewerId: "usr_migration",
      parentId: null,
      correlationId: "invocation_correlation",
      startedAt,
      deadline: startedAt + 5_000,
      argsBytes: 2
    });
    yield* log.begin({
      companyId: "cmp_migration",
      patchId: "patch_migration",
      versionId: "version_migration",
      userId: null,
      effectivePrincipal: "patch",
      invocationId: "invocation_migration",
      credentialKind: "session",
      op: "tables.update",
      resource: "leads",
      connectionId: null,
      correlationId: "callback_correlation"
    });
    yield* log.finish({
      correlationId: "callback_correlation",
      outcome: "handler_error",
      outcomeCode: "approval_required",
      durationMs: 10,
      rowCount: null
    });
    const callback = yield* log.find({
      companyId: "cmp_migration",
      correlationId: "callback_correlation"
    });
    assert.strictEqual(callback?.userId, null);
    assert.strictEqual(callback?.effectivePrincipal, "patch");
    assert.strictEqual(callback?.invocationId, "invocation_migration");
    assert.strictEqual(callback?.outcome, "handler_error");
    assert.strictEqual(callback?.outcomeCode, "approval_required");
    const invocation = yield* invocations.find({
      companyId: "cmp_migration",
      invocationId: "invocation_migration"
    });
    assert.strictEqual(invocation?.effectivePrincipal, "patch");
    assert.strictEqual(invocation?.initiatingViewerId, "usr_migration");
    assert.strictEqual(invocation?.outcome, "pending");
  }).pipe(Effect.provide(Testing.emptyLayer(withLifecycle)))
);

it.effect(
  "adds mutation commit proof to retained invocations without inventing settlement facts",
  () =>
    Effect.gen(function* () {
      const invocations = yield* InvocationLog.make;
      const input: InvocationLog.Begin = {
        id: "invocation_retained_proof",
        companyId: "cmp_retained_proof",
        patchId: "patch_retained_proof",
        versionId: "version_retained_proof",
        handler: "leads.approve",
        kind: "mutation",
        initiatingViewerId: "usr_retained_proof",
        parentId: null,
        correlationId: "correlation_retained_proof",
        startedAt: 0,
        deadline: 5_000,
        argsBytes: 2
      };
      yield* invocations.begin(input);
      assert.deepStrictEqual(yield* migrate(current), [[12, "runtime_mutation_commit_proof"]]);
      assert.deepStrictEqual(yield* migrate(current), []);
      const lookup = { companyId: input.companyId, invocationId: input.id };
      const retained = yield* invocations.find(lookup);
      assert.strictEqual(retained?.outcome, "pending");
      assert.isNull(retained?.settledAt);
      assert.isNull(retained?.durationMs);
      assert.isFalse(retained?.replyDelivered);
      yield* invocations.reconcileMutation(lookup);
      assert.deepStrictEqual(
        yield* invocations.find(lookup),
        new InvocationLog.Invocation({ ...retained!, outcome: "success", outcomeCode: null })
      );
    }).pipe(Effect.provide(Testing.emptyLayer(withInvocations)))
);

it.effect("keys query rollups by UTC minute and deduplicates applied run ids", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO runtime_query_rollups
      (company_id, patch_id, version_id, handler, minute, runs, db_ms)
      VALUES ('cmp_rollup', 'patch_rollup', 'version_rollup', 'leads.list',
        '2026-01-01T00:00:00Z', 1, 7)`;
    const duplicate = yield* sql`INSERT INTO runtime_query_rollups
      (company_id, patch_id, version_id, handler, minute)
      VALUES ('cmp_rollup', 'patch_rollup', 'version_rollup', 'leads.list',
        '2026-01-01T01:00:00+01:00')`.pipe(Effect.flip);
    assert.strictEqual(duplicate._tag, "SqlError");
    const unaligned = yield* sql`INSERT INTO runtime_query_rollups
      (company_id, patch_id, version_id, handler, minute)
      VALUES ('cmp_rollup', 'patch_rollup', 'version_rollup', 'leads.list',
        '2026-01-01T00:01:01Z')`.pipe(Effect.flip);
    assert.strictEqual(unaligned._tag, "SqlError");
    yield* sql`INSERT INTO runtime_query_rollups
      (company_id, patch_id, version_id, handler, minute, runs, db_ms)
      VALUES ('cmp_rollup', 'patch_rollup', 'version_rollup', 'leads.list',
        '2026-01-01T00:01:00Z', 2, 11)`;
    assert.deepStrictEqual(
      yield* sql`SELECT runs, db_ms FROM runtime_query_rollups ORDER BY minute`,
      [
        { runs: "1", db_ms: "7" },
        { runs: "2", db_ms: "11" }
      ]
    );
    yield* sql`INSERT INTO runtime_query_rollup_runs (run_id) VALUES ('run_rollup')`;
    const replay = yield* sql`INSERT INTO runtime_query_rollup_runs (run_id)
      VALUES ('run_rollup')`.pipe(Effect.flip);
    assert.strictEqual(replay._tag, "SqlError");
  }).pipe(Effect.provide(Testing.emptyLayer(current)))
);
