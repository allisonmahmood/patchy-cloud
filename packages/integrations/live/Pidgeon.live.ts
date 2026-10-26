// First: the harness keeps Node's own fetch before the pages' offline Clerk fixture replaces it.
import * as Live from "./harness.js";
import { assert, describe, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ConnectionStore from "../src/ConnectionStore.js";
import * as Calls from "../src/pidgeon/Calls.js";
import * as Keys from "../src/pidgeon/Keys.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
import { losingCommits } from "../src/test/commits.js";
import {
  connectPath,
  createCompany,
  follow,
  post,
  read,
  send,
  services as pageServices
} from "../src/test/pages.js";

/**
 * Pidgeon connections against Pidgeon itself, in test mode: what Patchy asks of Pidgeon and what
 * Pidgeon answers, failures included through `Pidgeon-Test-Fail`. Every address it makes is a
 * test address of its own, and every key it mints carries the run's tag; both go when it ends.
 * It asserts only on what it made, and never on a list Pidgeon returned.
 *
 *   node --env-file=$HOME/.config/patchy-cloud/pidgeon-test.env node_modules/vitest/vitest.mjs \
 *     run --config vitest.pidgeon-live.config.ts
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const handle = (name: string) => `${Live.RUN}-${name}`;
const attempt = () => Keys.newAttempt();

/** The connections pages and store over Pidgeon; when the suite ends, everything the run made goes. */
const services = pageServices(Live.layer).pipe(
  Layer.merge(
    Layer.effectDiscard(Effect.addFinalizer(() => Live.cleanup)).pipe(Layer.provide(Live.layer))
  )
);
/** What `/me` says about a key, as far as these tests look. */
const decodeMe = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      key: Schema.Struct({
        access: Schema.String,
        test: Schema.Boolean,
        reaches_all_addresses: Schema.Boolean
      }),
      reaches: Schema.Int
    })
  })
);
const decodeMinted = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Struct({ token: Schema.String }) })
);

type Pidgeon = Extract<ConnectionStore.Connection, { readonly integration: "pidgeon" }>;
const pidgeon = (connection: ConnectionStore.Connection): Pidgeon => {
  if (connection.integration !== "pidgeon") return assert.fail("A Pidgeon connection");
  return connection;
};
/** The key a connection stores now, as a call loads it. */
const stored = (store: ConnectionStore.ConnectionStore["Service"], connection: Pidgeon) =>
  Calls.connect(who.companyId, connection).pipe(
    Effect.provideService(ConnectionStore.ConnectionStore, store)
  );
/** Whether Pidgeon still takes this secret: its own `/me`. */
const works = (token: string) =>
  Live.call(Redacted.make(token), { method: "GET", path: "/me" }).pipe(
    Effect.as(true),
    Effect.catchTag("PidgeonKeyRejected", () => Effect.succeed(false))
  );
const writes = (request: Live.Sent) =>
  request.method === "POST" && (request.path === "/api-keys" || request.path === "/identities");

/** What one run carries from a test to the next. */
const made: { address?: string; a?: Pidgeon; b?: Pidgeon; c?: Pidgeon } = {};

describe.skipIf(Live.ADMIN_KEY === undefined)("Pidgeon, live in test mode", () => {
  it.layer(services, { timeout: "300 seconds", excludeTestServices: true })(
    "connections and their pages",
    (it) => {
      it.effect(
        "connects a new test address at send through a lost answer, keeping one key for it alone",
        () =>
          Effect.gen(function* () {
            const store = yield* SqlConnectionStore.make;
            const localPart = `patchy-${Live.RUN}-a`;
            const logs: string[] = [];
            // Pidgeon makes the address and its answer is lost; the same Idempotency-Key gets it.
            Live.fail(Live.route("POST", "/identities"), "drop");
            const before = {
              identities: Live.count(Live.route("POST", "/identities")),
              keys: Live.minted.size
            };
            const connected = pidgeon(
              yield* store
                .connect({
                  integration: "pidgeon",
                  ...who,
                  handle: handle("support"),
                  description: "Live test address, deleted when the run ends",
                  credentials: Keys.connectSecret({
                    adminKey: Redacted.value(Live.admin()),
                    attempt: attempt(),
                    access: "send",
                    address: {
                      create: {
                        localPart,
                        domain: Keys.SHARED_DOMAIN,
                        displayName: "Patchy live test",
                        sendPolicy: "reply_only"
                      }
                    }
                  })
                })
                .pipe(
                  Effect.provide(
                    Logger.layer([Logger.make((event) => logs.push(JSON.stringify(event.message)))])
                  )
                )
            );
            made.a = connected;
            made.address = connected.display.identityId;
            assert.strictEqual(connected.display.email, `${localPart}@${Keys.SHARED_DOMAIN}`);
            assert.strictEqual(connected.display.sendPolicy, "reply_only");
            assert.isTrue(connected.display.test);
            assert.strictEqual(
              Live.count(Live.route("POST", "/identities")) - before.identities,
              2
            );
            assert.isTrue(Live.created.has(connected.display.identityId));
            const metadata = yield* store.snapshot(who.companyId, connected.id, 1);
            if (metadata.integration !== "pidgeon") return assert.fail("A Pidgeon snapshot");
            assert.isTrue(metadata.snapshot.test);
            assert.strictEqual(metadata.snapshot.access, "send");
            // In Pidgeon, the one new key is the saved one: this address alone, at send, in test mode.
            assert.strictEqual(Live.minted.size - before.keys, 1);
            assert.isTrue(Live.minted.has(connected.display.key.id));
            assert.match(
              connected.display.key.name,
              new RegExp(`^Patchy ${handle("support")} [a-z0-9]{12}$`)
            );
            const key = yield* stored(store, connected);
            const me = yield* Live.call(Redacted.make(key.key.token), {
              method: "GET",
              path: "/me"
            });
            const found = decodeMe(me.body);
            assert.deepStrictEqual(
              [
                found.data.key.access,
                found.data.key.test,
                found.data.key.reaches_all_addresses,
                found.data.reaches
              ],
              ["send", true, false, 1]
            );
            // The admin key went in that request alone: never a stored row, a log line or a refusal.
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{
              readonly row: string;
            }>`SELECT row_to_json(t)::text AS row FROM (
              SELECT * FROM connections WHERE company_id = ${who.companyId}) t
            UNION ALL SELECT row_to_json(s)::text FROM connection_snapshots s WHERE company_id = ${who.companyId}
            UNION ALL SELECT row_to_json(c)::text FROM runtime_calls c WHERE company_id = ${who.companyId}`;
            const everything = [...rows.map((row) => row.row), ...logs, JSON.stringify(key)].join(
              "\n"
            );
            assert.isAbove(rows.length, 2);
            assert.isFalse(
              everything.includes(Redacted.value(Live.admin())),
              "The admin key reached a stored row or a log line."
            );
          })
      );

      it.effect(
        "refuses a key that isn't an admin key over the whole account, creating nothing",
        () =>
          Effect.gen(function* () {
            const store = yield* SqlConnectionStore.make;
            const address = made.address ?? assert.fail("The address from the first test");
            const addressKey = (yield* stored(store, made.a ?? assert.fail("The first connection")))
              .key.token;
            // An admin key over one address only, which the cleanup revokes with the rest.
            const partial = yield* Live.call(Live.admin(), {
              method: "POST",
              path: "/api-keys",
              body: {
                name: `Patchy ${Live.RUN} partial`,
                identity_ids: [address],
                access: "admin"
              },
              idempotencyKey: `${Live.RUN}-partial`
            });
            const partialToken = decodeMinted(partial.body).data.token;
            const before = Live.count(writes);
            for (const [adminKey, refusal] of [
              [addressKey, "PidgeonNotAdminKey"],
              [partialToken, "PidgeonPartialAdminKey"]
            ] as const) {
              const error = yield* store
                .connect({
                  integration: "pidgeon",
                  ...who,
                  handle: handle("refused"),
                  description: "",
                  credentials: Keys.connectSecret({
                    adminKey,
                    attempt: attempt(),
                    access: "read",
                    address: { id: address }
                  })
                })
                .pipe(Effect.flip);
              assert.strictEqual(error._tag, refusal);
              assert.isFalse(
                error.message.includes(adminKey),
                "A refusal echoed the key it refused."
              );
            }
            assert.strictEqual(Live.count(writes), before);
          })
      );

      it.effect(
        "recovers a lost mint by revoking the key it can't read, while another submission keeps its own",
        () =>
          Effect.gen(function* () {
            const store = yield* SqlConnectionStore.make;
            const address = made.address ?? assert.fail("The address from the first test");
            const shared = attempt();
            const connect = (name: string) =>
              store
                .connect({
                  integration: "pidgeon",
                  ...who,
                  handle: handle(name),
                  description: "",
                  credentials: Keys.connectSecret({
                    adminKey: Redacted.value(Live.admin()),
                    attempt: shared,
                    access: "read",
                    address: { id: address }
                  })
                })
                .pipe(Effect.map(pidgeon));
            // Pidgeon mints b's key and its answer is lost: the replay names it without a secret.
            Live.fail(
              (request) =>
                request.method === "POST" &&
                request.path === "/api-keys" &&
                request.body.includes(handle("b")),
              "drop"
            );
            const keysBefore = new Set(Live.minted);
            const [b, c] = yield* Effect.all([connect("b"), connect("c")], { concurrency: 2 });
            made.b = b;
            made.c = c;
            const newKeys = [...Live.minted].filter((id) => !keysBefore.has(id));
            // b's lost key, b's fresh one and c's: the lost one is revoked, the saved ones work.
            assert.strictEqual(newKeys.length, 3);
            const lost = newKeys.find((id) => id !== b.display.key.id && id !== c.display.key.id);
            assert.isDefined(lost);
            assert.strictEqual(Live.count(Live.route("DELETE", `/api-keys/${lost}`)), 1);
            for (const connection of [b, c])
              assert.isTrue(yield* works((yield* stored(store, connection)).key.token));
          })
      );

      it.effect(
        "changes access with a new key; an old key that won't revoke stays named until Test connection",
        () =>
          Effect.gen(function* () {
            const store = yield* SqlConnectionStore.make;
            const a = made.a ?? assert.fail("The connection from the first test");
            const old = yield* stored(store, a);
            // The old key's revoke is refused, every try, and nothing is done.
            Live.fail(Live.route("DELETE", `/api-keys/${old.key.id}`), "503", 3);
            const changed = pidgeon(
              yield* store.rotate({
                ...who,
                id: a.id,
                credentials: Keys.replaceSecret({
                  adminKey: Redacted.value(Live.admin()),
                  attempt: attempt(),
                  access: "read"
                })
              })
            );
            assert.strictEqual(changed.display.access, "read");
            assert.deepStrictEqual(changed.display.retired, [
              { id: old.key.id, name: a.display.key.name }
            ]);
            assert.isTrue(yield* works(old.key.token));
            const tested = pidgeon(yield* store.test({ ...who, id: a.id }));
            assert.isUndefined(tested.display.retired);
            assert.isFalse(yield* works(old.key.token));
            made.a = tested;
          })
      );

      it.effect("keeps the old key retired when Replace key's COMMIT answer is lost", () =>
        Effect.gen(function* () {
          const { store, armed } = yield* losingCommits(Live.layer);
          const c = made.c ?? assert.fail("The connection from the third test");
          const old = yield* stored(store, c);
          armed.next = { kind: "lose" };
          const unknown = yield* store
            .rotate({
              ...who,
              id: c.id,
              credentials: Keys.replaceSecret({
                adminKey: Redacted.value(Live.admin()),
                attempt: attempt(),
                access: "read"
              })
            })
            .pipe(Effect.flip);
          assert.strictEqual(unknown._tag, "PidgeonSaveUnknown");
          const saved = pidgeon(yield* store.get(who.companyId, c.id));
          assert.deepStrictEqual(saved.display.retired, [
            { id: old.key.id, name: c.display.key.name }
          ]);
          assert.isTrue(yield* works(old.key.token));
          assert.isUndefined(pidgeon(yield* store.test({ ...who, id: c.id })).display.retired);
          assert.isFalse(yield* works(old.key.token));
          made.c = saved;
        })
      );

      it.effect(
        "keeps a declared connection's key, revokes a deleted one's, and says when the address is gone",
        () =>
          Effect.gen(function* () {
            const store = yield* SqlConnectionStore.make;
            const a = made.a ?? assert.fail("The connection from the first test");
            const b = made.b ?? assert.fail("The connection from the third test");
            const c = made.c ?? assert.fail("The connection from the third test");
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
            VALUES (${`pat_${Live.RUN}`}, ${who.companyId}, ${who.userId}, 'Desk', ${`desk-${Live.RUN}`})`;
            yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key, content_hash,
            file_size, created_by_machine_token_id, owner_user_id, tier, release, manifest_version,
            wire_version, schema_revision, manifest, publish_key, payload_digest, publish_response,
            publish_status)
            VALUES (${`ver_${Live.RUN}`}, ${`pat_${Live.RUN}`}, 1, 'desk.html', 'test', 1, ${DEV_SEED.tokenId},
              ${who.userId}, 1, 'test', 1, 1, 0,
              ${JSON.stringify({ uses: { desk: { kind: "pidgeon", handle: b.handle, id: b.id, revision: 1 } } })}::jsonb,
              ${`key-${Live.RUN}`}, 'test', '{}'::jsonb, 201)`;
            assert.instanceOf(
              yield* store.delete({ ...who, id: b.id }).pipe(Effect.flip),
              ConnectionStore.ConnectionInUse
            );
            assert.isTrue(yield* works((yield* stored(store, b)).key.token));
            const cKey = (yield* stored(store, c)).key.token;
            const deleted = yield* store.delete({ ...who, id: c.id });
            assert.isNull(deleted.keyLeft);
            assert.isFalse(yield* works(cKey));
            // The address and its mail stay in Pidgeon.
            yield* Live.call(Live.admin(), {
              method: "GET",
              path: `/identities/${a.display.identityId}`
            });
            // Disconnect and reconnect keep the key; Refresh labels takes a new snapshot with it.
            yield* store.disconnect({ ...who, id: a.id });
            assert.strictEqual((yield* store.reconnect({ ...who, id: a.id })).status, "connected");
            const refreshed = yield* store.refresh({ ...who, id: a.id });
            assert.strictEqual(refreshed.metadataRevision, a.metadataRevision + 1);
            // Pidgeon deletes a test address a day after it's made; then Test connection says so.
            yield* Live.call(Live.admin(), {
              method: "DELETE",
              path: `/identities/${a.display.identityId}`,
              idempotencyKey: `${Live.RUN}-gone`
            });
            Live.created.delete(a.display.identityId);
            assert.strictEqual(
              (yield* store.test({ ...who, id: a.id }).pipe(Effect.flip))._tag,
              "PidgeonAddressGone"
            );
          })
      );

      it.effect("connects through the pages with a test key, never showing the key back", () =>
        Effect.gen(function* () {
          const owner = yield* createCompany(`pidgeon-${Live.RUN}`);
          const key = Redacted.value(Live.admin());
          const found = yield* send(
            "/company/connections/connect/pidgeon/addresses",
            post(owner.user, { key })
          );
          assert.strictEqual(found.status, 200);
          const fragment = yield* Effect.promise(() => found.text());
          assert.isTrue(
            fragment.includes("data-pidgeon-key-status>Test · "),
            "Find addresses names a test key."
          );
          assert.isFalse(fragment.includes(key), "Find addresses answered with the key.");
          const localPart = `patchy-${Live.RUN}-p`;
          const connected = yield* follow(
            yield* send(
              connectPath,
              post(owner.user, {
                attempt: attempt(),
                key,
                access: "send",
                handle: handle("page"),
                description: "Live page test",
                address: "new",
                local_part: localPart,
                domain: Keys.SHARED_DOMAIN,
                display_name: "Patchy live page",
                send_policy: "reply_only"
              })
            ),
            owner.user
          );
          assert.include(connected.html, `<span class="tag">Test · mail stays in Pidgeon</span>`);
          assert.include(
            connected.html,
            `<dt>Address</dt><dd>${localPart}@${Keys.SHARED_DOMAIN}</dd>`
          );
          assert.isFalse(connected.html.includes(key), "The connection page showed the key.");
          const index = yield* read("/company/connections", owner.user);
          assert.include(index.html, `<span class="tag">Test · mail stays in Pidgeon</span>`);
          const id = /\/company\/connections\/(conn_[a-z0-9]+)/.exec(connected.html)?.[1];
          assert.isDefined(id);
          const deleted = yield* follow(
            yield* send(`/company/connections/${id}/delete`, post(owner.user)),
            owner.user
          );
          assert.include(deleted.html, "Connection deleted, and its key revoked in Pidgeon.");
        })
      );
    }
  );
});
