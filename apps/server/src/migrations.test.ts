import { assert, it } from "@effect/vitest";
import { CredentialKeys, PostgresSource, SqlConnectionStore } from "@patchy/integrations";
import { RuntimeLog } from "@patchy/runtime";
import { migrate } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { capabilityMigrations, migrations } from "./migrations.js";

it("allocates migration ids once each, with no gaps", () => {
  const count = capabilityMigrations.reduce(
    (total, record) => total + Object.keys(record).length,
    0
  );
  assert.strictEqual(
    Object.keys(migrations).length,
    count,
    "two capabilities share a migration key"
  );
  const ids = Object.keys(migrations)
    .map((key) => Number(key.split("_")[0]))
    .sort((a, b) => a - b);
  // The Migrator applies only ids above the ledger's highest and never backfills a gap,
  // so a duplicate or skipped id silently never runs on an existing database.
  assert.deepStrictEqual(
    ids,
    ids.map((_, index) => index + 1)
  );
});

// The first steps after launch that change connections run on databases that already hold them.
const beforeIntegrations = Object.fromEntries(
  Object.entries(migrations).filter(([key]) => key < "0011_connections_per_integration")
);
const secret = Redacted.make(
  "postgresql://reader:do-not-log-this@warehouse.example/sales?sslmode=verify-full"
);
const services = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`upgrade:${Buffer.alloc(32, 7).toString("base64")}`)),
  RuntimeLog.layer,
  Layer.succeed(
    PostgresSource.Source,
    PostgresSource.Source.of({
      test: Effect.fn("UpgradeSource.test")(function* (credentials) {
        const { host, port, database, role } = yield* PostgresSource.parseCredentials(credentials);
        return { host, port, database, role };
      }),
      inspect: () => Effect.die("discovery is not part of the upgrade")
    })
  )
);

it.layer(Testing.emptyLayer(beforeIntegrations))(
  "the connections-per-integration upgrade",
  (it) => {
    it.effect(
      "keeps every connection, snapshot, declaration and logged query, and still accepts the previous release's writes",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const who = { companyId: "cmp_upgrade", userId: "usr_upgrade" };
          const connection = { ...who, id: "conn_upgrade" };
          yield* sql`INSERT INTO companies (id, handle, name) VALUES (${who.companyId}, 'upgrade', 'Northwind')`;
          yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES (${who.userId}, 'clerk_upgrade', ${who.companyId}, 'sam@example.com', 'Sam', 'admin')`;
          yield* sql`INSERT INTO machine_tokens (id, user_id, name, token_hash, expires_at, last_used_at)
          VALUES ('mt_upgrade', ${who.userId}, 'Laptop', 'hash_upgrade', now() + interval '1 day', now())`;
          // As the store wrote them before: ciphertext bound to the integration, an untagged snapshot.
          const encrypted = yield* (yield* CredentialKeys.CredentialKeys).encrypt(
            { companyId: who.companyId, id: connection.id, integration: "postgres" },
            secret
          );
          yield* sql`INSERT INTO connections
          (id, company_id, integration, handle, description, mode, status, display, credentials,
            key_id, credential_revision, metadata_revision, created_by, last_discovered_at)
          VALUES (${connection.id}, ${who.companyId}, 'postgres', 'warehouse', 'Sales warehouse',
            'company', 'connected',
            ${JSON.stringify({ host: "warehouse.example", port: 5432, database: "sales", role: "reader" })},
            ${encrypted.credentials}, ${encrypted.keyId}, 1, 1, ${who.userId}, now())`;
          yield* sql`INSERT INTO connection_snapshots (connection_id, company_id, revision, snapshot, created_at)
          VALUES (${connection.id}, ${who.companyId}, 1,
            ${JSON.stringify({ version: 1, relations: [], enums: [], exclusions: [] })},
            '2026-10-01T00:00:00Z')`;
          yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
          VALUES ('pat_upgrade', ${who.companyId}, ${who.userId}, 'Reports', 'reports')`;
          yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key,
          content_hash, file_size, created_by_machine_token_id, owner_user_id, tier, release,
          manifest_version, wire_version, schema_revision, manifest, publish_key, payload_digest,
          publish_response, publish_status)
          VALUES ('ver_upgrade', 'pat_upgrade', 1, 'upgrade/reports.html', 'test', 1, 'mt_upgrade',
            ${who.userId}, 1, 'test', 1, 1, 0,
            ${JSON.stringify({ uses: { sales: { kind: "postgres", handle: "warehouse", id: connection.id, revision: 1 } } })}::jsonb,
            'upgrade', 'test', '{}'::jsonb, 201)`;
          yield* sql`INSERT INTO runtime_calls (id, company_id, patch_id, version_id, user_id,
          credential_kind, op, connection_id, correlation_id, effective_principal, sql)
          VALUES ('call_upgrade', ${who.companyId}, 'pat_upgrade', 'ver_upgrade', ${who.userId},
            'session', 'postgres.query', ${connection.id}, 'cor_upgrade', ${who.userId}, 'select 1')`;

          yield* migrate(migrations);

          const store = yield* SqlConnectionStore.make;
          const kept = yield* store.get(who.companyId, connection.id);
          assert.deepInclude(kept, {
            integration: "postgres",
            handle: "warehouse",
            status: "connected",
            credentialRevision: 1,
            metadataRevision: 1
          });
          assert.deepStrictEqual(yield* store.detail(who.companyId, "postgres", "warehouse"), {
            integration: "postgres",
            handle: "warehouse",
            description: "Sales warehouse",
            status: "connected",
            snapshot: {
              version: 1,
              relations: [],
              enums: [],
              exclusions: [],
              revision: 1,
              takenAt: "2026-10-01T00:00:00.000Z"
            }
          });
          // The old ciphertext still decrypts, and the old declaration still guards deletion.
          assert.strictEqual((yield* store.test(connection)).credentialRevision, 1);
          assert.strictEqual(
            (yield* store.delete(connection).pipe(Effect.flip)).code,
            "connection_in_use"
          );
          assert.deepStrictEqual(
            yield* sql`SELECT integration FROM connection_snapshots WHERE connection_id = ${connection.id}`,
            [{ integration: "postgres" }]
          );
          assert.deepStrictEqual(
            yield* sql`SELECT op, sql FROM runtime_calls WHERE id = 'call_upgrade'`,
            [{ op: "postgres.query", sql: "select 1" }]
          );

          // The previous release, still running during a rollout or after a rollback, writes as
          // it always did: by the per-company key, and without naming the snapshot's integration.
          assert.deepStrictEqual(
            yield* sql`INSERT INTO connections
            (id, company_id, integration, handle, description, mode, status, display, credentials,
              key_id, credential_revision, metadata_revision, created_by)
            VALUES ('conn_previous', ${who.companyId}, 'postgres', 'reporting', '', 'company',
              'connected', '{}', 'ciphertext', 'upgrade', 1, 1, ${who.userId})
            ON CONFLICT (company_id, handle) DO NOTHING RETURNING id`,
            [{ id: "conn_previous" }]
          );
          yield* sql`INSERT INTO connection_snapshots (connection_id, company_id, revision, snapshot)
          VALUES ('conn_previous', ${who.companyId}, 1, '{}')`;
          assert.deepStrictEqual(
            yield* sql`SELECT integration FROM connection_snapshots WHERE connection_id = 'conn_previous'`,
            [{ integration: "postgres" }]
          );
          // Any integration's query keeps its text; other operations still keep none (the row is
          // otherwise valid, so only the query-text check can refuse it).
          const insertCall = (id: string, op: string) =>
            sql`INSERT INTO runtime_calls (id, company_id, credential_kind, op, correlation_id,
            effective_principal, sql)
            VALUES (${id}, ${who.companyId}, 'session', ${op}, ${id}, ${who.userId}, 'select 1')`;
          yield* insertCall("call_posthog", "posthog.query");
          assert.include(
            String((yield* insertCall("call_tables", "tables.list").pipe(Effect.flip)).cause),
            "ConstraintError"
          );
        }).pipe(Effect.provide(services))
    );
  }
);
