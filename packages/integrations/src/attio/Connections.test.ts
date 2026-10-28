import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as AttioDouble from "../test/attio.js";
import * as Source from "./Source.js";

/**
 * Attio connections in the store, offline over a scripted Attio: connect, the key check at Test,
 * Refresh and Reconnect, the write-scope disconnect and Replace key.
 */

const who: { readonly companyId: string; readonly userId: string } = {
  companyId: DEV_SEED.companyId,
  userId: DEV_SEED.userId
};
/** A second admin, whose Refresh or Test finds what the first admin's key became. */
const other = { ...who, userId: "usr_attio_other" };
const fixture = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 7).toString("base64")}`)),
  RuntimeLog.layer,
  // Never called: these connections reach no database, PostHog project or Pidgeon address.
  Layer.succeed(
    PostgresSource.Source,
    PostgresSource.Source.of({
      test: () => Effect.die("no Postgres here"),
      inspect: () => Effect.die("no Postgres here")
    })
  ),
  PostHogSource.layer,
  PidgeonSource.layer
).pipe(Layer.provideMerge(Testing.layer()));

const { readKey } = AttioDouble;
const write = [...readKey.scopes, "note:read-write"];

/** A store over a workspace whose keys a test can change, and what Attio received. */
const setup = (handle: string) =>
  Effect.gen(function* () {
    const keys = new Map<string, AttioDouble.Key>([
      [readKey.token, readKey],
      ["e".repeat(64), { ...readKey, token: "e".repeat(64) }]
    ]);
    const gates = new Map<string, Promise<void>>();
    const double = AttioDouble.make(async (request) => {
      const token = request.authorization?.replace(/^Bearer /, "") ?? "";
      if (request.url.pathname === "/v2/self") await gates.get(token);
      return AttioDouble.workspace(...keys.values())(request);
    });
    const store = yield* SqlConnectionStore.make.pipe(Effect.provide(double.layer));
    const connection = yield* store.connect({
      integration: "attio",
      ...who,
      handle,
      description: "The CRM",
      credentials: Redacted.make(readKey.token)
    });
    return { store, keys, gates, requests: double.requests, id: connection.id, connection };
  });
const as = (person: typeof who, id: string) => ({ ...person, id });
const attio = (connection: ConnectionStore.Connection) =>
  connection.integration === "attio" ? connection : assert.fail("not an Attio connection");

it.layer(fixture)("Attio connections", (it) => {
  it.effect("connects a workspace with a read key, keeping its shape and never the key", () =>
    Effect.gen(function* () {
      const { store, id, connection } = yield* setup("crm");
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(attio(connection).display, {
        workspace: { id: "ws-acme", name: "Acme", slug: "acme" },
        keyHint: `…${readKey.token.slice(-4)}`,
        scopes: [...readKey.scopes].sort()
      });
      const metadata = yield* store.snapshot(who.companyId, id, 1);
      if (metadata.integration !== "attio") return assert.fail("not an Attio snapshot");
      assert.deepStrictEqual(
        metadata.snapshot.objects.map((object) => object.slug),
        ["companies", "people", "deals"]
      );
      const [row] = yield* sql<{ readonly credentials: string; readonly display: string }>`
        SELECT credentials, display::text FROM connections WHERE id = ${id}`;
      assert.notInclude(row!.credentials, readKey.token);
      assert.notInclude(row!.display, readKey.token);
      const [call] = yield* (yield* RuntimeLog.RuntimeLog).recent({
        companyId: who.companyId,
        connectionId: id
      });
      assert.strictEqual(call?.op, "attio.discover");
      assert.strictEqual(call?.deadlineMs, 60_000);
    })
  );

  it.effect("refuses a key that can write or can't read enough, saving nothing", () =>
    Effect.gen(function* () {
      const { store, keys } = yield* setup("crm-refusals");
      keys.set("setup", { ...readKey, token: "setup", scopes: write });
      keys.set("bare", { ...readKey, token: "bare", scopes: ["record_permission:read"] });
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT id FROM connections`;
      const connect = (token: string) =>
        store
          .connect({
            integration: "attio",
            ...who,
            handle: `crm-${token}`,
            description: "",
            credentials: Redacted.make(token)
          })
          .pipe(Effect.flip);
      assert.instanceOf(yield* connect("setup"), Source.WriteScopes);
      assert.instanceOf(yield* connect("bare"), Source.MissingScopes);
      assert.strictEqual((yield* sql`SELECT id FROM connections`).length, before.length);
    })
  );

  it.effect(
    "disconnects a connection whose key gained a write scope on Refresh, and refuses its patches without asking Attio",
    () =>
      Effect.gen(function* () {
        const { store, keys, requests, id, connection } = yield* setup("crm-gained");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role, created_at)
          VALUES (${other.userId}, 'user_attio_other', ${who.companyId}, 'other@patchy.local',
            'Other Admin', 'admin', now()) ON CONFLICT (id) DO NOTHING`;
        keys.set(readKey.token, { ...readKey, scopes: write });
        const refused = yield* store.refresh(as(other, id)).pipe(Effect.flip);
        assert.instanceOf(refused, Source.WriteScopes);
        const after = attio(yield* store.get(who.companyId, id));
        assert.strictEqual(after.status, "disconnected");
        assert.strictEqual(after.credentialRevision, connection.credentialRevision + 1);
        assert.strictEqual(after.metadataRevision, connection.metadataRevision);
        assert.deepStrictEqual(after.display.writable?.scopes, ["note:read-write"]);
        assert.strictEqual(after.display.writable?.by, other.userId);
        assert.strictEqual(after.display.writable?.during, "refresh");
        // Patches are refused as for any disconnected connection: nothing reaches Attio.
        const sent = requests.length;
        assert.instanceOf(
          yield* store
            .resolve(who.companyId, { kind: "attio", handle: "crm-gained", id, revision: 1 })
            .pipe(Effect.flip),
          ConnectionStore.ConnectionNotConnected
        );
        assert.instanceOf(
          yield* store
            .poolCredentials(
              who.companyId,
              { kind: "attio", handle: "crm-gained", id, revision: 1 },
              after.credentialRevision
            )
            .pipe(Effect.flip),
          ConnectionStore.ConnectionNotConnected
        );
        assert.strictEqual(requests.length, sent);
        // Calls recorded in one test-clock instant have no order: find the Refresh by its admin.
        const calls = yield* (yield* RuntimeLog.RuntimeLog).recent({
          companyId: who.companyId,
          connectionId: id
        });
        const refresh = calls.find((call) => call.userId === other.userId);
        assert.strictEqual(refresh?.op, "attio.discover");
        assert.strictEqual(refresh?.outcome, "failure");

        // Reconnect runs the check: still writable, still disconnected, named again.
        assert.instanceOf(
          yield* store.reconnect(as(who, id)).pipe(Effect.flip),
          Source.WriteScopes
        );
        assert.strictEqual((yield* store.get(who.companyId, id)).status, "disconnected");
        // The scopes fixed in Attio, Reconnect restores it and forgets what it found.
        keys.set(readKey.token, readKey);
        const restored = attio(yield* store.reconnect(as(who, id)));
        assert.strictEqual(restored.status, "connected");
        assert.isUndefined(restored.display.writable);
      })
  );

  it.effect("leaves a newer key from a concurrent Replace key connected", () =>
    Effect.gen(function* () {
      const { store, keys, gates, id } = yield* setup("crm-race");
      const replacement = "e".repeat(64);
      let open = () => {};
      gates.set(
        readKey.token,
        new Promise((resolve) => {
          open = resolve;
        })
      );
      keys.set(readKey.token, { ...readKey, scopes: write });
      const testing = yield* store.test(as(who, id)).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.withLive(Effect.sleep("20 millis"));
      const replaced = yield* store.rotate({
        ...as(who, id),
        credentials: Redacted.make(replacement)
      });
      open();
      assert.instanceOf(yield* Fiber.join(testing), Source.WriteScopes);
      const after = attio(yield* store.get(who.companyId, id));
      assert.strictEqual(after.status, "connected");
      assert.strictEqual(after.credentialRevision, replaced.credentialRevision);
      assert.strictEqual(after.display.keyHint, `…${replacement.slice(-4)}`);
      assert.isUndefined(after.display.writable);
    })
  );

  it.effect(
    "Replace key keeps the workspace, and a failed one keeps the old key and snapshot",
    () =>
      Effect.gen(function* () {
        const { store, keys, requests, id, connection } = yield* setup("crm-replace");
        keys.set("f".repeat(64), {
          ...readKey,
          token: "f".repeat(64),
          workspace: { ...AttioDouble.acme, id: "ws-beta", name: "Beta", slug: "beta" }
        });
        const elsewhere = yield* store
          .rotate({ ...as(who, id), credentials: Redacted.make("f".repeat(64)) })
          .pipe(Effect.flip);
        assert.instanceOf(elsewhere, Source.OtherWorkspace);
        assert.include(elsewhere.message, "reads the workspace Beta, not Acme");
        // A key whose discovery fails saves nothing either.
        keys.set("g".repeat(64), {
          ...readKey,
          token: "g".repeat(64),
          scopes: readKey.scopes.filter((scope) => scope !== "list_configuration:read")
        });
        assert.instanceOf(
          yield* store
            .rotate({ ...as(who, id), credentials: Redacted.make("g".repeat(64)) })
            .pipe(Effect.flip),
          Source.MissingScopes
        );
        const kept = attio(yield* store.get(who.companyId, id));
        assert.strictEqual(kept.credentialRevision, connection.credentialRevision);
        assert.strictEqual(kept.metadataRevision, connection.metadataRevision);
        const sent = requests.length;
        yield* store.test(as(who, id));
        assert.strictEqual(requests[sent]?.authorization, `Bearer ${readKey.token}`);
        // The same workspace's key replaces it, with a fresh snapshot.
        const replaced = yield* store.rotate({
          ...as(who, id),
          credentials: Redacted.make("e".repeat(64))
        });
        assert.strictEqual(replaced.metadataRevision, connection.metadataRevision + 1);
        assert.strictEqual(replaced.credentialRevision, connection.credentialRevision + 1);
        assert.instanceOf(
          yield* store
            .retarget({ ...as(who, id), credentials: Redacted.make("e".repeat(64)) })
            .pipe(Effect.flip),
          ConnectionStore.ConnectionRetargetUnavailable
        );
      })
  );

  it.effect("Refresh rediscovers through the stored key, attributed to the admin", () =>
    Effect.gen(function* () {
      const { store, keys, id, connection } = yield* setup("crm-refresh");
      keys.set(readKey.token, {
        ...readKey,
        workspace: { ...AttioDouble.acme, name: "Acme Inc", lists: [] }
      });
      const refreshed = attio(yield* store.refresh(as(who, id)));
      assert.strictEqual(refreshed.metadataRevision, connection.metadataRevision + 1);
      assert.strictEqual(refreshed.display.workspace.name, "Acme Inc");
      const metadata = yield* store.snapshot(who.companyId, id, refreshed.metadataRevision);
      if (metadata.integration !== "attio") return assert.fail("not an Attio snapshot");
      assert.deepStrictEqual(metadata.snapshot.lists, []);
      const calls = yield* (yield* RuntimeLog.RuntimeLog).recent({
        companyId: who.companyId,
        connectionId: id
      });
      assert.strictEqual(calls.length, 2);
      assert.isTrue(
        calls.every(
          (call) =>
            call.op === "attio.discover" && call.userId === who.userId && call.outcome === "success"
        )
      );
    })
  );
  it.effect("stays hidden from the release before Attio, which still lists the rest", () =>
    Effect.gen(function* () {
      const { id } = yield* setup("crm-hidden");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
        VALUES ('pat_attio_hidden', ${who.companyId}, ${who.userId}, 'Deals', 'deals-hidden')`;
      yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key, content_hash,
        file_size, created_by_machine_token_id, owner_user_id, tier, release, manifest_version,
        wire_version, schema_revision, manifest, publish_key, payload_digest, publish_response,
        publish_status)
        VALUES ('ver_attio_hidden', 'pat_attio_hidden', 1, 'deals.html', 'test', 1, ${DEV_SEED.tokenId},
          ${who.userId}, 1, 'test', 1, 1, 0,
          ${JSON.stringify({ uses: { crm: { kind: "attio", handle: "crm-hidden", id, revision: 1 } } })}::jsonb,
          'attio-hidden', 'test', '{}'::jsonb, 201)`;
      // That release's queries: the same store, knowing only the integrations it shipped.
      const before = yield* SqlConnectionStore.knowing(["postgres", "posthog", "pidgeon"]).pipe(
        Effect.provide(AttioDouble.make(AttioDouble.workspace(readKey)).layer)
      );
      assert.notInclude(
        (yield* before.list(who.companyId)).map((item) => item.id),
        id
      );
      assert.isFalse((yield* before.usage(who.companyId)).has(id));
      const declaration = { kind: "attio" as const, handle: "crm-hidden", id, revision: 1 };
      const refusals = yield* Effect.all([
        Effect.flip(before.get(who.companyId, id)),
        Effect.flip(before.snapshot(who.companyId, id, 1)),
        Effect.flip(before.resolve(who.companyId, declaration)),
        Effect.flip(before.poolCredentials(who.companyId, declaration, 1)),
        Effect.flip(before.disconnect(as(who, id)))
      ]);
      assert.deepStrictEqual(
        refusals.map((error) => error._tag),
        [
          "ConnectionNotFound",
          "ConnectionNotFound",
          "ConnectionNotConnected",
          "ConnectionNotConnected",
          "ConnectionNotFound"
        ]
      );
    })
  );
  it.effect("refuses a second connect by the same name while the first runs", () =>
    Effect.gen(function* () {
      let open = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const honest = AttioDouble.workspace(readKey);
      const double = AttioDouble.make(async (request) => {
        if (request.url.pathname === "/v2/objects") await opened;
        return honest(request);
      });
      const store = yield* SqlConnectionStore.make.pipe(Effect.provide(double.layer));
      const connect = store.connect({
        integration: "attio",
        ...who,
        handle: "crm-twice",
        description: "",
        credentials: Redacted.make(readKey.token)
      });
      const first = yield* connect.pipe(Effect.forkChild);
      yield* TestClock.withLive(Effect.sleep("20 millis"));
      const second = yield* connect.pipe(Effect.flip);
      assert.instanceOf(second, ConnectionStore.ConnectInProgress);
      assert.include(second.message, "attio/crm-twice is already connecting");
      open();
      assert.strictEqual((yield* Fiber.join(first)).handle, "crm-twice");
      // Once it's done, the name is simply taken.
      assert.instanceOf(yield* connect.pipe(Effect.flip), ConnectionStore.ConnectionHandleTaken);
    })
  );
});
