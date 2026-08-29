import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { ContentStore } from "@patchy/content-store";
import * as Content from "./Content.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const { uploader } = Fixtures.identities;

/**
 * An in-memory store that runs a hook after every put — the seam the upload
 * contract's rollback race is forced through. Faults come from the layers
 * below it, never from a switch on this one.
 */
const memoryStore = Effect.gen(function* () {
  const objects = yield* Ref.make(new Map<string, string>());
  const control = { afterPut: Effect.void as Effect.Effect<void> };
  const service = ContentStore.ContentStore.of({
    put: (key, html) =>
      Ref.update(objects, (map) => new Map(map).set(key, html)).pipe(
        Effect.andThen(() => control.afterPut)
      ),
    get: (key) =>
      Effect.flatMap(Ref.get(objects), (map) => {
        const html = map.get(key);
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
});

const store = Effect.runSync(memoryStore);
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

const upload = (html: string, patchId: string | null = null) =>
  Effect.flatMap(content, (service) =>
    service.upload({
      patchId,
      accountId: uploader.accountId,
      apiTokenId: uploader.apiTokenId,
      title: "Page",
      html,
      filename: null,
      repoOrg: null,
      repoName: null,
      cliVersion: null,
      gitBranch: null,
      gitCommitSha: null,
      sourceIp: "203.0.113.9",
      userAgent: "vitest"
    })
  );

it.layer(
  Content.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Patches.layer, store.layer)),
    Layer.provideMerge(Fixtures.database)
  )
)("Content", (it) => {
  it.effect("stores the bytes, records the version, and reads both back", () =>
    Effect.gen(function* () {
      const created = yield* upload("<p>one</p>");
      assert.strictEqual(created.versionNumber, 1);
      const updated = yield* upload("<p>two</p>", created.patchId);
      assert.strictEqual(updated.versionNumber, 2);

      const service = yield* content;
      const latest = Option.getOrThrow(yield* service.read(created.patchId));
      assert.strictEqual(latest.html, "<p>two</p>");
      assert.strictEqual(latest.version.sourceIp, "203.0.113.9");
      const first = Option.getOrThrow(yield* service.read(created.patchId, 1));
      assert.strictEqual(first.html, "<p>one</p>");
      assert.isTrue(Option.isNone(yield* service.read(created.patchId, 3)));
      assert.isTrue(Option.isNone(yield* service.read("nope")));
      assert.deepStrictEqual(
        yield* store.keys,
        [
          Content.objectKey(created.patchId, created.versionId),
          Content.objectKey(updated.patchId, updated.versionId)
        ].sort()
      );
    })
  );

  it.effect("writes nothing when the store refuses the object", () =>
    Effect.gen(function* () {
      const created = yield* upload("<p>original</p>");
      const failed = yield* upload("<p>lost</p>", created.patchId).pipe(
        over(putFails),
        Effect.flip
      );
      assert.strictEqual(failed._tag, "StoreUnavailable");
      const current = Option.getOrThrow(yield* (yield* content).read(created.patchId));
      assert.strictEqual(current.version.id, created.versionId);
    })
  );

  it.effect("rolls the object back when the row is refused after it was written", () =>
    Effect.gen(function* () {
      const created = yield* upload("<p>original</p>");
      const before = yield* store.keys;
      // The patch is taken down between the preflight and the row insert.
      store.control.afterPut = Effect.flatMap(patches, (service) =>
        service
          .disable(created.patchId, uploader.accountId, "race", { canModerateAnyPrincipal: false })
          .pipe(Effect.orDie, Effect.asVoid)
      );
      const refused = yield* upload("<p>rejected</p>", created.patchId).pipe(Effect.flip);
      store.control.afterPut = Effect.void;
      assert.strictEqual(refused._tag, "PatchUnavailable");
      assert.deepStrictEqual(yield* store.keys, before);
    })
  );

  it.effect("dies rather than report a clean refusal when the rollback itself fails", () =>
    Effect.gen(function* () {
      const created = yield* upload("<p>original</p>");
      store.control.afterPut = Effect.flatMap(patches, (service) =>
        service
          .delete(created.patchId, uploader.accountId, { canModerateAnyPrincipal: false })
          .pipe(Effect.orDie, Effect.asVoid)
      );
      const exit = yield* upload("<p>orphan</p>", created.patchId).pipe(
        over(deleteFails),
        Effect.exit
      );
      store.control.afterPut = Effect.void;
      assert.isTrue(exit._tag === "Failure" && exit.cause.reasons.some((r) => r._tag === "Die"));
    })
  );
});
