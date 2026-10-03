import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { RuntimeStreamFrame, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import * as Companies from "../../companies/src/Companies.js";
import * as Users from "../../companies/src/Users.js";
import { newPatchId } from "@patchy/core";
import { Limits, OperatingLimits } from "@patchy/limits";
import {
  RuntimeStream,
  Runtime,
  StreamAdmission,
  StreamLimits,
  Subscriptions,
  me
} from "@patchy/runtime";
import { Wakes } from "@patchy/runtime/core";
import { SubscriptionReads } from "@patchy/primitives";
import * as TestMemberDirectory from "../../primitives/src/test/memberDirectory.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const identity = Fixtures.identities.uploader;
const actor = { userId: identity.user.id, admin: false };
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeStreamFrame));
const decode = (chunks: readonly Uint8Array[]) =>
  decodeFrame(new TextDecoder().decode(chunks[0]).slice(6).trim());
const dependencies = Layer.mergeAll(
  Patches.layer,
  OperatingLimits.layer,
  Limits.layer,
  Session.layer,
  Companies.layer,
  Users.layer
).pipe(
  Layer.provideMerge(Fixtures.database),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
const layer = RuntimeStream.layer.pipe(
  Layer.provide(Subscriptions.layer),
  Layer.provide(SubscriptionReads.layer),
  Layer.provide(TestMemberDirectory.layer),
  Layer.provideMerge(
    Layer.mergeAll(LoadedVersions.layer, StreamAdmission.layer, StreamLimits.layer).pipe(
      Layer.provideMerge(dependencies)
    )
  ),
  Layer.provide(WideEvents.layerNoop)
);
const request = HttpServerRequest.fromWeb(
  new Request(`${PUBLIC_BASE_URL}/api/runtime/stream`, {
    headers: {
      "x-patchy-wire": String(WIRE_VERSION),
      "x-patchy-principal": JSON.stringify({ userId: identity.user.id }),
      "sec-fetch-site": "same-origin",
      cookie: signedInCookies(
        signSession({
          sub: `clerk_${identity.user.id}`,
          email: identity.user.email,
          name: identity.user.name
        })
      )
    }
  })
);
const publish = (patchId: string, intent: "create" | "update") =>
  Fixtures.record(Fixtures.recordInput(identity, { intent, patchId, title: "Stream lifecycle" }));

const holdNextWake = Effect.gen(function* () {
  const wakes = yield* Wakes.Wakes;
  const committed = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();
  const patches = yield* Patches.make.pipe(
    Effect.provideService(Wakes.Wakes, {
      ...wakes,
      publish: (keys) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(committed, undefined);
          yield* Deferred.await(resume);
          yield* wakes.publish(keys);
        })
    })
  );
  return { patches, committed, resume };
});

it.layer(layer)("committed patch lifecycle streams", (it) => {
  it.effect("publishes, rolls back and rechecks lifecycle eligibility on reconnect", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const streams = yield* RuntimeStream.RuntimeStream;
      const patchId = newPatchId();
      const original = yield* publish(patchId, "create");
      const input = {
        patchId,
        versionId: original.versionId,
        documentId: "committed_lifecycle_document"
      };
      const body = yield* streams.open(input);
      const pull = yield* Stream.toPull(body);
      assert.strictEqual(decode(yield* pull).type, "hello");
      assert.deepStrictEqual(decode(yield* pull), {
        type: "served",
        versionId: original.versionId,
        tier: 0
      });
      const next = yield* publish(patchId, "update");
      assert.deepStrictEqual(decode(yield* pull), {
        type: "served",
        versionId: next.versionId,
        tier: 0
      });
      yield* patches.rollback(patchId, actor, 1);
      assert.deepStrictEqual(decode(yield* pull), {
        type: "served",
        versionId: original.versionId,
        tier: 0
      });
      yield* patches.retire(patchId, actor);
      assert.deepStrictEqual(decode(yield* pull), { type: "access_denied" });
      assert.strictEqual(yield* streams.connected(identity.company.id, patchId), 0);
      assert.isTrue(Option.isNone(yield* patches.find(patchId, 1)));
      assert.instanceOf(yield* streams.open(input).pipe(Effect.flip), Runtime.AccessDenied);
      const runtime = yield* Runtime.make(
        { me },
        {
          origin: PUBLIC_BASE_URL,
          bootstrapIdentity: Effect.fail(new Runtime.AccessDenied({})),
          identity: Effect.succeed({
            viewer: { user: identity.user, company: identity.company, admin: false },
            reauthorize: Effect.succeed({
              user: identity.user,
              company: identity.company,
              admin: false
            })
          })
        }
      );
      const refused = yield* runtime
        .call({
          patchId,
          versionId: original.versionId,
          wire: WIRE_VERSION,
          principal: { userId: identity.user.id },
          op: "me",
          args: {}
        })
        .pipe(Effect.flip);
      assert.instanceOf(refused, Runtime.AccessDenied);
      yield* patches.restore(patchId, actor);
      assert.isTrue(Option.isSome(yield* patches.find(patchId, 1)));
      const restored = yield* Stream.toPull(yield* streams.open(input));
      assert.strictEqual(decode(yield* restored).type, "hello");
      assert.deepStrictEqual(decode(yield* restored), {
        type: "served",
        versionId: original.versionId,
        tier: 0
      });
      yield* patches.delete(patchId, actor);
      assert.deepStrictEqual(decode(yield* restored), { type: "access_denied" });
      assert.instanceOf(yield* streams.open(input).pipe(Effect.flip), Runtime.AccessDenied);
    }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );

  it.effect("announces durable authority when wakes arrive in reverse commit order", () =>
    Effect.gen(function* () {
      const streams = yield* RuntimeStream.RuntimeStream;
      const patchId = newPatchId();
      const initial = yield* publish(patchId, "create");
      const pull = yield* Stream.toPull(
        yield* streams.open({
          patchId,
          versionId: initial.versionId,
          documentId: "reversed_served_document"
        })
      );
      yield* pull;
      yield* pull;
      const held = yield* holdNextWake;
      const older = yield* publish(patchId, "update").pipe(
        Effect.provideService(Patches.Patches, held.patches),
        Effect.forkScoped
      );
      yield* Deferred.await(held.committed);
      const latest = yield* publish(patchId, "update");
      const current = { type: "served", versionId: latest.versionId, tier: 0 } as const;
      assert.deepStrictEqual(decode(yield* pull), current);
      yield* Deferred.succeed(held.resume, undefined);
      yield* Fiber.join(older);
      const final = yield* publish(patchId, "update");
      while (true) {
        const frame = decode(yield* pull);
        if (frame.type === "served" && frame.versionId === final.versionId) break;
        assert.deepStrictEqual(frame, current);
      }
      assert.strictEqual(yield* streams.connected(identity.company.id, patchId), 1);
    }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );

  it.effect("keeps a restored document connected after a delayed retirement wake", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const streams = yield* RuntimeStream.RuntimeStream;
      const patchId = newPatchId();
      const initial = yield* publish(patchId, "create");
      const pull = yield* Stream.toPull(
        yield* streams.open({
          patchId,
          versionId: initial.versionId,
          documentId: "restored_document"
        })
      );
      yield* pull;
      yield* pull;
      const held = yield* holdNextWake;
      const retiring = yield* held.patches.retire(patchId, actor).pipe(Effect.forkScoped);
      yield* Deferred.await(held.committed);
      yield* patches.restore(patchId, actor);
      yield* Deferred.succeed(held.resume, undefined);
      yield* Fiber.join(retiring);
      const following = yield* publish(patchId, "update");
      assert.deepStrictEqual(decode(yield* pull), {
        type: "served",
        versionId: following.versionId,
        tier: 0
      });
      assert.strictEqual(yield* streams.connected(identity.company.id, patchId), 1);
      yield* patches.retire(patchId, actor);
      assert.deepStrictEqual(decode(yield* pull), { type: "access_denied" });
      assert.strictEqual(yield* streams.connected(identity.company.id, patchId), 0);
    }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );
});
