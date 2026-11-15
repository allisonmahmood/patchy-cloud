// First: the harness keeps Node's own fetch before the pages' offline Clerk fixture replaces it.
import { Teams } from "@patchy/companies";
import * as Live from "./pidgeonHarness.js";
import { assert, describe, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { NodeCryptography } from "@patchy/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ConnectionStore from "../src/ConnectionStore.js";
import * as Calls from "../src/pidgeon/Calls.js";
import * as Keys from "../src/pidgeon/Keys.js";
import * as Page from "../src/pidgeon/Page.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";
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
 * Pidgeon connections against Pidgeon itself, in test mode: a key pasted as an admin pastes one
 * from Pidgeon's dashboard, what Patchy asks of Pidgeon to check it, which changes nothing there,
 * and the inbox Patchy keeps it with. Every inbox it connects is one the run made, named with its
 * tag; it asserts only on what it made, and never on a list Pidgeon returned.
 *
 *   node --env-file=$HOME/.config/patchy-cloud/pidgeon-test.env node_modules/vitest/vitest.mjs \
 *     run --config vitest.pidgeon-live.config.ts
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const handle = (name: string) => `${Live.RUN}-${name}`;

/**
 * The connections pages and store over Pidgeon. Before the tests, stale leftovers of any run go;
 * after them, everything this run made, however it ended.
 */
const services = pageServices(Live.layer).pipe(
  Layer.merge(
    Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Live.requireTestKey;
        const before = yield* Live.sweep(true);
        yield* Effect.addFinalizer(() =>
          Live.sweep(false).pipe(
            Effect.flatMap((after) => Effect.sync(() => Live.summary({ before, after })))
          )
        );
      })
    ).pipe(Layer.provide(Live.sweepLayer))
  ),
  Layer.provideMerge(NodeCryptography.layer)
);

type Pidgeon = Extract<ConnectionStore.Connection, { readonly integration: "pidgeon" }>;
const pidgeon = (connection: ConnectionStore.Connection): Pidgeon => {
  if (connection.integration !== "pidgeon") return assert.fail("A Pidgeon connection");
  return connection;
};
/** Requests that could change something in Pidgeon, leaving out the level checks' own. */
const changes = () =>
  Live.sent.filter(
    (sent) =>
      sent.method !== "GET" &&
      sent.path !== "/email/drafts/00000000-0000-0000-0000-000000000000/send" &&
      !(sent.method === "POST" && sent.path === "/email/inboxes")
  ).length;

/** What one run carries from a test to the next. */
const made: { desk?: { readonly id: string; readonly address: string }; connection?: Pidgeon } = {};
const need = <A>(value: A | undefined, what: string): A => value ?? assert.fail(what);

describe.skipIf(Live.ADMIN_KEY === undefined)("Pidgeon, live in test mode", () => {
  it.layer(services, { timeout: "300 seconds", excludeTestServices: true })(
    "connections and their pages",
    (it) => {
      it.effect("lists what a pasted key reaches and may do, changing nothing in Pidgeon", () =>
        Effect.gen(function* () {
          made.desk = yield* Live.inbox("desk", "Lumen Bikes Support");
          yield* Live.inbox("hooks").pipe(Effect.asVoid);
          const before = changes();
          const listed = (key: string) => Keys.inboxes(Redacted.make(key));
          const asAdmin = yield* listed(Redacted.value(Live.admin()));
          assert.include(asAdmin, { test: true, level: "admin" });
          assert.isTrue(
            asAdmin.inboxes.some((inbox) => inbox.id === made.desk?.id),
            "The run's inbox is listed."
          );
          if (Live.SEND_KEY !== undefined)
            assert.include(yield* listed(Live.SEND_KEY), { test: true, level: "send" });
          if (Live.READ_KEY !== undefined)
            assert.include(yield* listed(Live.READ_KEY), { test: true, level: "read" });
          // The checks named things that don't exist: nothing was made, sent or changed.
          assert.strictEqual(changes(), before);
          // A key Pidgeon doesn't know is refused as such.
          assert.strictEqual(
            (yield* listed(`pgn_test_${"0".repeat(32)}`).pipe(Effect.flip))._tag,
            "PidgeonKeyRejected"
          );
        })
      );

      it.effect("connects one inbox at send with a pasted key, and keeps that key for it", () =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make.pipe(
            Effect.provide([Live.layer, Teams.layer])
          );
          const desk = need(made.desk, "The run's inbox");
          const before = changes();
          const connection = pidgeon(
            yield* store.connect({
              integration: "pidgeon",
              ...who,
              handle: handle("desk"),
              description: "Live test inbox, deleted when the run ends",
              credentials: Keys.connectSecret({
                key: Live.sender(),
                inboxId: desk.id,
                access: "send"
              })
            })
          );
          made.connection = connection;
          assert.deepStrictEqual(connection.display, {
            email: desk.address,
            inboxId: desk.id,
            access: "send",
            test: true
          });
          assert.include((yield* store.snapshot(who.companyId, connection.id, 1)).snapshot, {
            version: 2,
            access: "send",
            test: true
          });
          const credentials = yield* Calls.connect(who.companyId, connection).pipe(
            Effect.provideService(ConnectionStore.ConnectionStore, store)
          );
          assert.deepStrictEqual(credentials, { inboxId: desk.id, key: Live.sender() });
          yield* store.test({ ...who, id: connection.id });
          assert.strictEqual(changes(), before);
        })
      );

      it.effect("refuses send with a Read key, and an inbox that only receives events", () =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make.pipe(
            Effect.provide([Live.layer, Teams.layer])
          );
          const desk = need(made.desk, "The run's inbox");
          const connect = (name: string, request: Keys.ConnectRequest) =>
            store
              .connect({
                integration: "pidgeon",
                ...who,
                handle: handle(name),
                description: "Refused",
                credentials: Keys.connectSecret(request)
              })
              .pipe(Effect.flip);
          if (Live.READ_KEY !== undefined)
            assert.strictEqual(
              (yield* connect("reader", { key: Live.READ_KEY, inboxId: desk.id, access: "send" }))
                ._tag,
              "PidgeonCantSend"
            );
          const events = yield* Live.call(Live.admin(), {
            method: "POST",
            path: "/email/inboxes",
            body: { name: `patchy-${Live.RUN}-events`, kind: "events" }
          });
          const eventsId = (events.body as { readonly id: string }).id;
          Live.created.add(eventsId);
          assert.strictEqual(
            (yield* connect("events", { key: Live.sender(), inboxId: eventsId, access: "read" }))
              ._tag,
            "PidgeonNoInbox"
          );
          assert.strictEqual(
            (yield* connect("missing", {
              key: Live.sender(),
              inboxId: "00000000-0000-0000-0000-000000000000",
              access: "read"
            }))._tag,
            "PidgeonInboxNotFound"
          );
        })
      );

      it.effect("replaces the key and changes access, keeping the connection on its inbox", () =>
        Effect.gen(function* () {
          const store = yield* SqlConnectionStore.make.pipe(
            Effect.provide([Live.layer, Teams.layer])
          );
          const connection = need(made.connection, "The connection");
          const replaced = pidgeon(
            yield* store.rotate({
              ...who,
              id: connection.id,
              credentials: Keys.changeSecret({ key: Redacted.value(Live.admin()) })
            })
          );
          assert.strictEqual(replaced.credentialRevision, connection.credentialRevision + 1);
          assert.deepStrictEqual(replaced.display, connection.display);
          const lowered = pidgeon(
            yield* store.rotate({
              ...who,
              id: connection.id,
              credentials: Keys.changeSecret({ access: "read" })
            })
          );
          assert.strictEqual(lowered.display.access, "read");
          if (Live.READ_KEY !== undefined) {
            yield* store.rotate({
              ...who,
              id: connection.id,
              credentials: Keys.changeSecret({ key: Live.READ_KEY })
            });
            assert.strictEqual(
              (yield* store
                .rotate({
                  ...who,
                  id: connection.id,
                  credentials: Keys.changeSecret({ access: "send" })
                })
                .pipe(Effect.flip))._tag,
              "PidgeonStoredCantSend"
            );
          }
          yield* store.rotate({
            ...who,
            id: connection.id,
            credentials: Keys.changeSecret({ key: Live.sender() })
          });
          const raised = pidgeon(
            yield* store.rotate({
              ...who,
              id: connection.id,
              credentials: Keys.changeSecret({ access: "send" })
            })
          );
          assert.strictEqual(raised.display.access, "send");
          yield* store.refresh({ ...who, id: connection.id });
          // Its inbox gone, a Test says so.
          yield* Live.call(Live.admin(), {
            method: "DELETE",
            path: `/email/inboxes/${raised.display.inboxId}`
          });
          assert.strictEqual(
            (yield* store.test({ ...who, id: connection.id }).pipe(Effect.flip))._tag,
            "PidgeonInboxGone"
          );
          yield* store.delete({ ...who, id: connection.id });
        })
      );

      it.effect("connects through the pages with a test key, never showing the key back", () =>
        Effect.gen(function* () {
          const owner = yield* createCompany(`pidgeon-${Live.RUN}`);
          const inbox = yield* Live.inbox("page", "Patchy live page");
          const key = Live.sender();
          const found = yield* send(Page.addressesPath, post(owner.user, { key }));
          assert.strictEqual(found.status, 200);
          const fragment = yield* Effect.promise(() => found.text());
          assert.isTrue(fragment.includes("data-pidgeon-key-status>Test key"));
          assert.isTrue(fragment.includes(inbox.address), "Find inboxes lists the run's inbox.");
          assert.isFalse(fragment.includes(key), "Find inboxes answered with the key.");
          const connected = yield* follow(
            yield* send(
              connectPath,
              post(owner.user, {
                key,
                address: inbox.id,
                access: "send",
                handle: handle("page"),
                description: "Live page test"
              })
            ),
            owner.user
          );
          assert.include(connected.html, Page.copy.tag);
          assert.include(connected.html, `<dt>Inbox</dt><dd>${inbox.address}</dd>`);
          assert.isFalse(connected.html.includes(key), "The connection page showed the key.");
          const index = yield* read("/settings/integrations", owner.user);
          assert.include(index.html, Page.copy.tag);
          const id = /\/settings\/integrations\/(conn_[a-z0-9]+)/.exec(connected.html)?.[1];
          assert.isDefined(id);
          const deleted = yield* follow(
            yield* send(`/settings/integrations/${id}/delete`, post(owner.user)),
            owner.user
          );
          assert.include(deleted.html, Page.copy.results.delete);
        })
      );
    }
  );
});
