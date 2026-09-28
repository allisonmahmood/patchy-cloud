import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { RuntimeStreamFrame, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import * as Companies from "../../companies/src/Companies.js";
import * as Users from "../../companies/src/Users.js";
import { newInternalId, newPatchId } from "@patchy/core";
import { Limits, OperatingLimits } from "@patchy/limits";
import { RuntimeStream, Runtime, me } from "@patchy/runtime";
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
  Layer.provideMerge(LoadedVersions.layer.pipe(Layer.provideMerge(dependencies))),
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
  Fixtures.record({
    ...Fixtures.publishRecord(),
    intent,
    patchId,
    versionId: newInternalId("ver"),
    companyId: identity.company.id,
    ownerUserId: identity.user.id,
    machineTokenId: identity.machine.id,
    title: "Stream lifecycle",
    objectKey: `patches/${patchId}/${newInternalId("object")}.html`,
    contentHash: "sha256:stream-lifecycle",
    fileSize: 1,
    filename: null,
    repoOrg: null,
    repoName: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null,
    sourceIp: null,
    userAgent: null
  });

it.layer(layer)("committed patch lifecycle streams", (it) => {
  it.effect(
    "publishes, rolls back, revokes an open version and rechecks revocation on reconnect",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const streams = yield* RuntimeStream.RuntimeStream;
        yield* patches.listen((change) =>
          change.type === "served"
            ? streams.notify(change.patchId, {
                type: "served",
                versionId: change.versionId,
                tier: change.tier
              })
            : change.type === "revoked"
              ? streams.notify(change.patchId, { type: "revoked" }, change.versionId)
              : streams.notify(change.patchId, { type: "access_denied" })
        );
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
        yield* patches.setVersionRevoked(patchId, actor, 1, true);
        assert.deepStrictEqual(decode(yield* pull), { type: "revoked" });
        assert.strictEqual(yield* streams.connected(identity.company.id, patchId), 0);
        assert.isTrue(Option.isNone(yield* patches.find(patchId, 1)));
        assert.isNotNull(
          Option.getOrThrow(yield* patches.findRetained(patchId, 1)).version.revokedAt
        );
        const reconnect = yield* Stream.toPull(yield* streams.open(input));
        assert.strictEqual(decode(yield* reconnect).type, "hello");
        assert.deepStrictEqual(decode(yield* reconnect), { type: "revoked" });
        const runtime = yield* Runtime.make(
          { me },
          {
            origin: PUBLIC_BASE_URL,
            identity: Effect.succeed({
              user: identity.user,
              company: identity.company,
              admin: false
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
        yield* patches.setVersionRevoked(patchId, actor, 1, false);
        assert.isTrue(Option.isSome(yield* patches.find(patchId, 1)));
        const restored = yield* Stream.toPull(yield* streams.open(input));
        assert.strictEqual(decode(yield* restored).type, "hello");
        assert.deepStrictEqual(decode(yield* restored), {
          type: "served",
          versionId: original.versionId,
          tier: 0
        });
        yield* patches.retire(patchId, actor);
        assert.deepStrictEqual(decode(yield* restored), { type: "access_denied" });
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );

  it.effect(
    "announces durable authority when served callbacks arrive in reverse commit order",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
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
        const committed = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let delay = true;
        yield* patches.listen((change) =>
          Effect.gen(function* () {
            if (change.type !== "served") return;
            if (delay) {
              delay = false;
              yield* Deferred.succeed(committed, undefined);
              yield* Deferred.await(resume);
            }
            yield* streams.notify(change.patchId, {
              type: "served",
              versionId: change.versionId,
              tier: change.tier
            });
          })
        );
        const older = yield* publish(patchId, "update").pipe(Effect.forkScoped);
        yield* Deferred.await(committed);
        const latest = yield* publish(patchId, "update");
        const current = { type: "served", versionId: latest.versionId, tier: 0 };
        assert.deepStrictEqual(decode(yield* pull), current);
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(older);
        assert.deepStrictEqual(decode(yield* pull), current);
        assert.strictEqual(yield* streams.connected(identity.company.id, patchId), 1);
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );

  it.effect("keeps an unrevoked document connected after a stale revoked callback", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const streams = yield* RuntimeStream.RuntimeStream;
      const patchId = newPatchId();
      const initial = yield* publish(patchId, "create");
      const pull = yield* Stream.toPull(
        yield* streams.open({
          patchId,
          versionId: initial.versionId,
          documentId: "unrevoked_document"
        })
      );
      yield* pull;
      yield* pull;
      const committed = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      yield* patches.listen((change) =>
        Effect.gen(function* () {
          if (change.type === "revoked") {
            yield* Deferred.succeed(committed, undefined);
            yield* Deferred.await(resume);
            yield* streams.notify(change.patchId, { type: "revoked" }, change.versionId);
          } else if (change.type === "served") {
            yield* streams.notify(change.patchId, {
              type: "served",
              versionId: change.versionId,
              tier: change.tier
            });
          }
        })
      );
      const revoking = yield* patches
        .setVersionRevoked(patchId, actor, 1, true)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(committed);
      yield* patches.setVersionRevoked(patchId, actor, 1, false);
      const current = { type: "served", versionId: initial.versionId, tier: 0 };
      assert.deepStrictEqual(decode(yield* pull), current);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(revoking);
      yield* streams.notify(patchId, { type: "ready" });
      assert.deepStrictEqual(decode(yield* pull), { type: "ready" });
      assert.strictEqual(yield* streams.connected(identity.company.id, patchId), 1);
    }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );

  it.effect("keeps a restored document connected after a stale access-denied callback", () =>
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
      const committed = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      yield* patches.listen((change) =>
        Effect.gen(function* () {
          if (change.type !== "unavailable") return;
          yield* Deferred.succeed(committed, undefined);
          yield* Deferred.await(resume);
          yield* streams.notify(change.patchId, { type: "access_denied" });
        })
      );
      const retiring = yield* patches.retire(patchId, actor).pipe(Effect.forkScoped);
      yield* Deferred.await(committed);
      yield* patches.restore(patchId, actor);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(retiring);
      yield* streams.notify(patchId, { type: "ready" });
      assert.deepStrictEqual(decode(yield* pull), { type: "ready" });
      assert.strictEqual(yield* streams.connected(identity.company.id, patchId), 1);
      yield* patches.retire(patchId, actor);
      assert.deepStrictEqual(decode(yield* pull), { type: "access_denied" });
      assert.strictEqual(yield* streams.connected(identity.company.id, patchId), 0);
    }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );

  it.effect("does not announce a rolled-back portal bulk action", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const patchId = newPatchId();
      yield* publish(patchId, "create");
      const notices: Array<Patches.LifecycleChange> = [];
      yield* patches.listen((change) =>
        Effect.sync(() => {
          notices.push(change);
        })
      );
      yield* patches
        .withDependencyLock(actor.userId)(
          Effect.gen(function* () {
            yield* patches.retire(patchId, actor);
            return yield* Effect.fail("cancel-bulk");
          })
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(notices, []);
      assert.isTrue(Option.isSome(yield* patches.find(patchId)));
    }).pipe(Effect.scoped)
  );
});
