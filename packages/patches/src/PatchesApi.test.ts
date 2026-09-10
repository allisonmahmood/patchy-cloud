import { assert, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import {
  Authorization,
  PatchyApi,
  ShareRequest,
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
import { ConnectionStore, PostgresSource } from "@patchy/integrations";
import * as Content from "./Content.js";
import * as Patches from "./Patches.js";
import * as PatchesApi from "./PatchesApi.js";
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
      assert.include(invalid, { ok: false });
      assert.isTrue("errors" in invalid && invalid.errors.length > 0);

      const admins = yield* publish({ html: html("Theirs") }).pipe(
        Effect.provide(Fixtures.as(admin))
      );
      // Unknown and another user's: one 404, never saying which.
      for (const patchId of ["abcdefabcdef", admins.patchId]) {
        const refused = yield* publish({ html: html("x"), patchId }).pipe(
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
        yield* api.delete({ params: { patchId: first.patchId } });
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
    "publishes store-only repos and retains omitted stores in the owner's cumulative inventory",
    () =>
      Effect.gen(function* () {
        const owner = yield* client.pipe(Effect.provide(Fixtures.as(uploader)));
        const other = yield* client.pipe(Effect.provide(Fixtures.as(reader)));
        const manifest = {
          ...Fixtures.manifest,
          name: "inventory-files",
          files: { attachments: {} }
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
        assert.deepStrictEqual(yield* other.inventory({ params }).pipe(Effect.flip), {
          ok: false,
          error: "Patch not found."
        });
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
        for (const patchId of [created.patchId, "not-a-patch"]) {
          assert.deepStrictEqual(
            yield* other.inventory({ params: { patchId } }).pipe(Effect.flip),
            { ok: false, error: "Patch not found." }
          );
        }
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
        yield* owner.delete({ params });
        assert.deepStrictEqual(yield* owner.inventory({ params }).pipe(Effect.flip), {
          ok: false,
          error: "Patch not found."
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
          assert.strictEqual(yield* (yield* Patches.Patches).countLive(identity.user.id), 1);
        }
      })
  );

  it.effect("arbitrates exact-name creates across owners and frees the name on deletion", () =>
    Effect.gen(function* () {
      const contenders = yield* racingClients();
      const patches = yield* Patches.Patches;
      const before = yield* Effect.forEach(contenders, ({ identity }) =>
        patches.countLive(identity.user.id)
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
          yield* patches.countLive(contenders[index]!.identity.user.id),
          before[index]! + (index === winner ? 1 : 0)
        );
      }

      yield* contenders[winner]!.api.delete({ params: { patchId: created.patchId } });
      assert.isTrue(
        Option.isNone(yield* patches.resolveName(uploader.company.handle, "company-name-race"))
      );
      const [reused, response] = yield* contenders[loser]!.api.publish({
        payload: publishRequest({
          html: html("Reused exact name"),
          manifest: { ...Fixtures.manifest, name: "company-name-race" }
        }),
        responseMode: "decoded-and-response"
      });
      assert.strictEqual(response.status, 201);
      assert.strictEqual(reused.name, "company-name-race");
      assert.notStrictEqual(reused.patchId, created.patchId);
      assert.deepStrictEqual(
        {
          ...Option.getOrThrow(
            yield* patches.resolveName(uploader.company.handle, "company-name-race")
          )
        },
        { patchId: reused.patchId, name: "company-name-race", current: true }
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

  it.effect("refuses unsupported tiers and missing connections before writing content", () =>
    Effect.gen(function* () {
      const api = yield* client.pipe(Effect.provide(Fixtures.as(admin)));
      const patches = yield* Patches.Patches;
      const before = yield* patches.countLive(admin.user.id);
      const cases = [
        { manifest: { ...Fixtures.manifest, tier: 1 as const }, code: "tier_mismatch" },
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
        for (const state of ["deleted", "expired", "disabled"] as const) {
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
            yield* consumer.delete({ params: { patchId: inactive.patchId } });
          else if (state === "expired") {
            const expiredAt = (yield* Clock.currentTimeMillis) / 1_000 - 1;
            yield* sql`UPDATE patches SET expires_at = to_timestamp(${expiredAt})
            WHERE id = ${inactive.patchId}`;
          } else yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${inactive.patchId}`;
        }
        const unshared = yield* owner.publish({
          payload: publishRequest({
            patchId: source.patchId,
            html: html("No longer shared"),
            manifest: {
              ...evolvedManifest,
              tables: { contacts: { ...evolvedManifest.tables.contacts, shared: false } }
            }
          })
        });
        assert.isTrue(unshared.warnings.some((warning) => warning.includes("2 declaring patches")));
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
          tables: { contacts: { columns: {}, indexes: {}, shared: true } }
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
        const expiredAt = (yield* Clock.currentTimeMillis) / 1_000 - 1;
        yield* sql`UPDATE patches SET expires_at = to_timestamp(${expiredAt}) WHERE id = ${source.patchId}`;
        const expired = yield* consumer.publish({
          payload: publishRequest({
            html: html("Expired source"),
            manifest: { ...Fixtures.manifest, uses: { contacts: declaration } }
          }),
          responseMode: "response-only"
        });
        assert.include(yield* expired.json, { code: "patch_not_openable" });
        assert.deepStrictEqual(yield* Stream.runCollect(store.list("patches/")), before);
        yield* sql`UPDATE patches SET expires_at = to_timestamp(${expiredAt + 86400})
        WHERE id = ${source.patchId}`;
        yield* owner.delete({ params: { patchId: source.patchId } });
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
  const connections = yield* ConnectionStore.make.pipe(
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
