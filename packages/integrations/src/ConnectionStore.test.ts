import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ConnectionStore from "./ConnectionStore.js";
import * as CredentialKeys from "./CredentialKeys.js";
import { Snapshot } from "./postgres/Snapshot.js";
import * as Source from "./postgres/Source.js";
import * as SourceClient from "./postgres/SourceClient.js";

const empty: typeof Snapshot.Type = { version: 1, relations: [], enums: [], exclusions: [] };
const evolved: typeof Snapshot.Type = {
  ...empty,
  enums: [{ schema: "public", name: "order_status", labels: ["open", "closed"] }]
};
const oldKey = Buffer.alloc(32, 31).toString("base64");
const newKey = Buffer.alloc(32, 47).toString("base64");
const secret = Redacted.make(
  "postgresql://reader:do-not-log-this@warehouse.example/sales?sslmode=verify-full"
);
const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const input = (handle: string): ConnectionStore.ConnectInput => ({
  ...who,
  handle,
  description: "Sales warehouse",
  credentials: secret
});
const identity = (connection: ConnectionStore.Connection): ConnectionStore.Identity => ({
  ...who,
  id: connection.id
});
const declaration = (connection: ConnectionStore.Connection) => ({
  kind: "postgres" as const,
  handle: connection.handle,
  id: connection.id,
  revision: connection.metadataRevision
});
const source = Source.Source.of({
  test: Effect.fn("FixtureSource.test")(function* (credentials) {
    const { host, port, database, role } = yield* Source.parseCredentials(credentials);
    return { host, port, database, role };
  }),
  inspect: Effect.fn("FixtureSource.inspect")(function* (credentials) {
    const { host, port, database, role } = yield* Source.parseCredentials(credentials);
    return { display: { host, port, database, role }, snapshot: empty };
  })
});
const fixture = ConnectionStore.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CredentialKeys.layerFromKeys(Redacted.make(`old:${oldKey}`)),
      RuntimeLog.layer,
      Layer.succeed(Source.Source, source)
    )
  ),
  Layer.provideMerge(Testing.layer())
);

it.layer(fixture)("ConnectionStore", (it) => {
  it.effect(
    "pool creation checks live identity and credentials without rebinding published metadata",
    () =>
      Effect.gen(function* () {
        const store = yield* ConnectionStore.ConnectionStore;
        const connected = yield* store.connect(input("pool-credentials"));
        const declared = declaration(connected);
        const target = identity(connected);
        const refreshed = yield* store.refresh(target);
        assert.strictEqual(refreshed.metadataRevision, 2);
        assert.strictEqual(
          Redacted.value(yield* store.poolCredentials(who.companyId, declared, 1)),
          Redacted.value(secret)
        );
        const rotatedSecret = Redacted.make(
          "postgresql://reader:rotated-secret@warehouse.example/sales?sslmode=verify-full"
        );
        const rotated = yield* store.rotate({ ...target, credentials: rotatedSecret });
        assert.strictEqual(
          (yield* store.poolCredentials(who.companyId, declared, 1).pipe(Effect.flip)).code,
          "connection_changed"
        );
        assert.strictEqual(
          Redacted.value(
            yield* store.poolCredentials(who.companyId, declared, rotated.credentialRevision)
          ),
          Redacted.value(rotatedSecret)
        );
        for (const [companyId, candidate] of [
          ["other-company", declared],
          [who.companyId, { ...declared, id: "missing" }],
          [who.companyId, { ...declared, handle: "wrong-handle" }]
        ] as const) {
          assert.strictEqual(
            (yield* store
              .poolCredentials(companyId, candidate, rotated.credentialRevision)
              .pipe(Effect.flip)).code,
            "connection_not_connected"
          );
        }
        yield* store.disconnect(target);
        assert.strictEqual(
          (yield* store
            .poolCredentials(who.companyId, declared, rotated.credentialRevision)
            .pipe(Effect.flip)).code,
          "connection_not_connected"
        );
      })
  );

  it.effect("supports reverse states without silently changing identity or pinned metadata", () =>
    Effect.gen(function* () {
      const store = yield* ConnectionStore.ConnectionStore;
      const connected = yield* store.connect(input("reverse-states"));
      const target = identity(connected);
      assert.strictEqual(connected.status, "connected");
      assert.strictEqual(connected.credentialRevision, 1);
      const disconnected = yield* store.disconnect(target);
      assert.strictEqual(disconnected.status, "disconnected");
      assert.strictEqual(disconnected.credentialRevision, 2);
      assert.strictEqual(
        (yield* store.resolve(who.companyId, declaration(connected)).pipe(Effect.flip)).code,
        "connection_not_connected"
      );
      const tested = yield* store.test(target);
      assert.strictEqual(tested.status, "disconnected");
      assert.strictEqual(tested.credentialRevision, 2);
      assert.strictEqual((yield* store.disconnect(target)).credentialRevision, 2);
      assert.strictEqual(
        (yield* store.refresh(target).pipe(Effect.flip)).code,
        "connection_not_connected"
      );
      const rotated = yield* store.rotate({
        ...target,
        credentials: Redacted.make(
          "postgresql://replacement:new-password@warehouse.example/sales?sslmode=verify-full"
        )
      });
      assert.strictEqual(rotated.status, "disconnected");
      assert.strictEqual(rotated.display.role, "replacement");
      assert.strictEqual(rotated.credentialRevision, 3);
      assert.strictEqual(rotated.metadataRevision, 1);
      const reconnected = yield* store.reconnect(target);
      assert.strictEqual(reconnected.status, "connected");
      assert.strictEqual(reconnected.credentialRevision, 4);
      assert.strictEqual((yield* store.reconnect(target)).credentialRevision, 4);
      assert.deepStrictEqual(
        yield* store.resolve(who.companyId, declaration(reconnected)),
        declaration(reconnected)
      );
      assert.strictEqual((yield* store.describe({ ...target, description: "" })).description, "");
      const renamed = yield* store.describe({ ...target, description: "Updated purpose" });
      assert.strictEqual(renamed.description, "Updated purpose");
      assert.strictEqual(renamed.id, connected.id);
      assert.strictEqual(renamed.metadataRevision, 1);
      yield* store.delete(target);
      assert.strictEqual(
        (yield* store.get(who.companyId, connected.id).pipe(Effect.flip)).code,
        "connection_not_found"
      );
      assert.deepStrictEqual(yield* store.snapshot(who.companyId, connected.id, 1), empty);
    })
  );

  it.effect("requires retarget for a new endpoint, preserving the old credential on refusal", () =>
    Effect.gen(function* () {
      const store = yield* ConnectionStore.ConnectionStore;
      const connected = yield* store.connect(input("retarget-endpoint"));
      const target = identity(connected);
      const credentials = Redacted.make(
        "postgresql://reader:another-password@other.example/reporting?sslmode=verify-full"
      );
      assert.strictEqual(
        (yield* store.rotate({ ...target, credentials }).pipe(Effect.flip)).code,
        "connection_retarget_required"
      );
      assert.deepStrictEqual(yield* store.get(who.companyId, connected.id), connected);
      const retargeted = yield* store.retarget({ ...target, credentials });
      assert.strictEqual(retargeted.id, connected.id);
      assert.strictEqual(retargeted.display.host, "other.example");
      assert.strictEqual(retargeted.display.database, "reporting");
      assert.strictEqual(retargeted.credentialRevision, 2);
      assert.strictEqual(retargeted.metadataRevision, 2);
      assert.deepStrictEqual(yield* store.snapshot(who.companyId, connected.id, 1), empty);
      assert.strictEqual(
        (yield* store.resolve(who.companyId, declaration(connected)).pipe(Effect.flip)).code,
        "stale_generated"
      );
      assert.deepStrictEqual(
        yield* store.resolve(who.companyId, declaration(retargeted)),
        declaration(retargeted)
      );
    })
  );

  it.effect(
    "retains immutable whole snapshots and preserves the current revision on failed discovery",
    () =>
      Effect.gen(function* () {
        const store = yield* ConnectionStore.ConnectionStore;
        const sql = yield* SqlClient.SqlClient;
        const connected = yield* store.connect(input("snapshot-history"));
        const target = identity(connected);
        const changed = yield* ConnectionStore.make.pipe(
          Effect.provideService(Source.Source, {
            ...source,
            inspect: (credentials) =>
              source
                .test(credentials)
                .pipe(Effect.map((display) => ({ display, snapshot: evolved })))
          })
        );
        const refreshed = yield* changed.refresh(target);
        assert.strictEqual(refreshed.metadataRevision, 2);
        assert.deepStrictEqual(yield* store.snapshot(who.companyId, connected.id, 1), empty);
        assert.deepStrictEqual(yield* store.snapshot(who.companyId, connected.id, 2), evolved);
        assert.strictEqual(
          (yield* sql`UPDATE connection_snapshots SET snapshot = '{}'::jsonb WHERE connection_id = ${connected.id}`.pipe(
            Effect.flip
          ))._tag,
          "SqlError"
        );
        assert.strictEqual(
          (yield* sql`DELETE FROM connection_snapshots WHERE connection_id = ${connected.id}`.pipe(
            Effect.flip
          ))._tag,
          "SqlError"
        );
        const failed = yield* ConnectionStore.make.pipe(
          Effect.provideService(Source.Source, {
            ...source,
            inspect: () =>
              Effect.fail(
                new SourceClient.SourceUnavailable({
                  stage: "metadata",
                  cause: Redacted.make(new Error("source diagnostic with secret"))
                })
              )
          })
        );
        const refusal = yield* failed.refresh(target).pipe(Effect.flip);
        assert.strictEqual(refusal.code, "source_unavailable");
        assert.notInclude(JSON.stringify(refusal), "source diagnostic with secret");
        assert.deepStrictEqual(yield* store.get(who.companyId, connected.id), refreshed);
        assert.deepStrictEqual(yield* store.snapshot(who.companyId, connected.id, 2), evolved);
        assert.strictEqual(
          (yield* store.snapshot(who.companyId, connected.id, 3).pipe(Effect.flip)).code,
          "connection_not_found"
        );
        const calls =
          yield* sql`SELECT company_id, user_id, patch_id, version_id, credential_kind, outcome
      FROM runtime_calls WHERE connection_id = ${connected.id} ORDER BY at, id`;
        assert.strictEqual(calls.filter((call) => call.outcome === "success").length, 2);
        assert.strictEqual(calls.filter((call) => call.outcome === "failure").length, 1);
        for (const call of calls) {
          assert.strictEqual(call.company_id, who.companyId);
          assert.strictEqual(call.user_id, who.userId);
          assert.strictEqual(call.patch_id, null);
          assert.strictEqual(call.version_id, null);
          assert.strictEqual(call.credential_kind, "admin");
        }
        assert.notInclude(JSON.stringify(calls), "do-not-log-this");
      })
  );

  it.effect("refuses invalid whole metadata before creating another snapshot", () =>
    Effect.gen(function* () {
      const store = yield* ConnectionStore.ConnectionStore;
      const connected = yield* store.connect(input("invalid-snapshot"));
      const invalid = yield* ConnectionStore.make.pipe(
        Effect.provideService(Source.Source, {
          ...source,
          inspect: (credentials) =>
            source.test(credentials).pipe(
              Effect.map((display) => ({
                display,
                snapshot: {
                  ...empty,
                  enums: [{ schema: "public", name: "duplicate_labels", labels: ["same", "same"] }]
                }
              }))
            )
        })
      );
      assert.strictEqual(
        (yield* invalid.refresh(identity(connected)).pipe(Effect.flip)).code,
        "connection_storage_failed"
      );
      assert.deepStrictEqual(yield* store.get(who.companyId, connected.id), connected);
      assert.deepStrictEqual(yield* store.snapshot(who.companyId, connected.id, 1), empty);
      assert.strictEqual(
        (yield* store.snapshot(who.companyId, connected.id, 2).pipe(Effect.flip)).code,
        "connection_not_found"
      );
    })
  );

  it.effect(
    "keeps old rows readable after a keyring rotation and rewrites only explicitly rotated credentials",
    () =>
      Effect.gen(function* () {
        const store = yield* ConnectionStore.ConnectionStore;
        const sql = yield* SqlClient.SqlClient;
        const connected = yield* store.connect(input("old-key-row"));
        const restarted = yield* ConnectionStore.make.pipe(
          Effect.provide(CredentialKeys.layerFromKeys(Redacted.make(`new:${newKey},old:${oldKey}`)))
        );
        const tested = yield* restarted.test(identity(connected));
        assert.strictEqual(tested.display.database, "sales");
        assert.deepStrictEqual(
          yield* sql`SELECT key_id FROM connections WHERE id = ${connected.id}`,
          [{ key_id: "old" }]
        );
        const rotated = yield* restarted.rotate({ ...identity(connected), credentials: secret });
        assert.strictEqual(rotated.credentialRevision, 2);
        assert.deepStrictEqual(
          yield* sql`SELECT key_id FROM connections WHERE id = ${connected.id}`,
          [{ key_id: "new" }]
        );
        const currentOnly = yield* ConnectionStore.make.pipe(
          Effect.provide(CredentialKeys.layerFromKeys(Redacted.make(`new:${newKey}`)))
        );
        assert.strictEqual((yield* currentOnly.test(identity(connected))).id, connected.id);
        assert.notInclude(
          JSON.stringify(yield* store.get(who.companyId, connected.id)),
          "do-not-log-this"
        );
      })
  );

  it.effect(
    "isolates every lookup and mutation by company, including exact publish resolution",
    () =>
      Effect.gen(function* () {
        const store = yield* ConnectionStore.ConnectionStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_other_connections', 'other-connections', 'Other company')`;
        const connected = yield* store.connect(input("company-isolation"));
        const otherCompany = "cmp_other_connections";
        const other = { ...identity(connected), companyId: otherCompany };
        assert.deepStrictEqual(yield* store.list(otherCompany), []);
        const operations = [
          store.get(otherCompany, connected.id),
          store.snapshot(otherCompany, connected.id, 1),
          store.test(other),
          store.rotate({ ...other, credentials: secret }),
          store.retarget({ ...other, credentials: secret }),
          store.refresh(other),
          store.disconnect(other),
          store.reconnect(other),
          store.describe({ ...other, description: "stolen" }),
          store.delete(other)
        ];
        for (const operation of operations) {
          assert.strictEqual((yield* operation.pipe(Effect.flip)).code, "connection_not_found");
        }
        assert.strictEqual(
          (yield* store.resolve(otherCompany, declaration(connected)).pipe(Effect.flip)).code,
          "connection_not_connected"
        );
        assert.strictEqual(
          (yield* store
            .resolve(who.companyId, { ...declaration(connected), id: "missing" })
            .pipe(Effect.flip)).code,
          "connection_not_connected"
        );
        assert.strictEqual(
          (yield* store
            .resolve(who.companyId, { ...declaration(connected), handle: "another-handle" })
            .pipe(Effect.flip)).code,
          "connection_not_connected"
        );
        assert.strictEqual(
          (yield* store
            .resolve(who.companyId, { ...declaration(connected), revision: 2 })
            .pipe(Effect.flip)).code,
          "stale_generated"
        );
        assert.strictEqual(
          (yield* store.connect(input("company-isolation")).pipe(Effect.flip)).code,
          "connection_handle_taken"
        );
        const separate = yield* store.connect({
          ...input("company-isolation"),
          companyId: otherCompany
        });
        assert.notStrictEqual(separate.id, connected.id);
        assert.deepStrictEqual(yield* store.get(who.companyId, connected.id), connected);
      })
  );

  it.effect(
    "does not hold a transaction over network discovery or overwrite a concurrent disconnect",
    () =>
      Effect.gen(function* () {
        const store = yield* ConnectionStore.ConnectionStore;
        const connected = yield* store.connect(input("concurrent-refresh"));
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const slow = yield* ConnectionStore.make.pipe(
          Effect.provideService(Source.Source, {
            ...source,
            inspect: Effect.fn("SlowSource.inspect")(function* (credentials) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
              return { display: yield* source.test(credentials), snapshot: evolved };
            })
          })
        );
        const refresh = yield* slow
          .refresh(identity(connected))
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        const disconnected = yield* store.disconnect(identity(connected));
        yield* Deferred.succeed(resume, undefined);
        assert.strictEqual((yield* Fiber.join(refresh)).code, "connection_changed");
        assert.deepStrictEqual(yield* store.get(who.companyId, connected.id), disconnected);
        assert.deepStrictEqual(yield* store.snapshot(who.companyId, connected.id, 1), empty);
        assert.strictEqual(
          (yield* store.snapshot(who.companyId, connected.id, 2).pipe(Effect.flip)).code,
          "connection_not_found"
        );
      })
  );
});

it.effect("dev holds metadata alone and explicitly refuses every administration operation", () =>
  Effect.gen(function* () {
    const connection = new ConnectionStore.Connection({
      id: "dev-connection",
      companyId: "dev-company",
      integration: "postgres",
      handle: "warehouse",
      description: "Local metadata",
      mode: "company",
      status: "connected",
      display: { host: "warehouse.example", port: 5432, database: "sales", role: "reader" },
      credentialRevision: 1,
      metadataRevision: 2,
      lastTestedAt: null,
      lastDiscoveredAt: null,
      createdBy: "dev-user"
    });
    yield* Effect.gen(function* () {
      const store = yield* ConnectionStore.ConnectionStore;
      assert.deepStrictEqual(yield* store.snapshot(connection.companyId, connection.id, 1), empty);
      assert.deepStrictEqual(
        yield* store.snapshot(connection.companyId, connection.id, 2),
        evolved
      );
      assert.strictEqual(
        (yield* store.resolve(connection.companyId, declaration(connection))).revision,
        2
      );
      assert.strictEqual(
        (yield* store.resolve("other-company", declaration(connection)).pipe(Effect.flip)).code,
        "connection_not_connected"
      );
      const target = { companyId: connection.companyId, userId: "dev-user", id: connection.id };
      for (const operation of [
        store.connect(input("local-disabled")),
        store.poolCredentials(
          connection.companyId,
          declaration(connection),
          connection.credentialRevision
        ),
        store.test(target),
        store.rotate({ ...target, credentials: secret }),
        store.retarget({ ...target, credentials: secret }),
        store.refresh(target),
        store.disconnect(target),
        store.reconnect(target),
        store.describe({ ...target, description: "changed" }),
        store.delete(target)
      ]) {
        assert.strictEqual(
          (yield* operation.pipe(Effect.flip)).code,
          "connection_mutation_unavailable"
        );
      }
    }).pipe(
      Effect.provide(
        ConnectionStore.layerDev([
          {
            connection,
            snapshots: [
              { revision: 1, snapshot: empty },
              { revision: 2, snapshot: evolved }
            ]
          }
        ])
      )
    );
  })
);
