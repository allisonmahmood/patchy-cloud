import { assert, it } from "@effect/vitest";
import {
  CredentialKeys,
  PostgresSource,
  PostHogSource,
  PidgeonSource,
  AttioSource,
  SqlConnectionStore
} from "@patchy/integrations";
import { RuntimeLog } from "@patchy/runtime";
import { migrate } from "@patchy/sql";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { capabilityMigrations, migrations } from "./migrations.js";
import { NodeCryptography } from "@patchy/core";

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
const before = (step: string) =>
  Object.fromEntries(Object.entries(migrations).filter(([key]) => key < step));
const beforeIntegrations = before("0011_connections_per_integration");
/** The schema release 10 leaves: connections know their integration, handles are per company. */
const release10 = before("0013_handles_per_integration");
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
  ),
  // Never called: the upgrade reads no PostHog project, Pidgeon address or Attio workspace.
  PostHogSource.layer,
  PidgeonSource.layer,
  AttioSource.layer
).pipe(Layer.provideMerge(NodeCryptography.layer));

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

          yield* migrate(release10);

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
          // The earlier release writes against its own schema. After that proof, upgrade to the
          // current schema before asking the current reader for the new guest-block field.
          yield* migrate(migrations);
          const store = yield* SqlConnectionStore.make;
          const kept = yield* store.get(who.companyId, connection.id);
          assert.deepInclude(kept, {
            integration: "postgres",
            handle: "warehouse",
            status: "connected",
            blockGuests: false,
            credentialRevision: 1,
            metadataRevision: 1
          });
          assert.deepStrictEqual(yield* store.detail(who.companyId, "postgres", "warehouse"), {
            integration: "postgres",
            handle: "warehouse",
            description: "Sales warehouse",
            status: "connected",
            blockGuests: false,
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

it.layer(Testing.emptyLayer(release10))("the handles-per-integration upgrade", (it) => {
  it.effect(
    "lets two integrations share a handle, keeps every snapshot, and accepts release 10's writes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const who = { companyId: "cmp_handles", userId: "usr_handles" };
        yield* sql`INSERT INTO companies (id, handle, name) VALUES (${who.companyId}, 'handles', 'Northwind')`;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES (${who.userId}, 'clerk_handles', ${who.companyId}, 'sam@example.com', 'Sam', 'admin')`;
        // Release 10 connects with a targetless conflict and names every snapshot's integration.
        const connect = (id: string, integration: string, display: unknown) =>
          sql<{ id: string }>`INSERT INTO connections
            (id, company_id, integration, handle, description, mode, status, display, credentials,
              key_id, credential_revision, metadata_revision, created_by)
            VALUES (${id}, ${who.companyId}, ${integration}, 'warehouse', '', 'company',
              'connected', ${JSON.stringify(display)}, 'ciphertext', 'upgrade', 1, 1, ${who.userId})
            ON CONFLICT DO NOTHING RETURNING id`;
        const postgres = {
          host: "warehouse.example",
          port: 5432,
          database: "sales",
          role: "reader"
        };
        yield* connect("conn_release10", "postgres", postgres);
        yield* sql`INSERT INTO connection_snapshots
          (connection_id, company_id, integration, revision, snapshot, created_at)
          VALUES ('conn_release10', ${who.companyId}, 'postgres', 1,
            ${JSON.stringify({ version: 1, relations: [], enums: [], exclusions: [] })},
            '2026-10-01T00:00:00Z')`;

        yield* migrate(migrations);

        assert.deepStrictEqual(
          yield* sql`SELECT conname FROM pg_constraint
            WHERE conrelid = 'connections'::regclass AND contype = 'u' ORDER BY conname`,
          [{ conname: "connections_company_id_integration_handle_key" }]
        );
        // The same handle in another integration is a second connection; in the same one, taken.
        assert.deepStrictEqual(yield* connect("conn_duplicate", "postgres", postgres), []);
        assert.deepStrictEqual(
          yield* connect("conn_posthog", "posthog", {
            region: "us",
            projectId: 12345,
            keyHint: "phx_…a91f"
          }),
          [{ id: "conn_posthog" }]
        );
        yield* sql`INSERT INTO connection_snapshots (connection_id, company_id, integration, revision, snapshot)
          VALUES ('conn_posthog', ${who.companyId}, 'posthog', 1,
            ${JSON.stringify({ version: 1, events: [], eventProperties: [], personProperties: [] })})`;
        // A snapshot must name its integration now; only releases before 10 left it out.
        assert.include(
          String(
            (yield* sql`INSERT INTO connection_snapshots (connection_id, company_id, revision, snapshot)
              VALUES ('conn_posthog', ${who.companyId}, 2, '{}')`.pipe(Effect.flip)).cause
          ),
          "ConstraintError"
        );
        const store = yield* SqlConnectionStore.make;
        assert.deepStrictEqual(
          (yield* store.list(who.companyId)).map(({ id, integration, handle }) => ({
            id,
            integration,
            handle
          })),
          [
            { id: "conn_posthog", integration: "posthog", handle: "warehouse" },
            { id: "conn_release10", integration: "postgres", handle: "warehouse" }
          ]
        );
        assert.deepStrictEqual(yield* store.snapshot(who.companyId, "conn_release10", 1), {
          integration: "postgres",
          snapshot: { version: 1, relations: [], enums: [], exclusions: [] }
        });
        assert.strictEqual(
          (yield* store.snapshot(who.companyId, "conn_posthog", 1)).integration,
          "posthog"
        );
      }).pipe(Effect.provide(services))
  );
});

/** The schema the previous release leaves: no machine calls. */
const beforeMachineCalls = before("0014_runtime_calls_machine");

it.layer(Testing.emptyLayer(beforeMachineCalls))("the machine-calls upgrade", (it) => {
  it.effect(
    "keeps every logged call, accepts the previous release's writes and holds machine rows to their shape",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const companyId = "cmp_machine_calls";
        const insert = (id: string, kind: string, extra: Record<string, string | null> = {}) => {
          const row = {
            id,
            company_id: companyId,
            credential_kind: kind,
            op: "posthog.query",
            correlation_id: id,
            effective_principal: "usr_machine_calls",
            ...extra
          };
          return sql`INSERT INTO runtime_calls ${sql.insert(row)}`;
        };
        yield* insert("call_session", "session", { patch_id: "pat_kept", version_id: "ver_kept" });
        yield* insert("call_admin", "admin");

        yield* migrate(migrations);

        assert.deepStrictEqual(
          yield* sql`SELECT id, credential_kind, machine_id, machine_name, patch_id
            FROM runtime_calls ORDER BY id`,
          [
            {
              id: "call_admin",
              credential_kind: "admin",
              machine_id: null,
              machine_name: null,
              patch_id: null
            },
            {
              id: "call_session",
              credential_kind: "session",
              machine_id: null,
              machine_name: null,
              patch_id: "pat_kept"
            }
          ]
        );
        // The previous release, during a rollout or after a rollback, writes as it always did.
        yield* insert("call_previous", "session", { patch_id: "pat_kept" });
        yield* insert("call_machine", "machine", {
          machine_id: "tok_laptop",
          machine_name: "Laptop"
        });
        const refused = (id: string, kind: string, extra: Record<string, string | null>) =>
          insert(id, kind, extra).pipe(
            Effect.flip,
            Effect.map((error) => String(error.cause))
          );
        for (const [id, kind, extra] of [
          ["machine_without_name", "machine", { machine_id: "tok_laptop" }],
          ["machine_without_id", "machine", { machine_name: "Laptop" }],
          [
            "machine_from_a_patch",
            "machine",
            { machine_id: "tok_laptop", machine_name: "Laptop", patch_id: "pat_kept" }
          ],
          ["session_with_machine_id", "session", { machine_id: "tok_laptop" }],
          ["admin_with_machine_name", "admin", { machine_name: "Laptop" }],
          ["unknown_kind", "robot", {}]
        ] as const)
          assert.include(yield* refused(id, kind, extra), "ConstraintError", id);
      }).pipe(Effect.provide(services))
  );
});

it.layer(Testing.emptyLayer(before("0029_tier_zero_is_tier_one")))("the tier 0 fold", (it) => {
  it.effect(
    "makes every stored static page tier 1, deleted ones too, in its row, manifest and receipt, and refuses tier 0 after",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const who = { companyId: "cmp_fold", userId: "usr_fold" };
        yield* sql`INSERT INTO companies (id, handle, name) VALUES (${who.companyId}, 'fold', 'Northwind')`;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES (${who.userId}, 'clerk_fold', ${who.companyId}, 'sam@example.com', 'Sam', 'member')`;
        yield* sql`INSERT INTO machine_tokens (id, user_id, name, token_hash, expires_at, last_used_at)
          VALUES ('mt_fold', ${who.userId}, 'Laptop', 'hash_fold', now() + interval '1 day', now())`;
        yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name, deleted_at) VALUES
          ('pat_live', ${who.companyId}, ${who.userId}, 'Launch notes', 'launch-notes', NULL),
          ('pat_gone', ${who.companyId}, ${who.userId}, 'Old notes', 'old-notes', now())`;
        // As publish stored them: the manifest the CLI sent and the response a retry replays.
        const version = (id: string, patchId: string, number: number, tier: number) => {
          const manifest = {
            manifestVersion: 1,
            release: "0.21.0",
            tier,
            tables: {},
            files: {},
            uses: {}
          };
          const response = {
            ok: true,
            patchId,
            versionId: id,
            versionNumber: number,
            tier,
            scope: "company"
          };
          return sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key,
            content_hash, file_size, created_by_machine_token_id, original_filename, owner_user_id,
            tier, release, manifest_version, wire_version, schema_revision, manifest, publish_key,
            payload_digest, publish_response, publish_status)
            VALUES (${id}, ${patchId}, ${number}, ${`fold/${id}.html`}, 'hash', 1, 'mt_fold',
              'notes.html', ${who.userId}, ${tier}, '0.21.0', 1, 1, 0, ${JSON.stringify(manifest)}::jsonb,
              ${`pub_${id}`}, ${`digest_${id}`}, ${JSON.stringify(response)}::jsonb, 201)`;
        };
        yield* version("ver_static", "pat_live", 1, 0);
        yield* version("ver_scripted", "pat_live", 2, 1);
        yield* version("ver_deleted", "pat_gone", 1, 0);
        yield* version("ver_tool", "pat_gone", 2, 2);

        yield* migrate(migrations);

        const rows = yield* sql<{
          id: string;
          tier: number;
          manifest: { tier: number; release: string };
          response: { tier: number; versionId: string };
          digest: string;
        }>`SELECT id, tier, manifest, publish_response AS response, payload_digest AS digest
          FROM patch_versions ORDER BY id`;
        assert.deepStrictEqual(
          rows.map(({ id, tier, manifest, response, digest }) => ({
            id,
            tier,
            manifest: [manifest.tier, manifest.release],
            response: [response.tier, response.versionId],
            digest
          })),
          [
            {
              id: "ver_deleted",
              tier: 1,
              manifest: [1, "0.21.0"],
              response: [1, "ver_deleted"],
              digest: "digest_ver_deleted"
            },
            {
              id: "ver_scripted",
              tier: 1,
              manifest: [1, "0.21.0"],
              response: [1, "ver_scripted"],
              digest: "digest_ver_scripted"
            },
            {
              id: "ver_static",
              tier: 1,
              manifest: [1, "0.21.0"],
              response: [1, "ver_static"],
              digest: "digest_ver_static"
            },
            {
              id: "ver_tool",
              tier: 2,
              manifest: [2, "0.21.0"],
              response: [2, "ver_tool"],
              digest: "digest_ver_tool"
            }
          ]
        );
        // The previous release, during a rollout or after a rollback, publishes tier 1 as before;
        // a tier 0 version can no longer be stored.
        yield* version("ver_previous", "pat_live", 3, 1);
        assert.include(
          String((yield* version("ver_refused", "pat_live", 4, 0).pipe(Effect.flip)).cause),
          "ConstraintError"
        );
      })
  );
});
