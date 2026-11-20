import { Teams } from "@patchy/companies";
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
import * as NotionSource from "../notion/Source.js";
import * as ImapTest from "../test/imap.js";
import * as GithubTest from "../test/github.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import { losingCommits } from "../test/commits.js";
import * as PidgeonTest from "../test/pidgeon.js";
import * as Calls from "./Calls.js";
import * as Keys from "./Keys.js";
import * as Source from "./Source.js";
import { NodeCryptography } from "@patchy/core";
import * as PatchVisibilityTest from "../test/patchVisibility.js";

/**
 * Patchy's side of Pidgeon connections, offline, against the scripted double: a key pasted from
 * Pidgeon's dashboard, checked without changing anything, kept with the one inbox at the address
 * typed; Replace key, Change access, Test and Delete. What Pidgeon does for real is the live tier's
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
  AttioSource.layer,
  NotionSource.layer,
  ImapTest.offline,
  GithubTest.unconfigured
).pipe(
  Layer.provideMerge(PatchVisibilityTest.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);

/** A Pidgeon account with a desk inbox, an events inbox, and a store over it. */
const account = Effect.gen(function* () {
  const pidgeon = PidgeonTest.double();
  const desk = pidgeon.inbox("desk@acme.example", { displayName: "Acme Desk" });
  const events = pidgeon.inbox("hooks@acme.example", { kind: "events" });
  const billing = pidgeon.label(desk, "Billing", "amber");
  const store = yield* SqlConnectionStore.make.pipe(Effect.provide([pidgeon.layer, Teams.layer]));
  return { pidgeon, desk, events, billing, store };
});
/** A connect as the page submits one. */
const connecting = (handle: string, request: Keys.ConnectRequest) => ({
  integration: "pidgeon" as const,
  ...who,
  handle,
  description: "Customer questions",
  credentials: Keys.connectSecret(request)
});
const identity = (id: string) => ({ ...who, id });
/** Requests that could change something in Pidgeon, leaving out the level check. */
const changes = (requests: ReadonlyArray<PidgeonTest.Built>) =>
  requests.filter(
    (sent) =>
      sent.method !== "GET" &&
      !(sent.method === "POST" && sent.path === `/email/drafts/${Keys.NOTHING}/send`)
  );
/** Waits, on the real clock, for work a test can't join. */
const eventually = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400; tries++) {
      if (done()) return;
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
    return assert.fail("It never happened.");
  });

it.layer(fixture)("Pidgeon connections, offline", (it) => {
  it.effect("refuses what can't be a Pidgeon key before asking Pidgeon anything", () =>
    Effect.gen(function* () {
      const { pidgeon, store } = yield* account;
      const refused = yield* store
        .connect(
          connecting("not-a-key", { key: "not a key", email: "desk@acme.example", access: "read" })
        )
        .pipe(Effect.flip);
      assert.instanceOf(refused, Keys.InvalidKey);
      assert.deepStrictEqual(pidgeon.requests, []);
    })
  );

  it.effect("connects one inbox with the pasted key, keeping the key with the inbox's id", () =>
    Effect.gen(function* () {
      const { pidgeon, desk, billing, store } = yield* account;
      const token = pidgeon.key("send");
      // The address as typed: its case and the spaces around it don't matter.
      const connected = yield* store.connect(
        connecting("desk", { key: token, email: " DESK@acme.example ", access: "send" })
      );
      assert.deepStrictEqual(connected.display, {
        email: "desk@acme.example",
        inboxId: desk,
        access: "send",
        test: true
      });
      const snapshot = yield* store.snapshot(who.companyId, connected.id, 1);
      assert.deepStrictEqual(snapshot, {
        integration: "pidgeon",
        snapshot: {
          version: 2,
          address: { email: "desk@acme.example", displayName: "Acme Desk" },
          access: "send",
          test: true,
          labels: [{ id: billing, name: "Billing", colour: "amber" }]
        }
      });
      const keys = yield* CredentialKeys.CredentialKeys;
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ readonly credentials: string; readonly keyId: string }>`SELECT
        credentials, key_id AS "keyId" FROM connections WHERE id = ${connected.id}`;
      const secret = yield* keys.decrypt(
        { companyId: who.companyId, id: connected.id, integration: "pidgeon" },
        row!
      );
      assert.deepStrictEqual(yield* Source.parseCredentials(secret), { inboxId: desk, key: token });
      // Nothing was made, sent or changed in Pidgeon.
      assert.deepStrictEqual(changes(pidgeon.requests), []);
    })
  );

  it.effect(
    "refuses a key Pidgeon rejects, an address no inbox has, an events inbox, then send with a Read key",
    () =>
      Effect.gen(function* () {
        const { pidgeon, store } = yield* account;
        const reader = pidgeon.key("read");
        const sender = pidgeon.key("send");
        const unknown = `pgn_test_${"r".repeat(32)}`;
        const desk = "desk@acme.example";
        const cases = [
          [{ key: unknown, email: desk, access: "read" }, "PidgeonKeyRejected"],
          [{ key: sender, email: "sales@acme.example", access: "send" }, "PidgeonInboxNotFound"],
          [{ key: sender, email: "hooks@acme.example", access: "read" }, "PidgeonNoInbox"],
          // The inbox is checked before what the key may do.
          [{ key: reader, email: "sales@acme.example", access: "send" }, "PidgeonInboxNotFound"],
          [{ key: reader, email: desk, access: "send" }, "PidgeonCantSend"]
        ] as const;
        for (const [index, [request, refusal]] of cases.entries())
          assert.strictEqual(
            (yield* store.connect(connecting(`refused-${index}`, request)).pipe(Effect.flip))._tag,
            refusal
          );
        assert.deepStrictEqual(
          (yield* store.list(who.companyId)).filter((item) => item.handle.startsWith("refused-")),
          []
        );
        // A Read key connects at Read.
        assert.include(
          (yield* store.connect(connecting("reads", { key: reader, email: desk, access: "read" })))
            .display,
          { access: "read" }
        );
        assert.deepStrictEqual(changes(pidgeon.requests), []);
      })
  );

  it.effect(
    "replaces the key with one that reaches the same inbox and can do what patches may",
    () =>
      Effect.gen(function* () {
        const { pidgeon, desk, store } = yield* account;
        const connected = yield* store.connect(
          connecting("swap", {
            key: pidgeon.key("send"),
            email: "desk@acme.example",
            access: "send"
          })
        );
        const replace = (key: string) =>
          store.rotate({ ...identity(connected.id), credentials: Keys.changeSecret({ key }) });
        assert.instanceOf(
          yield* replace(pidgeon.key("read")).pipe(Effect.flip),
          Keys.NewKeyCantSend
        );
        // A key of another account doesn't reach the inbox.
        const stranger = pidgeon.key("send");
        pidgeon.fault(
          (sent) =>
            sent.method === "GET" &&
            sent.path === `/email/inboxes/${desk}` &&
            sent.authorization === `Bearer ${stranger}`,
          {
            status: 404,
            body: { error: { code: "not_found", message: "There is no such inbox." } }
          }
        );
        assert.instanceOf(yield* replace(stranger).pipe(Effect.flip), Keys.OtherAccount);
        const live = pidgeon.key("send", { live: true });
        const replaced = yield* replace(live);
        assert.deepInclude(replaced, {
          credentialRevision: connected.credentialRevision + 1,
          metadataRevision: 2
        });
        assert.deepStrictEqual(replaced.display, { ...connected.display, test: false });
        assert.include((yield* store.snapshot(who.companyId, connected.id, 2)).snapshot, {
          test: false,
          access: "send"
        });
        assert.deepStrictEqual(changes(pidgeon.requests), []);
      })
  );

  it.effect("changes access locally, checking only that a key patches may send with can send", () =>
    Effect.gen(function* () {
      const { pidgeon, store } = yield* account;
      const reader = pidgeon.key("read");
      const connected = yield* store.connect(
        connecting("access", { key: reader, email: "desk@acme.example", access: "read" })
      );
      const change = (access: Keys.Access) =>
        store.rotate({ ...identity(connected.id), credentials: Keys.changeSecret({ access }) });
      assert.instanceOf(yield* change("send").pipe(Effect.flip), Keys.StoredCantSend);
      yield* store.rotate({
        ...identity(connected.id),
        credentials: Keys.changeSecret({ key: pidgeon.key("send") })
      });
      const raised = yield* change("send");
      assert.include(raised.display, { access: "send" });
      assert.include((yield* store.snapshot(who.companyId, connected.id, 3)).snapshot, {
        access: "send"
      });
      // Lowering asks Pidgeon nothing.
      const before = pidgeon.requests.length;
      const lowered = yield* change("read");
      assert.include(lowered.display, { access: "read" });
      assert.include((yield* store.snapshot(who.companyId, connected.id, 4)).snapshot, {
        access: "read"
      });
      assert.strictEqual(pidgeon.requests.length, before);
    })
  );

  it.effect("tests and resumes with the stored key, saying when it stopped or its inbox went", () =>
    Effect.gen(function* () {
      const { pidgeon, desk, store } = yield* account;
      const token = pidgeon.key("send");
      const connected = yield* store.connect(
        connecting("checked", { key: token, email: "desk@acme.example", access: "send" })
      );
      yield* store.test(identity(connected.id));
      yield* store.disconnect(identity(connected.id));
      pidgeon.revoke(token);
      assert.instanceOf(
        yield* store.reconnect(identity(connected.id)).pipe(Effect.flip),
        Keys.StoredKeyRejected
      );
      pidgeon.key("send", { token });
      pidgeon.removeInbox(desk);
      assert.instanceOf(
        yield* store.test(identity(connected.id)).pipe(Effect.flip),
        Keys.InboxGone
      );
      assert.instanceOf(
        yield* store.refresh(identity(connected.id)).pipe(Effect.flip),
        ConnectionStore.ConnectionNotConnected
      );
    })
  );

  it.effect("deletes an unused connection without asking Pidgeon, and refuses a declared one", () =>
    Effect.gen(function* () {
      const { pidgeon, store } = yield* account;
      const declared = yield* store.connect(
        connecting("declared", {
          key: pidgeon.key("read"),
          email: "desk@acme.example",
          access: "read"
        })
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
        VALUES ('pat_pidgeon_decl', ${who.companyId}, ${who.userId}, 'Desk', 'desk-declared')`;
      yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key, content_hash,
        file_size, created_by_machine_token_id, owner_user_id, tier, release, manifest_version,
        wire_version, schema_revision, manifest, publish_key, payload_digest, publish_response,
        publish_status)
        VALUES ('ver_pidgeon_decl', 'pat_pidgeon_decl', 1, 'desk.html', 'test', 1, ${DEV_SEED.tokenId},
          ${who.userId}, 1, 'test', 1, 1, 0,
          ${JSON.stringify({ uses: { desk: { kind: "pidgeon", handle: "declared", id: declared.id, revision: 1 } } })}::jsonb,
          'pidgeon-decl', 'test', '{}'::jsonb, 201)`;
      assert.instanceOf(
        yield* store.delete(identity(declared.id)).pipe(Effect.flip),
        ConnectionStore.ConnectionInUse
      );
      const unused = yield* store.connect(
        connecting("unused", {
          key: pidgeon.key("read"),
          email: "desk@acme.example",
          access: "read"
        })
      );
      const before = pidgeon.requests.length;
      assert.strictEqual((yield* store.delete(identity(unused.id))).connection.id, unused.id);
      assert.strictEqual(pidgeon.requests.length, before);
    })
  );

  it.effect("reports a deletion once, from the delete whose own COMMIT answered", () =>
    Effect.gen(function* () {
      const { pidgeon, store } = yield* account;
      const { id } = yield* store.connect(
        connecting("raced", {
          key: pidgeon.key("read"),
          email: "desk@acme.example",
          access: "read"
        })
      );
      const { store: losing, armed } = yield* losingCommits(pidgeon.layer);
      const reports: Array<string> = [];
      const by = (admin: string) => () => Effect.sync(() => void reports.push(admin));
      // A's DELETE rolls back at COMMIT; B deletes it and reports before A hears back.
      armed.next = { kind: "fail", meanwhile: store.delete(identity(id), by("B")) };
      yield* losing.delete(identity(id), by("A")).pipe(Effect.ignore);
      assert.deepStrictEqual(reports, ["B"]);
    })
  );

  it.effect(
    "admits four calls per inbox, refuses the next busy, and sends a waiting one as things stand",
    () =>
      Effect.gen(function* () {
        const { pidgeon, store } = yield* account;
        const token = pidgeon.key("read");
        const connected = yield* store.connect(
          connecting("busy", { key: token, email: "desk@acme.example", access: "read" })
        );
        const connection = { id: connected.id, handle: "busy" };
        const source = yield* Source.Source.pipe(Effect.provide(pidgeon.layer));
        const threads = PidgeonTest.route("GET", "/email/threads");
        const slots = registry["pidgeon.calls.concurrent"].default;
        const release = yield* Deferred.make<void>();
        pidgeon.hold(threads, release, slots);
        const call = (deadline: number) =>
          Calls.withInbox(
            { companyId: who.companyId, connection, deadline, recheck: Effect.void },
            (inbox) =>
              inbox.call({
                method: "GET",
                path: "/email/threads",
                query: { inbox_id: inbox.credentials.inboxId }
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
        yield* store.disconnect(identity(connected.id));
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(running, Fiber.join);
        assert.instanceOf(
          yield* Fiber.join(waiting).pipe(Effect.flip),
          ConnectionStore.ConnectionNotConnected
        );
        assert.strictEqual(sent(), slots);
        assert.isTrue(
          pidgeon.requests.filter(threads).every((sent) => sent.authorization === `Bearer ${token}`)
        );
      })
  );

  it.effect("stays hidden from the release before Pidgeon, which still lists the rest", () =>
    Effect.gen(function* () {
      const { pidgeon, store } = yield* account;
      const { id } = yield* store.connect(
        connecting("hidden", {
          key: pidgeon.key("read"),
          email: "desk@acme.example",
          access: "read"
        })
      );
      // That release's queries: the same store, knowing only the integrations it shipped.
      const before = yield* SqlConnectionStore.knowing(["postgres", "posthog"]).pipe(
        Effect.provide([pidgeon.layer, Teams.layer])
      );
      assert.notInclude(
        (yield* before.list(who.companyId)).map((item) => item.id),
        id
      );
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
