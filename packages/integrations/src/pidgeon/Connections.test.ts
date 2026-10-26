import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { registry } from "@patchy/limits/registry";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import { ddl } from "@patchy/sql";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectionStore from "../ConnectionStore.js";
import * as CredentialKeys from "../CredentialKeys.js";
import * as PostgresSource from "../postgres/Source.js";
import * as PostHogSource from "../posthog/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";
import * as PidgeonDouble from "../test/pidgeon.js";
import * as Calls from "./Calls.js";
import type * as Fake from "./Fake.js";
import * as Keys from "./Keys.js";
import * as Source from "./Source.js";

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const GRACE_MS = registry["pidgeon.rotation.grace"].default * 1_000;
const DEADLINE_MS = registry["integration.deadline"].default;
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
  PostHogSource.layer
).pipe(Layer.provideMerge(Testing.layer()));

/** A fresh fake account and the production store over it. */
const setup = (account: Fake.Seed = PidgeonDouble.seed) =>
  Effect.gen(function* () {
    const double = PidgeonDouble.make(account);
    const store = yield* SqlConnectionStore.make.pipe(Effect.provide(double.layer));
    const help = double.fake.address("help@acme.example")!;
    const connect = (
      handle: string,
      address: Keys.Choice = { id: help.id },
      options: { access?: Keys.Access; adminKey?: string; attempt?: string } = {}
    ) =>
      store.connect({
        integration: "pidgeon",
        ...who,
        handle,
        description: "Customer questions",
        credentials: PidgeonDouble.connectRequest(
          address,
          options.access ?? "send",
          options.adminKey ?? PidgeonDouble.ADMIN_KEY,
          options.attempt ?? "attempt00001"
        )
      });
    const replace = (
      connection: ConnectionStore.Connection,
      access: Keys.Access = "send",
      attempt = "attempt00002"
    ) =>
      store.rotate({
        ...who,
        id: connection.id,
        credentials: PidgeonDouble.replaceRequest(access, PidgeonDouble.ADMIN_KEY, attempt)
      });
    return { double, store, help, connect, replace };
  });
const identity = (connection: ConnectionStore.Connection) => ({ ...who, id: connection.id });
const pidgeon = (connection: ConnectionStore.Connection) => {
  if (connection.integration !== "pidgeon") return assert.fail("A Pidgeon connection");
  return connection;
};
/** The key a connection stores now, as `Calls.connect` loads it. */
const stored = (
  store: ConnectionStore.ConnectionStore["Service"],
  connection: ConnectionStore.Connection
) =>
  Calls.connect(who.companyId, connection).pipe(
    Effect.provideService(ConnectionStore.ConnectionStore, store)
  );
/** What Pidgeon answers a secret now: 200 while it works, 401 after. */
const works = (fake: Fake.Workspace, token: string) =>
  Effect.map(
    Clock.currentTimeMillis,
    (at) =>
      fake.respond(
        {
          method: "GET",
          path: "/me",
          query: new URLSearchParams(),
          authorization: `Bearer ${token}`,
          idempotencyKey: undefined,
          body: undefined
        },
        at
      ).status
  );
/** The keys minted under one attempt's name, whatever their submission's own code. */
const named = (fake: Fake.Workspace, attempt: string) =>
  fake.keys(0).filter((key) => key.name.startsWith(`${attempt} `));
/** A key's name without its submission's code. */
const attemptOf = (name: string) => name.replace(/ [a-z0-9]{6}$/, "");
const keyOf = (fake: Fake.Workspace, id: string) => fake.keys(0).find((key) => key.id === id)!;
/** Waits, on the real clock, for work a test can't join, such as a detached delete. */
const eventually = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400; tries++) {
      if (done()) return;
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
    return assert.fail("It never happened.");
  });
/** What the next outermost COMMIT does once armed. */
type CommitFault =
  /** It goes through and answers with an error, as a connection lost right after COMMIT does. */
  | { readonly kind: "lose" }
  /** It fails and the transaction rolls back; `meanwhile` runs before the error answers. */
  | { readonly kind: "fail"; readonly meanwhile: Effect.Effect<unknown, unknown> };
const commitError = (cause: string) =>
  new SqlError({ reason: new ConnectionError({ cause: new Error(cause) }) });
/** The production store over a database whose next outermost COMMIT can be made to misbehave. */
const losingCommits = (double: ReturnType<typeof PidgeonDouble.make>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const armed: { next: CommitFault | undefined } = { next: undefined };
    const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
      Effect.gen(function* () {
        const fault = Option.isNone(yield* Effect.serviceOption(sql.transactionService))
          ? armed.next
          : undefined;
        if (fault === undefined) return yield* sql.withTransaction(effect);
        armed.next = undefined;
        if (fault.kind === "lose") {
          yield* sql.withTransaction(effect);
          return yield* commitError("the COMMIT's answer was lost");
        }
        const failed = yield* sql
          .withTransaction(
            Effect.flatMap(effect, () => Effect.fail(commitError("the COMMIT failed")))
          )
          .pipe(Effect.flip);
        yield* Effect.ignore(fault.meanwhile);
        return yield* Effect.fail(failed);
      });
    const lossy = new Proxy(sql, {
      get: (target, key, receiver) =>
        key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver)
    });
    const store = yield* SqlConnectionStore.make.pipe(
      Effect.provide(double.layer),
      Effect.provideService(SqlClient.SqlClient, lossy)
    );
    return { store, armed };
  });
const posts = (requests: ReadonlyArray<Fake.Request>, path: string | RegExp) =>
  requests.filter((request) => PidgeonDouble.route("POST", path)(request)).length;

it.layer(fixture)("Pidgeon connections", (it) => {
  it.effect(
    "connects an address with a key for it alone, at the chosen access, and keeps only that",
    () =>
      Effect.gen(function* () {
        const { double, store, help, connect } = yield* setup();
        const connected = pidgeon(yield* connect("help"));
        const minted = PidgeonDouble.liveKeys(double.fake);
        assert.strictEqual(minted.length, 1);
        assert.match(minted[0]!.name, /^Patchy help attempt00001 [a-z0-9]{6}$/);
        assert.deepInclude(minted[0], {
          access: "send",
          identity_ids: [help.id],
          test: false
        });
        assert.deepInclude(connected.display, {
          email: "help@acme.example",
          identityId: help.id,
          access: "send",
          sendPolicy: "reply_only",
          key: {
            id: minted[0]!.id,
            name: minted[0]!.name,
            madeAt: minted[0]!.created_at
          }
        });
        const metadata = yield* store.snapshot(who.companyId, connected.id, 1);
        assert.deepStrictEqual(metadata, {
          integration: "pidgeon",
          snapshot: {
            version: 1,
            address: {
              email: "help@acme.example",
              displayName: "Acme Help",
              sendPolicy: "reply_only"
            },
            access: "send",
            labels: [
              {
                id: metadata.integration === "pidgeon" ? metadata.snapshot.labels[0]!.id : "",
                name: "Billing",
                colour: "amber"
              },
              {
                id: metadata.integration === "pidgeon" ? metadata.snapshot.labels[1]!.id : "",
                name: "Bugs",
                colour: "red"
              }
            ],
            plan: "free"
          }
        });
        // Only the minted key is stored; the admin key went in this request alone.
        const credentials = yield* stored(store, connected);
        assert.deepStrictEqual(credentials, {
          identityId: help.id,
          key: { id: minted[0]!.id, token: minted[0]!.token }
        });
        // The admin key checked itself and found the address; the new key checked its own reach.
        const admin = double.requests.filter(
          (request) => request.authorization === `Bearer ${PidgeonDouble.ADMIN_KEY}`
        );
        assert.deepStrictEqual(
          admin.map((request) => `${request.method} ${request.path}`),
          ["GET /me", `GET /identities/${help.id}`, "POST /api-keys"]
        );
        assert.deepStrictEqual(
          double.requests
            .filter((request) => request.authorization === `Bearer ${minted[0]!.token}`)
            .map((request) => `${request.method} ${request.path}`),
          ["GET /me", "GET /identities", "GET /labels"]
        );
      })
  );

  it.effect(
    "creates a new address with an inbox, reply-only by default, once however often connect retries",
    () =>
      Effect.gen(function* () {
        const { double, connect } = yield* setup();
        const fresh = {
          create: {
            localPart: "support",
            domain: "pidgeon.email",
            displayName: "Support",
            sendPolicy: "reply_only" as const
          }
        };
        // Pidgeon refuses the mint, which changed nothing: the retry repeats the same attempt.
        double.fault(PidgeonDouble.route("POST", "/api-keys"), {
          kind: "answer",
          answer: {
            status: 429,
            headers: {},
            body: {
              error: { code: "rate_limited", message: "Too many attempts. Try again in 9 minutes." }
            }
          }
        });
        const limited = yield* connect("support", fresh, { attempt: "supportfirst" }).pipe(
          Effect.flip
        );
        assert.deepInclude(limited, { _tag: "PidgeonRateLimited", limit: "requests" });
        assert.include(limited.message, "Try again in a few minutes");
        const connected = pidgeon(yield* connect("support", fresh, { attempt: "supportfirst" }));
        const created = double.fake
          .state()
          .identities.filter(
            (item) => `${item.localPart}@${item.domain}` === "support@pidgeon.email"
          );
        assert.strictEqual(created.length, 1);
        assert.isTrue(created[0]!.hasInbox);
        assert.strictEqual(created[0]!.sendPolicy, "reply_only");
        assert.strictEqual(connected.display.identityId, created[0]!.id);
        assert.strictEqual(connected.display.sendPolicy, "reply_only");
        assert.strictEqual(posts(double.requests, "/identities"), 2);
        // The same address on another attempt is taken: pick it from the list instead.
        const taken = yield* connect("support-two", fresh, { attempt: "supportother" }).pipe(
          Effect.flip
        );
        assert.instanceOf(taken, Keys.AddressTaken);
        const elsewhere = yield* connect("elsewhere", {
          create: { ...fresh.create, localPart: "taken" }
        }).pipe(Effect.flip);
        assert.instanceOf(elsewhere, Keys.AddressTaken);
      })
  );

  it.effect("refuses an address without an inbox, minting nothing", () =>
    Effect.gen(function* () {
      const { double, connect } = yield* setup();
      const alerts = double.fake.address("alerts@acme.example")!;
      const refused = yield* connect("alerts", { id: alerts.id }).pipe(Effect.flip);
      assert.deepInclude(refused, { _tag: "PidgeonNoInbox", email: "alerts@acme.example" });
      assert.strictEqual(posts(double.requests, "/api-keys"), 0);
    })
  );

  it.effect(
    "refuses a test-mode, non-admin, partial or rejected admin key, creating nothing in Pidgeon",
    () =>
      Effect.gen(function* () {
        const { double, help, connect } = yield* setup();
        double.fake.addKey({
          token: "pgn_live_sendKeyForHelp0001",
          access: "send",
          reach: [help.id],
          at: 0
        });
        double.fake.addKey({
          token: "pgn_live_partialAdminKey001",
          access: "admin",
          reach: [help.id],
          at: 0
        });
        double.fake.addKey({
          token: "pgn_test_testAdminKey000001",
          access: "admin",
          reach: "all",
          test: true,
          at: 0
        });
        const fresh = {
          create: {
            localPart: "new",
            domain: "pidgeon.email",
            displayName: null,
            sendPolicy: "reply_only" as const
          }
        };
        const cases = [
          ["pgn_test_testAdminKey000001", "PidgeonTestModeKey"],
          ["pgn_live_sendKeyForHelp0001", "PidgeonNotAdminKey"],
          ["pgn_live_partialAdminKey001", "PidgeonPartialAdminKey"],
          ["pgn_live_revokedOrMistyped01", "PidgeonAdminKeyRejected"],
          ["not a key", "PidgeonInvalidAdminKey"]
        ] as const;
        for (const [adminKey, refusal] of cases) {
          const before = double.requests.length;
          assert.strictEqual(
            (yield* connect("refused", fresh, { adminKey }).pipe(Effect.flip))._tag,
            refusal
          );
          // A test key is refused by its prefix before Pidgeon is asked anything.
          if (adminKey.startsWith("pgn_test_") || adminKey === "not a key")
            assert.strictEqual(double.requests.length, before);
        }
        assert.strictEqual(posts(double.requests, /.*/), 0);
        assert.deepStrictEqual(PidgeonDouble.liveKeys(double.fake).length, 3);
      })
  );

  it.effect("revokes a minted key that reaches more, or another, or tests, and saves nothing", () =>
    Effect.gen(function* () {
      const { double, store, help, connect } = yield* setup();
      const minted = (request: Fake.Request) =>
        request.authorization !== undefined &&
        request.authorization !== `Bearer ${PidgeonDouble.ADMIN_KEY}`;
      const reachesAll = {
        data: {
          kind: "key",
          key: { id: "k", access: "send", reaches_all_addresses: true },
          workspace: { plan: "free" },
          reaches: 2
        }
      };
      double.fault((request) => minted(request) && request.path === "/me", {
        kind: "answer",
        answer: { status: 200, headers: {}, body: reachesAll }
      });
      assert.deepInclude(yield* connect("more").pipe(Effect.flip), { found: "reach" });
      double.fault((request) => minted(request) && request.path === "/identities", {
        kind: "answer",
        answer: {
          status: 200,
          headers: {},
          body: {
            data: [
              {
                id: "someone-else",
                email: "x@acme.example",
                display_name: null,
                has_inbox: true,
                send_policy: "open"
              }
            ],
            has_more: false,
            next_cursor: null
          }
        }
      });
      assert.deepInclude(yield* connect("other").pipe(Effect.flip), { found: "reach" });
      double.fault((request) => minted(request) && request.path === "/me", {
        kind: "answer",
        answer: {
          status: 200,
          headers: {},
          body: {
            ...reachesAll,
            data: {
              ...reachesAll.data,
              key: { id: "k", access: "read", reaches_all_addresses: false },
              reaches: 1
            }
          }
        }
      });
      assert.deepInclude(yield* connect("access").pipe(Effect.flip), { found: "access" });
      // Every key minted above revoked itself: none is left live.
      assert.deepStrictEqual(PidgeonDouble.liveKeys(double.fake), []);
      // A mint that says test mode is refused before anything uses it.
      double.fault(PidgeonDouble.route("POST", "/api-keys"), {
        kind: "answer",
        answer: {
          status: 201,
          headers: {},
          body: {
            data: {
              id: "test-key",
              name: "Patchy test attempt00001",
              token: "pgn_test_mintedTestKey001",
              test: true,
              created_at: "2026-10-25T00:00:00.000Z",
              identity_ids: [help.id]
            }
          }
        }
      });
      assert.deepInclude(yield* connect("test").pipe(Effect.flip), { found: "test" });
      assert.isTrue(
        double.requests.some(
          (request) =>
            request.method === "DELETE" &&
            request.path === "/api-keys/test-key" &&
            request.authorization === "Bearer pgn_test_mintedTestKey001"
        )
      );
      assert.deepStrictEqual(
        (yield* store.list(who.companyId)).filter((item) =>
          ["more", "other", "access", "test"].includes(item.handle)
        ),
        []
      );
    })
  );

  it.effect("revokes the minted key when anything after it fails before the save", () =>
    Effect.gen(function* () {
      const { double, connect } = yield* setup();
      double.fault(PidgeonDouble.route("GET", "/labels"), {
        kind: "answer",
        answer: {
          status: 503,
          headers: {},
          body: { error: { code: "unavailable", message: "Not now." } }
        }
      });
      assert.deepInclude(yield* connect("labels").pipe(Effect.flip), {
        _tag: "PidgeonUnavailable"
      });
      assert.deepStrictEqual(PidgeonDouble.liveKeys(double.fake), []);
      yield* connect("taken-handle");
      // The save itself refuses: the handle is taken, so the second key revokes itself.
      const taken = yield* connect("taken-handle", undefined, { attempt: "attempt00009" }).pipe(
        Effect.flip
      );
      assert.instanceOf(taken, ConnectionStore.ConnectionHandleTaken);
      assert.deepStrictEqual(
        PidgeonDouble.liveKeys(double.fake).map((key) => attemptOf(key.name)),
        ["Patchy taken-handle attempt00001"]
      );
      // A key that won't revoke is named, so an admin can revoke it in Pidgeon.
      double.fault(PidgeonDouble.route("DELETE", /^\/api-keys\//), { kind: "fail" });
      const left = yield* connect("taken-handle", undefined, { attempt: "attempt00010" }).pipe(
        Effect.flip
      );
      if (left._tag !== "PidgeonStrayKey") return assert.fail("A stray key");
      assert.strictEqual(attemptOf(left.key), "Patchy taken-handle attempt00010");
    })
  );

  it.effect("cleans up a lost mint by its own submission's name, never another's key", () =>
    Effect.gen(function* () {
      const { double, connect } = yield* setup();
      const attempt = "Patchy lost attempt00001";
      double.fault(PidgeonDouble.route("POST", "/api-keys"), { kind: "lose" });
      double.fault(PidgeonDouble.route("GET", "/api-keys"), { kind: "fail" });
      const stray = yield* connect("lost").pipe(Effect.flip);
      if (stray._tag !== "PidgeonStrayKey") return assert.fail("A stray key");
      assert.strictEqual(attemptOf(stray.key), attempt);
      // The retried connect's mint is lost too: its cleanup revokes its own key, and the one the
      // first refusal named stays for the admin, never guessed at.
      double.fault(PidgeonDouble.route("POST", "/api-keys"), { kind: "lose" });
      assert.instanceOf(yield* connect("lost").pipe(Effect.flip), Keys.MintUnknown);
      assert.deepStrictEqual(
        named(double.fake, attempt)
          .map((key) => [key.name === stray.key, key.revoked_at === null])
          .sort(),
        [
          [false, false],
          [true, true]
        ]
      );
    })
  );

  it.effect(
    "lets two submissions of one attempt overlap: a lost mint's cleanup leaves the other's key",
    () =>
      Effect.gen(function* () {
        const { double, store, help, connect } = yield* setup();
        const minted = (request: Fake.Request) =>
          request.path === "/me" && request.authorization !== `Bearer ${PidgeonDouble.ADMIN_KEY}`;
        const checking = yield* Deferred.make<void>();
        double.fault(minted, { kind: "hold", release: checking });
        // A has minted and is checking its key when B's mint answer is lost.
        const first = yield* connect("overlap", { id: help.id }, { attempt: "overlapping1" }).pipe(
          Effect.forkChild
        );
        yield* eventually(() => double.requests.some(minted));
        double.fault(PidgeonDouble.route("POST", "/api-keys"), { kind: "lose" });
        const second = yield* connect("overlap", { id: help.id }, { attempt: "overlapping1" }).pipe(
          Effect.flip
        );
        assert.instanceOf(second, Keys.MintUnknown);
        yield* Deferred.succeed(checking, undefined);
        const saved = pidgeon(yield* Fiber.join(first));
        assert.isNull(keyOf(double.fake, saved.display.key.id).revoked_at);
        assert.deepStrictEqual(
          named(double.fake, "Patchy overlap overlapping1").map((key) => [
            key.id === saved.display.key.id,
            key.revoked_at === null
          ]),
          [
            [true, true],
            [false, false]
          ]
        );
        assert.strictEqual((yield* stored(store, saved)).key.id, saved.display.key.id);
        // Both mint and both try to save: one saves, and the other's key revokes itself.
        const both = yield* Effect.all(
          [
            connect("together-save", { id: help.id }, { attempt: "overlapping2" }),
            connect("together-save", { id: help.id }, { attempt: "overlapping2" })
          ].map(Effect.result),
          { concurrency: 2 }
        );
        assert.deepStrictEqual(both.map((result) => result._tag).sort(), ["Failure", "Success"]);
        const refused = both.find((result) => result._tag === "Failure");
        if (refused?._tag === "Failure")
          assert.instanceOf(refused.failure, ConnectionStore.ConnectionHandleTaken);
        const kept = pidgeon(
          (yield* store.list(who.companyId)).find((item) => item.handle === "together-save")!
        );
        assert.deepStrictEqual(
          named(double.fake, "Patchy together-save overlapping2")
            .map((key) => [key.id === kept.display.key.id, key.revoked_at === null])
            .sort(),
          [
            [false, false],
            [true, true]
          ]
        );
      })
  );

  it.effect("revokes nothing when the save's own outcome is unknown", () =>
    Effect.gen(function* () {
      const { double, store, connect } = yield* setup();
      yield* Effect.acquireRelease(
        ddl(
          `CREATE FUNCTION pidgeon_commit_lost() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.handle = 'commit-lost' THEN RAISE EXCEPTION 'the commit was lost'; END IF; RETURN NULL; END $$`,
          `CREATE CONSTRAINT TRIGGER pidgeon_commit_lost AFTER INSERT ON connections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pidgeon_commit_lost()`
        ),
        () =>
          ddl(
            `DROP TRIGGER pidgeon_commit_lost ON connections`,
            `DROP FUNCTION pidgeon_commit_lost()`
          ).pipe(Effect.orDie)
      );
      const unknown = yield* connect("commit-lost").pipe(Effect.flip);
      if (unknown._tag !== "PidgeonSaveUnknown") return assert.fail("An unknown save");
      assert.strictEqual(attemptOf(unknown.key), "Patchy commit-lost attempt00001");
      assert.strictEqual(unknown.name, "pidgeon/commit-lost");
      assert.include(unknown.message, "Check the connections list");
      assert.strictEqual(PidgeonDouble.liveKeys(double.fake).length, 1);
      assert.deepStrictEqual(
        (yield* store.list(who.companyId)).filter((item) => item.handle === "commit-lost"),
        []
      );
    }).pipe(Effect.scoped)
  );

  it.effect(
    "rotates the stored key without an admin key; the old secret stops when the page said",
    () =>
      Effect.gen(function* () {
        const { double, store, connect } = yield* setup();
        const start = yield* Clock.currentTimeMillis;
        const connected = pidgeon(yield* connect("rotating"));
        const before = yield* stored(store, connected);
        const rotated = pidgeon(yield* store.renew(identity(connected)));
        const after = yield* stored(store, rotated);
        assert.notStrictEqual(after.key.token, before.key.token);
        assert.strictEqual(after.key.id, before.key.id);
        assert.strictEqual(rotated.credentialRevision, connected.credentialRevision + 1);
        assert.deepStrictEqual(rotated.display.rotation, {
          outcome: "saved",
          oldStopsAt: new Date(start + GRACE_MS).toISOString()
        });
        assert.strictEqual(yield* works(double.fake, before.key.token), 200);
        // A second rotation waits for the first's old secret to stop, as the page said it would.
        assert.instanceOf(
          yield* store.renew(identity(connected)).pipe(Effect.flip),
          Keys.RotationRunning
        );
        yield* TestClock.adjust(GRACE_MS);
        assert.strictEqual(yield* works(double.fake, before.key.token), 401);
        assert.strictEqual(yield* works(double.fake, after.key.token), 200);
        yield* store.renew(identity(connected));
        assert.strictEqual(posts(double.requests, /\/rotate$/), 2);
      })
  );

  it.effect(
    "records a rotation before Pidgeon is asked, so no process rotates again while it's unknown",
    () =>
      Effect.gen(function* () {
        const { double, store, connect } = yield* setup();
        const connected = pidgeon(yield* connect("recorded"));
        // The record can't be written: nothing is sent, and the connection is as it was.
        yield* Effect.acquireRelease(
          ddl(
            `CREATE FUNCTION pidgeon_record_lost() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.handle = 'recorded' AND NEW.display->'rotation'->>'outcome' = 'unknown' THEN RAISE EXCEPTION 'the record was lost'; END IF; RETURN NEW; END $$`,
            `CREATE TRIGGER pidgeon_record_lost BEFORE UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION pidgeon_record_lost()`
          ),
          () =>
            ddl(
              `DROP TRIGGER IF EXISTS pidgeon_record_lost ON connections`,
              `DROP FUNCTION IF EXISTS pidgeon_record_lost()`
            ).pipe(Effect.orDie)
        );
        yield* store.renew(identity(connected)).pipe(Effect.flip);
        assert.strictEqual(posts(double.requests, /\/rotate$/), 0);
        assert.isUndefined(pidgeon(yield* store.get(who.companyId, connected.id)).display.rotation);
        yield* ddl(
          `DROP TRIGGER pidgeon_record_lost ON connections`,
          `DROP FUNCTION pidgeon_record_lost()`
        );
        // While Pidgeon hasn't answered, the record refuses a rotation here or in another process,
        // as it does after a process stops mid-rotation; the page offers Replace key.
        const answering = yield* Deferred.make<void>();
        double.fault(PidgeonDouble.route("POST", /\/rotate$/), {
          kind: "hold",
          release: answering
        });
        const first = yield* store.renew(identity(connected)).pipe(Effect.forkChild);
        yield* eventually(() => posts(double.requests, /\/rotate$/) === 1);
        const other = yield* SqlConnectionStore.make.pipe(Effect.provide(double.layer));
        for (const instance of [store, other])
          assert.instanceOf(
            yield* instance.renew(identity(connected)).pipe(Effect.flip),
            Keys.RotationUnknown
          );
        assert.deepInclude(
          pidgeon(yield* other.get(who.companyId, connected.id)).display.rotation,
          { outcome: "unknown" }
        );
        assert.strictEqual(posts(double.requests, /\/rotate$/), 1);
        yield* Deferred.succeed(answering, undefined);
        const rotated = pidgeon(yield* Fiber.join(first));
        assert.deepInclude(rotated.display.rotation, { outcome: "saved" });
        assert.strictEqual(
          (yield* stored(store, rotated)).key.token,
          PidgeonDouble.liveKeys(double.fake).find((key) => key.id === rotated.display.key.id)!
            .token
        );
      }).pipe(Effect.scoped)
  );

  it.effect("saves a rotated secret again when its save fails, never rotating twice", () =>
    Effect.gen(function* () {
      const { double, store, connect } = yield* setup();
      const connected = yield* connect("rotate-retry");
      yield* Effect.acquireRelease(
        ddl(
          `CREATE SEQUENCE pidgeon_save_once`,
          `CREATE FUNCTION pidgeon_save_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.handle = 'rotate-retry' AND NEW.credential_revision > OLD.credential_revision AND nextval('pidgeon_save_once') = 1 THEN RAISE EXCEPTION 'the save was lost'; END IF; RETURN NEW; END $$`,
          `CREATE TRIGGER pidgeon_save_once BEFORE UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION pidgeon_save_once()`
        ),
        () =>
          ddl(
            `DROP TRIGGER pidgeon_save_once ON connections`,
            `DROP FUNCTION pidgeon_save_once()`,
            `DROP SEQUENCE pidgeon_save_once`
          ).pipe(Effect.orDie)
      );
      const rotated = yield* store.renew(identity(connected));
      assert.strictEqual(posts(double.requests, /\/rotate$/), 1);
      const live = PidgeonDouble.liveKeys(double.fake)[0]!;
      assert.strictEqual((yield* stored(store, rotated)).key.token, live.token);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "records a rotation whose answer never came, refuses Rotate, and Replace key fixes it",
    () =>
      Effect.gen(function* () {
        const { double, store, connect, replace } = yield* setup();
        const start = yield* Clock.currentTimeMillis;
        const connected = pidgeon(yield* connect("unsure"));
        const first = connected.display.key.id;
        double.fault(PidgeonDouble.route("POST", /\/rotate$/), { kind: "late" });
        const unknown = yield* store.renew(identity(connected)).pipe(Effect.flip);
        assert.deepInclude(unknown, {
          _tag: "PidgeonRotationUnknown",
          stopsBy: new Date(start + DEADLINE_MS + GRACE_MS).toISOString()
        });
        const recorded = pidgeon(yield* store.get(who.companyId, connected.id));
        assert.deepInclude(recorded.display.rotation, { outcome: "unknown" });
        // Rotating again could undo the first, which may still complete: refused, with nothing sent.
        assert.instanceOf(
          yield* store.renew(identity(connected)).pipe(Effect.flip),
          Keys.RotationUnknown
        );
        assert.strictEqual(posts(double.requests, /\/rotate$/), 1);
        const replaced = pidgeon(yield* replace(recorded));
        assert.notStrictEqual(replaced.display.key.id, first);
        assert.isUndefined(replaced.display.rotation);
        // The first rotation lands late, on a key already revoked: the connection keeps working.
        double.late(yield* Clock.currentTimeMillis);
        yield* store.test(identity(connected));
        assert.deepStrictEqual(
          PidgeonDouble.liveKeys(double.fake).map((key) => key.id),
          [replaced.display.key.id]
        );
      })
  );

  it.effect("treats Pidgeon's key-management 429 as changing nothing", () =>
    Effect.gen(function* () {
      const { double, store, connect } = yield* setup();
      const connected = yield* connect("limited");
      const before = yield* stored(store, connected);
      double.fake.limitKeys(yield* Clock.currentTimeMillis);
      const limited = yield* store.renew(identity(connected)).pipe(Effect.flip);
      assert.deepInclude(limited, { _tag: "PidgeonRateLimited", limit: "requests" });
      assert.include(limited.message, "Try again in a few minutes");
      const after = pidgeon(yield* store.get(who.companyId, connected.id));
      assert.isUndefined(after.display.rotation);
      assert.strictEqual((yield* stored(store, after)).key.token, before.key.token);
      yield* TestClock.adjust("10 minutes");
      yield* store.renew(identity(connected));
    })
  );

  it.effect("can't rotate a revoked key, and Replace key makes a working one", () =>
    Effect.gen(function* () {
      const { double, store, connect, replace } = yield* setup();
      const connected = pidgeon(yield* connect("revoked"));
      double.fake.revokeKey(connected.display.key.id, yield* Clock.currentTimeMillis);
      assert.instanceOf(
        yield* store.renew(identity(connected)).pipe(Effect.flip),
        Keys.StoredKeyRejected
      );
      assert.instanceOf(
        yield* store.test(identity(connected)).pipe(Effect.flip),
        Keys.StoredKeyRejected
      );
      const replaced = pidgeon(yield* replace(connected));
      // The old key's revoke answered 401, which counts as done: nothing is left to name.
      assert.isUndefined(replaced.display.retired);
      yield* store.test(identity(connected));
    })
  );

  it.effect("changes access with a new key and a fresh snapshot, then revokes the old key", () =>
    Effect.gen(function* () {
      const { double, store, connect, replace } = yield* setup();
      const connected = pidgeon(yield* connect("access"));
      const changed = pidgeon(yield* replace(connected, "read"));
      assert.strictEqual(changed.display.access, "read");
      assert.strictEqual(changed.metadataRevision, 2);
      const metadata = yield* store.snapshot(who.companyId, connected.id, 2);
      assert.deepInclude(metadata.integration === "pidgeon" ? metadata.snapshot : {}, {
        access: "read"
      });
      const live = PidgeonDouble.liveKeys(double.fake);
      assert.deepStrictEqual(
        live.map((key) => [key.id, key.access]),
        [[changed.display.key.id, "read"]]
      );
      assert.notStrictEqual(changed.display.key.id, connected.display.key.id);
    })
  );

  it.effect("leaves the connection as it was when Replace key fails before the save", () =>
    Effect.gen(function* () {
      const { double, store, connect, replace } = yield* setup();
      const connected = pidgeon(yield* connect("replace-fails"));
      double.fault(PidgeonDouble.route("GET", "/labels"), {
        kind: "answer",
        answer: {
          status: 503,
          headers: {},
          body: { error: { code: "unavailable", message: "Not now." } }
        }
      });
      yield* replace(connected, "read").pipe(Effect.flip);
      const kept = pidgeon(yield* store.get(who.companyId, connected.id));
      assert.deepStrictEqual(kept.display, connected.display);
      assert.strictEqual(kept.metadataRevision, 1);
      assert.deepStrictEqual(
        PidgeonDouble.liveKeys(double.fake).map((key) => key.id),
        [connected.display.key.id]
      );
    })
  );

  it.effect(
    "names an old key that couldn't revoke after the save, until a later try revokes it",
    () =>
      Effect.gen(function* () {
        const { double, store, connect, replace } = yield* setup();
        const connected = pidgeon(yield* connect("leftover"));
        double.fault(PidgeonDouble.route("DELETE", `/api-keys/${connected.display.key.id}`), {
          kind: "fail"
        });
        const replaced = pidgeon(yield* replace(connected));
        assert.deepStrictEqual(replaced.display.retired, [
          { id: connected.display.key.id, name: connected.display.key.name }
        ]);
        assert.strictEqual(PidgeonDouble.liveKeys(double.fake).length, 2);
        const tested = pidgeon(yield* store.test(identity(connected)));
        assert.isUndefined(tested.display.retired);
        assert.deepStrictEqual(
          PidgeonDouble.liveKeys(double.fake).map((key) => key.id),
          [replaced.display.key.id]
        );
      })
  );

  it.effect(
    "keeps the old key retired when Replace key's COMMIT answer is lost, until it's revoked",
    () =>
      Effect.gen(function* () {
        const { double, connect } = yield* setup();
        const { store, armed } = yield* losingCommits(double);
        const connected = pidgeon(yield* connect("ack-lost"));
        armed.next = { kind: "lose" };
        const unknown = yield* store
          .rotate({
            ...who,
            id: connected.id,
            credentials: PidgeonDouble.replaceRequest(
              "read",
              PidgeonDouble.ADMIN_KEY,
              "ackattempt01"
            )
          })
          .pipe(Effect.flip);
        assert.strictEqual(unknown._tag, "PidgeonSaveUnknown");
        // The save landed with the old key retired beside the new one, so it's tracked and named.
        const saved = pidgeon(yield* store.get(who.companyId, connected.id));
        assert.strictEqual(saved.display.access, "read");
        assert.deepStrictEqual(saved.display.retired, [
          { id: connected.display.key.id, name: connected.display.key.name }
        ]);
        assert.isNull(keyOf(double.fake, connected.display.key.id).revoked_at);
        const tested = pidgeon(yield* store.test(identity(connected)));
        assert.isUndefined(tested.display.retired);
        assert.isNotNull(keyOf(double.fake, connected.display.key.id).revoked_at);
        assert.isNull(keyOf(double.fake, saved.display.key.id).revoked_at);
      })
  );

  it.effect("says when the address is gone from Pidgeon, which Replace key can't bring back", () =>
    Effect.gen(function* () {
      const { double, store, connect, replace } = yield* setup();
      const connected = yield* connect("gone");
      double.fake.deleteAddress("help@acme.example");
      assert.deepInclude(yield* store.test(identity(connected)).pipe(Effect.flip), {
        _tag: "PidgeonAddressGone",
        email: "help@acme.example"
      });
      assert.instanceOf(yield* replace(connected).pipe(Effect.flip), Keys.AddressNotFound);
      assert.instanceOf(
        yield* store
          .retarget({ ...identity(connected), credentials: PidgeonDouble.replaceRequest() })
          .pipe(Effect.flip),
        ConnectionStore.ConnectionRetargetUnavailable
      );
    })
  );

  it.effect(
    "refuses to delete a declared connection, leaving its key; deleting an unused one revokes it",
    () =>
      Effect.gen(function* () {
        const { double, store, help, connect } = yield* setup();
        const sql = yield* SqlClient.SqlClient;
        const declared = pidgeon(yield* connect("declared"));
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
          yield* store.delete(identity(declared)).pipe(Effect.flip),
          ConnectionStore.ConnectionInUse
        );
        assert.strictEqual(
          yield* works(double.fake, (yield* stored(store, declared)).key.token),
          200
        );
        const unused = pidgeon(yield* connect("unused", undefined, { attempt: "attempt00003" }));
        const deleted = yield* store.delete(identity(unused));
        assert.deepStrictEqual(deleted.keyLeft, null);
        assert.isTrue(
          double.fake.keys(0).find((key) => key.id === unused.display.key.id)!.revoked_at !== null
        );
        // The address and its mail stay in Pidgeon.
        assert.isFalse(double.fake.address("help@acme.example")!.deleted);
        assert.strictEqual(help.id, double.fake.address("help@acme.example")!.id);
        // A key that won't revoke is named in the answer.
        const stubborn = pidgeon(
          yield* connect("stubborn", undefined, { attempt: "attempt00004" })
        );
        double.fault(PidgeonDouble.route("DELETE", /^\/api-keys\//), { kind: "fail" });
        assert.strictEqual(
          (yield* store.delete(identity(stubborn))).keyLeft,
          stubborn.display.key.name
        );
      })
  );

  it.effect(
    "revokes a deleted connection's key when Delete's request is interrupted or its COMMIT answer lost",
    () =>
      Effect.gen(function* () {
        const { double, store, connect } = yield* setup();
        const connected = pidgeon(yield* connect("interrupted"));
        const revoking = yield* Deferred.make<void>();
        const revoke = PidgeonDouble.route("DELETE", `/api-keys/${connected.display.key.id}`);
        double.fault(revoke, { kind: "hold", release: revoking });
        const deleting = yield* store.delete(identity(connected)).pipe(Effect.forkChild);
        yield* eventually(() => double.requests.some(revoke));
        yield* Fiber.interrupt(deleting);
        yield* Deferred.succeed(revoking, undefined);
        yield* eventually(() => keyOf(double.fake, connected.display.key.id).revoked_at !== null);
        assert.deepStrictEqual(
          (yield* store.list(who.companyId)).filter((item) => item.handle === "interrupted"),
          []
        );
        // The row went though COMMIT's answer was lost: its key revokes itself all the same.
        const { store: lossy, armed } = yield* losingCommits(double);
        const lost = pidgeon(yield* connect("delete-ack-lost"));
        armed.next = { kind: "lose" };
        const deleted = yield* lossy.delete(identity(lost));
        assert.isNull(deleted.keyLeft);
        assert.isNotNull(keyOf(double.fake, lost.display.key.id).revoked_at);
      })
  );

  it.effect("reports a deletion once, from the delete whose own COMMIT answered", () =>
    Effect.gen(function* () {
      const { double, store, connect } = yield* setup();
      const { store: failing, armed } = yield* losingCommits(double);
      const connected = pidgeon(yield* connect("raced"));
      const reports: Array<string> = [];
      const by = (admin: string) => () => Effect.sync(() => void reports.push(admin));
      // A's DELETE rolls back at COMMIT; B deletes it and reports before A hears back.
      armed.next = {
        kind: "fail",
        meanwhile: store.delete(identity(connected), by("B"))
      };
      const deleted = yield* failing.delete(identity(connected), by("A"));
      // A finds the row gone and its keys revoke themselves, but it can't tell it removed the row.
      assert.isNull(deleted.keyLeft);
      assert.deepStrictEqual(reports, ["B"]);
      assert.isNotNull(keyOf(double.fake, connected.display.key.id).revoked_at);
      assert.deepStrictEqual(
        (yield* store.list(who.companyId)).filter((item) => item.handle === "raced"),
        []
      );
    })
  );

  it.effect("keeps the key across disconnect, so reconnect needs no admin key", () =>
    Effect.gen(function* () {
      const { double, store, connect } = yield* setup();
      const connected = pidgeon(yield* connect("pause"));
      yield* store.disconnect(identity(connected));
      const back = yield* store.reconnect(identity(connected));
      assert.strictEqual(back.status, "connected");
      yield* store.disconnect(identity(connected));
      double.fake.revokeKey(connected.display.key.id, 0);
      assert.instanceOf(
        yield* store.reconnect(identity(connected)).pipe(Effect.flip),
        Keys.StoredKeyRejected
      );
    })
  );

  it.effect("refreshes the labels into a new snapshot with the stored key", () =>
    Effect.gen(function* () {
      const { double, store, help, connect } = yield* setup();
      const connected = yield* connect("refresh");
      double.fake.state().labels.push({
        id: "label-new",
        identityId: help.id,
        name: "Returns",
        colour: "pink",
        createdAt: 0
      });
      const refreshed = yield* store.refresh(identity(connected));
      assert.strictEqual(refreshed.metadataRevision, 2);
      const metadata = yield* store.snapshot(who.companyId, connected.id, 2);
      assert.deepStrictEqual(
        metadata.integration === "pidgeon"
          ? metadata.snapshot.labels.map((label) => label.name)
          : [],
        ["Billing", "Bugs", "Returns"]
      );
    })
  );

  it.effect(
    "admits four calls per address, refuses the next busy, and sends a waiting one as things stand",
    () =>
      Effect.gen(function* () {
        const { double, store, connect } = yield* setup();
        const connected = pidgeon(yield* connect("busy"));
        const source = yield* Source.Source.pipe(Effect.provide(double.layer));
        const release = yield* Deferred.make<void>();
        const threads = PidgeonDouble.route("GET", "/threads");
        const slots = registry["pidgeon.calls.concurrent"].default;
        double.fault(threads, { kind: "hold", release }, slots);
        const call = (deadline: number) =>
          Calls.send(
            { companyId: who.companyId, connection: connected, deadline, recheck: Effect.void },
            (credentials) => ({
              method: "GET",
              path: "/threads",
              query: { identity_id: credentials.identityId }
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
        const sent = () => double.requests.filter(threads).length;
        // Each call reloads its key from Postgres first, so wait on the real clock.
        yield* eventually(() => sent() === slots);
        const busy = yield* call(now + 2_000);
        yield* TestClock.adjust("1 second");
        assert.instanceOf(yield* Fiber.join(busy).pipe(Effect.flip), Source.Busy);
        // A call that waits through a rotation sends the secret stored when it goes.
        const rotated = yield* call(now + 60_000);
        const renewed = yield* store.renew(identity(connected));
        const token = (yield* stored(store, renewed)).key.token;
        // A call that waits while the connection is disconnected sends nothing.
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(running, Fiber.join);
        yield* Fiber.join(rotated);
        const last = double.requests.filter(threads).at(-1)!;
        assert.strictEqual(last.authorization, `Bearer ${token}`);
        // A call that waits while the connection is disconnected sends nothing.
        const held = yield* Deferred.make<void>();
        double.fault(threads, { kind: "hold", release: held }, slots);
        const filling = yield* Effect.forEach(Array.from({ length: slots }), () =>
          call(now + 60_000)
        );
        yield* eventually(() => sent() === 2 * slots + 1);
        const waiting = yield* call(now + 60_000);
        yield* store.disconnect(identity(connected));
        yield* Deferred.succeed(held, undefined);
        yield* Effect.forEach(filling, Fiber.join);
        assert.instanceOf(
          yield* Fiber.join(waiting).pipe(Effect.flip),
          ConnectionStore.ConnectionNotConnected
        );
        assert.strictEqual(sent(), 2 * slots + 1);
      })
  );

  it.effect("never lets the admin key into a stored row, a log line or a refusal", () =>
    Effect.gen(function* () {
      const SENTINEL = "pgn_live_SENTINELadminKey00000000";
      const { double, store, connect } = yield* setup();
      double.fake.addKey({ token: SENTINEL, access: "admin", reach: "all", at: 0 });
      const logs: string[] = [];
      const logged = Logger.layer([
        Logger.make((event) => logs.push(JSON.stringify(event.message)))
      ]);
      const connected = yield* connect("sentinel", undefined, { adminKey: SENTINEL }).pipe(
        Effect.provide(logged)
      );
      const refusals = yield* Effect.all([
        connect("sentinel", undefined, { adminKey: SENTINEL, attempt: "attempt00005" }).pipe(
          Effect.flip
        ),
        store
          .rotate({
            ...identity(connected),
            credentials: PidgeonDouble.replaceRequest("read", SENTINEL)
          })
          .pipe(
            Effect.as(null),
            Effect.catch((error) => Effect.succeed(error))
          )
      ]).pipe(Effect.provide(logged));
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly row: string }>`SELECT row_to_json(t)::text AS row FROM (
          SELECT * FROM connections WHERE company_id = ${who.companyId}) t
        UNION ALL SELECT row_to_json(s)::text FROM connection_snapshots s WHERE company_id = ${who.companyId}
        UNION ALL SELECT row_to_json(c)::text FROM runtime_calls c WHERE company_id = ${who.companyId}`;
      const credentials = yield* stored(store, connected);
      const everything = [
        ...rows.map((row) => row.row),
        ...logs,
        JSON.stringify(credentials),
        ...refusals.map((error) =>
          error === null ? "" : `${error.message} ${JSON.stringify(error)}`
        )
      ].join("\n");
      assert.notInclude(everything, SENTINEL);
      assert.notInclude(everything, SENTINEL.slice(9));
      assert.isAbove(rows.length, 2);
    })
  );

  it.effect("stays hidden from the release before Pidgeon, which still lists the rest", () =>
    Effect.gen(function* () {
      const { double, connect } = yield* setup();
      const connected = yield* connect("hidden");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
        VALUES ('pat_pidgeon_hidden', ${who.companyId}, ${who.userId}, 'Hidden', 'desk-hidden')`;
      yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key, content_hash,
        file_size, created_by_machine_token_id, owner_user_id, tier, release, manifest_version,
        wire_version, schema_revision, manifest, publish_key, payload_digest, publish_response,
        publish_status)
        VALUES ('ver_pidgeon_hidden', 'pat_pidgeon_hidden', 1, 'hidden.html', 'test', 1, ${DEV_SEED.tokenId},
          ${who.userId}, 1, 'test', 1, 1, 0,
          ${JSON.stringify({ uses: { desk: { kind: "pidgeon", handle: "hidden", id: connected.id, revision: 1 } } })}::jsonb,
          'pidgeon-hidden', 'test', '{}'::jsonb, 201)`;
      // That release's queries: the same store, knowing only the integrations it shipped.
      const before = yield* SqlConnectionStore.knowing(["postgres", "posthog"]).pipe(
        Effect.provide(double.layer)
      );
      assert.notInclude(
        (yield* before.list(who.companyId)).map((item) => item.id),
        connected.id
      );
      assert.isFalse((yield* before.usage(who.companyId)).has(connected.id));
      const declaration = {
        kind: "pidgeon" as const,
        handle: "hidden",
        id: connected.id,
        revision: 1
      };
      const refusals = yield* Effect.all([
        Effect.flip(before.get(who.companyId, connected.id)),
        Effect.flip(before.snapshot(who.companyId, connected.id, 1)),
        Effect.flip(before.resolve(who.companyId, declaration)),
        Effect.flip(before.poolCredentials(who.companyId, declaration, 1)),
        Effect.flip(before.disconnect(identity(connected)))
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
