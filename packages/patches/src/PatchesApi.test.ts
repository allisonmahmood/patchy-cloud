import { assert, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import { Analytics } from "@patchy/analytics";
import {
  Authorization,
  PatchyApi,
  ShareRequest,
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

const { admin, reader, sibling, uploader } = Fixtures.identities;

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

const events: Analytics.AnalyticsEvent[] = [];
const recordingAnalytics = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({
    track: (event) => Effect.sync(() => void events.push(event))
  })
);

const layer = Layer.mergeAll(PatchesApi.layer, HttpServer.layerServices).pipe(
  Layer.provideMerge(Fixtures.authorization),
  Layer.provideMerge(Layer.mergeAll(Content.layer, Limits.layer, recordingAnalytics)),
  Layer.provideMerge(Layer.mergeAll(Patches.layer, memoryStore)),
  Layer.provideMerge(Fixtures.database),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        PATCHY_PUBLIC_BASE_URL: "https://patchy.example/",
        PATCHY_PATCH_CREATE_RATE_LIMIT_PER_MINUTE: "3",
        PATCHY_LIVE_PATCHES_PER_USER: "2"
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
      assert.strictEqual(created.scope, "company");
      assert.strictEqual(created.publicUrl, `https://patchy.example/d/${created.patchId}`);
      assert.deepStrictEqual(created.warnings, []);

      const updated = yield* upload({
        html: html("Second"),
        patchId: created.patchId,
        scope: "public"
      }).pipe(Effect.provide(Fixtures.as(sibling)));
      assert.instanceOf(updated, UploadUpdated);
      assert.strictEqual(updated.versionNumber, 2);
      assert.strictEqual(updated.scope, "public");

      const preserved = yield* upload({ html: html("Third"), patchId: created.patchId }).pipe(
        Effect.provide(Fixtures.as(sibling))
      );
      assert.strictEqual(preserved.scope, "public");
      const restricted = yield* upload({
        html: html("Fourth"),
        patchId: created.patchId,
        scope: "company"
      }).pipe(Effect.provide(Fixtures.as(uploader)));
      assert.strictEqual(restricted.scope, "company");
      assert.deepStrictEqual(
        events
          .filter((event) => event.properties.patchId === created.patchId)
          .map((event) => event.properties.scope),
        ["company", "public", "public", "company"]
      );

      const served = Option.getOrThrow(yield* (yield* Patches.Patches).find(created.patchId));
      assert.strictEqual(served.patch.scope, "company");
      assert.include(yield* (yield* Content.Content).read(served.version), "Fourth");
    })
  );

  it.effect(
    "creates public patches and lets another machine of the owner share them both ways",
    () =>
      Effect.gen(function* () {
        const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const sameUser = yield* client.pipe(Effect.provide(Fixtures.as(sibling)));
        const anotherUser = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
        const created = yield* owner.upload({
          payload: new UploadRequest({ html: html("Public"), scope: "public" })
        });
        assert.strictEqual(created.scope, "public");
        const patches = yield* Patches.Patches;
        assert.strictEqual(
          Option.getOrThrow(yield* patches.find(created.patchId)).patch.scope,
          "public"
        );

        const params = { patchId: created.patchId };
        for (const scope of ["company", "public"] as const) {
          const shared = yield* sameUser.share({ params, payload: new ShareRequest({ scope }) });
          assert.deepStrictEqual(
            { ...shared },
            { ok: true, patchId: created.patchId, scope, publicUrl: created.publicUrl }
          );
          assert.strictEqual(
            Option.getOrThrow(yield* patches.find(created.patchId)).patch.scope,
            scope
          );
        }

        for (const patchId of [created.patchId, "abcdefabcdef"]) {
          assert.deepStrictEqual(
            yield* anotherUser
              .share({ params: { patchId }, payload: new ShareRequest({ scope: "company" }) })
              .pipe(Effect.flip),
            { ok: false, error: "Patch not found." }
          );
        }
        assert.strictEqual(
          Option.getOrThrow(yield* patches.find(created.patchId)).patch.scope,
          "public"
        );
        yield* owner.delete({ params });
        assert.deepStrictEqual(
          yield* sameUser
            .share({ params, payload: new ShareRequest({ scope: "public" }) })
            .pipe(Effect.flip),
          { ok: false, error: "Patch not found." }
        );
      })
  );

  it.effect("rejects null or unknown scopes on upload and share", () =>
    Effect.gen(function* () {
      for (const scope of [null, "everyone"]) {
        const malformedScope = HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
          next(
            request.pipe(
              HttpClientRequest.bearerToken(uploader.machine.id),
              HttpClientRequest.bodyJsonUnsafe({ html: html("Invalid scope"), scope })
            )
          )
        );
        const api = yield* client.pipe(Effect.provide(malformedScope));
        const uploadResponse = yield* api.upload({
          payload: new UploadRequest({ html: html("Invalid scope") }),
          responseMode: "response-only"
        });
        assert.strictEqual(uploadResponse.status, 400);
        expect(yield* uploadResponse.json).toEqual({ ok: false, error: expect.any(String) });
        const shareResponse = yield* api.share({
          params: { patchId: "abcdefabcdef" },
          payload: new ShareRequest({ scope: "company" }),
          responseMode: "response-only"
        });
        assert.strictEqual(shareResponse.status, 400);
        expect(yield* shareResponse.json).toEqual({ ok: false, error: expect.any(String) });
      }
    })
  );

  it.effect("refuses what the policy and the target refuse, in wire words", () =>
    Effect.gen(function* () {
      const asUploader = Fixtures.as(uploader);
      const invalid = yield* upload({ html: "<script>alert(1)</script>" }).pipe(
        Effect.provide(asUploader),
        Effect.flip
      );
      assert.include(invalid, { ok: false });
      assert.isTrue("errors" in invalid && invalid.errors.length > 0);

      const admins = yield* upload({ html: html("Theirs") }).pipe(
        Effect.provide(Fixtures.as(admin))
      );
      // Unknown and another user's: one 404, never saying which.
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
    "throttles creates per machine and keeps the owner's quota across machine changes",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const as = Fixtures.as(Fixtures.identities.quota);
        const first = yield* upload({ html: html("One") }).pipe(Effect.provide(as));
        yield* upload({ html: html("Two") }).pipe(Effect.provide(as));
        const quota = yield* upload({ html: html("Three") }).pipe(Effect.provide(as), Effect.flip);
        assert.include(quota, { ok: false, code: "live_patch_quota_exceeded", quota: 2 });
        const asSibling = Fixtures.as(Fixtures.identities.quotaSibling);
        const newMachineQuota = yield* upload({ html: html("New machine") }).pipe(
          Effect.provide(asSibling),
          Effect.flip
        );
        assert.include(newMachineQuota, { ok: false, code: "live_patch_quota_exceeded", quota: 2 });
        // The bucket is spent before the quota is counted.
        const throttled = yield* upload({ html: html("Four") }).pipe(
          Effect.provide(as),
          Effect.flip
        );
        assert.include(throttled, { ok: false, code: "rate_limited", retryAfterSeconds: 60 });
        // An update costs nothing against either.
        const updated = yield* upload({ html: html("Still one"), patchId: first.patchId }).pipe(
          Effect.provide(asSibling)
        );
        assert.strictEqual(updated.versionNumber, 2);

        // Deleting one returns its slot.
        yield* TestClock.adjust("1 minute");
        const api = yield* client.pipe(Effect.provide(as));
        yield* api.delete({ params: { patchId: first.patchId } });
        yield* upload({ html: html("Three again") }).pipe(Effect.provide(as));
      })
  );

  it.effect("lets members publish, but gives another user's admin role no ownership reach", () =>
    Effect.gen(function* () {
      const asOwner = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
      const asAdmin = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
      const created = yield* asOwner.upload({
        payload: new UploadRequest({ html: html("Owner create") })
      });
      const updated = yield* asOwner.upload({
        payload: new UploadRequest({ html: html("Owner update"), patchId: created.patchId })
      });
      assert.strictEqual(updated.versionNumber, 2);

      const params = { patchId: created.patchId };
      assert.deepStrictEqual(
        yield* asAdmin
          .upload({ payload: new UploadRequest({ html: html("Not yours"), ...params }) })
          .pipe(Effect.flip),
        { ok: false, error: "Patch not found." }
      );
      assert.deepStrictEqual(yield* asAdmin.delete({ params }).pipe(Effect.flip), {
        ok: false,
        error: "Patch not found."
      });
      const content = yield* Content.Content;
      const patches = yield* Patches.Patches;
      const current = Option.getOrThrow(yield* patches.find(created.patchId));
      assert.include(yield* content.read(current.version), "Owner update");

      assert.isTrue((yield* asOwner.delete({ params })).ok);
      assert.isTrue(Option.isNone(yield* patches.find(created.patchId)));
      assert.deepStrictEqual(yield* asOwner.delete({ params }).pipe(Effect.flip), {
        ok: false,
        error: "Patch not found."
      });
    })
  );
});
