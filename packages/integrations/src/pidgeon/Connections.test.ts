import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { registry } from "@patchy/limits/registry";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as AttioSource from "../attio/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import { losingCommits } from "../test/commits.js";
import * as PidgeonTest from "../test/pidgeon.js";
import * as Calls from "./Calls.js";
import * as Keys from "./Keys.js";
import * as Source from "./Source.js";

/**
 * Patchy's side of Pidgeon connections, offline: what needs no answer from Pidgeon beyond a revoke
 * or a read. What Pidgeon does with keys and addresses is the live tier's
 * (`packages/integrations/live`).
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const fixture = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`test:${Buffer.alloc(32, 9).toString("base64")}`)),
  RuntimeLog.layer,
  // Never called: these connections reach no database or PostHog project.
  Layer.succeed(
    PostgresSource.Source,
    PostgresSource.Source.of({
      test: () => Effect.die("no Postgres here"),
      inspect: () => Effect.die("no Postgres here")
    })
  ),
  PostHogSource.layer,
  AttioSource.layer
).pipe(Layer.provideMerge(Testing.layer()));

/** A store over the canned transport, and a seeded connection. */
const setup = (handle: string, options: { readonly test?: boolean } = {}) =>
  Effect.gen(function* () {
    const pidgeon = PidgeonTest.canned();
    const store = yield* SqlConnectionStore.make.pipe(Effect.provide(pidgeon.layer));
    const id = `conn_${handle.replaceAll("-", "_")}`;
    const seeded = yield* PidgeonTest.seed({ ...who, id, handle, ...options });
    return { pidgeon, store, id, key: seeded.key };
  });
const identity = (id: string) => ({ ...who, id });
const revokes = (requests: ReadonlyArray<PidgeonTest.Sent>, keyId: string) =>
  requests.filter(PidgeonTest.route("DELETE", `/api-keys/${keyId}`)).length;
/** Waits, on the real clock, for work a test can't join, such as a detached delete. */
const eventually = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400; tries++) {
      if (done()) return;
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
    return assert.fail("It never happened.");
  });

it.layer(fixture)("Pidgeon connections, offline", (it) => {
  it.effect("refuses what can't be an admin key before asking Pidgeon anything", () =>
    Effect.gen(function* () {
      const pidgeon = PidgeonTest.canned();
      const store = yield* SqlConnectionStore.make.pipe(Effect.provide(pidgeon.layer));
      const refused = yield* store
        .connect({
          integration: "pidgeon",
          ...who,
          handle: "not-a-key",
          description: "",
          credentials: Keys.connectSecret({
            adminKey: "not a key",
            attempt: "attempt00001",
            access: "read",
            address: { id: "idn" }
          })
        })
        .pipe(Effect.flip);
      assert.instanceOf(refused, Keys.InvalidAdminKey);
      assert.deepStrictEqual(pidgeon.requests, []);
    })
  );

  it.effect("refuses to delete a declared connection, revoking nothing", () =>
    Effect.gen(function* () {
      const { pidgeon, store, id, key } = yield* setup("declared");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
        VALUES ('pat_pidgeon_decl', ${who.companyId}, ${who.userId}, 'Desk', 'desk-declared')`;
      yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key, content_hash,
        file_size, created_by_machine_token_id, owner_user_id, tier, release, manifest_version,
        wire_version, schema_revision, manifest, publish_key, payload_digest, publish_response,
        publish_status)
        VALUES ('ver_pidgeon_decl', 'pat_pidgeon_decl', 1, 'desk.html', 'test', 1, ${DEV_SEED.tokenId},
          ${who.userId}, 1, 'test', 1, 1, 0,
          ${JSON.stringify({ uses: { desk: { kind: "pidgeon", handle: "declared", id, revision: 1 } } })}::jsonb,
          'pidgeon-decl', 'test', '{}'::jsonb, 201)`;
      assert.instanceOf(
        yield* store.delete(identity(id)).pipe(Effect.flip),
        ConnectionStore.ConnectionInUse
      );
      assert.strictEqual(revokes(pidgeon.requests, key.id), 0);
    })
  );

  it.effect(
    "revokes a deleted connection's keys when Delete's request is interrupted or its COMMIT answer lost",
    () =>
      Effect.gen(function* () {
        const { pidgeon, store, id, key } = yield* setup("interrupted");
        const revoking = yield* Deferred.make<void>();
        const revoke = PidgeonTest.route("DELETE", `/api-keys/${key.id}`);
        pidgeon.hold(revoke, revoking);
        const deleting = yield* store.delete(identity(id)).pipe(Effect.forkChild);
        yield* eventually(() => pidgeon.requests.some(revoke));
        yield* Fiber.interrupt(deleting);
        yield* Deferred.succeed(revoking, undefined);
        yield* eventually(() => pidgeon.requests.filter(revoke).length === 1);
        assert.deepStrictEqual(
          (yield* store.list(who.companyId)).filter((item) => item.id === id),
          []
        );
        // The row went though COMMIT's answer was lost: its keys, a retired one too, revoke
        // themselves all the same.
        const lossy = PidgeonTest.canned();
        const { store: losing, armed } = yield* losingCommits(lossy.layer);
        const lost = yield* PidgeonTest.seed({
          ...who,
          id: "conn_ack_lost",
          handle: "ack-lost",
          retired: [{ id: "key-old", name: "Patchy ack-lost oldattempt01" }]
        });
        armed.next = { kind: "lose" };
        const deleted = yield* losing.delete(identity("conn_ack_lost"));
        assert.isNull(deleted.keyLeft);
        assert.strictEqual(revokes(lossy.requests, lost.key.id), 1);
        assert.strictEqual(revokes(lossy.requests, "key-old"), 1);
      })
  );

  it.effect("reports a deletion once, from the delete whose own COMMIT answered", () =>
    Effect.gen(function* () {
      const { store, id } = yield* setup("raced");
      const failing = PidgeonTest.canned();
      const { store: losing, armed } = yield* losingCommits(failing.layer);
      const reports: Array<string> = [];
      const by = (admin: string) => () => Effect.sync(() => void reports.push(admin));
      // A's DELETE rolls back at COMMIT; B deletes it and reports before A hears back.
      armed.next = { kind: "fail", meanwhile: store.delete(identity(id), by("B")) };
      const deleted = yield* losing.delete(identity(id), by("A"));
      // A finds the row gone and its keys revoke themselves, but it can't tell it removed the row.
      assert.isNull(deleted.keyLeft);
      assert.deepStrictEqual(reports, ["B"]);
    })
  );

  it.effect(
    "admits four calls per address, refuses the next busy, and sends a waiting one as things stand",
    () =>
      Effect.gen(function* () {
        const { pidgeon, store, id, key } = yield* setup("busy");
        const connection = { id, handle: "busy" };
        const source = yield* Source.Source.pipe(Effect.provide(pidgeon.layer));
        const threads = PidgeonTest.route("GET", "/threads");
        const slots = registry["pidgeon.calls.concurrent"].default;
        const release = yield* Deferred.make<void>();
        pidgeon.hold(threads, release, slots);
        const call = (deadline: number) =>
          Calls.withAddress(
            { companyId: who.companyId, connection, deadline, recheck: Effect.void },
            (address) =>
              address.call({
                method: "GET",
                path: "/threads",
                query: { identity_id: address.credentials.identityId }
              })
          ).pipe(
            Effect.provideService(ConnectionStore.ConnectionStore, store),
            Effect.provideService(Source.Source, source),
            Effect.forkChild
          );
        const now = yield* Clock.currentTimeMillis;
        const running = yield* Effect.forEach(Array.from({ length: slots }), () =>
          call(now + 60_000)
        );
        const sent = () => pidgeon.requests.filter(threads).length;
        // Each call loads its key from Postgres first, so wait on the real clock.
        yield* eventually(() => sent() === slots);
        const busy = yield* call(now + 2_000);
        yield* TestClock.adjust("1 second");
        assert.instanceOf(yield* Fiber.join(busy).pipe(Effect.flip), Source.Busy);
        // A call that waits while the connection is disconnected sends nothing.
        const waiting = yield* call(now + 60_000);
        yield* store.disconnect(identity(id));
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(running, Fiber.join);
        assert.instanceOf(
          yield* Fiber.join(waiting).pipe(Effect.flip),
          ConnectionStore.ConnectionNotConnected
        );
        assert.strictEqual(sent(), slots);
        assert.isTrue(
          pidgeon.requests
            .filter(threads)
            .every((sent) => sent.authorization === `Bearer ${key.token}`)
        );
      })
  );

  it.effect("stays hidden from the release before Pidgeon, which still lists the rest", () =>
    Effect.gen(function* () {
      const { pidgeon, id } = yield* setup("hidden");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
        VALUES ('pat_pidgeon_hidden', ${who.companyId}, ${who.userId}, 'Hidden', 'desk-hidden')`;
      yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key, content_hash,
        file_size, created_by_machine_token_id, owner_user_id, tier, release, manifest_version,
        wire_version, schema_revision, manifest, publish_key, payload_digest, publish_response,
        publish_status)
        VALUES ('ver_pidgeon_hidden', 'pat_pidgeon_hidden', 1, 'hidden.html', 'test', 1, ${DEV_SEED.tokenId},
          ${who.userId}, 1, 'test', 1, 1, 0,
          ${JSON.stringify({ uses: { desk: { kind: "pidgeon", handle: "hidden", id, revision: 1 } } })}::jsonb,
          'pidgeon-hidden', 'test', '{}'::jsonb, 201)`;
      // That release's queries: the same store, knowing only the integrations it shipped.
      const before = yield* SqlConnectionStore.knowing(["postgres", "posthog"]).pipe(
        Effect.provide(pidgeon.layer)
      );
      assert.notInclude(
        (yield* before.list(who.companyId)).map((item) => item.id),
        id
      );
      assert.isFalse((yield* before.usage(who.companyId)).has(id));
      const declaration = { kind: "pidgeon" as const, handle: "hidden", id, revision: 1 };
      const refusals = yield* Effect.all([
        Effect.flip(before.get(who.companyId, id)),
        Effect.flip(before.snapshot(who.companyId, id, 1)),
        Effect.flip(before.resolve(who.companyId, declaration)),
        Effect.flip(before.poolCredentials(who.companyId, declaration, 1)),
        Effect.flip(before.disconnect(identity(id)))
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
});
