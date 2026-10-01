import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { RuntimeStreamFrame, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { Companies, Users } from "@patchy/companies";
import { contentHash, newInternalId, newPatchId } from "../../../packages/core/src/index.js";
import { Limits, OperatingLimits } from "@patchy/limits";
import { LoadedVersions as DurableVersions, Patches } from "@patchy/patches";
import {
  LoadedVersions,
  RuntimeStream,
  StreamAdmission,
  StreamLimits,
  Subscriptions
} from "@patchy/runtime";
import { SubscriptionReads } from "@patchy/primitives";
import * as Fixtures from "../../../packages/patches/src/test/fixtures.js";
import * as MemberDirectory from "./MemberDirectory.js";

const identity = Fixtures.identities.uploader;
const dependencies = Layer.mergeAll(
  Patches.layer,
  OperatingLimits.layer,
  Limits.layer,
  Session.layer,
  Companies.layer,
  Users.layer,
  MemberDirectory.layer
).pipe(
  Layer.provideMerge(Fixtures.database),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(clerkEnv())))
);
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeStreamFrame));
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
    title: "Async lifecycle dispatch",
    objectKey: `patches/${patchId}/${newInternalId("object")}.html`,
    contentHash: contentHash("async-lifecycle"),
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

it.layer(dependencies)("scoped lifecycle dispatch", (it) => {
  it.effect(
    "commits without waiting for readers, coalesces per patch, and cancels on shutdown",
    () =>
      Effect.gen(function* () {
        const source = yield* DurableVersions.make;
        const patchId = newPatchId();
        const otherId = newPatchId();
        const original = yield* publish(patchId, "create");
        const other = yield* publish(otherId, "create");
        const reading = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const stopping = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        let blocked = false;
        let shuttingDown = false;
        let reads = 0;
        const lifecycleScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(lifecycleScope, Exit.void));
        const streams = yield* RuntimeStream.make.pipe(
          Effect.provideServiceEffect(Subscriptions.Subscriptions, Subscriptions.make),
          Effect.provide(SubscriptionReads.layer),
          Effect.provideService(LoadedVersions.LoadedVersions, {
            find: (id, versionId) =>
              Effect.gen(function* () {
                const found = yield* source.find(id, versionId);
                if (id === patchId && versionId === undefined && blocked) {
                  reads++;
                  if (shuttingDown) {
                    yield* Deferred.succeed(stopping, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
                    );
                  } else if (reads === 1) {
                    yield* Deferred.succeed(reading, undefined);
                    yield* Deferred.await(resume);
                  }
                }
                return found;
              })
          }),
          Effect.provide(WideEvents.layerNoop),
          Effect.provide(Layer.mergeAll(StreamAdmission.layer, StreamLimits.layer)),
          Effect.provideService(Scope.Scope, lifecycleScope)
        );
        const firstPull = yield* streams
          .open({ patchId, versionId: original.versionId, documentId: "async_first_document" })
          .pipe(Effect.flatMap(Stream.toPull));
        const otherPull = yield* streams
          .open({
            patchId: otherId,
            versionId: other.versionId,
            documentId: "async_other_document"
          })
          .pipe(Effect.flatMap(Stream.toPull));
        yield* firstPull;
        yield* firstPull;
        yield* otherPull;
        yield* otherPull;
        blocked = true;
        const firstUpdate = yield* publish(patchId, "update");
        yield* Deferred.await(reading);
        yield* publish(patchId, "update");
        const latest = yield* publish(patchId, "update");
        const otherUpdate = yield* publish(otherId, "update");
        const otherFrame = decodeFrame(
          new TextDecoder()
            .decode((yield* otherPull)[0])
            .slice(6)
            .trim()
        );
        assert.deepStrictEqual(otherFrame, {
          type: "served",
          versionId: otherUpdate.versionId,
          tier: 0
        });
        yield* Deferred.succeed(resume, undefined);
        for (const versionId of [firstUpdate.versionId, latest.versionId]) {
          const frame = decodeFrame(
            new TextDecoder()
              .decode((yield* firstPull)[0])
              .slice(6)
              .trim()
          );
          assert.deepStrictEqual(frame, { type: "served", versionId, tier: 0 });
        }
        assert.strictEqual(reads, 2);
        const afterCompletion = yield* publish(patchId, "update");
        const next = decodeFrame(
          new TextDecoder()
            .decode((yield* firstPull)[0])
            .slice(6)
            .trim()
        );
        assert.deepStrictEqual(next, {
          type: "served",
          versionId: afterCompletion.versionId,
          tier: 0
        });
        shuttingDown = true;
        yield* publish(patchId, "update");
        yield* Deferred.await(stopping);
        yield* Scope.close(lifecycleScope, Exit.void);
        yield* Deferred.await(interrupted);
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );
});
