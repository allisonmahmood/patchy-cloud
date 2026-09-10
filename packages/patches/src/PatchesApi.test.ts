import { assert, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
  PublishCreated,
  PublishRequest,
  PublishUpdated,
  CURRENT_RELEASE,
  WIRE_VERSION
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

type PublishPayload = Pick<PublishRequest, "html"> & Partial<PublishRequest>;
const publishRequest = (payload: PublishPayload) =>
  new PublishRequest({
    manifest: Fixtures.manifest,
    publishKey: crypto.randomUUID(),
    metadata: {},
    ...payload
  });
const upload = (payload: PublishPayload) =>
  Effect.flatMap(client, (api) => api.publish({ payload: publishRequest(payload) }));

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
      const created = yield* upload({ html: html("First") }).pipe(
        Effect.provide(Fixtures.as(uploader))
      );
      assert.instanceOf(created, PublishCreated);
      assert.strictEqual(created.title, "First");
      assert.strictEqual(created.scope, "company");
      assert.strictEqual(created.publicUrl, `https://patchy.example/d/${created.patchId}`);
      assert.deepStrictEqual(created.warnings, []);

      const updated = yield* upload({
        html: html("Second"),
        patchId: created.patchId,
        scope: "public"
      }).pipe(Effect.provide(Fixtures.as(sibling)));
      assert.instanceOf(updated, PublishUpdated);
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
        const created = yield* owner.publish({
          payload: publishRequest({ html: html("Public"), scope: "public" })
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
              HttpClientRequest.bodyJsonUnsafe(
                request.url.endsWith("/share")
                  ? { scope }
                  : { ...publishRequest({ html: html("Invalid scope") }), scope }
              )
            )
          )
        );
        const api = yield* client.pipe(
          Effect.provide(malformedScope),
          Effect.provide(
            Layer.fresh(
              PatchesApi.layer.pipe(Layer.provide(Limits.layer), Layer.provide(publishConfig()))
            )
          )
        );
        const uploadResponse = yield* api.publish({
          payload: publishRequest({ html: html("Invalid scope") }),
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
      const created = yield* asOwner.publish({
        payload: publishRequest({ html: html("Owner create") })
      });
      const updated = yield* asOwner.publish({
        payload: publishRequest({ html: html("Owner update"), patchId: created.patchId })
      });
      assert.strictEqual(updated.versionNumber, 2);

      const params = { patchId: created.patchId };
      assert.deepStrictEqual(
        yield* asAdmin
          .publish({ payload: publishRequest({ html: html("Not yours"), ...params }) })
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

const publishConfig = (
  release = CURRENT_RELEASE,
  quota = 100,
  publishLimit = 100,
  createLimit = 100
) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PATCHY_PUBLIC_BASE_URL: "https://patchy.example",
      PATCHY_RELEASE: release,
      PATCHY_WIRE_VERSION: String(WIRE_VERSION),
      PATCHY_PATCH_CREATE_RATE_LIMIT_PER_MINUTE: String(createLimit),
      PATCHY_AUTHENTICATED_PUBLISH_RATE_LIMIT_PER_MINUTE: String(publishLimit),
      PATCHY_LIVE_PATCHES_PER_USER: String(quota)
    })
  );
const publishLayer = Layer.mergeAll(
  PatchesApi.layer,
  PatchesApi.releaseLayer,
  HttpServer.layerServices
).pipe(
  Layer.provideMerge(Fixtures.authorization),
  Layer.provideMerge(Layer.mergeAll(Content.layer, Limits.layer, recordingAnalytics)),
  Layer.provideMerge(Layer.mergeAll(Patches.layer, memoryStore)),
  Layer.provideMerge(Fixtures.database),
  Layer.provide(publishConfig())
);

it.layer(publishLayer)("publish attempts", (it) => {
  it.effect(
    "replays the exact create and update result after a release change without another version",
    () =>
      Effect.gen(function* () {
        const api = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const first = publishRequest({ html: html("Original") });
        const created = yield* api.publish({ payload: first });
        const second = publishRequest({
          html: html("Updated"),
          patchId: created.patchId,
          scope: "public"
        });
        const updated = yield* api.publish({ payload: second });
        const upgraded = yield* client.pipe(
          Effect.provide(Fixtures.as(sibling)),
          Effect.provide(Layer.fresh(PatchesApi.layer.pipe(Layer.provide(publishConfig("9.0.0")))))
        );
        for (const [payload, expected, status] of [
          [first, created, 201],
          [second, updated, 200]
        ] as const) {
          const replayed = yield* upgraded.publish({ payload, responseMode: "response-only" });
          assert.strictEqual(replayed.status, status);
          assert.deepStrictEqual(yield* replayed.json, { ...expected });
        }
        const latest = Option.getOrThrow(yield* (yield* Patches.Patches).find(created.patchId));
        assert.strictEqual(latest.version.versionNumber, 2);
        assert.strictEqual(latest.version.release, CURRENT_RELEASE);
        assert.strictEqual(latest.version.wireVersion, WIRE_VERSION);
        assert.strictEqual(latest.version.tier, 0);
        assert.deepStrictEqual(latest.version.manifest, Fixtures.manifest);
        const refused = yield* upgraded
          .publish({
            payload: publishRequest({ html: html("New attempt"), patchId: created.patchId })
          })
          .pipe(Effect.flip);
        assert.include(refused, { code: "release_mismatch" });
      })
  );

  it.effect(
    "rejects changed payloads under one owner's key but permits the same key for another owner",
    () =>
      Effect.gen(function* () {
        const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const payload = publishRequest({ html: html("One") });
        const created = yield* owner.publish({ payload });
        const changed = yield* owner.publish({
          payload: new PublishRequest({ ...payload, html: html("Different") }),
          responseMode: "response-only"
        });
        assert.strictEqual(changed.status, 409);
        assert.include(yield* changed.json, { code: "publish_key_conflict" });
        assert.include(
          yield* owner
            .publish({
              payload: new PublishRequest({ ...payload, html: html("Different") })
            })
            .pipe(Effect.flip),
          { code: "publish_key_conflict" }
        );
        const foreign = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
        const other = yield* foreign.publish({ payload });
        assert.notStrictEqual(other.patchId, created.patchId);
        assert.strictEqual(
          Option.getOrThrow(yield* (yield* Patches.Patches).find(created.patchId)).version
            .versionNumber,
          1
        );
      })
  );

  it.effect(
    "settles identical concurrent first publishes even when the winner fills the quota",
    () =>
      Effect.gen(function* () {
        const store = yield* ContentStore.ContentStore;
        for (const [identity, quota] of [
          [reader, 100],
          [Fixtures.identities.quota, 1]
        ] as const) {
          const ready = yield* Deferred.make<void>();
          let puts = 0;
          const heldStore = Layer.succeed(
            ContentStore.ContentStore,
            ContentStore.ContentStore.of({
              ...store,
              put: (key, body) =>
                Effect.gen(function* () {
                  yield* store.put(key, body);
                  if (++puts === 2) yield* Deferred.succeed(ready, undefined);
                  yield* Deferred.await(ready);
                })
            })
          );
          const api = yield* client.pipe(
            Effect.provide(Fixtures.as(identity)),
            Effect.provide(
              Layer.fresh(
                PatchesApi.layer.pipe(
                  Layer.provide(Content.layer.pipe(Layer.provide(heldStore))),
                  Layer.provide(publishConfig(CURRENT_RELEASE, quota))
                )
              )
            )
          );
          const payload = publishRequest({ html: html("Concurrent") });
          const [a, b] = yield* Effect.all(
            [
              api.publish({ payload, responseMode: "response-only" }),
              api.publish({ payload, responseMode: "response-only" })
            ],
            { concurrency: "unbounded" }
          );
          assert.strictEqual(a.status, 201);
          assert.strictEqual(b.status, 201);
          assert.strictEqual(yield* a.text, yield* b.text);
          assert.strictEqual(yield* (yield* Patches.Patches).countLive(identity.user.id), 1);
        }
      })
  );

  it.effect("refuses unsupported tiers and unprovisioned resources before writing content", () =>
    Effect.gen(function* () {
      const api = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
      const patches = yield* Patches.Patches;
      const before = yield* patches.countLive(admin.user.id);
      const cases = [
        { manifest: { ...Fixtures.manifest, tier: 1 as const }, code: "tier_mismatch" },
        {
          manifest: {
            ...Fixtures.manifest,
            tables: { notes: { columns: { title: { kind: "text" as const } }, indexes: {} } }
          },
          code: "invalid_manifest"
        },
        { manifest: { ...Fixtures.manifest, files: { images: {} } }, code: "invalid_manifest" },
        {
          manifest: {
            ...Fixtures.manifest,
            uses: {
              sales: { kind: "postgres" as const, handle: "warehouse", id: "conn_1", revision: 1 }
            }
          },
          code: "invalid_manifest"
        }
      ];
      for (const { manifest, code } of cases) {
        const response = yield* api.publish({
          payload: publishRequest({ html: html("Unsupported"), manifest }),
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, 422);
        assert.include(yield* response.json, { code });
      }
      assert.strictEqual(yield* patches.countLive(admin.user.id), before);
    })
  );

  it.effect("recovers a stored attempt even after the publishing machine is rate limited", () =>
    Effect.gen(function* () {
      const api = yield* client.pipe(
        Effect.provide(Fixtures.as(Fixtures.identities.quotaSibling)),
        Effect.provide(
          Layer.fresh(PatchesApi.layer.pipe(Layer.provide(publishConfig(CURRENT_RELEASE, 100, 1))))
        )
      );
      const payload = publishRequest({ html: html("Recoverable") });
      const first = yield* api.publish({ payload, responseMode: "response-only" });
      const refused = yield* api
        .publish({ payload: publishRequest({ html: html("New") }) })
        .pipe(Effect.flip);
      assert.include(refused, { code: "rate_limited" });
      const replayed = yield* api.publish({ payload, responseMode: "response-only" });
      assert.strictEqual(replayed.status, first.status);
      assert.strictEqual(yield* replayed.text, yield* first.text);
    })
  );

  it.effect("charges refused creates before validation but never charges stored replays", () =>
    Effect.gen(function* () {
      for (const [manifest, code] of [
        [{ ...Fixtures.manifest, release: "9.0.0" }, "release_mismatch"],
        [null, "invalid_manifest"]
      ] as const) {
        yield* Effect.gen(function* () {
          const payload = publishRequest({ html: html("Recoverable create") });
          const api = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
          const first = yield* api.publish({ payload });
          assert.deepStrictEqual(yield* api.publish({ payload }), first);
          const invalid = publishRequest({ html: html("Refused create") });
          const raw = yield* client.pipe(
            Effect.provide(
              HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
                next(
                  request.pipe(
                    HttpClientRequest.bearerToken(uploader.machine.id),
                    HttpClientRequest.bodyJsonUnsafe({ ...invalid, manifest })
                  )
                )
              )
            )
          );
          const rejected = yield* raw.publish({ payload: invalid, responseMode: "response-only" });
          assert.strictEqual(rejected.status, 422);
          assert.include(yield* rejected.json, { code });
          const throttled = yield* api.publish({
            payload: publishRequest({ html: html("New create") }),
            responseMode: "response-only"
          });
          assert.strictEqual(throttled.status, 429);
          assert.include(yield* throttled.json, { code: "rate_limited" });
          assert.deepStrictEqual(yield* api.publish({ payload }), first);
          const updated = yield* api.publish({
            payload: publishRequest({ html: html("Update still admitted"), patchId: first.patchId })
          });
          assert.strictEqual(updated.versionNumber, 2);
        }).pipe(
          Effect.provide(
            Layer.fresh(
              PatchesApi.layer.pipe(
                Layer.provide(Limits.layer),
                Layer.provide(publishConfig(CURRENT_RELEASE, 100, 100, 2))
              )
            )
          )
        );
      }
    })
  );

  it.effect(
    "checks raw manifest shapes and stamps the wire itself, never trusting a client field",
    () =>
      Effect.gen(function* () {
        const payload = publishRequest({ html: html("Wire stamp") });
        for (const [body, status] of [
          [{ ...payload, manifest: { ...Fixtures.manifest, tables: [] } }, 422],
          [{ ...payload, wireVersion: 999 }, 201],
          [{ publishKey: payload.publishKey, manifest: null }, 409]
        ] as const) {
          const api = yield* client.pipe(
            Effect.provide(
              HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
                next(
                  request.pipe(
                    HttpClientRequest.bearerToken(admin.machine.id),
                    HttpClientRequest.bodyJsonUnsafe(body)
                  )
                )
              )
            )
          );
          const response = yield* api.publish({ payload, responseMode: "response-only" });
          assert.strictEqual(response.status, status);
          const json = yield* response.json;
          if (status === 201) {
            const published = Schema.decodeUnknownSync(PublishCreated)(json);
            const version = Option.getOrThrow(
              yield* (yield* Patches.Patches).find(published.patchId)
            ).version;
            assert.strictEqual(version.wireVersion, WIRE_VERSION);
          } else {
            assert.include(json, {
              code: status === 422 ? "invalid_manifest" : "publish_key_conflict"
            });
          }
        }
      })
  );

  it.effect("discovers the current release without a bearer or a fabricated integrity", () =>
    Effect.gen(function* () {
      const api = yield* HttpApiTest.groups(PatchyApi, ["release"]);
      const release = yield* api.release();
      assert.deepStrictEqual(
        { ...release },
        {
          release: CURRENT_RELEASE,
          manifestVersion: Fixtures.manifest.manifestVersion,
          wireVersion: WIRE_VERSION,
          package: {
            tarball: `https://patchy.example/sdk/patchy-${CURRENT_RELEASE}.tgz`,
            integrity: null
          }
        }
      );
    })
  );
});
