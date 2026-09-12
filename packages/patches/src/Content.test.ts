import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { Analytics } from "@patchy/analytics";
import { ContentStore } from "@patchy/content-store";
import * as Content from "./Content.js";
import * as ExpirySweep from "./ExpirySweep.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const { uploader } = Fixtures.identities;

/**
 * An in-memory store with a post-write hook for pausing publication or changing
 * its target between preflight and recording. Faults come from alternate layers.
 */
const memoryStore = (() => {
  const objects = Ref.makeUnsafe(new Map<string, { html: string; lastModified: number }>());
  const control = { afterPut: Effect.void as Effect.Effect<void> };
  const service = ContentStore.ContentStore.of({
    list: (prefix) =>
      Stream.unwrap(
        Effect.map(Ref.get(objects), (map) =>
          Stream.fromIterable(
            [...map]
              .filter(([key]) => key.startsWith(prefix))
              .map(([key, object]) => ({ key, lastModified: object.lastModified }))
          )
        )
      ),
    put: Effect.fn(function* (key, html) {
      const lastModified = yield* Clock.currentTimeMillis;
      yield* Ref.update(objects, (map) => new Map(map).set(key, { html, lastModified }));
      yield* control.afterPut;
    }),
    get: (key) =>
      Effect.flatMap(Ref.get(objects), (map) => {
        const html = map.get(key)?.html;
        return html === undefined
          ? Effect.fail(new ContentStore.ObjectNotFound({ key }))
          : Effect.succeed(html);
      }),
    delete: (key) =>
      Ref.update(objects, (map) => {
        const next = new Map(map);
        next.delete(key);
        return next;
      })
  });
  return {
    control,
    service,
    layer: Layer.succeed(ContentStore.ContentStore, service),
    keys: Effect.map(Ref.get(objects), (map) => [...map.keys()].sort())
  };
})();

const store = memoryStore;
const unavailable = (operation: "put" | "delete", key: string) =>
  new ContentStore.StoreUnavailable({ operation, key, cause: new Error("down") });

/** The same store, refusing every put. */
const putFails = Layer.succeed(
  ContentStore.ContentStore,
  ContentStore.ContentStore.of({
    ...store.service,
    put: (key) => Effect.fail(unavailable("put", key))
  })
);

/** A write can succeed at the provider even when its reply reports failure. */
const putReplyLost = Layer.succeed(
  ContentStore.ContentStore,
  ContentStore.ContentStore.of({
    ...store.service,
    put: (key, html) =>
      store.service.put(key, html).pipe(Effect.andThen(Effect.fail(unavailable("put", key))))
  })
);

/** The same store, refusing every delete. */
const deleteFails = Layer.succeed(
  ContentStore.ContentStore,
  ContentStore.ContentStore.of({
    ...store.service,
    delete: (key) => Effect.fail(unavailable("delete", key))
  })
);

/** `Content` over a faulty store, sharing the block's `Patches`. */
const over = (faulty: Layer.Layer<ContentStore.ContentStore>) =>
  Effect.provide(Layer.effect(Content.Content, Content.make).pipe(Layer.provide(faulty)));

const content = Effect.flatMap(Content.Content, Effect.succeed);
const patches = Effect.flatMap(Patches.Patches, Effect.succeed);
const sweep = Effect.flatMap(ExpirySweep.ExpirySweep, (service) => service.sweep);

const publish = (
  html: string,
  patchId: string | null = null,
  extra: Partial<Content.PublishInput> = {}
) =>
  Effect.flatMap(content, (service) =>
    service.publish({
      ...Fixtures.publishRecord(),
      patchId,
      companyId: uploader.company.id,
      ownerUserId: uploader.user.id,
      machineTokenId: uploader.machine.id,
      title: "Page",
      html,
      filename: null,
      repoOrg: null,
      repoName: null,
      cliVersion: null,
      gitBranch: null,
      gitCommitSha: null,
      sourceIp: "203.0.113.9",
      userAgent: "vitest",
      ...extra
    })
  );

it.layer(
  Layer.mergeAll(Content.layer, ExpirySweep.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(Patches.layer, store.layer, Analytics.layerNoop)),
    Layer.provideMerge(Fixtures.database)
  )
)("Content", (it) => {
  it.effect("stores the bytes, records the version, and reads both back", () =>
    Effect.gen(function* () {
      const created = yield* publish("<p>one</p>");
      assert.strictEqual(created.versionNumber, 1);
      const updated = yield* publish("<p>two</p>", created.patchId);
      assert.strictEqual(updated.versionNumber, 2);

      const service = yield* content;
      const found = yield* patches;
      const latest = Option.getOrThrow(yield* found.find(created.patchId));
      assert.strictEqual(yield* service.read(latest.version), "<p>two</p>");
      assert.strictEqual(latest.version.sourceIp, "203.0.113.9");
      const first = Option.getOrThrow(yield* found.find(created.patchId, 1));
      assert.strictEqual(yield* service.read(first.version), "<p>one</p>");
      assert.deepStrictEqual(
        yield* store.keys,
        [
          Content.objectKey(created.patchId, created.versionId),
          Content.objectKey(updated.patchId, updated.versionId)
        ].sort()
      );
    })
  );

  it.effect("refuses a taken publish key with bounded diagnostics and preserves its version", () =>
    Effect.gen(function* () {
      const publishKey = `${crypto.randomUUID()}\n${"unsafe-key".repeat(128)}`;
      const created = yield* publish("<p>original</p>", null, { publishKey });
      const error = yield* publish("<p>conflicting</p>", created.patchId, { publishKey }).pipe(
        Effect.flip
      );
      assert.strictEqual(error._tag, "PublishKeyTaken");
      if (error._tag !== "PublishKeyTaken") return;
      assert.include(error.message, uploader.user.id);
      assert.include(error.message, String(publishKey.length));
      assert.isBelow(error.message.length, 200);
      assert.notInclude(error.message, "unsafe-key");
      assert.notInclude(JSON.stringify(error), "unsafe-key");
      const service = yield* patches;
      assert.strictEqual(
        Option.getOrThrow(yield* service.find(created.patchId)).version.versionNumber,
        1
      );
      assert.strictEqual(
        Option.getOrThrow(yield* service.replay(uploader.user.id, publishKey)).response.versionId,
        created.versionId
      );
      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
    })
  );

  it.effect("writes nothing when the store refuses the object", () =>
    Effect.gen(function* () {
      const created = yield* publish("<p>original</p>");
      const failed = yield* publish("<p>lost</p>", created.patchId).pipe(
        over(putFails),
        Effect.flip
      );
      assert.strictEqual(failed._tag, "StoreUnavailable");
      const current = Option.getOrThrow(yield* (yield* patches).find(created.patchId));
      assert.strictEqual(yield* (yield* content).read(current.version), "<p>original</p>");
    })
  );

  it.effect("reclaims bytes after a target refusal without removing its older version", () =>
    Effect.gen(function* () {
      const created = yield* publish("<p>original</p>");
      const before = yield* store.keys;
      // The patch is taken down between the preflight and the row insert.
      store.control.afterPut = Effect.flatMap(patches, (service) =>
        service.delete(created.patchId, uploader.user.id).pipe(Effect.orDie, Effect.asVoid)
      );
      const refused = yield* publish("<p>rejected</p>", created.patchId).pipe(
        Effect.flip,
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        )
      );
      assert.strictEqual(refused._tag, "PatchUnavailable");
      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
      assert.deepStrictEqual(yield* store.keys, before);
      assert.strictEqual(
        yield* store.service.get(Content.objectKey(created.patchId, created.versionId)),
        "<p>original</p>"
      );
    })
  );

  it.effect("reclaims an object whose write succeeded but whose reply failed", () =>
    Effect.gen(function* () {
      const before = yield* store.keys;
      const publishKey = crypto.randomUUID();
      const error = yield* publish("<p>unacknowledged</p>", null, { publishKey }).pipe(
        over(putReplyLost),
        Effect.flip
      );
      assert.strictEqual(error._tag, "StoreUnavailable");
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      assert.strictEqual(yield* store.service.get(key), "<p>unacknowledged</p>");
      assert.isTrue(Option.isNone(yield* (yield* patches).replay(uploader.user.id, publishKey)));

      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
      assert.deepStrictEqual(yield* store.keys, before);
    })
  );

  it.effect("reclaims an object when the version transaction rolls back", () =>
    Effect.gen(function* () {
      const created = yield* publish("<p>original</p>");
      const before = yield* store.keys;
      const publishKey = crypto.randomUUID();
      const error = yield* publish("<p>rolled back</p>", created.patchId, {
        publishKey,
        machineTokenId: "missing-machine-token"
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "SqlError");
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      assert.strictEqual(yield* store.service.get(key), "<p>rolled back</p>");
      const service = yield* patches;
      assert.isTrue(Option.isNone(yield* service.replay(uploader.user.id, publishKey)));
      assert.strictEqual(
        Option.getOrThrow(yield* service.find(created.patchId)).version.versionNumber,
        1
      );

      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
      assert.deepStrictEqual(yield* store.keys, before);
      assert.strictEqual(
        yield* (yield* content).read(
          Option.getOrThrow(yield* service.find(created.patchId)).version
        ),
        "<p>original</p>"
      );
    })
  );

  it.effect("retains live bytes and replay when commit succeeded but its reply failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
        sql.withTransaction(effect).pipe(
          Effect.andThen(
            Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.ConnectionError({ cause: new Error("commit reply lost") })
              })
            )
          )
        );
      const uncertainSql = new Proxy(sql, {
        get: (target, property, receiver) =>
          property === "withTransaction" ? withTransaction : Reflect.get(target, property, receiver)
      });
      const uncertain = Layer.effect(Content.Content, Content.make).pipe(
        Layer.provide(
          Layer.effect(Patches.Patches, Patches.make).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, uncertainSql))
          )
        )
      );
      const publishKey = crypto.randomUUID();
      const error = yield* publish("<p>committed</p>", null, { publishKey }).pipe(
        Effect.provide(uncertain),
        Effect.flip
      );
      assert.strictEqual(error._tag, "SqlError");
      const service = yield* patches;
      const replay = Option.getOrThrow(yield* service.replay(uploader.user.id, publishKey));
      assert.strictEqual(replay.status, 201);
      const patchId = replay.response.patchId as string;
      const version = Option.getOrThrow(yield* service.find(patchId)).version;

      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
      assert.strictEqual(yield* (yield* content).read(version), "<p>committed</p>");
      assert.deepStrictEqual(
        yield* service.replay(uploader.user.id, publishKey),
        Option.some(replay)
      );
    })
  );

  it.effect("retries reclamation after the store refuses deletion", () =>
    Effect.gen(function* () {
      const before = yield* store.keys;
      yield* publish("<p>retry deletion</p>").pipe(over(putReplyLost), Effect.flip);
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      const failed = yield* sweep.pipe(
        Effect.provide(
          Layer.effect(ExpirySweep.ExpirySweep, ExpirySweep.make).pipe(Layer.provide(deleteFails))
        )
      );
      assert.strictEqual(failed.orphanedObjects, 1);
      assert.strictEqual(yield* store.service.get(key), "<p>retry deletion</p>");

      yield* sweep;
      assert.deepStrictEqual(yield* store.keys, before);
      assert.deepStrictEqual(yield* (yield* patches).claimObjects(100), []);
    })
  );

  it.effect("does not reclaim bytes while their publication is active", () =>
    Effect.gen(function* () {
      const stored = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const before = yield* store.keys;
      store.control.afterPut = Deferred.succeed(stored, undefined).pipe(
        Effect.andThen(Deferred.await(resume))
      );
      const publication = yield* publish("<p>in flight</p>").pipe(
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        ),
        Effect.forkScoped
      );
      yield* Deferred.await(stored);
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      yield* TestClock.adjust("30 seconds");
      yield* sweep;
      assert.strictEqual(yield* store.service.get(key), "<p>in flight</p>");
      yield* Deferred.succeed(resume, undefined);
      const published = yield* Fiber.join(publication);
      yield* TestClock.adjust(Patches.PENDING_OBJECT_LEASE);
      yield* sweep;
      const version = Option.getOrThrow(yield* (yield* patches).find(published.patchId)).version;
      assert.strictEqual(yield* (yield* content).read(version), "<p>in flight</p>");
    })
  );

  it.effect("skips a record transaction's locked intent when its lease expires", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ready = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const before = yield* store.keys;
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
        sql.withTransaction(
          effect.pipe(
            Effect.tap(() =>
              Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume)))
            )
          )
        );
      const heldSql = new Proxy(sql, {
        get: (target, property, receiver) =>
          property === "withTransaction" ? withTransaction : Reflect.get(target, property, receiver)
      });
      const held = Layer.effect(Content.Content, Content.make).pipe(
        Layer.provide(
          Layer.effect(Patches.Patches, Patches.make).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, heldSql))
          )
        )
      );
      store.control.afterPut = Effect.gen(function* () {
        const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
        // Shorten only this test's lease so the transaction's own deadline stays live.
        yield* sql`
          UPDATE pending_patch_objects SET expires_at = expires_at - interval '4 minutes 59 seconds'
          WHERE object_key = ${key}`;
      }).pipe(Effect.orDie);
      const publication = yield* publish("<p>committing</p>").pipe(
        Effect.provide(held),
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        ),
        Effect.forkScoped
      );
      yield* Deferred.await(ready);
      const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
      yield* TestClock.adjust("2 seconds");
      yield* sweep;
      assert.strictEqual(yield* store.service.get(key), "<p>committing</p>");
      yield* Deferred.succeed(resume, undefined);
      const published = yield* Fiber.join(publication);
      yield* sweep;
      const version = Option.getOrThrow(yield* (yield* patches).find(published.patchId)).version;
      assert.strictEqual(yield* (yield* content).read(version), "<p>committing</p>");
    })
  );

  it.effect("refuses a late version after the sweep claims its pending object", () =>
    Effect.gen(function* () {
      const before = yield* store.keys;
      const service = yield* patches;
      const sql = yield* SqlClient.SqlClient;
      const publishKey = crypto.randomUUID();
      store.control.afterPut = Effect.gen(function* () {
        const key = (yield* store.keys).find((candidate) => !before.includes(candidate))!;
        // Force the lease boundary without timing out the paused uploader.
        yield* sql`UPDATE pending_patch_objects SET expires_at = to_timestamp(0) WHERE object_key = ${key}`;
        yield* service.claimObjects(100);
      }).pipe(Effect.orDie);
      const error = yield* publish("<p>too late</p>", null, { publishKey }).pipe(
        Effect.flip,
        Effect.ensuring(
          Effect.sync(() => {
            store.control.afterPut = Effect.void;
          })
        )
      );
      assert.strictEqual(error._tag, "PendingObjectExpired");
      assert.isTrue(Option.isNone(yield* service.replay(uploader.user.id, publishKey)));
      yield* sweep;
      assert.deepStrictEqual(yield* store.keys, before);
    })
  );
});
