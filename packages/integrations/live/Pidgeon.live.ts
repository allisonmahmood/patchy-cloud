import { assert, it } from "@effect/vitest";
import { DEV_SEED } from "@patchy/auth/seed";
import { RuntimeLog } from "@patchy/runtime";
import * as Testing from "@patchy/sql/testing";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../src/ConnectionStore.js";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as PostgresSource from "../src/postgres/Source.js";
import * as PostHogSource from "../src/posthog/Source.js";
import * as Calls from "../src/pidgeon/Calls.js";
import * as Keys from "../src/pidgeon/Keys.js";
import * as Source from "../src/pidgeon/Source.js";
import * as SqlConnectionStore from "../src/SqlConnectionStore.js";

/**
 * The one test against a real Pidgeon account, #823's, which offline CI never runs. It creates
 * one address of its own on the shared domain, connects it, rotates and changes its key, deletes
 * the connection, then deletes the address and revokes anything left with the name it uses. It
 * mints twice and rotates once, well under the account's key-management limit; run it rarely.
 *
 *   node --env-file=$HOME/.config/patchy-cloud/pidgeon.env node_modules/vitest/vitest.mjs \
 *     run --config vitest.pidgeon-live.config.ts
 */

const who = { companyId: DEV_SEED.companyId, userId: DEV_SEED.userId };
const run = Date.now().toString(36);
const handle = `live-${run}`;
const KeyPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      access: Schema.String,
      identity_ids: Schema.Array(Schema.String),
      revoked_at: Schema.NullOr(Schema.String),
      test: Schema.Boolean
    })
  ),
  next_cursor: Schema.NullOr(Schema.String)
});
const decodeKeys = Schema.decodeUnknownSync(KeyPage);

const services = Layer.mergeAll(
  CredentialKeys.layerFromKeys(Redacted.make(`live:${Buffer.alloc(32, 5).toString("base64")}`)),
  RuntimeLog.layer,
  Layer.succeed(
    PostgresSource.Source,
    PostgresSource.Source.of({
      test: () => Effect.die("no Postgres here"),
      inspect: () => Effect.die("no Postgres here")
    })
  ),
  PostHogSource.layer,
  Source.layer
).pipe(Layer.provideMerge(Testing.layer()));

it.layer(services, { timeout: "120 seconds" })("Pidgeon (live account)", (it) => {
  it.effect(
    "connects a new address at send, rotates, changes access and deletes, minting only its own keys",
    () =>
      Effect.gen(function* () {
        const admin = yield* Config.Redacted("PIDGEON_ADMIN_KEY");
        const source = yield* Source.Source;
        const store = yield* SqlConnectionStore.make;
        const far = () => Date.now() + 15_000;
        /** Every key on the account, as the admin key lists them. */
        const keys = Effect.gen(function* () {
          const found: Array<(typeof KeyPage.Type)["data"][number]> = [];
          let cursor: string | null = null;
          do {
            const answer = yield* source.call(
              admin,
              { method: "GET", path: "/api-keys", query: cursor === null ? {} : { cursor } },
              far()
            );
            const page = decodeKeys(answer.body);
            found.push(...page.data);
            cursor = page.next_cursor;
          } while (cursor !== null);
          return found;
        });
        const live = (key: { readonly revoked_at: string | null }) => key.revoked_at === null;
        const before = new Set((yield* keys).filter(live).map((key) => key.id));
        const created: { address?: string } = {};
        // Whatever happens, the address goes and no key with this run's name is left.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const key of yield* keys)
              if (key.name.startsWith(`Patchy ${handle} `) && live(key))
                yield* source.call(admin, { method: "DELETE", path: `/api-keys/${key.id}` }, far());
            if (created.address !== undefined)
              yield* source.call(
                admin,
                { method: "DELETE", path: `/identities/${created.address}` },
                far()
              );
          }).pipe(Effect.ignore)
        );
        const connected = yield* store.connect({
          integration: "pidgeon",
          ...who,
          handle,
          description: "Live test address, deleted when the test ends",
          credentials: Keys.connectSecret({
            adminKey: Redacted.value(admin),
            attempt: run.padStart(12, "0").slice(-12),
            access: "send",
            address: {
              create: {
                localPart: `patchy-live-${run}`,
                domain: Keys.SHARED_DOMAIN,
                displayName: "Patchy live test",
                sendPolicy: "reply_only"
              }
            }
          })
        });
        if (connected.integration !== "pidgeon") return assert.fail("A Pidgeon connection");
        const address = connected.display.identityId;
        created.address = address;
        assert.strictEqual(connected.display.email, `patchy-live-${run}@${Keys.SHARED_DOMAIN}`);
        assert.strictEqual(connected.display.sendPolicy, "reply_only");
        const snapshot = yield* store.snapshot(who.companyId, connected.id, 1);
        assert.deepInclude(snapshot.integration === "pidgeon" ? snapshot.snapshot : {}, {
          access: "send"
        });
        // In Pidgeon, the only new key is the one for that address, at send.
        const added = (yield* keys).filter((key) => live(key) && !before.has(key.id));
        assert.deepStrictEqual(
          added.map((key) => [key.id, key.access, key.identity_ids, key.test]),
          [[connected.display.key.id, "send", [address], false]]
        );
        // The address key isn't an admin key, and connect refuses it creating nothing.
        const minted = yield* Calls.connect(who.companyId, connected).pipe(
          Effect.provideService(ConnectionStore.ConnectionStore, store)
        );
        const refused = yield* store
          .connect({
            integration: "pidgeon",
            ...who,
            handle: `${handle}-x`,
            description: "",
            credentials: Keys.connectSecret({
              adminKey: minted.key.token,
              attempt: "liverefused1",
              access: "read",
              address: { id: address }
            })
          })
          .pipe(Effect.flip);
        assert.instanceOf(refused, Keys.NotAdminKey);
        // Rotate key: a new secret without the admin key, the old one working through its grace.
        const rotated = yield* store.renew({ ...who, id: connected.id });
        if (rotated.integration !== "pidgeon") return assert.fail("A Pidgeon connection");
        assert.strictEqual(rotated.display.rotation?.outcome, "saved");
        const renewed = yield* Calls.connect(who.companyId, rotated).pipe(
          Effect.provideService(ConnectionStore.ConnectionStore, store)
        );
        assert.isTrue(renewed.key.token !== minted.key.token);
        for (const token of [renewed.key.token, minted.key.token])
          yield* source.call(Redacted.make(token), { method: "GET", path: "/me" }, far());
        // Change access to read: a new key, and the old one revoked.
        const changed = yield* store.rotate({
          ...who,
          id: connected.id,
          credentials: Keys.replaceSecret({
            adminKey: Redacted.value(admin),
            attempt: "livechange01",
            access: "read"
          })
        });
        if (changed.integration !== "pidgeon") return assert.fail("A Pidgeon connection");
        assert.strictEqual(changed.display.access, "read");
        assert.isUndefined(changed.display.retired);
        const after = yield* keys;
        assert.isFalse(live(after.find((key) => key.id === connected.display.key.id)!));
        assert.deepInclude(
          after.find((key) => key.id === changed.display.key.id),
          {
            access: "read",
            revoked_at: null
          }
        );
        // Delete: the key revokes itself; the address stays until this test removes it.
        const deleted = yield* store.delete({ ...who, id: connected.id });
        assert.isNull(deleted.keyLeft);
        assert.isFalse(live((yield* keys).find((key) => key.id === changed.display.key.id)!));
        yield* source.call(admin, { method: "GET", path: `/identities/${created.address}` }, far());
      }).pipe(Effect.scoped)
  );
});
