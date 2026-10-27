import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { PidgeonSource } from "@patchy/integrations";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { isTestKey, recordAddress, takeDown, takeDownRecorded, told } from "./pidgeon.js";

/**
 * Pidgeon as these tests script it: answers by method, path and cursor, and every request it saw.
 * An unscripted request answers 404.
 */
const scripted = (answers: Record<string, unknown>) => {
  const sent: string[] = [];
  const source = PidgeonSource.Source.of({
    call: (_token, request) => {
      const cursor = request.query?.cursor;
      const route = `${request.method} ${request.path}${cursor === undefined ? "" : `?${cursor}`}`;
      sent.push(route);
      const answer = answers[route];
      return answer === undefined
        ? Effect.fail(new PidgeonSource.NotFound({}))
        : answer === "unavailable"
          ? Effect.fail(new PidgeonSource.Unavailable({ stage: "status", upstreamStatus: 503 }))
          : Effect.succeed({ body: answer, replayed: false });
    },
    withSlot: () => (effect) => effect
  });
  return { sent, provide: Effect.provideService(PidgeonSource.Source, source) };
};
const admin = Redacted.make("pgn_test_scriptedDevAdmin0001");
const me = (test: boolean) => ({ data: { key: { test } } });
const address = (id: string, local_part: string, test = true) => ({ id, local_part, test });
const key = (
  id: string,
  identity_ids: ReadonlyArray<string>,
  fields: { name?: string; access?: string; test?: boolean; revoked_at?: string } = {}
) => ({
  id,
  name: fields.name ?? `Patchy support attempt-${id}`,
  access: fields.access ?? "send",
  test: fields.test ?? true,
  revoked_at: fields.revoked_at ?? null,
  identity_ids
});
const deletes = (sent: ReadonlyArray<string>) => sent.filter((route) => route.startsWith("DELETE"));

it.effect("refuses a live admin key, by its own /me", () =>
  Effect.gen(function* () {
    for (const test of [true, false]) {
      const pidgeon = scripted({ "GET /me": me(test) });
      assert.strictEqual(yield* isTestKey(admin).pipe(pidgeon.provide), test);
    }
  })
);

it.effect("takes down only the recorded test addresses and the keys that reach nothing else", () =>
  Effect.gen(function* () {
    const pidgeon = scripted({
      "GET /me": me(true),
      "GET /identities": {
        data: [
          address("ours", "support-ab12cd"),
          address("longer", "support-ab12cde"),
          address("live", "support-ab12cd", false),
          address("other", "help-zz99yy")
        ],
        next_cursor: null
      },
      "GET /api-keys": {
        data: [
          key("minted", ["ours"]),
          key("both", ["ours", "other"]),
          key("admin", ["ours"], { access: "admin" }),
          key("named", ["ours"], { name: "Support inbox" })
        ],
        next_cursor: "page2"
      },
      "GET /api-keys?page2": {
        data: [
          key("retired", ["ours"], { access: "read" }),
          key("liveKey", ["ours"], { test: false }),
          key("revoked", ["ours"], { revoked_at: "2026-10-26T00:00:00Z" }),
          key("everywhere", []),
          key("lookalike", ["longer"])
        ],
        next_cursor: null
      },
      "DELETE /api-keys/minted": { data: {} },
      "DELETE /api-keys/retired": { data: {} },
      "DELETE /identities/ours": { data: {} }
    });
    const done = yield* takeDown(admin, ["support-ab12cd", "support-gone00"]).pipe(pidgeon.provide);
    assert.deepStrictEqual(done, { revoked: 2, deleted: 1, missing: ["support-gone00"] });
    // The address Pidgeon already deleted is named, its key left to the stale sweep.
    const lines = told(done);
    assert.include(lines[0], "support-gone00 isn't in Pidgeon any more");
    assert.include(lines[0], "`pnpm test:pidgeon:sweep`");
    assert.include(lines[1], "revoked 2 keys and deleted 1 test address");
    // Keys first, so none is left reaching nothing; never the live address or another's key.
    assert.deepStrictEqual(deletes(pidgeon.sent), [
      "DELETE /api-keys/minted",
      "DELETE /api-keys/retired",
      "DELETE /identities/ours"
    ]);
  })
);

it.effect("changes nothing with a key that isn't a test key", () =>
  Effect.gen(function* () {
    const pidgeon = scripted({ "GET /me": me(false) });
    const exit = yield* takeDown(admin, ["support-ab12cd"]).pipe(pidgeon.provide, Effect.exit);
    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual(pidgeon.sent, ["GET /me"]);
  })
);

it.effect("keeps the address when a key won't revoke, and says so", () =>
  Effect.gen(function* () {
    const pidgeon = scripted({
      "GET /me": me(true),
      "GET /identities": { data: [address("ours", "support-ab12cd")], next_cursor: null },
      "GET /api-keys": { data: [key("stuck", ["ours"])], next_cursor: null },
      "DELETE /api-keys/stuck": "unavailable"
    });
    const error = yield* takeDown(admin, ["support-ab12cd"]).pipe(pidgeon.provide, Effect.flip);
    assert.strictEqual(error._tag, "PidgeonLeft");
    assert.include(error.message, "support-ab12cd");
    assert.include(error.message, "Nothing was removed");
    assert.deepStrictEqual(deletes(pidgeon.sent), ["DELETE /api-keys/stuck"]);
  })
);

it.layer(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))("takeDownRecorded", (it) => {
  it.effect("calls Pidgeon only for an environment that recorded an address", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "pidgeon-addresses.json");
      const devEnv = path.join(dir, "dev.env");
      // There's no key either, so any call to Pidgeon would have failed this.
      yield* takeDownRecorded(file, devEnv);
      yield* recordAddress(file, "support-ab12cd");
      yield* recordAddress(file, "support-ef34gh");
      const error = yield* takeDownRecorded(file, devEnv).pipe(Effect.flip);
      if (error._tag !== "PidgeonLeft") return assert.fail(error.message);
      assert.deepStrictEqual(error.addresses, ["support-ab12cd", "support-ef34gh"]);
      assert.include(error.message, "PIDGEON_TEST_ADMIN_KEY");
      // The record stays for the next try, and nothing but it is left beside it.
      assert.isTrue(yield* fs.exists(file));
      assert.deepStrictEqual(yield* fs.readDirectory(dir), ["pidgeon-addresses.json"]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))))
  );
});
