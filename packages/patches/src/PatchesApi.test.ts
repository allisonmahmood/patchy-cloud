import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import { Analytics } from "@patchy/analytics";
import {
  DisableRequest,
  PatchyApi,
  UploadCreated,
  UploadRequest,
  UploadUpdated
} from "@patchy/api";
import { ContentStore } from "@patchy/content-store";
import { Limits } from "@patchy/limits";
import * as Content from "./Content.js";
import * as Patches from "./Patches.js";
import * as PatchesApi from "./PatchesApi.js";
import * as Fixtures from "./test/fixtures.js";

const { admin, reader, uploader } = Fixtures.identities;

const memoryStore = Layer.sync(ContentStore.ContentStore, () => {
  const objects = new Map<string, string>();
  return ContentStore.ContentStore.of({
    put: (key, html) => Effect.sync(() => void objects.set(key, html)),
    get: (key) =>
      Effect.suspend(() => {
        const html = objects.get(key);
        return html === undefined
          ? Effect.fail(new ContentStore.ObjectNotFound({ key }))
          : Effect.succeed(html);
      }),
    delete: (key) => Effect.sync(() => void objects.delete(key))
  });
});

const client = HttpApiTest.groups(PatchyApi, ["patches"]);

const html = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;

const upload = (payload: ConstructorParameters<typeof UploadRequest>[0]) =>
  Effect.flatMap(client, (api) => api.upload({ payload: new UploadRequest(payload) }));

const layer = Layer.mergeAll(PatchesApi.layer, HttpServer.layerServices).pipe(
  Layer.provideMerge(Fixtures.authorization),
  Layer.provideMerge(Layer.mergeAll(Content.layer, Limits.layer, Analytics.layerNoop)),
  Layer.provideMerge(Layer.mergeAll(Patches.layer, memoryStore)),
  Layer.provideMerge(Fixtures.database),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        PATCHY_PUBLIC_BASE_URL: "https://patchy.example/",
        PATCHY_PATCH_CREATE_RATE_LIMIT_PER_MINUTE: "3",
        PATCHY_LIVE_PATCHES_PER_TOKEN: "2"
      })
    )
  )
);

it.layer(layer)("patches group", (it) => {
  it.effect("creates with 201 and updates with 200, on the configured public origin", () =>
    Effect.gen(function* () {
      const created = yield* upload({ html: html("First"), filename: "  first.html " }).pipe(
        Effect.provide(Fixtures.as(uploader))
      );
      assert.instanceOf(created, UploadCreated);
      assert.strictEqual(created.title, "First");
      assert.strictEqual(created.publicUrl, `https://patchy.example/d/${created.patchId}`);
      assert.deepStrictEqual(created.warnings, []);

      const updated = yield* upload({ html: html("Second"), patchId: created.patchId }).pipe(
        Effect.provide(Fixtures.as(uploader))
      );
      assert.instanceOf(updated, UploadUpdated);
      assert.strictEqual(updated.versionNumber, 2);

      const served = Option.getOrThrow(yield* (yield* Content.Content).read(created.patchId));
      assert.include(served.html, "Second");
    })
  );

  it.effect("refuses what the policy, the scope and the target refuse, in wire words", () =>
    Effect.gen(function* () {
      const asUploader = Fixtures.as(uploader);
      const invalid = yield* upload({ html: "<script>alert(1)</script>" }).pipe(
        Effect.provide(asUploader),
        Effect.flip
      );
      assert.include(invalid, { ok: false });
      assert.isTrue("errors" in invalid && invalid.errors.length > 0);

      const forbidden = yield* upload({ html: html("No") }).pipe(
        Effect.provide(Fixtures.as(reader)),
        Effect.flip
      );
      assert.deepStrictEqual(forbidden, {
        ok: false,
        error: "API token does not have the required scope."
      });

      const admins = yield* upload({ html: html("Theirs") }).pipe(
        Effect.provide(Fixtures.as(admin))
      );
      // Unknown, another principal's, disabled: one 404, never saying which.
      for (const patchId of ["abcdefabcdef", admins.patchId]) {
        const refused = yield* upload({ html: html("x"), patchId }).pipe(
          Effect.provide(asUploader),
          Effect.flip
        );
        assert.deepStrictEqual(refused, { ok: false, error: "Patch not found." });
      }
    })
  );

  it.effect(
    "throttles creates per token, then holds them to the live-patch quota, never updates",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const as = Fixtures.as(Fixtures.identities.sibling);
        const first = yield* upload({ html: html("One") }).pipe(Effect.provide(as));
        yield* upload({ html: html("Two") }).pipe(Effect.provide(as));
        const quota = yield* upload({ html: html("Three") }).pipe(Effect.provide(as), Effect.flip);
        assert.include(quota, { ok: false, code: "live_patch_quota_exceeded", quota: 2 });
        // The bucket is spent before the quota is counted.
        const throttled = yield* upload({ html: html("Four") }).pipe(
          Effect.provide(as),
          Effect.flip
        );
        assert.include(throttled, { ok: false, code: "rate_limited", retryAfterSeconds: 60 });
        // An update costs nothing against either.
        const updated = yield* upload({ html: html("Still one"), patchId: first.patchId }).pipe(
          Effect.provide(as)
        );
        assert.strictEqual(updated.versionNumber, 2);

        // Deleting one returns its slot.
        yield* TestClock.adjust("1 minute");
        const api = yield* client.pipe(Effect.provide(as));
        yield* api.delete({ params: { patchId: first.patchId } });
        yield* upload({ html: html("Three again") }).pipe(Effect.provide(as));
      })
  );

  it.effect(
    "moderates: reads and lists for admins, disables and deletes for owners, pins for admins",
    () =>
      Effect.gen(function* () {
        const asUploader = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const asAdmin = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
        const mine = yield* upload({ html: html("Mine") }).pipe(
          Effect.provide(Fixtures.as(uploader))
        );

        const forbidden = { ok: false, error: "API token does not have the required scope." };
        assert.deepStrictEqual(
          yield* asUploader.read({ params: { patchId: mine.patchId } }).pipe(Effect.flip),
          forbidden
        );
        assert.deepStrictEqual(
          yield* asUploader.pin({ params: { patchId: mine.patchId } }).pipe(Effect.flip),
          forbidden
        );
        const view = yield* asAdmin.read({ params: { patchId: mine.patchId } });
        assert.include(view.patch, {
          id: mine.patchId,
          principalId: uploader.accountId,
          createdByApiTokenId: uploader.apiTokenId,
          pinnedAt: null
        });
        assert.deepStrictEqual(
          { ...(yield* asAdmin.pin({ params: { patchId: mine.patchId } })) },
          {
            ok: true,
            pinned: true
          }
        );
        assert.deepStrictEqual(
          { ...(yield* asAdmin.unpin({ params: { patchId: mine.patchId } })) },
          { ok: true, pinned: false }
        );

        // The owner disables its own; nobody else's without admin scope.
        const theirs = yield* upload({ html: html("Theirs") }).pipe(
          Effect.provide(Fixtures.as(admin))
        );
        assert.deepStrictEqual(
          yield* asUploader
            .disable({ params: { patchId: theirs.patchId }, payload: new DisableRequest({}) })
            .pipe(Effect.flip),
          { ok: false, error: "Patch not found." }
        );
        assert.deepStrictEqual(
          {
            ...(yield* asUploader.disable({
              params: { patchId: mine.patchId },
              payload: new DisableRequest({ reason: " policy " })
            }))
          },
          { ok: true }
        );
        assert.strictEqual(
          (yield* asAdmin.read({ params: { patchId: mine.patchId } })).patch.disabledReason,
          "policy"
        );
        // Disabled is out of service, so it cannot be pinned; it still lists.
        assert.deepStrictEqual(
          yield* asAdmin.pin({ params: { patchId: mine.patchId } }).pipe(Effect.flip),
          { ok: false, error: "Patch not found." }
        );
        const listed = yield* asAdmin.listByPrincipal({
          params: { principalId: uploader.accountId }
        });
        assert.isTrue(listed.patches.some((patch) => patch.id === mine.patchId));
        assert.deepStrictEqual(
          { ...(yield* asAdmin.delete({ params: { patchId: mine.patchId } })) },
          {
            ok: true
          }
        );
        const after = yield* asAdmin.listByPrincipal({
          params: { principalId: uploader.accountId }
        });
        assert.isFalse(after.patches.some((patch) => patch.id === mine.patchId));
        assert.deepStrictEqual(
          yield* asAdmin.delete({ params: { patchId: mine.patchId } }).pipe(Effect.flip),
          { ok: false, error: "Patch not found." }
        );
      })
  );
});
