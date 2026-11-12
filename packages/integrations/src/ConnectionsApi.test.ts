import { Teams } from "@patchy/companies";
import { assert, it } from "@effect/vitest";
import { Authorization, PatchyApi, authorizationClient } from "@patchy/api";
import { Authorization as BearerAuthorization, MachineTokens } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Testing from "@patchy/sql/testing";
import { RuntimeLog } from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as ConnectionsApi from "./ConnectionsApi.js";
import * as ConnectionStore from "./ConnectionStore.js";
import * as SqlConnectionStore from "./SqlConnectionStore.js";
import * as CredentialKeys from "./CredentialKeys.js";
import * as Source from "./postgres/Source.js";
import * as PostHogSource from "./posthog/Source.js";
import * as AttioSource from "./attio/Source.js";
import * as ImapTest from "./test/imap.js";
import * as PidgeonSource from "./pidgeon/Source.js";
import * as PidgeonTest from "./test/pidgeon.js";
import { NodeCryptography } from "@patchy/core";

const snapshot = {
  version: 1,
  relations: [
    {
      schema: "public",
      name: "contacts",
      kind: "table",
      columns: [
        {
          name: "id",
          nullable: false,
          type: {
            schema: "pg_catalog",
            name: "int4",
            sql: "integer",
            baseSchema: "pg_catalog",
            baseName: "int4",
            kind: "base"
          }
        }
      ],
      primaryKey: { name: "contacts_pkey", columns: ["id"] },
      foreignKeys: []
    }
  ],
  enums: [],
  exclusions: []
} satisfies typeof Snapshot.Type;
const takenAt = "2026-01-02T03:04:05.000Z";
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_foreign_connections', 'foreign-connections', 'Foreign')`;
  for (const [id, companyId] of [
    ["connections-member", DEV_SEED.companyId],
    ["connections-inactive", DEV_SEED.companyId],
    ["connections-foreign", "cmp_foreign_connections"]
  ]) {
    yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES (${id}, ${id}, ${companyId}, ${`${id}@example.com`}, ${id}, 'member')`;
  }
  for (const [id, companyId, handle, status] of [
    ["conn_archive", DEV_SEED.companyId, "archive", "disconnected"],
    ["conn_pending", DEV_SEED.companyId, "pending", "connected"],
    ["conn_warehouse", DEV_SEED.companyId, "warehouse", "connected"],
    ["conn_foreign", "cmp_foreign_connections", "foreign-only", "connected"]
  ]) {
    yield* sql`INSERT INTO connections
      (id, company_id, integration, handle, description, mode, status, display, credentials,
        key_id, credential_revision, metadata_revision, created_by, last_discovered_at)
      VALUES (${id}, ${companyId}, 'postgres', ${handle}, ${`${handle} description`}, 'company', ${status},
        ${JSON.stringify({ host: "private-host.example", port: 5432, database: "private-db", role: "secret-role" })}, 'private-ciphertext',
        'missing-key', 1, 4, ${DEV_SEED.userId}, '2026-02-01T00:00:00Z')`;
    // An older snapshot must never masquerade as the missing current revision.
    yield* sql`INSERT INTO connection_snapshots
      (connection_id, company_id, integration, revision, snapshot, created_at)
      VALUES (${id}, ${companyId}, 'postgres', ${handle === "pending" ? 3 : 4},
        ${JSON.stringify(snapshot)}, ${takenAt})`;
  }
});
const layer = Layer.mergeAll(ConnectionsApi.layer, HttpServer.layerServices).pipe(
  Layer.provideMerge(BearerAuthorization.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(
    SqlConnectionStore.layer.pipe(
      Layer.provide([
        RuntimeLog.layer,
        Source.layer,
        PostHogSource.layer,
        AttioSource.layer,
        ImapTest.offline,
        PidgeonSource.layer,
        CredentialKeys.layerFromKeys(
          Redacted.make(`test:${Buffer.alloc(32, 1).toString("base64")}`)
        )
      ])
    )
  ),
  Layer.provideMerge(
    Layer.effectDiscard(seed).pipe(
      Layer.provideMerge(Teams.layer),
      Layer.provideMerge(Testing.layer())
    )
  ),
  Layer.provideMerge(NodeCryptography.layer)
);
const client = (token: string) =>
  HttpApiTest.groups(PatchyApi, ["connections"]).pipe(
    Effect.provide(authorizationClient(Redacted.make(token)))
  );
const memberClient = Effect.gen(function* () {
  const tokens = yield* MachineTokens.MachineTokens;
  return yield* client(
    (yield* tokens.mint({ userId: "connections-member", name: "Reader" })).token
  );
});

it.layer(layer)("connections group", (it) => {
  it.effect(
    "hides connection metadata on direct requests and restores discovery through a team grant",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ConnectionStore.ConnectionStore;
        const team = yield* (yield* Teams.Teams).create({
          companyId: DEV_SEED.companyId,
          actorId: DEV_SEED.userId,
          name: "API connection audience"
        });
        yield* sql`INSERT INTO connections(id, company_id, integration, handle, description, mode, status, display, credentials, key_id, credential_revision, metadata_revision, created_by)
      SELECT 'conn_audience_api', company_id, integration, 'restricted-api', description, mode, status, display, credentials, key_id, credential_revision, metadata_revision, created_by FROM connections WHERE id = 'conn_warehouse'`;
        yield* store.setAudience({
          companyId: DEV_SEED.companyId,
          userId: DEV_SEED.userId,
          id: "conn_audience_api",
          audience: { kind: "teams", teamIds: [team.id] }
        });
        const api = yield* memberClient;
        assert.equal(
          (yield* api.listConnections({ query: {} })).connections.some(
            (row) => row.id === "conn_audience_api"
          ),
          false
        );
        const denied = yield* api.getIntegrationConnection({
          params: { integration: "postgres", handle: "restricted-api" },
          responseMode: "response-only"
        });
        assert.equal(denied.status, 404);
        assert.notInclude(yield* denied.text, "private-db");
        yield* (yield* Teams.Teams).setMemberships({
          companyId: DEV_SEED.companyId,
          actorId: DEV_SEED.userId,
          teamId: team.id,
          userIds: ["connections-member"],
          added: true
        });
        assert.equal(
          (yield* api.listConnections({ query: {} })).connections.some(
            (row) => row.id === "conn_audience_api"
          ),
          true
        );
        yield* (yield* Teams.Teams).setMemberships({
          companyId: DEV_SEED.companyId,
          actorId: DEV_SEED.userId,
          teamId: team.id,
          userIds: ["connections-member"],
          added: false
        });
        assert.equal(
          (yield* api.listConnections({ query: {} })).connections.some(
            (row) => row.id === "conn_audience_api"
          ),
          false
        );
        yield* sql`DELETE FROM connections WHERE id = 'conn_audience_api'`;
      })
  );
  it.effect(
    "lists both states for a member, with safe declaration hints and offered integrations only under all",
    () =>
      Effect.gen(function* () {
        const api = yield* memberClient;
        const expected = {
          connections: [
            {
              id: "conn_pending",
              handle: "pending",
              integration: "postgres",
              description: "pending description",
              status: "connected",
              hint: "patchy add postgres/pending"
            },
            {
              id: "conn_warehouse",
              handle: "warehouse",
              integration: "postgres",
              description: "warehouse description",
              status: "connected",
              hint: "patchy add postgres/warehouse"
            }
          ]
        };
        const response = yield* api.listConnections({ query: {}, responseMode: "response-only" });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers["cache-control"], "private, no-store");
        const listed = yield* api.listConnections({ query: {} });
        const { hint, ...disconnected } = listed.connections[0]!;
        assert.include(hint, "/settings/integrations");
        assert.notInclude(hint, "patchy add");
        assert.deepStrictEqual(disconnected, {
          id: "conn_archive",
          handle: "archive",
          integration: "postgres",
          description: "archive description",
          status: "disconnected",
          reason: "not_connected"
        });
        assert.deepStrictEqual(listed.connections.slice(1), expected.connections);
        assert.isUndefined(listed.offered);
        assert.deepStrictEqual(yield* response.json, listed);
        assert.deepStrictEqual(yield* api.listConnections({ query: { all: false } }), listed);
        assert.deepStrictEqual(yield* api.listConnections({ query: { all: true } }), {
          ...listed,
          offered: [{ integration: "postgres", connected: true }]
        });
        const bareFlag = yield* HttpApiTest.groups(PatchyApi, ["connections"]).pipe(
          Effect.provide(
            HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
              next(
                request.pipe(
                  HttpClientRequest.bearerToken(DEV_SEED.token),
                  HttpClientRequest.setUrlParam("all", "")
                )
              )
            )
          )
        );
        assert.deepStrictEqual(yield* bareFlag.listConnections({ query: {} }), {
          ...listed,
          offered: [{ integration: "postgres", connected: true }]
        });
      })
  );

  it.effect(
    "returns the exact current snapshot and its own timestamp, retains disconnected metadata, and reports a missing current snapshot as null",
    () =>
      Effect.gen(function* () {
        const api = yield* memberClient;
        for (const [handle, status] of [
          ["warehouse", "connected"],
          ["archive", "disconnected"]
        ] as const) {
          const response = yield* api.getConnection({
            params: { handle },
            responseMode: "response-only"
          });
          assert.strictEqual(response.status, 200);
          assert.strictEqual(response.headers["cache-control"], "private, no-store");
          assert.deepStrictEqual(yield* response.json, {
            integration: "postgres",
            handle,
            description: `${handle} description`,
            status,
            snapshot: { ...snapshot, revision: 4, takenAt }
          });
        }
        assert.deepStrictEqual(yield* api.getConnection({ params: { handle: "pending" } }), {
          integration: "postgres",
          handle: "pending",
          description: "pending description",
          status: "connected",
          snapshot: null
        });
        const unknown = yield* api.getConnection({
          params: { handle: "unknown" },
          responseMode: "response-only"
        });
        const foreign = yield* api.getConnection({
          params: { handle: "foreign-only" },
          responseMode: "response-only"
        });
        assert.strictEqual(unknown.status, 404);
        assert.strictEqual(foreign.status, 404);
        assert.deepStrictEqual(yield* foreign.json, yield* unknown.json);
      })
  );

  it.effect(
    "names a connection by its integration, answering an unknown integration like an unknown handle",
    () =>
      Effect.gen(function* () {
        const api = yield* memberClient;
        assert.deepStrictEqual(
          yield* api.getIntegrationConnection({
            params: { integration: "postgres", handle: "warehouse" }
          }),
          yield* api.getConnection({ params: { handle: "warehouse" } })
        );
        const unknown = yield* api.getConnection({
          params: { handle: "unknown" },
          responseMode: "response-only"
        });
        for (const params of [
          { integration: "postgres", handle: "unknown" },
          { integration: "salesforce", handle: "warehouse" },
          { integration: "postgres", handle: "foreign-only" }
        ]) {
          const response = yield* api.getIntegrationConnection({
            params,
            responseMode: "response-only"
          });
          assert.strictEqual(response.status, 404);
          assert.strictEqual(response.headers["cache-control"], "private, no-store");
          assert.deepStrictEqual(yield* response.json, yield* unknown.json);
        }
        // With Postgres the only integration, every integration lists what Postgres alone does.
        const legacy = yield* api.listConnections({ query: { all: true } });
        assert.deepStrictEqual(
          yield* api.listConnections({ query: { all: true, integrations: "all" } }),
          legacy
        );
      })
  );

  it.effect("requires an active member bearer on every route, not a browser cookie", () =>
    Effect.gen(function* () {
      const tokens = yield* MachineTokens.MachineTokens;
      const minted = yield* tokens.mint({ userId: "connections-inactive", name: "Inactive" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'connections-inactive'`;
      for (const token of ["", "invalid", minted.token]) {
        const api = yield* client(token);
        for (const response of [
          yield* api.listConnections({ query: {}, responseMode: "response-only" }),
          yield* api.getConnection({
            params: { handle: "warehouse" },
            responseMode: "response-only"
          }),
          yield* api.getIntegrationConnection({
            params: { integration: "postgres", handle: "warehouse" },
            responseMode: "response-only"
          })
        ])
          assert.strictEqual(response.status, 401);
      }
      const cookiesOnly = yield* HttpApiTest.groups(PatchyApi, ["connections"]).pipe(
        Effect.provide(
          HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
            next(HttpClientRequest.setHeader(request, "cookie", `__session=${DEV_SEED.token}`))
          )
        )
      );
      assert.strictEqual(
        (yield* cookiesOnly.listConnections({ query: {}, responseMode: "response-only" })).status,
        401
      );
      assert.strictEqual(
        (yield* cookiesOnly.getConnection({
          params: { handle: "warehouse" },
          responseMode: "response-only"
        })).status,
        401
      );
    })
  );

  it.effect(
    "scopes connection lists to the token's company and reports an unconnected offering",
    () =>
      Effect.gen(function* () {
        const tokens = yield* MachineTokens.MachineTokens;
        const api = yield* client(
          (yield* tokens.mint({ userId: "connections-foreign", name: "Foreign" })).token
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE connections SET status = 'disconnected' WHERE id = 'conn_foreign'`;
        const result = yield* api.listConnections({ query: { all: true } });
        assert.deepStrictEqual(
          result.connections.map(({ handle }) => handle),
          ["foreign-only"]
        );
        assert.deepStrictEqual(result.offered, [{ integration: "postgres", connected: false }]);
        assert.strictEqual(
          (yield* api.getConnection({
            params: { handle: "warehouse" },
            responseMode: "response-only"
          })).status,
          404
        );
      })
  );

  it.effect("reports storage outages as private 503s without leaking SQL diagnostics", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const api = yield* memberClient;
      const store = yield* ConnectionStore.ConnectionStore;
      yield* Effect.acquireUseRelease(
        sql`ALTER TABLE connection_snapshots RENAME TO private_missing_snapshots`,
        () =>
          Effect.gen(function* () {
            const response = yield* api.getConnection({
              params: { handle: "warehouse" },
              responseMode: "response-only"
            });
            assert.strictEqual(response.status, 503);
            assert.strictEqual(response.headers["cache-control"], "private, no-store");
            assert.include(yield* response.json, { ok: false, code: "connection_storage_failed" });
            assert.notInclude(yield* response.text, "connection_snapshots");
            assert.notInclude(yield* response.text, "private_missing_snapshots");
            const failure = yield* store
              .detail(DEV_SEED.companyId, "postgres", "warehouse")
              .pipe(Effect.flip);
            assert.instanceOf(failure, ConnectionStore.ConnectionStorageFailed);
            if (failure._tag === "ConnectionStorageFailed")
              assert.strictEqual(failure.operation, "detail");
          }),
        () =>
          sql`ALTER TABLE private_missing_snapshots RENAME TO connection_snapshots`.pipe(
            Effect.orDie
          )
      );
      yield* Effect.acquireUseRelease(
        sql`ALTER TABLE connections RENAME TO private_missing_connections`,
        () =>
          Effect.gen(function* () {
            const listing = yield* api.listConnections({
              query: {},
              responseMode: "response-only"
            });
            assert.strictEqual(listing.status, 503);
            assert.strictEqual(listing.headers["cache-control"], "private, no-store");
            assert.include(yield* listing.json, { ok: false, code: "connection_storage_failed" });
            assert.notInclude(yield* listing.text, "private_missing_connections");
          }),
        () => sql`ALTER TABLE private_missing_connections RENAME TO connections`.pipe(Effect.orDie)
      );
    })
  );

  it.effect("marks a Pidgeon connection made with a test key in the list", () =>
    Effect.gen(function* () {
      const tokens = yield* MachineTokens.MachineTokens;
      const api = yield* client(
        (yield* tokens.mint({ userId: "connections-foreign", name: "Pidgeon reader" })).token
      );
      for (const [id, handle, test] of [
        ["conn_test_mail", "test-mail", true],
        ["conn_live_mail", "live-mail", false]
      ] as const)
        yield* PidgeonTest.seed({
          id,
          companyId: "cmp_foreign_connections",
          userId: "connections-foreign",
          handle,
          test
        }).pipe(
          Effect.provide(
            CredentialKeys.layerFromKeys(
              Redacted.make(`test:${Buffer.alloc(32, 1).toString("base64")}`)
            ).pipe(Layer.provideMerge(NodeCryptography.layer))
          )
        );
      const listed = yield* api.listConnections({ query: { integrations: "pidgeon" } });
      assert.deepStrictEqual(
        listed.connections.map((connection) => [connection.handle, connection.test]),
        [
          ["live-mail", undefined],
          ["test-mail", true]
        ]
      );
    })
  );
  it.effect("lists an Attio connection only to a caller that decodes Attio", () =>
    Effect.gen(function* () {
      const tokens = yield* MachineTokens.MachineTokens;
      const api = yield* client(
        (yield* tokens.mint({ userId: "connections-foreign", name: "Attio reader" })).token
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO connections (id, company_id, integration, handle, description, mode,
        status, display, credentials, key_id, credential_revision, metadata_revision, created_by)
        VALUES ('conn_crm', 'cmp_foreign_connections', 'attio', 'crm', 'The CRM', 'company',
          'connected', ${JSON.stringify({ workspace: { id: "ws", name: "Acme", slug: "acme" }, keyHint: "…abcd", scopes: [] })}::jsonb,
          'not-a-valid-ciphertext', 'missing-key', 1, 1, 'connections-foreign')`;
      // A CLI from before Attio names the integrations it decodes, and Attio isn't one.
      const older = yield* api.listConnections({
        query: { integrations: "postgres,posthog,pidgeon" }
      });
      assert.notInclude(
        older.connections.map((connection) => connection.integration),
        "attio"
      );
      const current = yield* api.listConnections({
        query: { integrations: "postgres,posthog,pidgeon,attio", all: true }
      });
      assert.deepInclude(current.connections, {
        id: "conn_crm",
        handle: "crm",
        integration: "attio",
        description: "The CRM",
        status: "connected",
        hint: "patchy add attio/crm"
      });
      assert.deepInclude(current.offered ?? [], { integration: "attio", connected: true });
    })
  );
  it.effect("lists an IMAP connection only to a caller that decodes IMAP", () =>
    Effect.gen(function* () {
      const tokens = yield* MachineTokens.MachineTokens;
      const api = yield* client(
        (yield* tokens.mint({ userId: "connections-foreign", name: "IMAP reader" })).token
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO connections (id, company_id, integration, handle, description, mode,
        status, display, credentials, key_id, credential_revision, metadata_revision, created_by)
        VALUES ('conn_invoices', 'cmp_foreign_connections', 'imap', 'invoices', 'Invoices', 'company',
          'connected', ${JSON.stringify({ host: "mail.example.test", port: 993, security: "tls", username: "invoices@example.test" })}::jsonb,
          'not-a-valid-ciphertext', 'missing-key', 1, 1, 'connections-foreign')`;
      // A CLI from before IMAP names the integrations it decodes, and IMAP isn't one.
      const older = yield* api.listConnections({
        query: { integrations: "postgres,posthog,pidgeon,attio" }
      });
      assert.notInclude(
        older.connections.map((connection) => connection.integration),
        "imap"
      );
      const current = yield* api.listConnections({
        query: { integrations: "postgres,posthog,pidgeon,attio,imap", all: true }
      });
      assert.deepInclude(current.connections, {
        id: "conn_invoices",
        handle: "invoices",
        integration: "imap",
        description: "Invoices",
        status: "connected",
        hint: "patchy add imap/invoices"
      });
      assert.deepInclude(current.offered ?? [], { integration: "imap", connected: true });
    })
  );
  it.effect(
    "says a paused IMAP connection is paused, with the way out, in its row and detail",
    () =>
      Effect.gen(function* () {
        const tokens = yield* MachineTokens.MachineTokens;
        const api = yield* client(
          (yield* tokens.mint({ userId: "connections-foreign", name: "Paused reader" })).token
        );
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-11-05T09:00:00.000Z";
        yield* sql`INSERT INTO connections (id, company_id, integration, handle, description, mode,
        status, display, credentials, key_id, credential_revision, metadata_revision, created_by)
        VALUES ('conn_paused', 'cmp_foreign_connections', 'imap', 'paused', 'Paused mailbox', 'company',
          'connected', ${JSON.stringify({ host: "mail.example.test", port: 993, security: "tls", username: "paused@example.test", logins: 1, paused: { at, reply: null, during: "call" } })}::jsonb,
          'not-a-valid-ciphertext', 'missing-key', 1, 1, 'connections-foreign')`;
        yield* sql`INSERT INTO connection_snapshots (company_id, connection_id, integration, revision, snapshot)
        VALUES ('cmp_foreign_connections', 'conn_paused', 'imap', 1,
          ${JSON.stringify({ version: 1, host: "mail.example.test", port: 993, security: "tls", username: "paused@example.test", capabilities: [], folders: [], truncated: false })}::jsonb)`;
        const listed = yield* api.listConnections({ query: { integrations: "imap" } });
        const row = listed.connections.find((connection) => connection.id === "conn_paused");
        assert.deepInclude(row, { status: "connected", paused: true });
        assert.include(row?.hint, "Its mail server refused the password");
        assert.include(row?.hint, "replace the password or test it at /settings/integrations");
        assert.notInclude(row?.hint, "patchy add");
        const detail = yield* api.getIntegrationConnection({
          params: { integration: "imap", handle: "paused" }
        });
        assert.deepInclude(detail, { integration: "imap", paused: { at } });
      })
  );
});
