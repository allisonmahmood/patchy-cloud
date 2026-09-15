import { assert, expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import {
  Authorization,
  PatchyApi,
  PatchesGroup,
  ShareRequest,
  ForceRequest,
  DescriptionRequest,
  RollbackRequest,
  PublishCreated,
  PublishRequest,
  PublishUpdated,
  NotAdditive,
  CURRENT_RELEASE,
  WIRE_VERSION,
  sharedTableId
} from "@patchy/api";
import { ContentStore } from "@patchy/content-store";
import { Limits } from "@patchy/limits";
import { ConnectionStore, SqlConnectionStore, PostgresSource } from "@patchy/integrations";
import * as Content from "./Content.js";
import * as Patches from "./Patches.js";
import * as PatchesApi from "./PatchesApi.js";
import * as PatchesConfig from "./PatchesConfig.js";
import * as Fixtures from "./test/fixtures.js";

const { admin, reader, sibling, uploader } = Fixtures.identities;

const memoryStore = Layer.sync(ContentStore.ContentStore, () => {
  const objects = new Map<string, { bytes: Uint8Array; lastModified: number }>();
  return ContentStore.ContentStore.of({
    list: (prefix) =>
      Stream.suspend(() =>
        Stream.fromIterable(
          [...objects]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, object]) => ({ key, lastModified: object.lastModified }))
        )
      ),
    put: Effect.fn(function* (key, html) {
      objects.set(key, {
        bytes: new TextEncoder().encode(html),
        lastModified: yield* Clock.currentTimeMillis
      });
    }),
    get: (key) =>
      Effect.suspend(() => {
        const bytes = objects.get(key)?.bytes;
        return bytes === undefined
          ? Effect.fail(new ContentStore.ObjectNotFound({ key }))
          : Effect.succeed(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));
      }),
    putBytes: Effect.fn(function* (key, bytes) {
      objects.set(key, { bytes: bytes.slice(), lastModified: yield* Clock.currentTimeMillis });
    }),
    getBytes: (key) =>
      Effect.suspend(() => {
        const bytes = objects.get(key)?.bytes;
        return bytes === undefined
          ? Effect.fail(new ContentStore.ObjectNotFound({ key }))
          : Effect.succeed(bytes.slice());
      }),
    delete: (key) => Effect.sync(() => void objects.delete(key))
  });
});

const client = HttpApiTest.groups(PatchyApi, ["patches"]);
const decodeNotAdditive = Schema.decodeUnknownEffect(NotAdditive);
const decodeCreated = Schema.decodeUnknownSync(PublishCreated);

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
const publish = (payload: PublishPayload) =>
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
      const created = yield* publish({
        html: html("First"),
        metadata: { filename: "Launch Plan.HTML" }
      }).pipe(Effect.provide(Fixtures.as(uploader)));
      assert.instanceOf(created, PublishCreated);
      assert.strictEqual(created.title, "First");
      assert.strictEqual(created.scope, "company");
      assert.strictEqual(created.name, "launch-plan");
      assert.strictEqual(
        created.address,
        `https://patchy.example/${uploader.company.handle}/launch-plan`
      );
      assert.strictEqual(created.publicUrl, created.address);
      assert.deepStrictEqual(created.warnings, []);

      const updated = yield* publish({
        html: html("Second"),
        patchId: created.patchId,
        scope: "public"
      }).pipe(Effect.provide(Fixtures.as(sibling)));
      assert.instanceOf(updated, PublishUpdated);
      assert.strictEqual(updated.versionNumber, 2);
      assert.strictEqual(updated.scope, "public");
      assert.strictEqual(updated.name, created.name);
      assert.strictEqual(updated.address, created.address);

      const preserved = yield* publish({ html: html("Third"), patchId: created.patchId }).pipe(
        Effect.provide(Fixtures.as(sibling))
      );
      assert.strictEqual(preserved.scope, "public");
      const restricted = yield* publish({
        html: html("Fourth"),
        patchId: created.patchId,
        scope: "company",
        manifest: { ...Fixtures.manifest, name: "launch-notes" }
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
      assert.strictEqual(restricted.name, "launch-notes");
      assert.strictEqual(served.patch.name, restricted.name);
      assert.strictEqual(served.patch.companyHandle, uploader.company.handle);
      assert.deepStrictEqual(
        {
          ...Option.getOrThrow(
            yield* (yield* Patches.Patches).resolveName(uploader.company.handle, created.name)
          )
        },
        { patchId: created.patchId, name: restricted.name, current: false }
      );
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

        const nonOwner = yield* anotherUser
          .share({ params, payload: new ShareRequest({ scope: "company" }) })
          .pipe(Effect.flip);
        assert.include(nonOwner, { ok: false, code: "not_owner" });
        expect(nonOwner).toMatchObject({
          owner: { id: uploader.user.id, name: uploader.user.name }
        });
        assert.deepStrictEqual(
          yield* anotherUser
            .share({
              params: { patchId: "abcdefabcdef" },
              payload: new ShareRequest({ scope: "company" })
            })
            .pipe(Effect.flip),
          { ok: false, error: "Patch not found." }
        );
        assert.strictEqual(
          Option.getOrThrow(yield* patches.find(created.patchId)).patch.scope,
          "public"
        );
        yield* owner.delete({ params, query: {} });
        assert.include(
          yield* sameUser
            .share({ params, payload: new ShareRequest({ scope: "public" }) })
            .pipe(Effect.flip),
          { ok: false, code: "wrong_state", state: "deleted" }
        );
      })
  );

  it.effect("rejects null or unknown scopes on publish and share", () =>
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
        const publishResponse = yield* api.publish({
          payload: publishRequest({ html: html("Invalid scope") }),
          responseMode: "response-only"
        });
        assert.strictEqual(publishResponse.status, 400);
        expect(yield* publishResponse.json).toEqual({ ok: false, error: expect.any(String) });
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
      const invalid = yield* publish({ html: "<script>alert(1)</script>" }).pipe(
        Effect.provide(asUploader),
        Effect.flip
      );
      assert.include(invalid, { ok: false, code: "tier_mismatch" });

      const admins = yield* publish({ html: html("Theirs") }).pipe(
        Effect.provide(Fixtures.as(admin))
      );
      assert.include(
        yield* publish({ html: html("x"), patchId: admins.patchId }).pipe(
          Effect.provide(asUploader),
          Effect.flip
        ),
        { ok: false, code: "not_owner" }
      );
      assert.deepStrictEqual(
        yield* publish({ html: html("x"), patchId: "abcdefabcdef" }).pipe(
          Effect.provide(asUploader),
          Effect.flip
        ),
        { ok: false, error: "Patch not found." }
      );
    })
  );

  it.effect(
    "throttles creates per machine and keeps the owner's quota across machine changes",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const as = Fixtures.as(Fixtures.identities.quota);
        const first = yield* publish({ html: html("One") }).pipe(Effect.provide(as));
        yield* publish({ html: html("Two") }).pipe(Effect.provide(as));
        const quota = yield* publish({ html: html("Three") }).pipe(Effect.provide(as), Effect.flip);
        assert.include(quota, { ok: false, code: "live_patch_quota_exceeded", quota: 2 });
        const asSibling = Fixtures.as(Fixtures.identities.quotaSibling);
        const newMachineQuota = yield* publish({ html: html("New machine") }).pipe(
          Effect.provide(asSibling),
          Effect.flip
        );
        assert.include(newMachineQuota, { ok: false, code: "live_patch_quota_exceeded", quota: 2 });
        // The bucket is spent before the quota is counted.
        const throttled = yield* publish({ html: html("Four") }).pipe(
          Effect.provide(as),
          Effect.flip
        );
        assert.include(throttled, { ok: false, code: "rate_limited", retryAfterSeconds: 60 });
        // An update costs nothing against either.
        const updated = yield* publish({ html: html("Still one"), patchId: first.patchId }).pipe(
          Effect.provide(asSibling)
        );
        assert.strictEqual(updated.versionNumber, 2);

        // Deleting one returns its slot.
        yield* TestClock.adjust("1 minute");
        const api = yield* client.pipe(Effect.provide(as));
        yield* api.delete({ params: { patchId: first.patchId }, query: {} });
        yield* publish({ html: html("Three again") }).pipe(Effect.provide(as));
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
      expect(
        yield* asAdmin
          .publish({ payload: publishRequest({ html: html("Not yours"), ...params }) })
          .pipe(Effect.flip)
      ).toMatchObject({
        ok: false,
        code: "not_owner",
        owner: { id: reader.user.id, name: reader.user.name }
      });
      assert.include(yield* asAdmin.delete({ params, query: {} }).pipe(Effect.flip), {
        ok: false,
        code: "not_owner"
      });
      const content = yield* Content.Content;
      const patches = yield* Patches.Patches;
      const current = Option.getOrThrow(yield* patches.find(created.patchId));
      assert.include(yield* content.read(current.version), "Owner update");

      assert.isTrue((yield* asOwner.delete({ params, query: {} })).ok);
      assert.isTrue(Option.isNone(yield* patches.find(created.patchId)));
      assert.include(yield* asOwner.delete({ params, query: {} }).pipe(Effect.flip), {
        ok: false,
        code: "wrong_state",
        state: "deleted"
      });
    })
  );
});

const publishConfig = (
  release = CURRENT_RELEASE,
  quota = 100,
  publishLimit = 100,
  createLimit = 100,
  bounds: Readonly<Record<string, string>> = {}
) =>
  Layer.merge(
    Layer.succeed(PatchesConfig.release, release),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        PATCHY_PUBLIC_BASE_URL: "https://patchy.example",
        PATCHY_PATCH_CREATE_RATE_LIMIT_PER_MINUTE: String(createLimit),
        PATCHY_AUTHENTICATED_PUBLISH_RATE_LIMIT_PER_MINUTE: String(publishLimit),
        PATCHY_LIVE_PATCHES_PER_USER: String(quota),
        ...bounds
      })
    )
  );
const publishLayer = Layer.mergeAll(PatchesApi.layer, HttpServer.layerServices).pipe(
  Layer.provideMerge(Fixtures.authorization),
  Layer.provideMerge(Layer.mergeAll(Content.layer, Limits.layer, recordingAnalytics)),
  Layer.provideMerge(Layer.mergeAll(Patches.layer, memoryStore)),
  Layer.provideMerge(Fixtures.database),
  Layer.provide(publishConfig())
);

const lifecycleSocketLayer = HttpRouter.serve(
  HttpApiBuilder.layer(HttpApi.make("patchy").add(PatchesGroup)),
  { disableLogger: true, disableListenLog: true }
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(publishLayer));

it.layer(Layer.fresh(lifecycleSocketLayer))("owner lifecycle body bounds on a socket", (it) => {
  for (const route of ["retire", "restore", "rollback", "description"] as const) {
    it.effect(`bounds ${route} bodies before mutation and accepts ordinary owner requests`, () =>
      Effect.gen(function* () {
        const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const first = yield* owner.publish({
          payload: publishRequest({
            html: html(`Bounded ${route} first`),
            manifest: { ...Fixtures.manifest, description: "Original description" }
          })
        });
        const params = { patchId: first.patchId };
        const second = yield* owner.publish({
          payload: publishRequest({ ...params, html: html(`Bounded ${route} second`) })
        });
        if (route === "restore") {
          yield* owner.retire({ params, payload: new ForceRequest({}) });
        }
        const http = yield* HttpClient.HttpClient;
        const sql = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        const snapshot = sql`
          SELECT current_version_id, description, description_updated_at,
            retired_at, deleted_at, last_changed_at
          FROM patches WHERE id = ${first.patchId}`;
        const before = yield* snapshot;
        const description = String.fromCodePoint(0x20000).repeat(500);
        const payload =
          route === "description"
            ? { description }
            : route === "rollback"
              ? { versionNumber: 1 }
              : { force: true };
        const padding = " ".repeat(4 * 1024 * 1024);
        const padded =
          route === "description"
            ? JSON.stringify({ description: padding + description })
            : JSON.stringify(payload) + padding;
        const bytes = new TextEncoder().encode(padded);
        const request = HttpClientRequest.make(route === "description" ? "PUT" : "POST")(
          `/api/patches/${first.patchId}/${route}`
        ).pipe(HttpClientRequest.bearerToken(uploader.machine.id));

        const declared = yield* http.execute(
          request.pipe(HttpClientRequest.bodyText(padded, "application/json"))
        );
        assert.strictEqual(declared.status, 413);
        expect(yield* declared.json).toEqual({ ok: false, error: expect.any(String) });
        assert.deepStrictEqual(yield* snapshot, before);

        const chunked = request.pipe(
          HttpClientRequest.bodyStream(
            Stream.fromIterable([bytes.subarray(0, 1024), bytes.subarray(1024)]),
            { contentType: "application/json" }
          )
        );
        // Node closes the socket when an undeclared body crosses the cap.
        const failure = yield* http.execute(chunked).pipe(Effect.flip);
        assert.strictEqual(failure.reason._tag, "TransportError");
        assert.deepStrictEqual(yield* snapshot, before);

        for (const malformed of ["{", '{"force":"yes","versionNumber":0,"description":null}']) {
          const response = yield* http.execute(
            request.pipe(HttpClientRequest.bodyText(malformed, "application/json"))
          );
          assert.strictEqual(response.status, 400);
          expect(yield* response.json).toEqual({ ok: false, error: expect.any(String) });
        }
        assert.deepStrictEqual(yield* snapshot, before);

        const accepted = yield* http.execute(
          request.pipe(HttpClientRequest.bodyJsonUnsafe(payload))
        );
        assert.strictEqual(accepted.status, 200);
        expect(yield* accepted.json).toMatchObject({ ok: true, patchId: first.patchId });
        if (route === "retire") {
          assert.isTrue(Option.isNone(yield* patches.find(first.patchId)));
          yield* owner.restore({ params, payload: new ForceRequest({}) });
        }
        const current = Option.getOrThrow(yield* patches.find(first.patchId));
        assert.strictEqual(
          current.version.id,
          route === "rollback" ? first.versionId : second.versionId
        );
        assert.strictEqual(
          current.patch.description,
          route === "description" ? description : first.description
        );
        const versions = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM patch_versions WHERE patch_id = ${first.patchId}`;
        assert.strictEqual(versions[0]!.count, 2);
      })
    );
  }
});

it.layer(Layer.fresh(publishLayer))("owner lifecycle over machine tokens", (it) => {
  it.effect("retires, describes, restores, rolls back and deletes without replacing versions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const first = yield* owner.publish({
        payload: publishRequest({
          html: html("Lifecycle first"),
          manifest: { ...Fixtures.manifest, description: "  Tracks\u2003orders.  " }
        })
      });
      assert.strictEqual(first.description, "Tracks orders.");
      assert.strictEqual(first.descriptionUpdatedAt, "2026-01-01T00:00:00.000Z");
      const params = { patchId: first.patchId };
      yield* TestClock.adjust("1 minute");
      const second = yield* owner.publish({
        payload: publishRequest({ ...params, html: html("Lifecycle second") })
      });
      assert.strictEqual(second.description, first.description);
      assert.strictEqual(second.descriptionUpdatedAt, first.descriptionUpdatedAt);
      const retired = yield* owner.retire({ params, payload: new ForceRequest({}) });
      expect(retired).toMatchObject({
        ok: true,
        ...params,
        state: "retired",
        retiredAt: "2026-01-01T00:01:00.000Z"
      });
      const patches = yield* Patches.Patches;
      assert.isTrue(Option.isNone(yield* patches.find(first.patchId)));
      const described = yield* owner.describe({
        params,
        payload: new DescriptionRequest({ description: "<b>Tracks</b>\n\torders." })
      });
      assert.strictEqual(described.description, "<b>Tracks</b> orders.");
      expect(yield* owner.restore({ params, payload: new ForceRequest({}) })).toMatchObject({
        ok: true,
        ...params,
        state: "live"
      });
      expect(
        yield* owner.rollback({ params, payload: new RollbackRequest({ versionNumber: 1 }) })
      ).toMatchObject({
        ok: true,
        ...params,
        currentVersion: 1,
        address: first.address
      });
      const rolledBack = Option.getOrThrow(yield* patches.find(first.patchId));
      assert.strictEqual(rolledBack.version.id, first.versionId);
      assert.strictEqual(rolledBack.patch.description, described.description);
      const next = yield* owner.publish({
        payload: publishRequest({ ...params, html: html("After rollback") })
      });
      assert.strictEqual(next.versionNumber, 3);
      assert.strictEqual(next.description, described.description);
      assert.strictEqual(next.descriptionUpdatedAt, described.descriptionUpdatedAt);
      const deleted = yield* owner.delete({ params, query: {} });
      expect(deleted).toMatchObject({
        ok: true,
        ...params,
        state: "deleted",
        deletedAt: "2026-01-01T00:01:00.000Z",
        purgeAt: "2026-01-31T00:01:00.000Z"
      });
      yield* owner.restore({ params, payload: new ForceRequest({}) });
      assert.strictEqual(
        Option.getOrThrow(yield* patches.find(first.patchId)).version.id,
        next.versionId
      );
    })
  );

  it.effect("returns each owner refusal before inspecting invalid publish bytes", () =>
    Effect.gen(function* () {
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const nonOwner = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
      const patches = yield* Patches.Patches;
      const store = yield* ContentStore.ContentStore;
      for (const state of ["live", "retired", "deleted"] as const) {
        const created = yield* owner.publish({
          payload: publishRequest({ html: html(`Owner refusal ${state}`) })
        });
        const params = { patchId: created.patchId };
        if (state === "retired") yield* owner.retire({ params, payload: new ForceRequest({}) });
        if (state === "deleted") yield* owner.delete({ params, query: {} });
        const before = yield* Stream.runCollect(store.list("patches/"));
        const options = { params, responseMode: "response-only" as const };
        for (const response of [
          yield* nonOwner.publish({
            payload: publishRequest({
              ...params,
              html: "<script>bad()</script>",
              manifest: { ...Fixtures.manifest, release: "not-current" }
            }),
            responseMode: "response-only"
          }),
          yield* nonOwner.retire({ ...options, payload: new ForceRequest({}) }),
          yield* nonOwner.delete({ ...options, query: {} }),
          yield* nonOwner.restore({ ...options, payload: new ForceRequest({}) }),
          yield* nonOwner.rollback({
            ...options,
            payload: new RollbackRequest({ versionNumber: 999 })
          }),
          yield* nonOwner.describe({
            ...options,
            payload: new DescriptionRequest({ description: "\u0000" })
          }),
          yield* nonOwner.share({ ...options, payload: new ShareRequest({ scope: "public" }) })
        ]) {
          assert.strictEqual(response.status, 403);
          expect(yield* response.json).toMatchObject({
            ok: false,
            code: "not_owner",
            owner: { id: uploader.user.id, name: uploader.user.name }
          });
        }
        if (state !== "live") {
          const response = yield* owner.publish({
            payload: publishRequest({ ...params, html: "<script>bad()</script>" }),
            responseMode: "response-only"
          });
          assert.strictEqual(response.status, 409);
          expect(yield* response.json).toMatchObject({
            code: state === "retired" ? "patch_retired" : "patch_deleted",
            ...(state === "deleted" ? { purgeAt: expect.any(String) } : {})
          });
        }
        assert.deepStrictEqual(yield* Stream.runCollect(store.list("patches/")), before);
        assert.strictEqual(Option.isSome(yield* patches.find(created.patchId)), state === "live");
      }
    })
  );

  it.effect("reports wrong states, unavailable versions and the recovery deadline", () =>
    Effect.gen(function* () {
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const created = yield* owner.publish({
        payload: publishRequest({ html: html("State gates") })
      });
      const params = { patchId: created.patchId };
      assert.include(
        yield* owner.restore({ params, payload: new ForceRequest({}) }).pipe(Effect.flip),
        {
          code: "wrong_state",
          state: "live"
        }
      );
      const absent = yield* owner.rollback({
        params,
        payload: new RollbackRequest({ versionNumber: 999 }),
        responseMode: "response-only"
      });
      assert.strictEqual(absent.status, 422);
      assert.include(yield* absent.json, { code: "version_unavailable" });
      yield* owner.retire({ params, payload: new ForceRequest({}) });
      assert.include(
        yield* owner.retire({ params, payload: new ForceRequest({}) }).pipe(Effect.flip),
        {
          code: "wrong_state",
          state: "retired"
        }
      );
      for (const response of [
        yield* owner.rollback({
          params,
          payload: new RollbackRequest({ versionNumber: 1 }),
          responseMode: "response-only"
        }),
        yield* owner.share({
          params,
          payload: new ShareRequest({ scope: "public" }),
          responseMode: "response-only"
        })
      ]) {
        assert.strictEqual(response.status, 409);
        assert.include(yield* response.json, { code: "wrong_state", state: "retired" });
      }
      const deleted = yield* owner.delete({ params, query: {} });
      for (const response of [
        yield* owner.delete({ params, query: {}, responseMode: "response-only" }),
        yield* owner.retire({
          params,
          payload: new ForceRequest({}),
          responseMode: "response-only"
        }),
        yield* owner.rollback({
          params,
          payload: new RollbackRequest({ versionNumber: 1 }),
          responseMode: "response-only"
        }),
        yield* owner.describe({
          params,
          payload: new DescriptionRequest({ description: "Cannot edit deleted" }),
          responseMode: "response-only"
        }),
        yield* owner.share({
          params,
          payload: new ShareRequest({ scope: "public" }),
          responseMode: "response-only"
        })
      ]) {
        assert.strictEqual(response.status, 409);
        assert.include(yield* response.json, { code: "wrong_state", state: "deleted" });
      }
      yield* TestClock.adjust("30 days");
      assert.include(
        yield* owner.restore({ params, payload: new ForceRequest({}) }).pipe(Effect.flip),
        {
          code: "patch_deleted",
          purgeAt: deleted.purgeAt
        }
      );
    })
  );

  it.effect("normalizes descriptions, counts code points and preserves no-op stamps", () =>
    Effect.gen(function* () {
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const created = yield* owner.publish({
        payload: publishRequest({
          html: html("Description bounds"),
          manifest: { ...Fixtures.manifest, description: "Manifest text" },
          metadata: { description: " File\u00a0description " }
        })
      });
      assert.strictEqual(created.description, "File description");
      const params = { patchId: created.patchId };
      const atLimit = "\u{1F680}".repeat(500);
      yield* TestClock.adjust("1 second");
      const described = yield* owner.describe({
        params,
        payload: new DescriptionRequest({ description: atLimit })
      });
      assert.strictEqual(described.description, atLimit);
      yield* TestClock.adjust("1 second");
      const unchanged = yield* owner.describe({
        params,
        payload: new DescriptionRequest({ description: ` \t${atLimit}\n ` })
      });
      assert.strictEqual(unchanged.descriptionUpdatedAt, described.descriptionUpdatedAt);
      for (const description of [
        atLimit + "x",
        " \n\t ",
        "bad\u0000text",
        "bad\u007ftext",
        "bad\u0085text"
      ]) {
        const response = yield* owner.describe({
          params,
          payload: new DescriptionRequest({ description }),
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, 422);
        assert.include(yield* response.json, { code: "invalid_description" });
      }
      const invalidPublish = yield* owner.publish({
        payload: publishRequest({
          ...params,
          html: html("Invalid description"),
          metadata: { description: "bad\u0000text" }
        }),
        responseMode: "response-only"
      });
      assert.strictEqual(invalidPublish.status, 422);
      assert.include(yield* invalidPublish.json, { code: "invalid_description" });
      const current = Option.getOrThrow(yield* (yield* Patches.Patches).find(created.patchId));
      assert.strictEqual(current.patch.description, atLimit);
      assert.strictEqual(current.version.id, created.versionId);
      const cleared = yield* owner.describe({
        params,
        payload: new DescriptionRequest({ description: "" })
      });
      assert.strictEqual(cleared.description, "");
      assert.notStrictEqual(cleared.descriptionUpdatedAt, described.descriptionUpdatedAt);
      for (const name of ["patches", "connections"]) {
        const response = yield* owner.publish({
          payload: publishRequest({
            html: html("Reserved name"),
            manifest: { ...Fixtures.manifest, name }
          }),
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, 422);
        assert.include(yield* response.json, { code: "reserved_name" });
      }
    })
  );

  it.effect("requires tokens and hides unknown and foreign patches on every owner route", () =>
    Effect.gen(function* () {
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const anonymous = yield* client.pipe(
        Effect.provide(
          HttpApiMiddleware.layerClient(Authorization, ({ next, request }) => next(request))
        )
      );
      const created = yield* owner.publish({ payload: publishRequest({ html: html("Foreign") }) });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO companies (id, handle, name)
        VALUES ('cmp_owner_wire_foreign', 'owner-wire-foreign', 'Foreign')`;
      yield* sql`UPDATE patches SET company_id = 'cmp_owner_wire_foreign' WHERE id = ${created.patchId}`;
      for (const [api, patchId, status] of [
        [owner, created.patchId, 404],
        [owner, "abcdefghijkl", 404],
        [anonymous, created.patchId, 401]
      ] as const) {
        const options = { params: { patchId }, responseMode: "response-only" as const };
        for (const response of [
          yield* api.publish({
            payload: publishRequest({ patchId, html: "" }),
            responseMode: "response-only"
          }),
          yield* api.retire({ ...options, payload: new ForceRequest({}) }),
          yield* api.delete({ ...options, query: {} }),
          yield* api.restore({ ...options, payload: new ForceRequest({}) }),
          yield* api.rollback({ ...options, payload: new RollbackRequest({ versionNumber: 1 }) }),
          yield* api.describe({
            ...options,
            payload: new DescriptionRequest({ description: "No leak" })
          }),
          yield* api.share({ ...options, payload: new ShareRequest({ scope: "public" }) })
        ]) {
          assert.strictEqual(response.status, status);
          const body = yield* response.json;
          expect(body).toEqual({ ok: false, error: expect.any(String) });
        }
      }
    })
  );
  it.effect("names dependants and off sources and admits force only when requested", () =>
    Effect.gen(function* () {
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const consumerOwner = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
      const sources: Array<PublishCreated | PublishUpdated> = [];
      for (const name of ["lifecycle-gone", "lifecycle-retired", "lifecycle-deleted"]) {
        sources.push(
          yield* owner.publish({
            payload: publishRequest({
              html: html(name),
              manifest: {
                ...Fixtures.manifest,
                name,
                tables: {
                  orders: {
                    description: "Notes keyed by id.",
                    columns: {},
                    indexes: {},
                    shared: true
                  }
                }
              }
            })
          })
        );
      }
      const [gone, retired, deleted] = sources;
      const uses = Object.fromEntries(
        sources.map((source, index) => [
          `source${index}`,
          {
            kind: "sharedTable" as const,
            patchId: source.patchId,
            table: "orders",
            id: sharedTableId(source.patchId, "orders"),
            revision: source.schemaRevision
          }
        ])
      );
      const consumer = yield* consumerOwner.publish({
        payload: publishRequest({
          html: html("Lifecycle reader"),
          manifest: { ...Fixtures.manifest, name: "lifecycle-reader", uses }
        })
      });
      const params = { patchId: gone!.patchId };
      for (const response of [
        yield* owner.retire({
          params,
          payload: new ForceRequest({}),
          responseMode: "response-only"
        }),
        yield* owner.delete({ params, query: { force: false }, responseMode: "response-only" })
      ]) {
        assert.strictEqual(response.status, 409);
        expect(yield* response.json).toMatchObject({
          code: "has_dependants",
          dependants: [
            {
              patchId: consumer.patchId,
              name: consumer.name,
              owner: { id: reader.user.id, name: reader.user.name }
            }
          ]
        });
      }
      yield* owner.retire({ params, payload: new ForceRequest({ force: true }) });
      yield* owner.restore({ params, payload: new ForceRequest({}) });
      const bareForce = yield* client.pipe(
        Effect.provide(
          HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
            next(
              request.pipe(
                HttpClientRequest.bearerToken(uploader.machine.id),
                HttpClientRequest.setUrlParam("force", "")
              )
            )
          )
        )
      );
      yield* bareForce.delete({ params, query: {} });
      yield* TestClock.adjust("30 days");
      yield* (yield* Patches.Patches).purgeDeleted(gone!.patchId);
      yield* owner.retire({
        params: { patchId: retired!.patchId },
        payload: new ForceRequest({ force: true })
      });
      yield* owner.delete({ params: { patchId: deleted!.patchId }, query: { force: true } });
      const consumerParams = { patchId: consumer.patchId };
      yield* consumerOwner.retire({ params: consumerParams, payload: new ForceRequest({}) });
      const warning = yield* consumerOwner.restore({
        params: consumerParams,
        payload: new ForceRequest({}),
        responseMode: "response-only"
      });
      assert.strictEqual(warning.status, 409);
      const body = yield* warning.json;
      expect(body).toMatchObject({
        code: "sources_off",
        sources: expect.arrayContaining([
          { patchId: gone!.patchId, table: "orders", state: "gone" },
          { patchId: retired!.patchId, name: retired!.name, table: "orders", state: "retired" },
          { patchId: deleted!.patchId, name: deleted!.name, table: "orders", state: "deleted" }
        ])
      });
      expect(
        yield* consumerOwner.restore({
          params: consumerParams,
          payload: new ForceRequest({ force: true })
        })
      ).toMatchObject({ ok: true, patchId: consumer.patchId, state: "live" });
      assert.strictEqual(
        Option.getOrThrow(yield* (yield* Patches.Patches).find(consumer.patchId)).version.id,
        consumer.versionId
      );
    })
  );
});

it.layer(
  Layer.fresh(publishLayer).pipe(
    Layer.provide(
      Layer.succeed(
        Patches.Openability,
        (patch, userId) => patch.name !== "hidden-discovery" || userId === uploader.user.id
      )
    )
  )
)("patch discovery over machine tokens", (it) => {
  it.effect("reports unavailable inventory without inventing an empty database", () =>
    Effect.gen(function* () {
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const colleague = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
      const created = yield* owner.publish({
        payload: publishRequest({
          html: html("No company database"),
          manifest: { ...Fixtures.manifest, name: "discovery-no-database" }
        })
      });
      const [detail, response] = yield* colleague.detail({
        params: { patchRef: created.patchId },
        query: {},
        responseMode: "decoded-and-response"
      });
      assert.isNull(detail.inventory);
      assert.strictEqual(response.headers["cache-control"], "private, no-store");
      const primitive = yield* colleague.primitive({
        params: { patchRef: created.patchId, name: "notes" },
        query: {},
        responseMode: "response-only"
      });
      assert.strictEqual(primitive.status, 503);
      expect(yield* primitive.json).toMatchObject({ code: "source_unavailable" });
    })
  );

  it.effect("hides unopenable patches before resolving state and respects mine", () =>
    Effect.gen(function* () {
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const colleague = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
      const created = yield* owner.publish({
        payload: publishRequest({
          html: html("Hidden"),
          manifest: { ...Fixtures.manifest, name: "hidden-discovery" }
        })
      });
      expect(
        (yield* owner.list({ query: { mine: true } })).patches.map((patch) => patch.id)
      ).toContain(created.patchId);
      expect(
        (yield* colleague.list({ query: { state: "all" } })).patches.map((patch) => patch.id)
      ).not.toContain(created.patchId);
      assert.deepStrictEqual((yield* colleague.list({ query: { mine: true } })).patches, []);
      for (const patchRef of [created.patchId, created.name, "unknown-discovery"]) {
        const response = yield* colleague.detail({
          params: { patchRef },
          query: { state: "retired" },
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, 404);
        assert.deepStrictEqual(yield* response.json, { ok: false, error: "Patch not found." });
      }
    })
  );

  it.effect("resolves names before state filters and deleted patches only by id", () =>
    Effect.gen(function* () {
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const colleague = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
      const created = yield* owner.publish({
        payload: publishRequest({
          html: html("State resolution"),
          manifest: {
            ...Fixtures.manifest,
            name: "discovery-states",
            tables: { notes: { description: "Notes.", columns: {}, indexes: {}, shared: true } }
          }
        })
      });
      const params = { patchId: created.patchId };
      for (const [state, filter] of [
        ["live", "retired"],
        ["retired", "live"],
        ["deleted", "live"]
      ] as const) {
        const patchRef = state === "deleted" ? created.patchId : created.name;
        for (const response of [
          yield* colleague.detail({
            params: { patchRef },
            query: { state: filter },
            responseMode: "response-only"
          }),
          yield* colleague.primitive({
            params: { patchRef, name: "notes" },
            query: { state: filter },
            responseMode: "response-only"
          })
        ]) {
          assert.strictEqual(response.status, 409);
          expect(yield* response.json).toMatchObject({ code: "wrong_state", state });
        }
        if (state === "live") {
          yield* owner.retire({ params, payload: new ForceRequest({}) });
          const retired = yield* colleague.detail({
            params: { patchRef: created.name },
            query: { state: "retired" }
          });
          expect(retired.inventory?.tables).toContainEqual(
            expect.objectContaining({ name: "notes", declarable: false, reason: "source_off" })
          );
        } else if (state === "retired") {
          yield* owner.delete({ params, query: {} });
        }
      }
      const deleted = yield* colleague.detail({
        params: { patchRef: created.patchId },
        query: { state: "all" }
      });
      assert.strictEqual(
        Date.parse(deleted.purgeAt!) - Date.parse(deleted.deletedAt!),
        30 * 24 * 60 * 60 * 1000
      );
      const byName = yield* colleague.detail({
        params: { patchRef: created.name },
        query: { state: "all" },
        responseMode: "response-only"
      });
      assert.strictEqual(byName.status, 404);
      expect((yield* colleague.list({ query: {} })).patches.map((patch) => patch.id)).not.toContain(
        created.patchId
      );
      expect(
        (yield* colleague.list({ query: { state: "all" } })).patches.map((patch) => patch.id)
      ).toContain(created.patchId);
    })
  );

  it.effect("shows colleagues cumulative definitions, retained reads and declaration hints", () =>
    Effect.gen(function* () {
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const colleague = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
      const source = yield* owner.publish({
        payload: publishRequest({
          html: html("Shared inventory"),
          manifest: {
            ...Fixtures.manifest,
            name: "discovery-inventory",
            description: "Records for other tools.",
            tables: {
              notes: {
                description: "Notes keyed by id.",
                columns: {
                  title: { kind: "text" },
                  parent: { kind: "ref", table: "notes", optional: true },
                  priority: { kind: "integer", default: 1 }
                },
                indexes: { byTitle: { columns: ["title"], unique: true } },
                shared: true
              },
              privateNotes: { description: "Private notes.", columns: {}, indexes: {} }
            },
            files: { photos: { description: "Receipt photos." } }
          }
        })
      });
      const consumer = yield* colleague.publish({
        payload: publishRequest({
          html: html("Reader"),
          manifest: {
            ...Fixtures.manifest,
            name: "discovery-reader",
            uses: {
              sourceNotes: {
                kind: "sharedTable",
                patchId: source.patchId,
                table: "notes",
                id: sharedTableId(source.patchId, "notes"),
                revision: source.schemaRevision
              }
            }
          }
        })
      });
      for (const [api, patch] of [
        [owner, source],
        [colleague, consumer]
      ] as const) {
        yield* api.publish({
          payload: publishRequest({
            patchId: patch.patchId,
            html: html("Dropped declarations"),
            manifest: { ...Fixtures.manifest, name: patch.name }
          })
        });
      }
      const detail = yield* colleague.detail({
        params: { patchRef: source.name },
        query: {}
      });
      expect(detail).toMatchObject({
        id: source.patchId,
        title: "Dropped declarations",
        description: "Records for other tools.",
        mine: false,
        currentVersion: 2,
        owner: { id: uploader.user.id, name: uploader.user.name },
        inventory: {
          tables: expect.arrayContaining([
            {
              name: "notes",
              description: "Notes keyed by id.",
              shared: true,
              declarable: true,
              hint: `patchy add shared-table ${source.patchId}/notes`
            },
            expect.objectContaining({
              name: "privateNotes",
              declarable: false,
              reason: "not_shared",
              hint: expect.stringContaining(uploader.user.name)
            })
          ]),
          stores: [
            {
              name: "photos",
              description: "Receipt photos.",
              declarable: false,
              reason: "not_shareable",
              hint: expect.any(String)
            }
          ]
        }
      });
      const primitive = yield* colleague.primitive({
        params: { patchRef: source.patchId, name: "notes" },
        query: {}
      });
      expect(primitive).toMatchObject({
        kind: "table",
        name: "notes",
        shared: true,
        schemaRevision: source.schemaRevision,
        columns: expect.arrayContaining([
          { name: "title", kind: "text", optional: false },
          { name: "parent", kind: "ref", optional: true, ref: "notes" },
          { name: "priority", kind: "integer", optional: false, default: 1 }
        ]),
        indexes: [{ name: "byTitle", columns: ["title"], unique: true }]
      });
      assert.isFalse(
        Object.hasOwn(
          primitive.columns.find((column) => column.name === "title")!,
          "default"
        )
      );
      const store = yield* colleague.primitive({
        params: { patchRef: source.patchId, name: "photos" },
        query: {}
      });
      expect(store).toMatchObject({
        kind: "store",
        name: "photos",
        shared: false,
        columns: [],
        indexes: []
      });
      const retained = yield* owner.detail({
        params: { patchRef: consumer.patchId },
        query: {}
      });
      assert.deepStrictEqual(retained.reads, [
        {
          alias: "sourceNotes",
          patchId: source.patchId,
          name: source.name,
          table: "notes",
          state: "live"
        }
      ]);
      const missing = yield* colleague.primitive({
        params: { patchRef: source.patchId, name: "absent" },
        query: {},
        responseMode: "response-only"
      });
      assert.strictEqual(missing.status, 404);
    })
  );
});

const racingClients = Effect.fn("racingClients")(function* () {
  const store = yield* ContentStore.ContentStore;
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
  const routes = Layer.fresh(
    PatchesApi.layer.pipe(
      Layer.provide(Content.layer.pipe(Layer.provide(heldStore))),
      Layer.provide(publishConfig())
    )
  );
  // Same company, different users: the owner quota locks cannot serialize the name claims.
  return yield* Effect.forEach([uploader, reader], (identity) =>
    Effect.gen(function* () {
      const api = yield* client.pipe(Effect.provide(Fixtures.as(identity)), Effect.provide(routes));
      return { identity, api };
    })
  );
});

it.layer(publishLayer)("publish attempts", (it) => {
  it.effect(
    "replaces primitive descriptions without changing schema and preserves them on omission and rollback",
    () =>
      Effect.gen(function* () {
        const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const manifest = {
          ...Fixtures.manifest,
          name: "primitive-descriptions",
          tables: { notes: { description: "Notes keyed by id.", columns: {}, indexes: {} } },
          files: { attachments: { description: "Attachments keyed by file name." } }
        };
        const first = yield* owner.publish({
          payload: publishRequest({ html: html("Descriptions"), manifest })
        });
        const params = { patchId: first.patchId };
        const revised = {
          ...manifest,
          tables: {
            notes: { ...manifest.tables.notes, description: "Meeting notes keyed by id." }
          },
          files: {
            attachments: {
              description: "Meeting recordings keyed by file name; durations are seconds."
            }
          }
        };
        const second = yield* owner.publish({
          payload: publishRequest({
            ...params,
            html: html("Revised descriptions"),
            manifest: revised
          })
        });
        assert.strictEqual(second.schemaRevision, first.schemaRevision);
        const expected = {
          schemaRevision: first.schemaRevision,
          tables: { notes: { ...revised.tables.notes, shared: false } },
          files: revised.files
        };
        expect(yield* owner.inventory({ params })).toEqual(expected);
        const omitted = yield* owner.publish({
          payload: publishRequest({
            ...params,
            html: html("Omitted definitions"),
            manifest: { ...Fixtures.manifest, name: manifest.name }
          })
        });
        assert.strictEqual(omitted.schemaRevision, first.schemaRevision);
        expect(yield* owner.inventory({ params })).toEqual(expected);
        yield* owner.rollback({ params, payload: new RollbackRequest({ versionNumber: 1 }) });
        expect(yield* owner.inventory({ params })).toEqual(expected);
      })
  );

  it.effect(
    "publishes store-only repos and retains omitted stores in the owner's cumulative inventory",
    () =>
      Effect.gen(function* () {
        const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const other = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
        const manifest = {
          ...Fixtures.manifest,
          name: "inventory-files",
          files: { attachments: { description: "Attachments keyed by file name." } }
        };
        const payload = publishRequest({ html: html("File store repo"), manifest });
        const [created, response] = yield* owner.publish({
          payload,
          responseMode: "decoded-and-response"
        });
        assert.strictEqual(response.status, 201);
        assert.strictEqual(created.schemaRevision, 1);
        assert.deepStrictEqual(created.provisioned, {
          tables: [],
          columns: [],
          indexes: [],
          stores: ["attachments"]
        });
        const params = { patchId: created.patchId };
        const baseline = yield* owner.inventory({ params });
        assert.strictEqual(baseline.schemaRevision, 1);
        assert.deepStrictEqual(baseline.tables, {});
        assert.deepStrictEqual(baseline.files, manifest.files);
        assert.deepStrictEqual(yield* other.inventory({ params }), baseline);
        const replayed = yield* owner.publish({ payload, responseMode: "response-only" });
        assert.strictEqual(yield* replayed.text, yield* response.text);
        const omitted = yield* owner.publish({
          payload: publishRequest({
            patchId: created.patchId,
            html: html("Omits file store"),
            manifest: { ...Fixtures.manifest, name: manifest.name }
          })
        });
        assert.strictEqual(omitted.schemaRevision, 1);
        assert.deepStrictEqual(omitted.unused.stores, ["attachments"]);
        assert.deepStrictEqual(yield* owner.inventory({ params }), baseline);
        const restored = yield* owner.publish({
          payload: publishRequest({
            patchId: created.patchId,
            html: html("Restores file store"),
            manifest
          })
        });
        assert.strictEqual(restored.schemaRevision, 1);
        assert.deepStrictEqual(restored.provisioned.stores, []);
        assert.deepStrictEqual(restored.unused.stores, []);
        const store = yield* ContentStore.ContentStore;
        const before = yield* Stream.runCollect(store.list("patches/"));
        const refused = yield* owner.publish({
          payload: publishRequest({
            patchId: created.patchId,
            html: html("Single file"),
            metadata: { filename: "attachments.html" }
          }),
          responseMode: "response-only"
        });
        assert.strictEqual(refused.status, 422);
        assert.include(yield* refused.json, { code: "has_primitives" });
        assert.deepStrictEqual(yield* Stream.runCollect(store.list("patches/")), before);
      })
  );

  it.effect(
    "publishes tier-zero tables, replays their reports, and exposes only the owner's cumulative inventory",
    () =>
      Effect.gen(function* () {
        const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const other = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
        const manifest = {
          ...Fixtures.manifest,
          name: "inventory-notes",
          tables: {
            notes: {
              description: "Notes keyed by id.",
              columns: {
                title: { kind: "text" as const },
                parent: { kind: "ref" as const, table: "notes", optional: true },
                priority: { kind: "integer" as const, default: 1 }
              },
              indexes: { byTitle: { columns: ["title"] } },
              shared: true
            }
          }
        };
        const payload = publishRequest({ html: html("Table repo"), manifest });
        const [created, response] = yield* owner.publish({
          payload,
          responseMode: "decoded-and-response"
        });
        assert.strictEqual(created.schemaRevision, 1);
        assert.deepStrictEqual(created.provisioned.tables, ["notes"]);
        const replayed = yield* owner.publish({ payload, responseMode: "response-only" });
        assert.strictEqual(yield* replayed.text, yield* response.text);
        const params = { patchId: created.patchId };
        const baseline = yield* owner.inventory({ params });
        assert.strictEqual(baseline.schemaRevision, 1);
        assert.deepStrictEqual(baseline.tables.notes?.columns, manifest.tables.notes.columns);
        assert.deepStrictEqual(baseline.tables.notes?.indexes.byTitle?.columns, ["title"]);
        assert.strictEqual(baseline.tables.notes?.shared, true);
        assert.deepStrictEqual(yield* other.inventory({ params }), baseline);
        assert.deepStrictEqual(
          yield* other.inventory({ params: { patchId: "not-a-patch" } }).pipe(Effect.flip),
          { ok: false, error: "Patch not found." }
        );
        const omitted = yield* owner.publish({
          payload: publishRequest({
            patchId: created.patchId,
            html: html("No longer uses notes"),
            manifest: { ...Fixtures.manifest, name: manifest.name }
          })
        });
        assert.strictEqual(omitted.schemaRevision, 1);
        assert.deepStrictEqual(omitted.unused.tables, ["notes"]);
        assert.deepStrictEqual(yield* owner.inventory({ params }), baseline);
        const restored = yield* owner.publish({
          payload: publishRequest({
            patchId: created.patchId,
            html: html("Uses notes again"),
            manifest
          })
        });
        assert.strictEqual(restored.schemaRevision, 1);
        assert.deepStrictEqual(restored.provisioned, {
          tables: [],
          columns: [],
          indexes: [],
          stores: []
        });
        const store = yield* ContentStore.ContentStore;
        const before = yield* Stream.runCollect(store.list("patches/"));
        for (const name of [undefined, "named-file"]) {
          const refused = yield* owner.publish({
            payload: publishRequest({
              patchId: created.patchId,
              html: html("Single file"),
              manifest: { ...Fixtures.manifest, ...(name === undefined ? {} : { name }) },
              metadata: { filename: "notes.html" }
            }),
            responseMode: "response-only"
          });
          assert.strictEqual(refused.status, 422);
          assert.include(yield* refused.json, { code: "has_primitives" });
        }
        const incompatible = yield* owner.publish({
          payload: publishRequest({
            patchId: created.patchId,
            html: html("Changed kind"),
            manifest: {
              ...manifest,
              tables: {
                notes: {
                  ...manifest.tables.notes,
                  columns: { ...manifest.tables.notes.columns, title: { kind: "integer" } }
                }
              }
            }
          }),
          responseMode: "response-only"
        });
        assert.strictEqual(incompatible.status, 422);
        const refusal = yield* incompatible.json.pipe(Effect.flatMap(decodeNotAdditive));
        assert.strictEqual(refusal.code, "not_additive");
        assert.deepStrictEqual(
          refusal.changes.map((change) => change.object),
          ["notes.title"]
        );
        assert.include(refusal.error, "notes.title");
        assert.deepStrictEqual(yield* Stream.runCollect(store.list("patches/")), before);
        yield* owner.delete({ params, query: {} });
        assert.deepStrictEqual(yield* owner.inventory({ params }), baseline);
      })
  );

  it.effect("recovers one repo patch when response delivery fails after the commit", () =>
    Effect.gen(function* () {
      const analytics = yield* Analytics.Analytics;
      const failedDelivery = Layer.succeed(Analytics.Analytics, {
        track: (event: Analytics.AnalyticsEvent) =>
          analytics.track(event).pipe(Effect.andThen(Effect.die(new Error("publish reply lost"))))
      });
      const unavailable = yield* client.pipe(
        Effect.provide(Fixtures.as(uploader)),
        Effect.provide(
          Layer.fresh(
            PatchesApi.layer.pipe(Layer.provide(failedDelivery), Layer.provide(publishConfig()))
          )
        )
      );
      const payload = publishRequest({
        html: "<!doctype html><html><body><script>window.answer = 42;</script></body></html>",
        manifest: {
          ...Fixtures.manifest,
          tier: 1,
          name: "lost-repo-reply",
          tables: {
            notes: {
              description: "Records keyed by id.",
              columns: { title: { kind: "text" } },
              indexes: {}
            }
          },
          files: { attachments: { description: "Attachments keyed by file name." } }
        }
      });
      const patches = yield* Patches.Patches;
      const before = yield* patches.countQuotaPatches(uploader.user.id);
      const failed = yield* unavailable
        .publish({ payload, responseMode: "response-only" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));
      const stored = Option.getOrThrow(yield* patches.replay(uploader.user.id, payload.publishKey));
      const committed = decodeCreated(stored.response);
      const { versionId, patchId } = committed;
      assert.strictEqual(yield* patches.countQuotaPatches(uploader.user.id), before + 1);
      const objects = yield* ContentStore.ContentStore;
      const committedObjects = yield* Stream.runCollect(objects.list("patches/"));
      const upgraded = yield* client.pipe(
        Effect.provide(Fixtures.as(sibling)),
        Effect.provide(
          Layer.fresh(PatchesApi.layer.pipe(Layer.provide(publishConfig("9.0.0", 0, 0, 0))))
        )
      );
      const replayed = yield* upgraded.publish({ payload, responseMode: "response-only" });
      assert.strictEqual(replayed.status, 201);
      assert.strictEqual(yield* replayed.text, stored.body);
      assert.strictEqual(yield* patches.countQuotaPatches(uploader.user.id), before + 1);
      assert.deepStrictEqual(yield* Stream.runCollect(objects.list("patches/")), committedObjects);
      const latest = Option.getOrThrow(yield* patches.find(patchId));
      assert.strictEqual(latest.version.id, versionId);
      assert.strictEqual(latest.version.versionNumber, 1);
      assert.strictEqual(yield* (yield* Content.Content).read(latest.version), payload.html);
      const inventory = yield* patches.inventory(patchId, uploader.user.id);
      assert.strictEqual(inventory.schemaRevision, 1);
      assert.strictEqual(inventory.tables.notes?.columns.title?.kind, "text");
      assert.deepStrictEqual(inventory.files, {
        attachments: { description: "Attachments keyed by file name." }
      });
    })
  );

  it.effect(
    "replays stored JSONB bytes across release and response schema changes without another version",
    () =>
      Effect.gen(function* () {
        const api = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const first = publishRequest({ html: html("Original") });
        const [created, createdResponse] = yield* api.publish({
          payload: first,
          responseMode: "decoded-and-response"
        });
        const second = publishRequest({
          html: html("Updated"),
          patchId: created.patchId,
          scope: "public"
        });
        const [updated, updatedResponse] = yield* api.publish({
          payload: second,
          responseMode: "decoded-and-response"
        });
        const upgraded = yield* client.pipe(
          Effect.provide(Fixtures.as(sibling)),
          Effect.provide(Layer.fresh(PatchesApi.layer.pipe(Layer.provide(publishConfig("9.0.0")))))
        );
        const sql = yield* SqlClient.SqlClient;
        for (const [payload, expected, initial, status] of [
          [first, created, createdResponse, 201],
          [second, updated, updatedResponse, 200]
        ] as const) {
          const [stored] = yield* sql<{ body: string }>`
            SELECT publish_response::text AS body FROM patch_versions
            WHERE owner_user_id = ${uploader.user.id} AND publish_key = ${payload.publishKey}`;
          assert.strictEqual(initial.status, status);
          assert.strictEqual(yield* initial.text, stored!.body);
          const replayed = yield* upgraded.publish({ payload, responseMode: "response-only" });
          assert.strictEqual(replayed.status, status);
          assert.deepStrictEqual(yield* replayed.json, { ...expected });
          assert.strictEqual(yield* replayed.text, stored!.body);

          // A historic response can lack fields required today and retain retired fields.
          const [historic] = yield* sql<{ body: string }>`
            UPDATE patch_versions
            SET publish_response = (publish_response - 'warnings') ||
              '{"retiredReport":{"completed":true,"entries":["legacy"]}}'::jsonb
            WHERE owner_user_id = ${uploader.user.id} AND publish_key = ${payload.publishKey}
            RETURNING publish_response::text AS body`;
          const historicReplay = yield* upgraded.publish({
            payload,
            responseMode: "response-only"
          });
          assert.strictEqual(historicReplay.status, status);
          assert.strictEqual(yield* historicReplay.text, historic!.body);
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
          const payload = publishRequest({
            html: html("Concurrent"),
            manifest: {
              ...Fixtures.manifest,
              name: `concurrent-${identity.user.id.replace(/_/g, "-")}`
            }
          });
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
          assert.strictEqual(
            yield* (yield* Patches.Patches).countQuotaPatches(identity.user.id),
            1
          );
        }
      })
  );

  it.effect("arbitrates exact-name creates across owners and reserves the name on deletion", () =>
    Effect.gen(function* () {
      const contenders = yield* racingClients();
      const patches = yield* Patches.Patches;
      const before = yield* Effect.forEach(contenders, ({ identity }) =>
        patches.countQuotaPatches(identity.user.id)
      );
      const responses = yield* Effect.all(
        contenders.map(({ identity, api }) =>
          api.publish({
            payload: publishRequest({
              html: html(`Exact name from ${identity.user.name}`),
              manifest: { ...Fixtures.manifest, name: "company-name-race" }
            }),
            responseMode: "response-only"
          })
        ),
        { concurrency: "unbounded" }
      );
      assert.deepStrictEqual(responses.map((response) => response.status).toSorted(), [201, 409]);
      const winner = responses[0]!.status === 201 ? 0 : 1;
      const loser = 1 - winner;
      assert.include(yield* responses[loser]!.json, { ok: false, code: "name_taken" });
      const created = Schema.decodeUnknownSync(PublishCreated)(yield* responses[winner]!.json);
      assert.strictEqual(created.name, "company-name-race");
      const current = Option.getOrThrow(yield* patches.find(created.patchId));
      assert.strictEqual(current.patch.ownerUserId, contenders[winner]!.identity.user.id);
      assert.include(
        yield* (yield* Content.Content).read(current.version),
        `Exact name from ${contenders[winner]!.identity.user.name}`
      );
      for (let index = 0; index < contenders.length; index++) {
        assert.strictEqual(
          yield* patches.countQuotaPatches(contenders[index]!.identity.user.id),
          before[index]! + (index === winner ? 1 : 0)
        );
      }

      yield* contenders[winner]!.api.delete({ params: { patchId: created.patchId }, query: {} });
      assert.isTrue(
        Option.isNone(yield* patches.resolveName(uploader.company.handle, "company-name-race"))
      );
      const refused = yield* contenders[loser]!.api.publish({
        payload: publishRequest({
          html: html("Reserved exact name"),
          manifest: { ...Fixtures.manifest, name: "company-name-race" }
        }),
        responseMode: "response-only"
      });
      assert.strictEqual(refused.status, 409);
      assert.include(yield* refused.json, { code: "name_taken" });
      yield* contenders[winner]!.api.restore({
        params: { patchId: created.patchId },
        payload: new ForceRequest({})
      });
      assert.strictEqual(
        Option.getOrThrow(yield* patches.find(created.patchId)).patch.name,
        "company-name-race"
      );
    })
  );

  it.effect("allocates derived filename collisions across owners as base, -2 and -3", () =>
    Effect.gen(function* () {
      const contenders = yield* racingClients();
      const results = yield* Effect.all(
        contenders.map(({ identity, api }) =>
          api.publish({
            payload: publishRequest({
              html: html(`Derived name from ${identity.user.name}`),
              metadata: { filename: "  Résumé___Review!! .HTML  " }
            }),
            responseMode: "decoded-and-response"
          })
        ),
        { concurrency: "unbounded" }
      );
      assert.deepStrictEqual(results.map(([created]) => created.name).toSorted(), [
        "resume-review",
        "resume-review-2"
      ]);
      assert.notStrictEqual(results[0]![0].patchId, results[1]![0].patchId);
      const patches = yield* Patches.Patches;
      const content = yield* Content.Content;
      for (let index = 0; index < results.length; index++) {
        const [created, response] = results[index]!;
        assert.strictEqual(response.status, 201);
        const current = Option.getOrThrow(yield* patches.find(created.patchId));
        assert.strictEqual(current.patch.ownerUserId, contenders[index]!.identity.user.id);
        assert.include(
          yield* content.read(current.version),
          `Derived name from ${contenders[index]!.identity.user.name}`
        );
        assert.strictEqual(
          Option.getOrThrow(yield* patches.resolveName(uploader.company.handle, created.name))
            .patchId,
          created.patchId
        );
      }
      const [third, response] = yield* contenders[0]!.api.publish({
        payload: publishRequest({
          html: html("Third derived name"),
          metadata: { filename: "Résumé Review.html" }
        }),
        responseMode: "decoded-and-response"
      });
      assert.strictEqual(response.status, 201);
      assert.strictEqual(third.name, "resume-review-3");
      assert.notStrictEqual(third.patchId, results[0]![0].patchId);
      assert.notStrictEqual(third.patchId, results[1]![0].patchId);
    })
  );

  it.effect("bounds filename names including suffixes and falls back for an unusable title", () =>
    Effect.gen(function* () {
      const api = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
      for (const [title, name] of [
        ["Long filename first", "abcdefghijklmnopqrstuvwxyz012345"],
        ["Long filename second", "abcdefghijklmnopqrstuvwxyz0123-2"]
      ] as const) {
        const created = yield* api.publish({
          payload: publishRequest({
            html: html(title),
            metadata: { filename: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.html" }
          })
        });
        assert.strictEqual(created.name, name);
        assert.strictEqual(
          created.address,
          `https://patchy.example/${admin.company.handle}/${name}`
        );
      }
      const fallback = yield* api.publish({
        payload: publishRequest({ html: html("東京") })
      });
      assert.strictEqual(fallback.name, "patch");
      assert.strictEqual(
        Option.getOrThrow(yield* (yield* Patches.Patches).find(fallback.patchId)).patch.name,
        "patch"
      );
    })
  );

  it.effect("refuses opposing renames without deadlocking or changing either address", () =>
    Effect.gen(function* () {
      const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
      const alpha = yield* owner.publish({
        payload: publishRequest({
          html: html("Alpha"),
          manifest: { ...Fixtures.manifest, name: "rename-alpha" }
        })
      });
      const beta = yield* owner.publish({
        payload: publishRequest({
          html: html("Beta"),
          manifest: { ...Fixtures.manifest, name: "rename-beta" }
        })
      });
      const store = yield* ContentStore.ContentStore;
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
        Effect.provide(Fixtures.as(uploader)),
        Effect.provide(
          Layer.fresh(
            PatchesApi.layer.pipe(
              Layer.provide(Content.layer.pipe(Layer.provide(heldStore))),
              Layer.provide(publishConfig())
            )
          )
        )
      );
      const responses = yield* Effect.all(
        (
          [
            [alpha, beta.name],
            [beta, alpha.name]
          ] as const
        ).map(([patch, name]) =>
          api.publish({
            payload: publishRequest({
              patchId: patch.patchId,
              html: html("Rename"),
              manifest: { ...Fixtures.manifest, name }
            }),
            responseMode: "response-only"
          })
        ),
        { concurrency: "unbounded" }
      );
      for (const response of responses) {
        assert.strictEqual(response.status, 409);
        assert.include(yield* response.json, { code: "name_taken" });
      }
      const patches = yield* Patches.Patches;
      for (const patch of [alpha, beta]) {
        const unchanged = Option.getOrThrow(yield* patches.find(patch.patchId));
        assert.strictEqual(unchanged.patch.name, patch.name);
        assert.strictEqual(unchanged.version.id, patch.versionId);
      }
      const renamed = yield* owner.publish({
        payload: publishRequest({
          patchId: alpha.patchId,
          html: html("Gamma"),
          manifest: { ...Fixtures.manifest, name: "rename-gamma" }
        })
      });
      assert.strictEqual(renamed.name, "rename-gamma");
      assert.isTrue(
        Option.getOrThrow(yield* patches.resolveName(uploader.company.handle, renamed.name)).current
      );
      const former = Option.getOrThrow(
        yield* patches.resolveName(uploader.company.handle, alpha.name)
      );
      assert.isFalse(former.current);
      assert.strictEqual(former.name, renamed.name);
      const restored = yield* owner.publish({
        payload: publishRequest({
          patchId: alpha.patchId,
          html: html("Alpha restored"),
          manifest: { ...Fixtures.manifest, name: alpha.name }
        })
      });
      assert.isTrue(
        Option.getOrThrow(yield* patches.resolveName(uploader.company.handle, restored.name))
          .current
      );
      assert.isFalse(
        Option.getOrThrow(yield* patches.resolveName(uploader.company.handle, renamed.name)).current
      );
    })
  );

  it.effect("publishes tier-one scripts without changing their bytes and replays the attempt", () =>
    Effect.gen(function* () {
      const api = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
      const raw =
        '\uFEFF<!DOCTYPE html>\r\n<HTML><body><script>window.answer = "東京 & < >";</script></body></HTML>\r\n';
      const payload = publishRequest({
        html: raw,
        manifest: { ...Fixtures.manifest, tier: 1, name: "raw-script" }
      });
      const [created, response] = yield* api.publish({
        payload,
        responseMode: "decoded-and-response"
      });
      assert.strictEqual(created.tier, 1);
      const patches = yield* Patches.Patches;
      const version = Option.getOrThrow(yield* patches.find(created.patchId)).version;
      assert.strictEqual(yield* (yield* Content.Content).read(version), raw);
      const replayed = yield* api.publish({ payload, responseMode: "response-only" });
      assert.strictEqual(replayed.status, response.status);
      assert.strictEqual(yield* replayed.text, yield* response.text);
      const conflict = yield* api.publish({
        payload: publishRequest({ ...payload, html: raw + " " }),
        responseMode: "response-only"
      });
      assert.strictEqual(conflict.status, 409);
      assert.include(yield* conflict.json, { code: "publish_key_conflict" });
      assert.strictEqual(
        Option.getOrThrow(yield* patches.find(created.patchId)).version.id,
        created.versionId
      );
    })
  );

  it.effect(
    "refuses a tier-zero claim over executable HTML without changing published content",
    () =>
      Effect.gen(function* () {
        const api = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
        const safe = html("Static original");
        const created = yield* api.publish({ payload: publishRequest({ html: safe }) });
        const store = yield* ContentStore.ContentStore;
        const before = yield* Stream.runCollect(store.list("patches/"));
        const refused = yield* api.publish({
          payload: publishRequest({
            patchId: created.patchId,
            html: "<!doctype html><html><body><ScRiPt>window.answer = 42;</ScRiPt></body></html>"
          }),
          responseMode: "response-only"
        });
        assert.strictEqual(refused.status, 422);
        assert.include(yield* refused.json, { code: "tier_mismatch" });
        const version = Option.getOrThrow(
          yield* (yield* Patches.Patches).find(created.patchId)
        ).version;
        assert.strictEqual(version.id, created.versionId);
        assert.strictEqual(yield* (yield* Content.Content).read(version), safe);
        assert.deepStrictEqual(yield* Stream.runCollect(store.list("patches/")), before);
      })
  );

  it.effect("enforces tier-specific UTF-8 bundle caps and the enclosing request cap", () =>
    Effect.gen(function* () {
      const api = yield* client.pipe(
        Effect.provide(Fixtures.as(admin)),
        Effect.provide(
          Layer.fresh(
            PatchesApi.layer.pipe(
              Layer.provide(
                publishConfig(CURRENT_RELEASE, 100, 100, 100, {
                  PATCHY_MAX_HTML_BYTES: "512",
                  PATCHY_MAX_BUNDLE_BYTES: "1024"
                })
              )
            )
          )
        )
      );
      const raw = "<script>/*" + "é".repeat(501) + "*/</script>";
      const atLimit = raw + " ";
      const payload = publishRequest({
        html: atLimit,
        manifest: { ...Fixtures.manifest, tier: 1 }
      });
      const created = yield* api.publish({ payload });
      const version = Option.getOrThrow(
        yield* (yield* Patches.Patches).find(created.patchId)
      ).version;
      assert.strictEqual(yield* (yield* Content.Content).read(version), atLimit);
      const oversized = yield* api.publish({
        payload: publishRequest({
          ...payload,
          publishKey: crypto.randomUUID(),
          html: atLimit + "x"
        }),
        responseMode: "response-only"
      });
      assert.strictEqual(oversized.status, 413);
      expect(yield* oversized.json).toEqual({
        ok: false,
        error: expect.stringContaining("maximum is 1024 bytes")
      });
      const tierZero = yield* api.publish({
        payload: publishRequest({ html: "<p>" + "é".repeat(256) + "</p>" }),
        responseMode: "response-only"
      });
      assert.strictEqual(tierZero.status, 422);
      expect(yield* tierZero.json).toEqual({
        ok: false,
        errors: [expect.stringContaining("maximum is 512 bytes")],
        warnings: []
      });
      const empty = yield* api.publish({
        payload: publishRequest({ html: " \n\t" }),
        responseMode: "response-only"
      });
      assert.strictEqual(empty.status, 422);
      expect(yield* empty.json).toEqual({
        ok: false,
        errors: [expect.any(String)],
        warnings: []
      });
      const envelope = publishRequest({
        ...payload,
        publishKey: crypto.randomUUID(),
        metadata: { filename: "" }
      });
      const padding = "x".repeat(3072 - Buffer.byteLength(JSON.stringify(envelope), "utf8"));
      const atBodyLimit = publishRequest({ ...envelope, metadata: { filename: padding } });
      const accepted = yield* api.publish({ payload: atBodyLimit });
      assert.strictEqual(accepted.tier, 1);
      const bodyTooLarge = yield* api.publish({
        payload: publishRequest({
          ...atBodyLimit,
          metadata: { filename: padding + "x" }
        }),
        responseMode: "response-only"
      });
      assert.strictEqual(bodyTooLarge.status, 413);
    })
  );

  it.effect("refuses unsupported tiers and missing connections before writing content", () =>
    Effect.gen(function* () {
      const api = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
      const patches = yield* Patches.Patches;
      const before = yield* patches.countQuotaPatches(admin.user.id);
      const cases = [
        { manifest: { ...Fixtures.manifest, tier: 2 as const }, code: "tier_mismatch" },
        { manifest: { ...Fixtures.manifest, tier: 3 as const }, code: "tier_mismatch" },
        {
          manifest: {
            ...Fixtures.manifest,
            uses: {
              sales: { kind: "postgres" as const, handle: "warehouse", id: "conn_1", revision: 1 }
            }
          },
          code: "connection_not_connected"
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
      assert.strictEqual(yield* patches.countQuotaPatches(admin.user.id), before);
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
          [
            {
              ...payload,
              manifest: { ...Fixtures.manifest, tables: { notes: { columns: {}, indexes: {} } } }
            },
            422
          ],
          [{ ...payload, manifest: { ...Fixtures.manifest, files: { docs: {} } } }, 422],
          [
            {
              ...payload,
              manifest: {
                ...Fixtures.manifest,
                tables: { notes: { description: "", columns: {}, indexes: {} } }
              }
            },
            422
          ],
          [
            {
              ...payload,
              manifest: { ...Fixtures.manifest, files: { docs: { description: " \t\n" } } }
            },
            422
          ],
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
});

it.layer(Layer.fresh(publishLayer))("shared table publishing", (it) => {
  it.effect(
    "keeps shared metadata after omission and counts declaring patches across stored versions",
    () =>
      Effect.gen(function* () {
        const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const consumer = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
        const patches = yield* Patches.Patches;
        const sourceManifest = {
          ...Fixtures.manifest,
          name: "shared-contacts",
          tables: {
            contacts: {
              description: "Notes keyed by id.",
              columns: { name: { kind: "text" as const } },
              indexes: { byName: { columns: ["name"] } },
              shared: true
            }
          }
        };
        const source = yield* owner.publish({
          payload: publishRequest({ html: html("Contacts"), manifest: sourceManifest })
        });
        const declaration = {
          kind: "sharedTable" as const,
          patchId: source.patchId,
          table: "contacts",
          id: sharedTableId(source.patchId, "contacts"),
          revision: source.schemaRevision
        };
        const evolvedManifest = {
          ...sourceManifest,
          tables: {
            contacts: {
              ...sourceManifest.tables.contacts,
              columns: {
                ...sourceManifest.tables.contacts.columns,
                email: { kind: "text" as const, optional: true }
              }
            }
          }
        };
        const evolved = yield* owner.publish({
          payload: publishRequest({
            patchId: source.patchId,
            html: html("Contacts with email"),
            manifest: evolvedManifest
          })
        });
        assert.strictEqual(evolved.schemaRevision, source.schemaRevision + 1);
        const omitted = yield* owner.publish({
          payload: publishRequest({
            patchId: source.patchId,
            html: html("Source omits contacts"),
            manifest: { ...Fixtures.manifest, name: source.name }
          })
        });
        assert.deepStrictEqual(omitted.unused.tables, ["contacts"]);
        const metadata = yield* patches.sharedTable(source.patchId, "contacts", reader.company.id);
        assert.strictEqual(metadata.id, declaration.id);
        assert.strictEqual(metadata.schemaRevision, evolved.schemaRevision);
        assert.deepStrictEqual(
          metadata.definition.columns,
          evolvedManifest.tables.contacts.columns
        );
        assert.deepStrictEqual(metadata.definition.indexes.byName?.columns, ["name"]);
        assert.isTrue(metadata.definition.shared);
        yield* owner.share({
          params: { patchId: source.patchId },
          payload: new ShareRequest({ scope: "public" })
        });
        const consumerManifest = {
          ...Fixtures.manifest,
          name: "shared-consumer",
          tables: {
            notes: {
              description: "Records keyed by id.",
              columns: { contact: { kind: "ref" as const, table: declaration.id } },
              indexes: {}
            }
          },
          uses: { contacts: declaration, duplicate: declaration }
        };
        const undeclaredRef = yield* consumer.publish({
          payload: publishRequest({
            html: html("Undeclared shared ref"),
            manifest: { ...consumerManifest, uses: {} }
          }),
          responseMode: "response-only"
        });
        assert.strictEqual(undeclaredRef.status, 422);
        const refRefusal = yield* undeclaredRef.json.pipe(Effect.flatMap(decodeNotAdditive));
        assert.deepStrictEqual(
          refRefusal.changes.map((change) => change.object),
          ["notes.contact"]
        );
        const payload = publishRequest({ html: html("Consumer"), manifest: consumerManifest });
        const [created, response] = yield* consumer.publish({
          payload,
          responseMode: "decoded-and-response"
        });
        assert.isTrue(
          created.warnings.some(
            (warning) =>
              warning.includes("revision 1") &&
              warning.includes("revision 2") &&
              warning.includes(declaration.id)
          )
        );
        const baseline = yield* consumer.inventory({ params: { patchId: created.patchId } });
        assert.deepStrictEqual(baseline.tables.notes?.columns.contact, {
          kind: "ref",
          table: declaration.id
        });
        const fileMode = yield* consumer.publish({
          payload: publishRequest({
            patchId: created.patchId,
            html: html("File update with a declaration"),
            metadata: { filename: "consumer.html" },
            manifest: { ...Fixtures.manifest, uses: { contacts: declaration } }
          }),
          responseMode: "response-only"
        });
        assert.strictEqual(fileMode.status, 422);
        assert.include(yield* fileMode.json, { code: "has_primitives" });
        const loaded = Option.getOrThrow(yield* patches.find(created.patchId));
        assert.strictEqual(loaded.version.manifest.uses.contacts?.id, declaration.id);
        yield* consumer.publish({
          payload: publishRequest({
            patchId: created.patchId,
            html: html("Another declaring version"),
            manifest: consumerManifest
          })
        });
        const historical = yield* consumer.publish({
          payload: publishRequest({
            html: html("Historical declaration"),
            manifest: {
              ...Fixtures.manifest,
              name: "historical-declaration",
              uses: { contacts: declaration }
            }
          })
        });
        yield* consumer.publish({
          payload: publishRequest({
            patchId: historical.patchId,
            html: html("No current declaration"),
            manifest: { ...Fixtures.manifest, name: historical.name }
          })
        });
        const sql = yield* SqlClient.SqlClient;
        for (const state of ["deleted", "retired", "disabled"] as const) {
          const inactive = yield* consumer.publish({
            payload: publishRequest({
              html: html(state),
              manifest: {
                ...Fixtures.manifest,
                name: `shared-${state}`,
                uses: { contacts: declaration }
              }
            })
          });
          if (state === "deleted")
            yield* consumer.delete({ params: { patchId: inactive.patchId }, query: {} });
          else if (state === "retired")
            yield* consumer.retire({
              params: { patchId: inactive.patchId },
              payload: new ForceRequest({})
            });
          else yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${inactive.patchId}`;
        }
        const unsharePayload = publishRequest({
          patchId: source.patchId,
          html: html("No longer shared"),
          manifest: {
            ...evolvedManifest,
            tables: { contacts: { ...evolvedManifest.tables.contacts, shared: false } }
          }
        });
        const blocked = yield* owner.publish({
          payload: unsharePayload,
          responseMode: "response-only"
        });
        assert.strictEqual(blocked.status, 409);
        expect(yield* blocked.json).toMatchObject({
          code: "has_dependants",
          dependants: [
            {
              patchId: historical.patchId,
              name: historical.name,
              owner: { id: reader.user.id, name: reader.user.name }
            },
            {
              patchId: created.patchId,
              name: created.name,
              owner: { id: reader.user.id, name: reader.user.name }
            }
          ]
        });
        yield* owner.publish({ payload: new PublishRequest({ ...unsharePayload, force: true }) });
        assert.deepStrictEqual(
          yield* consumer.inventory({ params: { patchId: created.patchId } }),
          baseline
        );
        assert.instanceOf(
          yield* patches
            .sharedTable(source.patchId, "contacts", reader.company.id)
            .pipe(Effect.flip),
          Patches.PatchNotOpenable
        );
        const replay = yield* consumer.publish({ payload, responseMode: "response-only" });
        assert.strictEqual(yield* replay.text, yield* response.text);
        const store = yield* ContentStore.ContentStore;
        const before = yield* Stream.runCollect(store.list("patches/"));
        const refused = yield* consumer.publish({
          payload: publishRequest({
            patchId: created.patchId,
            html: html("Fresh attempt after unshare"),
            manifest: consumerManifest
          }),
          responseMode: "response-only"
        });
        assert.strictEqual(refused.status, 422);
        assert.include(yield* refused.json, { code: "patch_not_openable" });
        assert.deepStrictEqual(yield* Stream.runCollect(store.list("patches/")), before);
      })
  );

  it.effect(
    "refuses unavailable shared identities before bytes and never rebinds a recreated name",
    () =>
      Effect.gen(function* () {
        const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const consumer = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
        const manifest = {
          ...Fixtures.manifest,
          name: "stable-source-name",
          tables: {
            contacts: { description: "Notes keyed by id.", columns: {}, indexes: {}, shared: true }
          }
        };
        const source = yield* owner.publish({
          payload: publishRequest({ html: html("Source"), manifest })
        });
        const declaration = {
          kind: "sharedTable" as const,
          patchId: source.patchId,
          table: "contacts",
          id: sharedTableId(source.patchId, "contacts"),
          revision: source.schemaRevision
        };
        const store = yield* ContentStore.ContentStore;
        const before = yield* Stream.runCollect(store.list("patches/"));
        for (const unavailable of [
          { ...declaration, id: "forged-id" },
          { ...declaration, table: "missing", id: sharedTableId(source.patchId, "missing") },
          { ...declaration, patchId: "abcdefghijkl", id: "abcdefghijkl/contacts" }
        ]) {
          const refused = yield* consumer.publish({
            payload: publishRequest({
              html: html("Refused consumer"),
              manifest: { ...Fixtures.manifest, uses: { contacts: unavailable } }
            }),
            responseMode: "response-only"
          });
          assert.strictEqual(refused.status, 422);
          assert.include(yield* refused.json, { code: "patch_not_openable" });
        }
        assert.deepStrictEqual(yield* Stream.runCollect(store.list("patches/")), before);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO companies (id, handle, name)
        VALUES ('cmp_shared_foreign', 'shared-foreign', 'Foreign company')`;
        yield* sql`UPDATE patches SET company_id = 'cmp_shared_foreign' WHERE id = ${source.patchId}`;
        const foreign = yield* consumer.publish({
          payload: publishRequest({
            html: html("Foreign consumer"),
            manifest: { ...Fixtures.manifest, uses: { contacts: declaration } }
          }),
          responseMode: "response-only"
        });
        assert.include(yield* foreign.json, { code: "patch_not_openable" });
        assert.deepStrictEqual(yield* Stream.runCollect(store.list("patches/")), before);
        yield* sql`UPDATE patches SET company_id = ${uploader.company.id} WHERE id = ${source.patchId}`;
        yield* owner.retire({ params: { patchId: source.patchId }, payload: new ForceRequest({}) });
        const retired = yield* consumer.publish({
          payload: publishRequest({
            html: html("Retired source"),
            manifest: { ...Fixtures.manifest, uses: { contacts: declaration } }
          }),
          responseMode: "response-only"
        });
        assert.include(yield* retired.json, { code: "patch_not_openable" });
        assert.deepStrictEqual(yield* Stream.runCollect(store.list("patches/")), before);
        yield* owner.delete({ params: { patchId: source.patchId }, query: {} });
        yield* TestClock.adjust("30 days");
        yield* (yield* Patches.Patches).purgeDeleted(source.patchId);
        const replacement = yield* owner.publish({
          payload: publishRequest({ html: html("Replacement"), manifest })
        });
        assert.strictEqual(replacement.name, source.name);
        assert.notStrictEqual(replacement.patchId, source.patchId);
        const refused = yield* consumer.publish({
          payload: publishRequest({
            html: html("Old identity"),
            manifest: { ...Fixtures.manifest, uses: { contacts: declaration } }
          }),
          responseMode: "response-only"
        });
        assert.include(yield* refused.json, { code: "patch_not_openable" });
        const patches = yield* Patches.Patches;
        assert.instanceOf(
          yield* patches
            .sharedTable(source.patchId, "contacts", reader.company.id)
            .pipe(Effect.flip),
          Patches.PatchNotOpenable
        );
        assert.strictEqual(
          (yield* patches.sharedTable(replacement.patchId, "contacts", reader.company.id)).id,
          sharedTableId(replacement.patchId, "contacts")
        );
      })
  );
});

const sourceConnection = Effect.fn("test.sourceConnection")(function* (handle: string) {
  const display = { host: "warehouse.example", port: 5432, database: "warehouse", role: "reader" };
  const snapshot = { version: 1 as const, relations: [], enums: [], exclusions: [] };
  // Substitute only the outside source; encryption, persistence and publishing remain real.
  const connections = yield* SqlConnectionStore.make.pipe(
    Effect.provideService(PostgresSource.Source, {
      test: () => Effect.succeed(display),
      inspect: () => Effect.succeed({ display, snapshot })
    })
  );
  const connection = yield* connections.connect({
    companyId: admin.company.id,
    userId: admin.user.id,
    handle,
    description: "Publish contract source",
    credentials: Redacted.make(
      "postgresql://reader:private-test-password@warehouse.example/warehouse"
    )
  });
  return {
    connections,
    connection,
    snapshot,
    identity: { companyId: admin.company.id, userId: admin.user.id, id: connection.id },
    declaration: {
      kind: "postgres" as const,
      handle,
      id: connection.id,
      revision: connection.metadataRevision
    }
  };
});

it.layer(Layer.fresh(publishLayer))("Postgres declaration publishing", (it) => {
  it.effect(
    "binds an immutable connection snapshot and refuses new publishes after disconnect or discovery",
    () =>
      Effect.gen(function* () {
        const { connections, connection, snapshot, identity, declaration } =
          yield* sourceConnection("publish-warehouse");
        const api = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const payload = publishRequest({
          html: html("Warehouse report"),
          manifest: { ...Fixtures.manifest, name: "warehouse-report", uses: { sales: declaration } }
        });
        const created = yield* api.publish({ payload });
        const patches = yield* Patches.Patches;
        const loaded = Option.getOrThrow(yield* patches.find(created.patchId));
        assert.deepStrictEqual(loaded.version.manifest.uses.sales, declaration);
        assert.deepStrictEqual(
          yield* connections.snapshot(admin.company.id, connection.id, 1),
          snapshot
        );

        yield* connections.disconnect(identity);
        const objects = yield* ContentStore.ContentStore;
        const before = yield* Stream.runCollect(objects.list("patches/"));
        const refused = yield* api.publish({
          payload: publishRequest({
            ...payload,
            patchId: created.patchId,
            publishKey: crypto.randomUUID()
          }),
          responseMode: "response-only"
        });
        assert.strictEqual(refused.status, 422);
        assert.include(yield* refused.json, { code: "connection_not_connected" });
        assert.deepStrictEqual(yield* Stream.runCollect(objects.list("patches/")), before);
        assert.deepStrictEqual(yield* api.publish({ payload }), created);

        yield* connections.reconnect(identity);
        const refreshed = yield* connections.refresh(identity);
        const stale = yield* api.publish({
          payload: publishRequest({
            ...payload,
            patchId: created.patchId,
            publishKey: crypto.randomUUID()
          }),
          responseMode: "response-only"
        });
        assert.strictEqual(stale.status, 422);
        assert.include(yield* stale.json, { code: "stale_generated" });
        const ahead = yield* api.publish({
          payload: publishRequest({
            ...payload,
            patchId: created.patchId,
            publishKey: crypto.randomUUID(),
            manifest: {
              ...payload.manifest,
              uses: { sales: { ...declaration, revision: refreshed.metadataRevision + 1 } }
            }
          }),
          responseMode: "response-only"
        });
        assert.strictEqual(ahead.status, 422);
        assert.include(yield* ahead.json, { code: "stale_generated" });
        const updated = yield* api.publish({
          payload: publishRequest({
            ...payload,
            patchId: created.patchId,
            publishKey: crypto.randomUUID(),
            manifest: {
              ...payload.manifest,
              uses: { sales: { ...declaration, revision: refreshed.metadataRevision } }
            }
          })
        });
        assert.strictEqual(updated.versionNumber, 2);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* patches.find(created.patchId, 1)).version.manifest.uses.sales,
          declaration
        );
        yield* api.publish({
          payload: publishRequest({
            html: html("No current declaration"),
            patchId: created.patchId,
            manifest: { ...Fixtures.manifest, name: "warehouse-report" }
          })
        });
        assert.instanceOf(
          yield* connections.delete(identity).pipe(Effect.flip),
          ConnectionStore.ConnectionInUse
        );
      })
  );

  it.effect("serializes deletion against the transaction recording a declaring version", () =>
    Effect.gen(function* () {
      const { connections, identity, declaration } = yield* sourceConnection("locked-warehouse");
      const sql = yield* SqlClient.SqlClient;
      const content = yield* Content.Content;
      const locked = yield* Deferred.make<number>();
      const waiting = yield* Deferred.make<number>();
      const release = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* connections.resolve(identity.companyId, declaration);
            const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
            yield* Deferred.succeed(locked, row!.pid);
            yield* Deferred.await(release);
            return yield* content.publish({
              ...Fixtures.publishRecord(),
              patchId: null,
              companyId: admin.company.id,
              ownerUserId: admin.user.id,
              machineTokenId: admin.machine.id,
              html: html("Locked connection"),
              title: "Locked connection",
              filename: null,
              repoOrg: null,
              repoName: null,
              cliVersion: null,
              gitBranch: null,
              gitCommitSha: null,
              sourceIp: null,
              userAgent: null,
              manifest: {
                ...Fixtures.manifest,
                name: "locked-connection",
                uses: { sales: declaration }
              }
            });
          })
        )
        .pipe(Effect.forkScoped);
      const holderPid = yield* Deferred.await(locked);
      const deletion = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
            yield* Deferred.succeed(waiting, row!.pid);
            return yield* connections.delete(identity);
          })
        )
        .pipe(Effect.result, Effect.forkScoped);
      yield* Effect.gen(function* () {
        const deletionPid = yield* Deferred.await(waiting);
        assert.notStrictEqual(deletionPid, holderPid);
        yield* sql<{ waiting: boolean }>`
          SELECT ${holderPid} = ANY(pg_blocking_pids(${deletionPid})) AS waiting
        `.pipe(Effect.repeat({ until: (rows) => rows[0]!.waiting }));
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      const created = yield* Fiber.join(holder);
      const refused = yield* Fiber.join(deletion);
      assert.isTrue(Result.isFailure(refused));
      if (Result.isFailure(refused))
        assert.instanceOf(refused.failure, ConnectionStore.ConnectionInUse);
      assert.deepStrictEqual(
        Option.getOrThrow(yield* (yield* Patches.Patches).find(created.patchId)).version.manifest
          .uses.sales,
        declaration
      );
    }).pipe(Effect.scoped)
  );
});
