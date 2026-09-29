import { assert, it } from "@effect/vitest";
import { expect } from "vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import {
  Identity,
  Manifest,
  RuntimeStreamFrame,
  TableRow,
  WIRE_VERSION,
  sharedTableId
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { CompanyDatabases } from "@patchy/company-database";
import { contentHash, newInternalId, newPatchId } from "@patchy/core";
import { Limits, OperatingLimits } from "@patchy/limits";
import { SubscriptionReads, TableOperations } from "@patchy/primitives";
import { Binding, RuntimeStream, StreamAdmission, StreamLimits, Wakes } from "@patchy/runtime";
import * as Companies from "../../companies/src/Companies.js";
import * as Users from "../../companies/src/Users.js";
import * as PortalPages from "../../portal/src/PortalPages.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const { uploader, reader } = Fixtures.identities;
const actor = { userId: uploader.user.id, admin: false };
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeStreamFrame));
const decodeRow = Schema.decodeUnknownEffect(TableRow);
const cookies = (identity: Identity) =>
  signedInCookies(
    signSession({
      sub: `clerk_${identity.user.id}`,
      email: identity.user.email,
      name: identity.user.name
    })
  );
const request = HttpServerRequest.fromWeb(
  new Request(`${PUBLIC_BASE_URL}/api/runtime/stream`, {
    headers: {
      "x-patchy-wire": String(WIRE_VERSION),
      "x-patchy-principal": JSON.stringify({ userId: reader.user.id }),
      "sec-fetch-site": "same-origin",
      cookie: cookies(reader)
    }
  })
);
const services = Layer.mergeAll(
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
const loaded = LoadedVersions.layer.pipe(Layer.provideMerge(services));
const runtime = RuntimeStream.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(StreamAdmission.layer, StreamLimits.layer, SubscriptionReads.layer).pipe(
      Layer.provideMerge(loaded)
    )
  ),
  Layer.provide(WideEvents.layerNoop)
);
const layer = HttpRouter.serve(PortalPages.layer, {
  disableLogger: true,
  disableListenLog: true
}).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(runtime),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
);

const publish = Effect.fn("SubscriptionsTest.publish")(function* (
  identity: Identity,
  manifest: typeof Manifest.Type,
  existingPatchId?: string
) {
  const patchId = existingPatchId ?? newPatchId();
  const versionId = newInternalId("ver");
  return yield* Fixtures.record({
    ...Fixtures.publishRecord(),
    manifest,
    intent: existingPatchId === undefined ? "create" : "update",
    patchId,
    versionId,
    companyId: identity.company.id,
    ownerUserId: identity.user.id,
    machineTokenId: identity.machine.id,
    title: "Shared subscription acceptance",
    objectKey: `patches/${patchId}/${versionId}.html`,
    contentHash: contentHash("subscription-acceptance"),
    fileSize: 1,
    filename: null,
    repoOrg: null,
    repoName: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null,
    sourceIp: null,
    userAgent: null,
    force: true
  });
});
let counter = 0;
const setup = Effect.gen(function* () {
  const ordinal = ++counter;
  const sourceManifest: typeof Manifest.Type = {
    ...Fixtures.manifest,
    name: `subscription-source-${ordinal}`,
    tier: 1,
    tables: {
      notes: {
        description: "Shared notes",
        columns: { body: { kind: "text" } },
        indexes: {},
        shared: true
      }
    }
  };
  yield* (yield* CompanyDatabases.CompanyDatabases).ensureReady(uploader.company.id);
  const source = yield* publish(uploader, sourceManifest);
  const consumerManifest: typeof Manifest.Type = {
    ...Fixtures.manifest,
    name: `subscription-consumer-${ordinal}`,
    tier: 1,
    uses: {
      source: {
        kind: "sharedTable",
        patchId: source.patchId,
        table: "notes",
        id: sharedTableId(source.patchId, "notes"),
        revision: source.schemaRevision
      }
    }
  };
  const consumer = yield* publish(reader, consumerManifest);
  const binding = Binding.Binding.of({
    companyId: uploader.company.id,
    patchId: source.patchId,
    versionId: source.versionId,
    manifest: sourceManifest,
    wireVersion: WIRE_VERSION,
    scope: "company",
    identity: { user: uploader.user, company: uploader.company, admin: false },
    principal: { userId: uploader.user.id },
    correlationId: newInternalId("op")
  });
  const handlers = yield* TableOperations.make;
  const row = yield* handlers["tables.insert"]
    .run({ table: "notes", row: { body: "kept through lifecycle changes" } })
    .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodeRow));
  const publishSource = (shared = true) =>
    publish(
      uploader,
      {
        ...sourceManifest,
        tables: { notes: { ...sourceManifest.tables.notes!, shared } }
      },
      source.patchId
    );
  return {
    source,
    consumer,
    binding,
    handlers,
    row,
    publishSource,
    publishConsumer: () => publish(reader, consumerManifest, consumer.patchId)
  };
});

const connect = Effect.fn("SubscriptionsTest.connect")(function* (
  consumer: Patches.Recorded,
  sourceId: string
) {
  const streams = yield* RuntimeStream.RuntimeStream;
  const document = {
    patchId: consumer.patchId,
    versionId: consumer.versionId,
    documentId: newInternalId("doc")
  };
  const pull = yield* Stream.toPull(yield* streams.open(document));
  const frame = Effect.map(pull, (chunks) =>
    decodeFrame(new TextDecoder().decode(chunks[0]).slice(6).trim())
  );
  const hello = yield* frame;
  if (hello.type !== "hello") return yield* Effect.die(new Error("The stream did not send hello."));
  const frames: RuntimeStreamFrame[] = [hello];
  const next = Effect.gen(function* () {
    while (true) {
      const current = yield* frame;
      frames.push(current);
      if (current.type === "snapshot" || current.type === "up-to-date" || current.type === "error")
        return current;
      assert.include(["served", "admitted"], current.type);
    }
  });
  yield* streams.update({
    ...document,
    generation: hello.generation,
    sequence: 1,
    type: "subscribe",
    subscription: { id: "notes", op: "shared.list", args: { alias: "source" } }
  });
  const fresh = Effect.fn("SubscriptionsTest.fresh")(function* (revision: string) {
    while (true) {
      const current = yield* next;
      if (current.type === "error") {
        assert.isFalse(current.permanent);
        continue;
      }
      const lifecycle = current.vector[`patch:${sourceId}`];
      if (lifecycle !== undefined && BigInt(lifecycle) >= BigInt(revision)) return current;
    }
  });
  const refused = Effect.gen(function* () {
    while (true) {
      const current = yield* next;
      if (current.type === "error") return current;
    }
  });
  return { next, fresh, refused, frames, frame };
});
const refusal = {
  type: "error",
  id: "notes",
  permanent: false,
  error: { source: "patchy", code: "access_denied" }
};

it.layer(layer)("shared source subscription lifecycle", (it) => {
  it.effect(
    "refuses public current data while retaining lifecycle and historical company reads",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup;
        const patches = yield* Patches.Patches;
        const streams = yield* RuntimeStream.RuntimeStream;
        const subscription = yield* connect(fixture.consumer, fixture.source.patchId);
        expect(yield* subscription.next).toMatchObject({
          type: "snapshot",
          result: { rows: [fixture.row], cursor: null }
        });
        yield* patches.setScope(
          fixture.consumer.patchId,
          { userId: reader.user.id, admin: false },
          "public"
        );
        yield* TestClock.adjust("30 seconds");
        const publicRefusal = {
          type: "error",
          id: "notes",
          permanent: true,
          error: { code: "not_available_on_public" }
        };
        expect(yield* subscription.next).toMatchObject(publicRefusal);
        const publicDocument = yield* connect(fixture.consumer, fixture.source.patchId);
        expect(yield* publicDocument.next).toMatchObject(publicRefusal);
        assert.strictEqual(
          yield* streams.connected(reader.company.id, fixture.consumer.patchId),
          2
        );

        const newer = yield* fixture.publishConsumer();
        assert.deepStrictEqual(yield* subscription.frame, {
          type: "served",
          versionId: newer.versionId,
          tier: 1
        });
        const historical = yield* connect(fixture.consumer, fixture.source.patchId);
        expect(yield* historical.next).toMatchObject({
          type: "snapshot",
          result: { rows: [fixture.row], cursor: null }
        });
        const current = yield* connect(newer, fixture.source.patchId);
        expect(yield* current.next).toMatchObject(publicRefusal);
        assert.strictEqual(
          yield* streams.connected(reader.company.id, fixture.consumer.patchId),
          4
        );
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );

  it.effect(
    "keeps an admitted consumer through source publishes, sharing and CLI lifecycle acts",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup;
        const patches = yield* Patches.Patches;
        const subscription = yield* connect(fixture.consumer, fixture.source.patchId);
        expect(yield* subscription.fresh("1")).toMatchObject({
          type: "snapshot",
          id: "notes",
          revision: "1",
          result: { rows: [fixture.row], cursor: null },
          vector: { [`patch:${fixture.source.patchId}`]: "1" }
        });
        const updated = yield* fixture.handlers["tables.update"]
          .run({
            table: "notes",
            id: fixture.row.id,
            patch: { body: "updated while subscribed" }
          })
          .pipe(Effect.provideService(Binding.Binding, fixture.binding), Effect.flatMap(decodeRow));
        expect(yield* subscription.next).toMatchObject({
          type: "snapshot",
          id: "notes",
          revision: "2",
          result: { rows: [updated], cursor: null }
        });
        yield* fixture.publishSource();
        expect(yield* subscription.fresh("2")).toMatchObject({
          type: "up-to-date",
          id: "notes",
          revision: "2",
          vector: { [`patch:${fixture.source.patchId}`]: "2" }
        });
        yield* fixture.publishSource(false);
        expect(yield* subscription.refused).toMatchObject(refusal);
        yield* fixture.publishSource();
        expect(yield* subscription.fresh("4")).toMatchObject({
          type: "up-to-date",
          id: "notes",
          revision: "2",
          vector: { [`patch:${fixture.source.patchId}`]: "4" }
        });
        for (const [off, expectedRevision] of [
          [patches.retire(fixture.source.patchId, actor, true), "6"],
          [patches.delete(fixture.source.patchId, actor, true), "8"]
        ] as const) {
          yield* off;
          expect(yield* subscription.refused).toMatchObject(refusal);
          yield* patches.restore(fixture.source.patchId, actor);
          expect(yield* subscription.fresh(expectedRevision)).toMatchObject({
            type: "up-to-date",
            id: "notes",
            revision: "2",
            vector: { [`patch:${fixture.source.patchId}`]: expectedRevision }
          });
        }
        assert.deepStrictEqual(
          subscription.frames.filter((frame) => frame.type === "admitted"),
          [{ type: "admitted", sequence: 1 }]
        );
        assert.strictEqual(
          yield* (yield* RuntimeStream.RuntimeStream).connected(
            reader.company.id,
            fixture.consumer.patchId
          ),
          1
        );
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );

  it.effect(
    "portal retire, delete and restore wake the same consumer without replacing its last result",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup;
        const subscription = yield* connect(fixture.consumer, fixture.source.patchId);
        expect(yield* subscription.fresh("1")).toMatchObject({
          type: "snapshot",
          revision: "1",
          result: { rows: [fixture.row], cursor: null }
        });
        const client = yield* HttpClient.HttpClient;
        const post = Effect.fn("SubscriptionsTest.portalAct")(function* (
          action: string,
          fields: Record<string, string>
        ) {
          const response = yield* client.execute(
            HttpClientRequest.post(`/patches/${fixture.source.name}/${action}`).pipe(
              HttpClientRequest.setHeaders({ cookie: cookies(uploader), origin: PUBLIC_BASE_URL }),
              HttpClientRequest.bodyText(
                new URLSearchParams(fields).toString(),
                "application/x-www-form-urlencoded"
              )
            )
          );
          yield* response.text;
          assert.strictEqual(response.status, 303);
        });
        for (const [action, expectedRevision] of [
          ["retire", "3"],
          ["delete", "5"]
        ] as const) {
          yield* post(action, {
            expectedPatchId: fixture.source.patchId,
            expectedState: action === "retire" ? "live" : "not-deleted",
            ...(action === "delete" ? { confirm: fixture.source.name } : {}),
            ack: "1"
          });
          expect(yield* subscription.refused).toMatchObject(refusal);
          yield* post("restore", {
            expectedState: action === "retire" ? "retired" : "deleted",
            ack: "1"
          });
          expect(yield* subscription.fresh(expectedRevision)).toMatchObject({
            type: "up-to-date",
            id: "notes",
            revision: "1",
            vector: { [`patch:${fixture.source.patchId}`]: expectedRevision }
          });
        }
        assert.deepStrictEqual(
          subscription.frames.filter((frame) => frame.type === "admitted"),
          [{ type: "admitted", sequence: 1 }]
        );
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );

  it.effect("retains a dependency refused before the first snapshot and wakes it on reshare", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* fixture.publishSource(false);
      const subscription = yield* connect(fixture.consumer, fixture.source.patchId);
      expect(yield* subscription.refused).toMatchObject(refusal);
      yield* fixture.publishSource();
      expect(yield* subscription.fresh("3")).toMatchObject({
        type: "snapshot",
        id: "notes",
        revision: "1",
        result: { rows: [fixture.row], cursor: null },
        vector: { [`patch:${fixture.source.patchId}`]: "3" }
      });
    }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );

  it.effect("reconciles a source commit whose owner never delivers its wake", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const subscription = yield* connect(fixture.consumer, fixture.source.patchId);
      expect(yield* subscription.fresh("1")).toMatchObject({ type: "snapshot", revision: "1" });
      const wakes = yield* Wakes.Wakes;
      const silent = yield* Patches.make.pipe(
        Effect.provideService(Wakes.Wakes, {
          ...wakes,
          publish: () => Effect.void
        })
      );
      yield* fixture.publishSource().pipe(Effect.provideService(Patches.Patches, silent));
      yield* TestClock.adjust("30 seconds");
      expect(yield* subscription.fresh("2")).toMatchObject({
        type: "up-to-date",
        id: "notes",
        revision: "1",
        vector: { [`patch:${fixture.source.patchId}`]: "2" }
      });
    }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.scoped)
  );
});
