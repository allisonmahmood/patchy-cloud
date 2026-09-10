import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DEV_SEED } from "@patchy/auth/seed";
import * as Testing from "@patchy/sql/testing";
import * as RuntimeLog from "./RuntimeLog.js";

const NOW = Date.UTC(2026, 0, 1);
const mutation = (correlationId: string): RuntimeLog.Begin => ({
  companyId: DEV_SEED.companyId,
  patchId: "runtimepatch",
  versionId: "ver_runtime",
  userId: DEV_SEED.userId,
  credentialKind: "session",
  op: "tables.insert",
  resource: "notes",
  connectionId: null,
  correlationId
});

it.layer(RuntimeLog.layer.pipe(Layer.provideMerge(Testing.layer())))("RuntimeLog", (it) => {
  it.effect(
    "bounds recent calls by company and connection with the same deadline semantics as correlation lookup",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const log = yield* RuntimeLog.RuntimeLog;
        const sql = yield* SqlClient.SqlClient;
        const companyId = DEV_SEED.companyId;
        const connectionId = "recent-connection";
        yield* sql`INSERT INTO runtime_calls
        (id, at, company_id, user_id, credential_kind, op, connection_id, correlation_id, deadline_ms)
        SELECT 'recent-' || n, to_timestamp(${NOW / 1000}) + n * interval '1 millisecond',
          ${companyId}, ${DEV_SEED.userId}, 'session', 'postgres.list', ${connectionId},
          'recent-correlation-' || n, 15000
        FROM generate_series(1, 101) AS n`;
        yield* log.begin({
          ...mutation("recent-other-company"),
          op: "postgres.query",
          companyId: "foreign",
          connectionId,
          sql: "SELECT 'foreign-company'"
        });
        yield* log.begin({
          ...mutation("recent-other-connection"),
          op: "postgres.query",
          connectionId: "another",
          sql: "SELECT 'foreign-connection'"
        });
        const selected = yield* log.recent({ companyId, connectionId, limit: 2 });
        assert.deepStrictEqual(
          selected.map((call) => call.correlationId),
          ["recent-correlation-101", "recent-correlation-100"]
        );
        assert.strictEqual((yield* log.recent({ companyId, connectionId })).length, 50);
        assert.strictEqual(
          (yield* log.recent({ companyId, connectionId, limit: 1000 })).length,
          100
        );
        yield* TestClock.setTime(NOW + 15_101);
        assert.strictEqual(
          (yield* log.recent({ companyId, connectionId, limit: 1 }))[0]?.outcome,
          "pending"
        );
        yield* TestClock.adjust(1);
        assert.strictEqual(
          (yield* log.recent({ companyId, connectionId, limit: 1 }))[0]?.outcome,
          "unknown"
        );
        yield* log.finish({
          correlationId: "recent-correlation-101",
          outcome: "failure",
          outcomeCode: "timeout",
          durationMs: 15_001,
          rowCount: null
        });
        const completed = (yield* log.recent({ companyId, connectionId, limit: 1 }))[0]!;
        assert.strictEqual(completed.outcome, "failure");
        assert.strictEqual(completed.outcomeCode, "timeout");
      })
  );
  it.effect("persists pending before completion and a fresh service finds the final result", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const log = yield* RuntimeLog.RuntimeLog;
      const correlationId = "runtime-pending";
      const id = yield* log.begin(mutation(correlationId));
      const restarted = yield* RuntimeLog.make;
      const lookup = { companyId: DEV_SEED.companyId, correlationId };
      const pending = yield* restarted.find(lookup);
      assert.strictEqual(pending?.id, id);
      assert.strictEqual(pending?.outcome, "pending");
      assert.strictEqual(pending?.durationMs, null);
      assert.strictEqual(pending?.rowCount, null);
      yield* log.finish({ correlationId, outcome: "success", durationMs: 12, rowCount: 1 });
      const completed = yield* restarted.find(lookup);
      assert.strictEqual(completed?.outcome, "success");
      assert.strictEqual(completed?.durationMs, 12);
      assert.strictEqual(completed?.rowCount, 1);
    })
  );

  it.effect(
    "finds a failed call by correlation without allowing a second finish to rewrite it",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const log = yield* RuntimeLog.RuntimeLog;
        const correlationId = "runtime-failure";
        yield* log.begin({
          ...mutation(correlationId),
          op: "postgres.query",
          connectionId: "connection-failure",
          sql: "SELECT 1",
          deadlineMs: 15_000
        });
        yield* log.finish({ correlationId, outcome: "failure", durationMs: 24, rowCount: null });
        yield* log.finish({ correlationId, outcome: "success", durationMs: 25, rowCount: 1 });
        const failed = yield* log.find({ companyId: DEV_SEED.companyId, correlationId });
        assert.strictEqual(failed?.outcome, "failure");
        assert.strictEqual(failed?.durationMs, 24);
        assert.strictEqual(failed?.rowCount, null);
        assert.strictEqual(failed?.userId, DEV_SEED.userId);
        assert.isNull(
          yield* log.find({ companyId: DEV_SEED.companyId, correlationId: "runtime-missing" })
        );
      })
  );

  it.effect("derives unknown after each persisted deadline without replacing pending", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const log = yield* RuntimeLog.RuntimeLog;
      const companyId = DEV_SEED.companyId;
      const mutationId = "runtime-mutation-deadline";
      const integrationId = "runtime-integration-deadline";
      const connectionId = "connection-deadline";
      yield* log.begin(mutation(mutationId));
      yield* log.begin({
        ...mutation(integrationId),
        op: "postgres.list",
        connectionId,
        deadlineMs: 15_000
      });
      const restarted = yield* RuntimeLog.make;
      yield* TestClock.adjust(15_000);
      assert.strictEqual(
        (yield* restarted.find({ companyId, correlationId: integrationId }))?.outcome,
        "pending"
      );
      yield* TestClock.adjust(1);
      assert.strictEqual(
        (yield* restarted.find({ companyId, correlationId: integrationId }))?.outcome,
        "unknown"
      );
      assert.strictEqual(
        (yield* restarted.find({ companyId, correlationId: mutationId }))?.outcome,
        "pending"
      );
      yield* TestClock.setTime(NOW + 30_000);
      assert.strictEqual(
        (yield* restarted.find({ companyId, correlationId: mutationId }))?.outcome,
        "pending"
      );
      yield* TestClock.adjust(1);
      assert.strictEqual(
        (yield* restarted.find({ companyId, correlationId: mutationId }))?.outcome,
        "unknown"
      );
      // Read-time uncertainty must not turn into a stored outcome.
      yield* TestClock.setTime(NOW);
      assert.strictEqual(
        (yield* restarted.find({ companyId, correlationId: integrationId }))?.outcome,
        "pending"
      );
      yield* TestClock.setTime(NOW + 60_000);
      yield* log.finish({
        correlationId: integrationId,
        outcome: "failure",
        durationMs: 60_000,
        rowCount: null
      });
      assert.strictEqual(
        (yield* restarted.find({ companyId, correlationId: integrationId }))?.outcome,
        "failure"
      );
    })
  );

  it.effect("isolates correlation lookups by company", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const log = yield* RuntimeLog.RuntimeLog;
      const companyId = DEV_SEED.companyId;
      const otherCompanyId = "cmp_runtime_other";
      const correlationId = "runtime-company";
      const otherCorrelationId = "runtime-other-company";
      const id = yield* log.begin(mutation(correlationId));
      const otherId = yield* log.begin({
        ...mutation(otherCorrelationId),
        companyId: otherCompanyId,
        userId: "usr_runtime_other"
      });
      assert.strictEqual((yield* log.find({ companyId, correlationId }))?.id, id);
      assert.strictEqual(
        (yield* log.find({ companyId: otherCompanyId, correlationId: otherCorrelationId }))?.id,
        otherId
      );
      assert.isNull(yield* log.find({ companyId: otherCompanyId, correlationId }));
      assert.isNull(yield* log.find({ companyId, correlationId: otherCorrelationId }));
    })
  );

  it.effect("keeps only explicit query text and truncates on UTF-8 boundaries at 8192 bytes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const log = yield* RuntimeLog.RuntimeLog;
      const companyId = DEV_SEED.companyId;
      const exact = "é".repeat(4_096);
      const prefix = "x".repeat(8_189);
      yield* log.begin({
        ...mutation("runtime-sql-exact"),
        op: "postgres.query",
        sql: exact
      });
      assert.strictEqual(
        (yield* log.find({ companyId, correlationId: "runtime-sql-exact" }))?.sql,
        exact
      );
      yield* log.begin({
        ...mutation("runtime-sql-truncated"),
        op: "postgres.query",
        sql: `${prefix}𐀀not retained`
      });
      assert.strictEqual(
        (yield* log.find({ companyId, correlationId: "runtime-sql-truncated" }))?.sql,
        prefix
      );
      yield* log.begin({
        ...mutation("runtime-sql-generated"),
        op: "postgres.list",
        sql: "SELECT secret FROM credentials"
      });
      assert.strictEqual(
        (yield* log.find({ companyId, correlationId: "runtime-sql-generated" }))?.sql,
        null
      );
      yield* log.begin({
        ...mutation("runtime-sql-mutation"),
        sql: "a mutation body must never become audit SQL"
      });
      assert.strictEqual(
        (yield* log.find({ companyId, correlationId: "runtime-sql-mutation" }))?.sql,
        null
      );
    })
  );

  it.effect("retains attribution when the version, patch and acting user are deleted", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const log = yield* RuntimeLog.RuntimeLog;
      const sql = yield* SqlClient.SqlClient;
      const companyId = DEV_SEED.companyId;
      const userId = "usr_runtime_deleted";
      const patchId = "runtimegone1";
      const versionId = "ver_runtime_deleted";
      const correlationId = "runtime-deleted";
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES (${userId}, 'user_runtime_deleted', ${companyId},
          'deleted@runtime.test', 'Deleted member', 'member')`;
      yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name, expires_at)
        VALUES (${patchId}, ${companyId}, ${userId}, 'Deleted patch', 'runtime-deleted',
          to_timestamp(${NOW / 1_000}))`;
      yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key,
        content_hash, file_size, created_by_machine_token_id, owner_user_id, tier, release,
        manifest_version, wire_version, schema_revision, manifest, publish_key, payload_digest,
        publish_response, publish_status)
        VALUES (${versionId}, ${patchId}, 1, 'runtime/deleted.html', 'test', 1,
          ${DEV_SEED.tokenId}, ${userId}, 0, 'test', 1, 1, 0, '{}'::jsonb,
          'runtime-deleted', 'test', '{}'::jsonb, 201)`;
      yield* log.begin({ ...mutation(correlationId), userId, patchId, versionId });
      yield* sql`DELETE FROM patch_versions WHERE id = ${versionId}`;
      yield* sql`DELETE FROM patches WHERE id = ${patchId}`;
      yield* sql`DELETE FROM users WHERE id = ${userId}`;
      yield* log.finish({ correlationId, outcome: "success", durationMs: 20, rowCount: 1 });
      const retained = yield* log.find({ companyId, correlationId });
      assert.strictEqual(retained?.outcome, "success");
      assert.strictEqual(retained?.userId, userId);
      assert.strictEqual(retained?.patchId, patchId);
      assert.strictEqual(retained?.versionId, versionId);
    })
  );

  it.effect(
    "refuses duplicate correlation ids as SqlError without overwriting the first call",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const log = yield* RuntimeLog.RuntimeLog;
        const correlationId = "runtime-duplicate";
        const id = yield* log.begin(mutation(correlationId));
        const error = yield* log
          .begin({ ...mutation(correlationId), op: "files.delete", resource: "images" })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "SqlError");
        const retained = yield* log.find({ companyId: DEV_SEED.companyId, correlationId });
        assert.strictEqual(retained?.id, id);
        assert.strictEqual(retained?.op, "tables.insert");
        assert.strictEqual(retained?.outcome, "pending");
      })
  );
});
