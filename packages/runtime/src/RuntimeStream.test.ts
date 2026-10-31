import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as SqlError from "effect/sql/SqlError";
import {
  RuntimeStreamFrame,
  WIRE_VERSION,
  type RuntimeSubscription,
  type RuntimeSubscriptionRequest
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { DEV_SEED } from "@patchy/auth/seed";
import { ContractLimits, Limits, OperatingLimits } from "@patchy/limits";
import * as ConnectedVersions from "./ConnectedVersions.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as ExecutionLifecycle from "./ExecutionLifecycle.js";
import * as Fixtures from "./test/fixtures.js";
import * as Invocation from "./Invocation.js";
import { HandlerFailed } from "./Invocation.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeApi from "./RuntimeApi.js";
import * as CompanyAdmission from "./CompanyAdmission.js";
import * as RuntimeProduction from "./RuntimeProduction.js";
import * as RuntimeStream from "./RuntimeStream.js";
import * as StreamAdmission from "./StreamAdmission.js";
import * as StreamLimits from "./StreamLimits.js";
import * as SubscriptionReads from "./SubscriptionReads.js";
import * as Subscriptions from "./Subscriptions.js";
import * as Wakes from "./Wakes.js";
import { me } from "./me.js";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(RuntimeStreamFrame));
const text = new TextDecoder();
const frame = (chunks: readonly Uint8Array[]) => decode(text.decode(chunks[0]).slice(6).trim());
const request = (generation?: string) =>
  HttpServerRequest.fromWeb(
    new Request(`${PUBLIC_BASE_URL}/api/runtime/stream`, {
      headers: {
        ...Fixtures.headers({ userId: DEV_SEED.userId }),
        cookie: signedInCookies(),
        "sec-fetch-site": "same-origin",
        ...(generation === undefined ? {} : { "x-patchy-generation": generation })
      }
    })
  );
const memberRequest = (generation?: string) =>
  HttpServerRequest.fromWeb(
    new Request(`${PUBLIC_BASE_URL}/api/runtime/stream`, {
      headers: {
        ...Fixtures.headers({ userId: "usr_member" }),
        cookie: signedInCookies(signSession({ sub: "user_member", email: "member@patchy.local" })),
        "sec-fetch-site": "same-origin",
        ...(generation === undefined ? {} : { "x-patchy-generation": generation })
      }
    })
  );
const input = (documentId: string) => ({
  patchId: Fixtures.patchId,
  versionId: Fixtures.versionId,
  documentId
});
const open = Effect.fnUntraced(function* (
  documentId: string,
  generation?: string,
  patchId = Fixtures.patchId
) {
  const streams = yield* RuntimeStream.RuntimeStream;
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const body = yield* streams
    .open({ ...input(documentId), patchId })
    .pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request(generation)),
      Effect.provideService(Scope.Scope, scope)
    );
  const pull = yield* Stream.toPull(body).pipe(Effect.provideService(Scope.Scope, scope));
  return { scope, pull };
});
const dependencies = Fixtures.layer();
const layer = RuntimeStream.layer.pipe(
  Layer.provide(Subscriptions.layer),
  Layer.provide(StreamAdmission.layer),
  Layer.provide(StreamLimits.layer),
  Layer.provideMerge(Fixtures.streamPorts),
  Layer.provide(WideEvents.layerNoop),
  Layer.provideMerge(dependencies)
);
const makeStreams = RuntimeStream.make.pipe(
  Effect.provideServiceEffect(Subscriptions.Subscriptions, Subscriptions.make),
  Effect.provide(StreamAdmission.layer),
  Effect.provide(StreamLimits.layer)
);

// LoadedVersions is Runtime's external persistence port. Each test controls committed
// state separately from the order in which the lifecycle listener is called.
const versionAuthority = Effect.gen(function* () {
  const source = yield* LoadedVersions.LoadedVersions;
  const initial = Option.getOrThrow(yield* source.find(Fixtures.patchId, Fixtures.versionId));
  const latest = Option.getOrThrow(yield* source.find(Fixtures.patchId, Fixtures.tier1VersionId));
  const state = {
    current: initial.versionId as string | undefined,
    retained: new Map([
      [initial.versionId, initial],
      [latest.versionId, latest]
    ])
  };
  const find: LoadedVersions.LoadedVersions["Service"]["find"] = (patchId, versionId) =>
    Effect.sync(() =>
      patchId !== Fixtures.patchId || state.current === undefined
        ? Option.none()
        : Option.map(
            Option.fromUndefinedOr(state.retained.get(versionId ?? state.current)),
            (loaded) => ({
              ...loaded,
              patchTier: state.retained.get(state.current!)!.manifest.tier
            })
          )
    );
  return {
    state,
    initial,
    latest,
    find,
    layer: Layer.succeed(LoadedVersions.LoadedVersions, { find })
  };
});

/**
 * Opens a document on the latest version and subscribes, holding the first
 * delivery (its read, or a resume's revision fence) while `change` alters
 * the version's authority, then lets the delivery go on.
 */
const deliveryFence = Effect.fnUntraced(function* (
  delivery: "snapshot" | "resume" | "failure",
  change: (authority: Effect.Success<typeof versionAuthority>) => void
) {
  const resume = delivery === "resume";
  const authority = yield* versionAuthority;
  authority.state.current = authority.latest.versionId;
  const reading = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const vector = { [`table:${Fixtures.patchId}:items`]: "1" };
  const waiting = Deferred.succeed(reading, undefined).pipe(
    Effect.andThen(Deferred.await(release))
  );
  let reads = 0;
  const streams = yield* makeStreams.pipe(
    Effect.provide(authority.layer),
    Effect.provide(WideEvents.layerNoop),
    Effect.provideService(SubscriptionReads.SubscriptionReads, {
      admit: ({ onDependency }) =>
        Effect.sync(() => {
          for (const key of Object.keys(vector)) onDependency?.(key);
          return Object.keys(vector);
        }),
      revisions: () => (resume ? waiting.pipe(Effect.as(vector)) : Effect.succeed(vector)),
      read: () =>
        Effect.gen(function* () {
          reads++;
          yield* waiting;
          if (delivery === "failure")
            return yield* new HandlerFailed({ correlationId: "fenced-delivery" });
          return { result: { rows: [{ id: "private-row" }], cursor: null }, vector };
        })
    })
  );
  const document = {
    ...input("delivery_fence_document"),
    versionId: authority.latest.versionId
  };
  const pull = yield* Stream.toPull(yield* streams.open(document));
  const hello = frame(yield* pull);
  assert(hello.type === "hello");
  yield* pull;
  yield* streams.update({
    ...document,
    generation: hello.generation,
    sequence: 1,
    type: "subscribe",
    subscription: {
      id: "items",
      op: "tables.list",
      args: { table: "items" },
      ...(resume ? { vector, revision: "1" } : {})
    }
  });
  assert.deepStrictEqual(frame(yield* pull), { type: "admitted", sequence: 1 });
  yield* Deferred.await(reading);
  change(authority);
  yield* Deferred.succeed(release, undefined);
  return { authority, streams, pull, reads: () => reads };
});

it.layer(layer)("document streams", (it) => {
  it.effect("replaces only the current generation and ignores the old scope's departure", () =>
    Effect.gen(function* () {
      const streams = yield* RuntimeStream.RuntimeStream;
      const first = yield* open("generation_document");
      const hello = frame(yield* first.pull);
      assert.strictEqual(hello.type, "hello");
      if (hello.type !== "hello") return;
      assert.deepStrictEqual(frame(yield* first.pull), {
        type: "served",
        versionId: Fixtures.versionId,
        tier: 1
      });
      const second = yield* open("generation_document", hello.generation);
      const nextHello = frame(yield* second.pull);
      assert.strictEqual(nextHello.type, "hello");
      if (nextHello.type !== "hello") return;
      assert.notStrictEqual(nextHello.generation, hello.generation);
      assert.deepStrictEqual(frame(yield* first.pull), { type: "closed", reason: "replaced" });
      yield* Scope.close(first.scope, Exit.void);
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId, Fixtures.patchId), 1);
      const stale = yield* open("generation_document", hello.generation).pipe(Effect.flip);
      assert.instanceOf(stale, RuntimeStream.StreamReplaced);
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 1);
      yield* Scope.close(second.scope, Exit.void);
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 0);
    }).pipe(Effect.scoped)
  );

  it.effect("refuses another viewer opening the same document, even with its generation", () =>
    Effect.gen(function* () {
      const streams = yield* RuntimeStream.RuntimeStream;
      const document = "claimed_document";
      const owner = yield* open(document);
      const hello = frame(yield* owner.pull);
      assert(hello.type === "hello");
      yield* owner.pull;
      const member = HttpServerRequest.fromWeb(
        new Request(`${PUBLIC_BASE_URL}/api/runtime/stream`, {
          headers: {
            ...Fixtures.headers({ userId: "usr_member" }),
            cookie: signedInCookies(
              signSession({ sub: "user_member", email: "member@patchy.local" })
            ),
            "sec-fetch-site": "same-origin",
            "x-patchy-generation": hello.generation
          }
        })
      );
      const refused = yield* streams
        .open(input(document))
        .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, member), Effect.flip);
      assert.instanceOf(refused, RuntimeStream.StreamReplaced);
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId, Fixtures.patchId), 1);
      // The owner keeps its document: its next control is admitted on the same stream.
      yield* streams
        .update({
          ...input(document),
          generation: hello.generation,
          sequence: 1,
          type: "replace",
          subscriptions: []
        })
        .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()));
      assert.deepStrictEqual(frame(yield* owner.pull), { type: "admitted", sequence: 1 });
    }).pipe(Effect.scoped)
  );

  it.effect("sends the current dev handler kinds on initial admission and reconnect", () =>
    Effect.gen(function* () {
      const authority = yield* versionAuthority;
      const initial = {
        ...authority.initial,
        executionVersionId: "dev-execution-initial",
        manifest: {
          ...authority.initial.manifest,
          tier: 2 as const,
          handlers: {
            "leads.save": { kind: "query" as const, args: {}, result: { kind: "text" as const } }
          }
        }
      };
      authority.state.retained.set(initial.versionId, initial);
      const streams = yield* makeStreams.pipe(
        Effect.provide(authority.layer),
        Effect.provide(WideEvents.layerNoop)
      );
      const first = yield* open("dev_metadata_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      assert.strictEqual(frame(yield* first.pull).type, "hello");
      assert.strictEqual(frame(yield* first.pull).type, "served");
      assert.deepStrictEqual(frame(yield* first.pull), {
        type: "handlers",
        kinds: { "leads.save": "query" }
      });
      assert.deepStrictEqual(frame(yield* first.pull), { type: "ready" });
      yield* Scope.close(first.scope, Exit.void);
      authority.state.retained.set(initial.versionId, {
        ...initial,
        executionVersionId: "dev-execution-rebuilt",
        manifest: {
          ...initial.manifest,
          handlers: {
            "leads.save": { kind: "mutation", args: {}, result: { kind: "text" } },
            "added.save": { kind: "mutation", args: {}, result: { kind: "text" } }
          }
        }
      });
      const reconnected = yield* open("dev_metadata_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      assert.strictEqual(frame(yield* reconnected.pull).type, "hello");
      assert.strictEqual(frame(yield* reconnected.pull).type, "served");
      assert.deepStrictEqual(frame(yield* reconnected.pull), {
        type: "handlers",
        kinds: { "leads.save": "mutation", "added.save": "mutation" }
      });
      assert.deepStrictEqual(frame(yield* reconnected.pull), { type: "ready" });
    }).pipe(Effect.scoped)
  );

  it.effect("fails a timed-out binding without ready and retries only on a new stream", () =>
    Effect.gen(function* () {
      const authority = yield* versionAuthority;
      authority.state.retained.set(authority.initial.versionId, {
        ...authority.initial,
        manifest: { ...authority.initial.manifest, tier: 2 }
      });
      const attempts = yield* Queue.unbounded<Deferred.Deferred<void>>();
      let connected = 0;
      const streams = yield* makeStreams.pipe(
        Effect.provide(authority.layer),
        Effect.provide(WideEvents.layerNoop),
        Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
          prewarm: () => Effect.die("Nothing here prewarms."),
          touch: () => Effect.succeed({ outcome: "absent" as const }),
          connect: () =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => connected++),
                () =>
                  Effect.sync(() => {
                    connected--;
                  })
              );
              const ready = yield* Deferred.make<void>();
              yield* Queue.offer(attempts, ready);
              yield* Deferred.await(ready);
            }),
          acquire: () => Effect.die("A stream cannot admit an invocation.")
        })
      );
      const first = yield* open("starting_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      const hello = frame(yield* first.pull);
      assert.strictEqual(hello.type, "hello");
      if (hello.type !== "hello") return;
      assert.strictEqual(frame(yield* first.pull).type, "served");
      assert.deepStrictEqual(frame(yield* first.pull), { type: "starting" });
      const abandoned = yield* Queue.take(attempts);
      const received: RuntimeStreamFrame[] = [];
      yield* first.pull.pipe(
        Effect.tap((chunks) =>
          Effect.sync(() => {
            received.push(frame(chunks));
          })
        ),
        Effect.forkChild
      );
      yield* TestClock.adjust("39 seconds");
      assert.deepStrictEqual(received, []);
      assert.strictEqual(connected, 1);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(received, [
        {
          type: "start_failed",
          code: "busy",
          retryAfter: 1,
          scope: "company",
          limitId: "execution.pool.wait",
          value: 40000
        }
      ]);
      assert.strictEqual(connected, 0);
      yield* Deferred.succeed(abandoned, undefined);
      const next = yield* open("starting_document", hello.generation).pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      assert.strictEqual(frame(yield* next.pull).type, "hello");
      assert.strictEqual(frame(yield* next.pull).type, "served");
      assert.deepStrictEqual(frame(yield* next.pull), { type: "starting" });
      assert.deepStrictEqual(frame(yield* first.pull), { type: "closed", reason: "replaced" });
      yield* Deferred.succeed(yield* Queue.take(attempts), undefined);
      assert.deepStrictEqual(frame(yield* next.pull), { type: "ready" });
      assert.strictEqual(connected, 1);
      yield* Scope.close(next.scope, Exit.void);
      assert.strictEqual(connected, 0);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "keeps a ready document's version warm until it disconnects, warming only its first stream",
    () =>
      Effect.gen(function* () {
        const authority = yield* versionAuthority;
        authority.state.retained.set(authority.initial.versionId, {
          ...authority.initial,
          manifest: { ...authority.initial.manifest, tier: 2 }
        });
        const connections: Array<{ readonly versionId: string; readonly warm: boolean }> = [];
        let held = 0;
        const streams = yield* makeStreams.pipe(
          Effect.provide(authority.layer),
          Effect.provide(WideEvents.layerNoop),
          Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
            prewarm: () => Effect.die("Nothing here prewarms."),
            connect: () => Effect.void,
            acquire: () => Effect.die("A stream cannot admit an invocation."),
            touch: () => Effect.die("Only the keepalive touches.")
          }),
          Effect.provideService(ConnectedVersions.ConnectedVersions, {
            connect: (version, options) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  connections.push({ versionId: version.versionId, warm: options.warm });
                  held++;
                }),
                () =>
                  Effect.sync(() => {
                    held--;
                  })
              )
          })
        );
        const ready = Effect.fnUntraced(function* (generation?: string) {
          const document = yield* open("warm_document_one", generation).pipe(
            Effect.provideService(RuntimeStream.RuntimeStream, streams)
          );
          const hello = frame(yield* document.pull);
          assert.strictEqual(frame(yield* document.pull).type, "served");
          assert.deepStrictEqual(frame(yield* document.pull), { type: "starting" });
          assert.deepStrictEqual(frame(yield* document.pull), { type: "ready" });
          return { ...document, generation: hello.type === "hello" ? hello.generation : "" };
        });
        const first = yield* ready();
        assert.deepStrictEqual(connections, [
          { versionId: authority.initial.versionId, warm: true }
        ]);
        // A reconnect names its previous generation: the version stays held, never warmed again.
        const reconnected = yield* ready(first.generation);
        assert.deepStrictEqual(frame(yield* first.pull), { type: "closed", reason: "replaced" });
        assert.deepStrictEqual(connections[1], {
          versionId: authority.initial.versionId,
          warm: false
        });
        // A disconnect, including a hidden document's suspension, lets the version go.
        yield* Scope.close(first.scope, Exit.void);
        yield* Scope.close(reconnected.scope, Exit.void);
        assert.strictEqual(held, 0);
      }).pipe(Effect.scoped)
  );

  it.effect("preserves the effective pool limit on a refused bind", () =>
    Effect.gen(function* () {
      const authority = yield* versionAuthority;
      authority.state.retained.set(authority.initial.versionId, {
        ...authority.initial,
        manifest: { ...authority.initial.manifest, tier: 2 }
      });
      const streams = yield* makeStreams.pipe(
        Effect.provide(authority.layer),
        Effect.provide(WideEvents.layerNoop),
        Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
          prewarm: () => Effect.die("Nothing here prewarms."),
          touch: () => Effect.succeed({ outcome: "absent" as const }),
          connect: () =>
            Effect.fail(
              new ExecutionLifecycle.LifecycleError({
                code: "busy",
                status: 503,
                retryAfterSeconds: 7,
                limitId: "execution.pool.wait",
                scope: "company",
                value: 17000
              })
            ),
          acquire: () => Effect.die("A stream cannot admit an invocation.")
        })
      );
      const document = yield* open("refused_bind_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      assert.strictEqual(frame(yield* document.pull).type, "hello");
      assert.strictEqual(frame(yield* document.pull).type, "served");
      assert.deepStrictEqual(frame(yield* document.pull), { type: "starting" });
      assert.deepStrictEqual(frame(yield* document.pull), {
        type: "start_failed",
        code: "busy",
        retryAfter: 7,
        limitId: "execution.pool.wait",
        scope: "company",
        value: 17000
      });
    }).pipe(Effect.scoped)
  );

  it.effect("keeps subscription dispatch behind ready", () =>
    Effect.gen(function* () {
      const authority = yield* versionAuthority;
      authority.state.retained.set(authority.initial.versionId, {
        ...authority.initial,
        manifest: {
          ...authority.initial.manifest,
          tier: 2,
          handlers: { "demo.query": { kind: "query", args: {}, result: { kind: "integer" } } }
        }
      });
      const ready = yield* Deferred.make<void>();
      const departed = yield* Deferred.make<void>();
      const streams = yield* makeStreams.pipe(
        Effect.provide(authority.layer),
        Effect.provide(WideEvents.layerNoop),
        Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
          prewarm: () => Effect.die("Nothing here prewarms."),
          touch: () => Effect.succeed({ outcome: "absent" as const }),
          connect: () =>
            Effect.acquireRelease(Effect.void, () =>
              Deferred.succeed(departed, undefined).pipe(Effect.asVoid)
            ).pipe(Effect.andThen(Deferred.await(ready))),
          acquire: () => Effect.die("A stream cannot admit an invocation.")
        })
      );
      const document = yield* open("pending_subscriptions").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      const hello = frame(yield* document.pull);
      if (hello.type !== "hello") return assert.fail("Expected hello");
      assert.strictEqual(frame(yield* document.pull).type, "served");
      assert.strictEqual(frame(yield* document.pull).type, "starting");
      yield* streams
        .update({
          ...input("pending_subscriptions"),
          generation: hello.generation,
          sequence: 1,
          type: "subscribe",
          subscription: {
            id: "query",
            op: "server.call",
            args: { handler: "demo.query", args: {} }
          }
        })
        .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()));
      assert.deepStrictEqual(frame(yield* document.pull), { type: "admitted", sequence: 1 });
      const next = yield* document.pull.pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      assert.isUndefined(next.pollUnsafe());
      yield* Deferred.succeed(ready, undefined);
      assert.deepStrictEqual(frame(yield* Fiber.join(next)), { type: "ready" });
      const error = frame(yield* document.pull);
      assert.strictEqual(error.type, "error");
      if (error.type === "error") assert.strictEqual(error.error.code, "source_unavailable");
      yield* Scope.close(document.scope, Exit.void);
      yield* Deferred.await(departed);
    }).pipe(Effect.scoped)
  );

  it.effect("releases a disconnected document while its binding is still pending", () =>
    Effect.gen(function* () {
      const authority = yield* versionAuthority;
      authority.state.retained.set(authority.initial.versionId, {
        ...authority.initial,
        manifest: { ...authority.initial.manifest, tier: 2 }
      });
      const entered = yield* Deferred.make<void>();
      let connections = 0;
      const streams = yield* makeStreams.pipe(
        Effect.provide(authority.layer),
        Effect.provide(WideEvents.layerNoop),
        Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
          prewarm: () => Effect.die("Nothing here prewarms."),
          touch: () => Effect.succeed({ outcome: "absent" as const }),
          connect: () =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  connections++;
                }),
                () =>
                  Effect.sync(() => {
                    connections--;
                  })
              );
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }),
          acquire: () => Effect.die("A stream cannot admit an invocation.")
        })
      );
      const document = yield* open("departed_starting_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      yield* Deferred.await(entered);
      assert.strictEqual(connections, 1);
      yield* Scope.close(document.scope, Exit.void);
      assert.strictEqual(connections, 0);
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 0);
    }).pipe(Effect.scoped)
  );

  it.effect("enforces the viewer document bound and frees slots on disconnect", () =>
    Effect.gen(function* () {
      const streams = yield* RuntimeStream.RuntimeStream;
      const documents = [];
      for (let index = 0; index < 8; index++)
        documents.push(yield* open(`limited_document_${index}`));
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId, Fixtures.patchId), 8);
      const refused = yield* open("limited_document_8").pipe(Effect.flip);
      assert.instanceOf(refused, RuntimeStream.StreamLimit);
      yield* Scope.close(documents[0]!.scope, Exit.void);
      const admitted = yield* open("limited_document_8");
      assert.strictEqual(frame(yield* admitted.pull).type, "hello");
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 8);
    }).pipe(Effect.scoped)
  );

  it.effect("closes a backed-up consumer with a readable reason and releases presence", () =>
    Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      const ref = {
        companyId: DEV_SEED.companyId,
        limitId: "stream.buffer.bytes",
        actor: "stream-test"
      };
      yield* limits.setOverride({ ...ref, value: 256 });
      yield* Effect.addFinalizer(() => limits.removeOverride(ref).pipe(Effect.orDie));
      const authority = yield* versionAuthority;
      const streams = yield* makeStreams.pipe(
        Effect.provide(authority.layer),
        Effect.provide(WideEvents.layerNoop)
      );
      const document = yield* open("slow_consumer_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      assert.strictEqual(frame(yield* document.pull).type, "hello");
      yield* document.pull;
      for (let index = 0; index < 10; index++) {
        authority.state.current =
          index % 2 === 0 ? authority.latest.versionId : authority.initial.versionId;
        yield* streams.notify(Fixtures.patchId);
      }
      assert.deepStrictEqual(frame(yield* document.pull), {
        type: "closed",
        reason: "slow_consumer"
      });
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 0);
    }).pipe(Effect.scoped)
  );

  it.effect("reconnects at the verified token deadline without idle authentication work", () =>
    Effect.gen(function* () {
      const session = yield* Session.Session;
      let authentications = 0;
      const externalSession = Layer.succeed(Session.Session, {
        ...session,
        authenticate: (request) =>
          Effect.gen(function* () {
            authentications++;
            const signedIn = yield* session.authenticate(request);
            if (signedIn.status !== "signed-in") return signedIn;
            const now = yield* Clock.currentTimeMillis;
            return {
              ...signedIn,
              claims: { ...signedIn.claims, exp: Math.floor(now / 1000) + 12 }
            };
          })
      });
      const admission = yield* StreamAdmission.make.pipe(Effect.provide(externalSession));
      const streams = yield* RuntimeStream.make.pipe(
        Effect.provideServiceEffect(Subscriptions.Subscriptions, Subscriptions.make),
        Effect.provideService(StreamAdmission.StreamAdmission, admission),
        Effect.provide(StreamLimits.layer),
        Effect.provide(WideEvents.layerNoop)
      );
      const document = yield* open("idle_session_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      yield* document.pull;
      yield* document.pull;
      yield* TestClock.adjust("11999 millis");
      assert.strictEqual(authentications, 1);
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 1);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 0);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(document.pull)));
      assert.strictEqual(authentications, 1);
      const reconnected = yield* open("idle_session_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      assert.strictEqual(frame(yield* reconnected.pull).type, "hello");
      assert.strictEqual(authentications, 2);
    }).pipe(Effect.scoped)
  );

  it.effect("drains as EOF and refuses new documents", () =>
    Effect.gen(function* () {
      const streams = yield* makeStreams.pipe(Effect.provide(WideEvents.layerNoop));
      const document = yield* open("draining_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      yield* document.pull;
      yield* document.pull;
      yield* streams.drain;
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 0);
      const refused = yield* streams
        .open(input("new_draining_document"))
        .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()), Effect.flip);
      assert.instanceOf(refused, Runtime.Draining);
    }).pipe(Effect.scoped)
  );

  it.effect("emits one close event with delivered bytes and zero peak subscriptions", () =>
    Effect.gen(function* () {
      const recorded = yield* Queue.make<WideEvents.WideEvent>();
      const authority = yield* versionAuthority;
      const events = yield* WideEvents.make.pipe(
        Effect.provideService(WideEvents.Sink, {
          write: (event) => Queue.offer(recorded, event).pipe(Effect.asVoid)
        })
      );
      const streams = yield* makeStreams.pipe(
        Effect.provide(authority.layer),
        Effect.provideService(WideEvents.WideEvents, events)
      );
      const document = yield* open("wide_event_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      const hello = yield* document.pull;
      const served = yield* document.pull;
      authority.state.current = undefined;
      yield* streams.notify(Fixtures.patchId);
      const denied = yield* document.pull;
      yield* Effect.exit(document.pull);
      const event = yield* Queue.take(recorded);
      assert.strictEqual(event.type, "stream");
      if (event.type !== "stream") return;
      assert.strictEqual(event.peakSubscriptions, 0);
      assert.strictEqual(
        event.bytes,
        hello[0].byteLength + served[0].byteLength + denied[0].byteLength
      );
      assert.strictEqual(event.closeReason, "access_denied");
      assert.strictEqual(event.documentId, "wide_event_document");
      assert.strictEqual(event.checks, 0);
      assert.strictEqual(event.companyId, DEV_SEED.companyId);
      assert.strictEqual(event.patchId, Fixtures.patchId);
      assert.strictEqual(yield* Queue.size(recorded), 0);
    }).pipe(Effect.scoped)
  );

  it.effect("reports a check still holding its slot after the stream's summary on its own", () =>
    Effect.gen(function* () {
      const recorded = yield* Queue.unbounded<WideEvents.WideEvent>();
      const authority = yield* versionAuthority;
      authority.state.current = authority.latest.versionId;
      const events = yield* WideEvents.make.pipe(
        Effect.provideService(WideEvents.Sink, {
          write: (event) => Queue.offer(recorded, event).pipe(Effect.asVoid)
        })
      );
      const checking = yield* Deferred.make<void>();
      const settle = yield* Deferred.make<void>();
      const vector = { [`table:${Fixtures.patchId}:items`]: "1" };
      const streams = yield* makeStreams.pipe(
        Effect.provide(authority.layer),
        Effect.provideService(WideEvents.WideEvents, events),
        Effect.provideService(SubscriptionReads.SubscriptionReads, {
          admit: () => Effect.succeed(Object.keys(vector)),
          revisions: () =>
            Deferred.succeed(checking, undefined).pipe(
              Effect.andThen(Deferred.await(settle)),
              Effect.as(vector)
            ),
          read: () => Effect.die("An equal-vector resume answers without a read.")
        })
      );
      const document = { ...input("late_check_document"), versionId: authority.latest.versionId };
      const pull = yield* Stream.toPull(yield* streams.open(document));
      const hello = frame(yield* pull);
      assert(hello.type === "hello");
      yield* pull;
      yield* streams.update({
        ...document,
        generation: hello.generation,
        sequence: 1,
        type: "subscribe",
        subscription: {
          id: "items",
          op: "tables.list",
          args: { table: "items" },
          vector,
          revision: "1"
        }
      });
      yield* Deferred.await(checking);
      yield* TestClock.adjust("100 millis");
      yield* streams.drain;
      while (Exit.isSuccess(yield* Effect.exit(pull))) {
        /* read the admission and the drained end */
      }
      const summary = yield* Queue.take(recorded);
      assert.include(summary, { type: "stream", closeReason: "draining", checks: 0, checkMs: 0 });
      yield* TestClock.adjust("100 millis");
      yield* Deferred.succeed(settle, undefined);
      assert.include(yield* Queue.take(recorded), {
        type: "re-run",
        documentId: "late_check_document",
        trigger: "initial",
        disposition: "discarded",
        slotOccupancyMs: 200
      });
    }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()), Effect.scoped)
  );

  it.effect("orders an in-flight initial snapshot before a racing publish notification", () =>
    Effect.gen(function* () {
      const authority = yield* versionAuthority;
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let holdCurrent = true;
      const delayed = Layer.succeed(LoadedVersions.LoadedVersions, {
        find: (patchId, versionId) =>
          Effect.gen(function* () {
            const found = yield* authority.find(patchId, versionId);
            if (versionId === undefined && holdCurrent) {
              holdCurrent = false;
              yield* Deferred.succeed(reading, undefined);
              yield* Deferred.await(resume);
            }
            return found;
          })
      });
      const streams = yield* makeStreams.pipe(
        Effect.provide(delayed),
        Effect.provide(WideEvents.layerNoop)
      );
      const opening = yield* open("initial_publish_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams),
        Effect.forkScoped
      );
      yield* Deferred.await(reading);
      authority.state.current = authority.latest.versionId;
      const publishing = yield* streams
        .notify(Fixtures.patchId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(resume, undefined);
      const document = yield* Fiber.join(opening);
      yield* Fiber.join(publishing);
      assert.strictEqual(frame(yield* document.pull).type, "hello");
      assert.deepStrictEqual(frame(yield* document.pull), {
        type: "served",
        versionId: authority.initial.versionId,
        tier: authority.initial.manifest.tier
      });
      assert.deepStrictEqual(frame(yield* document.pull), {
        type: "served",
        versionId: authority.latest.versionId,
        tier: authority.latest.manifest.tier
      });
    }).pipe(Effect.scoped)
  );

  it.effect("rechecks patch retirement after an in-flight admission lookup", () =>
    Effect.gen(function* () {
      const authority = yield* versionAuthority;
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let holdAdmission = true;
      const delayed = Layer.succeed(LoadedVersions.LoadedVersions, {
        find: (patchId, versionId) =>
          Effect.gen(function* () {
            const found = yield* authority.find(patchId, versionId);
            if (holdAdmission) {
              holdAdmission = false;
              yield* Deferred.succeed(reading, undefined);
              yield* Deferred.await(resume);
            }
            return found;
          })
      });
      const streams = yield* makeStreams.pipe(
        Effect.provide(delayed),
        Effect.provide(WideEvents.layerNoop)
      );
      const opening = yield* open("initial_retired_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams),
        Effect.forkScoped
      );
      yield* Deferred.await(reading);
      authority.state.current = undefined;
      yield* Deferred.succeed(resume, undefined);
      const document = yield* Fiber.join(opening);
      assert.strictEqual(frame(yield* document.pull).type, "hello");
      assert.deepStrictEqual(frame(yield* document.pull), { type: "access_denied" });
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 0);
    }).pipe(Effect.scoped)
  );

  it.effect("closes retryably when authority lookup fails after a committed lifecycle change", () =>
    Effect.gen(function* () {
      const authority = yield* versionAuthority;
      let unavailable = false;
      const cause = new SqlError.SqlError({
        reason: new SqlError.ConnectionError({ cause: new Error("database offline") })
      });
      const logs: unknown[] = [];
      const failing = Layer.succeed(LoadedVersions.LoadedVersions, {
        find: (patchId, versionId) =>
          Effect.suspend(() =>
            unavailable ? Effect.fail(cause) : authority.find(patchId, versionId)
          )
      });
      const streams = yield* makeStreams.pipe(
        Effect.provide(failing),
        Effect.provide(WideEvents.layerNoop)
      );
      const document = yield* open("failed_authority_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      yield* document.pull;
      yield* document.pull;
      authority.state.current = authority.latest.versionId;
      unavailable = true;
      yield* streams.notify(Fixtures.patchId).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((event) => {
              logs.push(event.message);
            })
          ])
        )
      );
      const logged = logs.flat()[0];
      assert.instanceOf(logged, Runtime.SourceUnavailable);
      assert.strictEqual((logged as Runtime.SourceUnavailable).cause, cause);
      assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 0);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(document.pull)));
      unavailable = false;
      const reconnected = yield* open("failed_authority_document").pipe(
        Effect.provideService(RuntimeStream.RuntimeStream, streams)
      );
      assert.strictEqual(frame(yield* reconnected.pull).type, "hello");
      assert.deepStrictEqual(frame(yield* reconnected.pull), {
        type: "served",
        versionId: authority.latest.versionId,
        tier: authority.latest.manifest.tier
      });
    }).pipe(Effect.scoped)
  );
  it.effect(
    "shares the viewer call budget with subscription controls without extending the window",
    () =>
      Effect.gen(function* () {
        const limits = yield* Limits.make;
        const runtime = yield* RuntimeProduction.make({ me }).pipe(
          Effect.provide(CompanyAdmission.layer),
          Effect.provideService(Limits.Limits, limits),
          Effect.provideService(ContractLimits.overrides, { "runtime.calls.perMinute": 3 })
        );
        const streams = yield* makeStreams.pipe(
          Effect.provideService(Limits.Limits, limits),
          Effect.provideService(ContractLimits.overrides, { "runtime.calls.perMinute": 3 }),
          Effect.provide(WideEvents.layerNoop)
        );
        const document = input("rate_limited_document");
        const pull = yield* Stream.toPull(yield* streams.open(document));
        const hello = frame(yield* pull);
        assert.strictEqual(hello.type, "hello");
        if (hello.type !== "hello") return;
        yield* pull;
        const call = runtime.call({
          wire: WIRE_VERSION,
          patchId: Fixtures.patchId,
          versionId: Fixtures.versionId,
          principal: { userId: DEV_SEED.userId },
          op: "me",
          args: {}
        });
        const update = (sequence: number) =>
          streams.update({
            ...document,
            generation: hello.generation,
            sequence,
            type: "replace",
            subscriptions: []
          });
        yield* call;
        for (const sequence of [1, 2]) {
          yield* update(sequence);
          assert.deepStrictEqual(frame(yield* pull), { type: "admitted", sequence });
        }
        for (let attempt = 0; attempt < 4; attempt++) {
          const error = yield* update(3).pipe(Effect.flip);
          assert.instanceOf(error, Runtime.RateLimited);
          const response = RuntimeApi.failure(error);
          assert.strictEqual(response.status, 429);
          assert.strictEqual(response.headers["retry-after"], "60");
          assert.deepStrictEqual(Runtime.toFailure(error), {
            ok: false,
            source: "patchy",
            code: "rate_limited",
            error: "Runtime request refused: rate_limited.",
            retryAfter: 60,
            limitId: "runtime.calls.perMinute",
            scope: "viewer",
            value: 3
          });
        }
        assert.instanceOf(yield* call.pipe(Effect.flip), Runtime.RateLimited);
        yield* TestClock.adjust("59 seconds");
        const refused = yield* update(3).pipe(Effect.flip);
        assert.strictEqual(RuntimeApi.failure(refused).headers["retry-after"], "1");
        yield* TestClock.adjust("1 second");
        yield* update(3);
        assert.deepStrictEqual(frame(yield* pull), { type: "admitted", sequence: 3 });
        yield* call;
        assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 1);
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()), Effect.scoped)
  );

  it.effect(
    "a tier 1 document subscribes only to its own tables, and a public one to nothing",
    () =>
      Effect.gen(function* () {
        const authority = yield* versionAuthority;
        authority.state.current = authority.latest.versionId;
        const streams = yield* makeStreams.pipe(
          Effect.provide(authority.layer),
          Effect.provide(WideEvents.layerNoop),
          Effect.provideService(SubscriptionReads.SubscriptionReads, {
            admit: () => Effect.die("A refused subscription is never admitted."),
            revisions: () => Effect.die("A refused subscription reads no revisions."),
            read: () => Effect.die("A refused subscription is never read.")
          })
        );
        const document = { ...input("own_patch_document"), versionId: authority.latest.versionId };
        const pull = yield* Stream.toPull(yield* streams.open(document));
        const hello = frame(yield* pull);
        assert(hello.type === "hello");
        yield* pull;
        let sequence = 0;
        const refused = Effect.fnUntraced(function* (
          op: RuntimeSubscription["op"],
          args: RuntimeSubscription["args"],
          error: Runtime.RuntimeError
        ) {
          yield* streams.update({
            ...document,
            generation: hello.generation,
            sequence: ++sequence,
            type: "subscribe",
            subscription: { id: op, op, args }
          });
          assert.deepStrictEqual(frame(yield* pull), { type: "admitted", sequence });
          assert.deepStrictEqual(frame(yield* pull), {
            type: "error",
            id: op,
            permanent: true,
            error: Runtime.toFailure(error)
          });
        });
        // The directory and other patches' tables are tier 2 handlers' to read.
        yield* refused("members.list", {}, new Runtime.ServerRequired());
        yield* refused("shared.list", { alias: "source" }, new Runtime.ServerRequired());
        authority.state.retained.set(authority.latest.versionId, {
          ...authority.latest,
          scope: "public"
        });
        yield* refused("tables.list", { table: "items" }, new Runtime.PublicUnavailable({}));
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()), Effect.scoped)
  );

  for (const delivery of ["snapshot", "resume", "failure"] as const) {
    const resume = delivery === "resume";
    const subject = resume ? "an equal-vector resume" : `a ${delivery}`;
    it.effect(`refuses ${subject} when the loaded version becomes public before delivery`, () =>
      Effect.gen(function* () {
        const { authority, streams, pull, reads } = yield* deliveryFence(delivery, (authority) =>
          authority.state.retained.set(authority.latest.versionId, {
            ...authority.latest,
            scope: "public"
          })
        );
        assert.deepStrictEqual(frame(yield* pull), {
          type: "error",
          id: "items",
          permanent: true,
          error: Runtime.toFailure(new Runtime.PublicUnavailable({}))
        });
        assert.strictEqual(reads(), resume ? 0 : 1);
        assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 1);
        authority.state.current = authority.initial.versionId;
        yield* streams.notify(Fixtures.patchId);
        assert.deepStrictEqual(frame(yield* pull), {
          type: "served",
          versionId: authority.initial.versionId,
          tier: authority.initial.manifest.tier
        });
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()), Effect.scoped)
    );

    it.effect(`stops ${subject} when authority is lost before delivery`, () =>
      Effect.gen(function* () {
        const { streams, pull, reads } = yield* deliveryFence(delivery, (authority) => {
          authority.state.current = undefined;
        });
        assert.deepStrictEqual(frame(yield* pull), { type: "access_denied" });
        assert.isTrue(Exit.isFailure(yield* Effect.exit(pull)));
        assert.strictEqual(reads(), resume ? 0 : 1);
        assert.strictEqual(yield* streams.connected(DEV_SEED.companyId), 0);
      }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()), Effect.scoped)
    );
  }
});

const itemsKey = `table:${Fixtures.patchId}:items`;
const items: RuntimeSubscription = {
  id: "items",
  op: "server.call",
  args: { handler: "items.list", args: {} }
};
const window = "10 minutes";
type Change<R = RuntimeSubscriptionRequest> = R extends unknown
  ? Omit<R, "patchId" | "versionId" | "documentId" | "generation">
  : never;

/**
 * Streams for a tier 2 version beside a fleet that counts what its documents hold: company locks
 * from `connect`, and keepalives with whether each warmed and why it ended. Query re-runs admit
 * themselves like calls, counted in `admissions`, and read `revision`. With `gated`, each
 * `connect` waits in `attempts` for its release; while `releasing` is set, a company lock that
 * lets go waits for it first, and while `landing` is set, a desired-set change waits for it
 * before its activity lands. `idle` overrides the company's window and `records` the bounds on
 * disconnected documents' records.
 */
const fleetStreams = Effect.fnUntraced(function* (
  options: {
    readonly idle?: number;
    readonly records?: typeof RuntimeStream.ActivityRecords.Service;
  } = {}
) {
  const operating = yield* StreamLimits.make;
  const limits = StreamLimits.StreamLimits.of({
    getMany: (input) =>
      operating
        .getMany(input)
        .pipe(
          Effect.map(
            (values) =>
              Object.fromEntries(
                Object.entries(values).map(([name, limit]) => [
                  name,
                  limit.limitId === "execution.document.idle" && options.idle !== undefined
                    ? { ...limit, value: options.idle }
                    : limit
                ])
              ) as typeof values
          )
        )
  });
  const authority = yield* versionAuthority;
  authority.state.retained.set(authority.initial.versionId, {
    ...authority.initial,
    manifest: {
      ...authority.initial.manifest,
      tier: 2,
      handlers: { "items.list": { kind: "query", args: {}, result: { kind: "integer" } } }
    }
  });
  const attempts = yield* Queue.unbounded<Deferred.Deferred<void>>();
  const changes = yield* Queue.unbounded<void>();
  const recorded = yield* Queue.unbounded<WideEvents.WideEvent>();
  const fleet = {
    company: 0,
    connects: 0,
    versions: 0,
    warmed: [] as boolean[],
    ended: [] as Array<"idle" | "left">,
    admissions: 0,
    revision: 0,
    gated: false,
    releasing: undefined as Deferred.Deferred<void> | undefined,
    landing: undefined as Deferred.Deferred<void> | undefined
  };
  const events = yield* WideEvents.make.pipe(
    Effect.provideService(WideEvents.Sink, {
      write: (event) => Queue.offer(recorded, event).pipe(Effect.asVoid)
    })
  );
  const streams = yield* RuntimeStream.make.pipe(
    Effect.provideServiceEffect(
      Subscriptions.Subscriptions,
      Effect.map(Subscriptions.make, (registry) =>
        Subscriptions.Subscriptions.of({
          ...registry,
          attach: (attached) => {
            const document = registry.attach(attached);
            return {
              ...document,
              update: (request) =>
                document
                  .update(request)
                  .pipe(
                    Effect.tap((changed) =>
                      changed && fleet.landing !== undefined
                        ? Deferred.await(fleet.landing)
                        : Effect.void
                    )
                  )
            };
          }
        })
      )
    ),
    Effect.provide(StreamAdmission.layer),
    Effect.provideService(StreamLimits.StreamLimits, limits),
    Effect.provide(authority.layer),
    Effect.provideService(WideEvents.WideEvents, events),
    // The suite's call budget of three a minute is for its own tests.
    Effect.provideService(ContractLimits.overrides, {}),
    Effect.provideService(
      RuntimeStream.ActivityRecords,
      options.records ?? RuntimeStream.ActivityRecords.defaultValue()
    ),
    Effect.provideService(SubscriptionReads.SubscriptionReads, {
      admit: () => Effect.die("Hosted queries admit through Invocation."),
      read: () => Effect.die("Hosted queries read through Invocation."),
      revisions: () => Effect.succeed({})
    }),
    Effect.provideService(Invocation.Invocation, {
      call: (_args, _binding, observation) =>
        Effect.sync(() => {
          fleet.admissions++;
          observation?.onDependency(itemsKey);
          observation?.onSnapshot({ [itemsKey]: String(fleet.revision) });
          return { ok: true as const, value: fleet.revision };
        })
    }),
    Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
      prewarm: () => Effect.die("Nothing here prewarms."),
      connect: () =>
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              fleet.company++;
              fleet.connects++;
              Queue.offerUnsafe(changes, undefined);
            }),
            () =>
              Effect.suspend(() =>
                fleet.releasing === undefined ? Effect.void : Deferred.await(fleet.releasing)
              ).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    fleet.company--;
                    Queue.offerUnsafe(changes, undefined);
                  })
                )
              )
          );
          if (!fleet.gated) return;
          const attempt = yield* Deferred.make<void>();
          yield* Queue.offer(attempts, attempt);
          yield* Deferred.await(attempt);
        }),
      acquire: () => Effect.die("Re-runs admit through Invocation."),
      touch: () => Effect.die("Only the keepalive touches.")
    }),
    Effect.provideService(ConnectedVersions.ConnectedVersions, {
      connect: (_version, options) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            fleet.versions++;
            fleet.warmed.push(options.warm);
            Queue.offerUnsafe(changes, undefined);
          }),
          () =>
            Effect.sync(() => {
              fleet.versions--;
              fleet.ended.push(options.idle?.() === true ? "idle" : "left");
              Queue.offerUnsafe(changes, undefined);
            })
        )
    })
  );
  /** Opens the document through `served`, then says whether it started or came straight up. */
  const connect = Effect.fnUntraced(function* (
    documentId: string,
    generation?: string,
    viewer: typeof request = request
  ) {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const body = yield* streams
      .open(input(documentId))
      .pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, viewer(generation)),
        Effect.provideService(Scope.Scope, scope)
      );
    const pull = yield* Stream.toPull(body).pipe(Effect.provideService(Scope.Scope, scope));
    const next = Effect.map(pull, frame);
    const hello = yield* next;
    if (hello.type !== "hello") return assert.fail("Expected hello");
    assert.strictEqual((yield* next).type, "served");
    const opened = yield* next;
    if (opened.type !== "starting" && opened.type !== "ready")
      return assert.fail("Expected starting or ready");
    return { documentId, scope, next, generation: hello.generation, opened: opened.type };
  });
  type Document = Effect.Success<ReturnType<typeof connect>>;
  const update = (document: Document, change: Change) =>
    streams
      .update({ ...input(document.documentId), generation: document.generation, ...change })
      .pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request()));
  /** Reads frames until one matches, returning everything read. */
  const until = Effect.fnUntraced(function* (
    document: Document,
    matches: (frame: RuntimeStreamFrame) => boolean
  ) {
    const read: RuntimeStreamFrame[] = [];
    while (true) {
      const next = yield* document.next;
      read.push(next);
      if (matches(next)) return read;
    }
  });
  /** The latest answer for a subscription, read past anything before it. */
  const answer = Effect.fnUntraced(function* (document: Document, id: string) {
    const read = yield* until(
      document,
      (next) => (next.type === "snapshot" || next.type === "up-to-date") && next.id === id
    );
    const last = read.at(-1);
    if (last?.type !== "snapshot" && last?.type !== "up-to-date")
      return assert.fail("Expected an answer");
    return { last, read };
  });
  type Counts = Partial<Pick<typeof fleet, "company" | "connects" | "versions">>;
  /**
   * Waits until the fleet shows these counts. Holds are taken and let go by background fibers,
   * some after real I/O, so they land in their own time.
   */
  const settle = (counts: Counts): Effect.Effect<void> =>
    Effect.suspend(() =>
      (Object.keys(counts) as Array<keyof Counts>).every((name) => fleet[name] === counts[name])
        ? Effect.void
        : Effect.andThen(Queue.take(changes), settle(counts))
    );
  return { streams, fleet, attempts, recorded, connect, update, until, answer, settle };
});

it.layer(layer)("document activity", (it) => {
  it.effect(
    "holds the company and version while active, then lets both go after the window and stays usable",
    () =>
      Effect.gen(function* () {
        const host = yield* fleetStreams();
        const document = yield* host.connect("idle_after_window_document");
        assert.strictEqual(document.opened, "starting");
        assert.deepStrictEqual(yield* document.next, { type: "ready" });
        yield* host.settle({ company: 1, versions: 1 });
        assert.deepStrictEqual(host.fleet.warmed, [true]);
        yield* TestClock.adjust(10 * 60_000 - 1);
        assert.deepInclude(host.fleet, { company: 1, versions: 1 });
        yield* TestClock.adjust(1);
        yield* host.settle({ company: 0, versions: 0 });
        assert.deepStrictEqual(host.fleet.ended, ["idle"]);
        // The screen and stream stay: the document still counts and its controls are admitted.
        assert.strictEqual(yield* host.streams.connected(DEV_SEED.companyId), 1);
        yield* host.update(document, { sequence: 1, type: "replace", subscriptions: [] });
        assert.deepStrictEqual(yield* document.next, { type: "admitted", sequence: 1 });
        yield* Scope.close(document.scope, Exit.void);
        const summary = yield* Queue.take(host.recorded);
        if (summary.type !== "stream") return assert.fail("Expected the stream event");
        assert.deepInclude(summary, { idled: 1, reactivated: 0 });
        assert.deepInclude(
          summary.limits?.find((limit) => limit.limitId === "execution.document.idle"),
          { value: 600_000, peak: 600_000 }
        );
        assert.deepInclude(host.fleet, { company: 0, versions: 0, connects: 1 });
      }).pipe(Effect.scoped)
  );

  it.effect(
    "stays idle across reconnects whose replace repeats its set with advancing revisions",
    () =>
      Effect.gen(function* () {
        const host = yield* fleetStreams();
        let document = yield* host.connect("reconnecting_document");
        assert.deepStrictEqual(yield* document.next, { type: "ready" });
        yield* host.update(document, { sequence: 1, type: "subscribe", subscription: items });
        let { last } = yield* host.answer(document, "items");
        yield* TestClock.adjust(window);
        yield* host.settle({ company: 0, versions: 0 });
        // Reauthentication reconnects about every 50 seconds, across two more windows.
        for (let reconnect = 0; reconnect < 30; reconnect++) {
          host.fleet.revision++;
          document = yield* host.connect("reconnecting_document", document.generation);
          assert.strictEqual(document.opened, "ready");
          yield* host.update(document, {
            sequence: 0,
            type: "replace",
            subscriptions: [{ ...items, revision: last.revision, vector: last.vector }]
          });
          ({ last } = yield* host.answer(document, "items"));
          yield* TestClock.adjust("50 seconds");
        }
        assert.strictEqual(last.vector[itemsKey], "30");
        assert.deepInclude(host.fleet, { company: 0, versions: 0, connects: 1 });
        assert.deepStrictEqual(host.fleet.warmed, [true]);
      }).pipe(Effect.scoped)
  );

  it.effect("re-holds in the background for a change to its set, not for a repeat", () =>
    Effect.gen(function* () {
      const host = yield* fleetStreams();
      const document = yield* host.connect("changing_document");
      assert.deepStrictEqual(yield* document.next, { type: "ready" });
      yield* host.update(document, { sequence: 1, type: "subscribe", subscription: items });
      const { last } = yield* host.answer(document, "items");
      yield* TestClock.adjust(window);
      yield* host.settle({ company: 0, versions: 0 });
      // The shell's reconciliation repeats the set it holds, with what it has received since.
      yield* host.update(document, {
        sequence: 2,
        type: "replace",
        subscriptions: [{ ...items, revision: last.revision, vector: last.vector }]
      });
      yield* host.answer(document, "items");
      assert.deepInclude(host.fleet, { company: 0, versions: 0, connects: 1 });
      yield* host.update(document, {
        sequence: 3,
        type: "subscribe",
        subscription: { ...items, id: "more" }
      });
      const { read } = yield* host.answer(document, "more");
      yield* host.settle({ company: 1, versions: 1, connects: 2 });
      // A background re-hold sends no startup frames and warms nothing.
      assert.isFalse(read.some((next) => next.type === "starting" || next.type === "ready"));
      assert.deepStrictEqual(host.fleet.warmed, [true, false]);
      yield* TestClock.adjust(window);
      yield* host.settle({ company: 0, versions: 0 });
      assert.deepStrictEqual(host.fleet.ended, ["idle", "idle"]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "re-holds the calling viewer's connected documents of the version, not others' or hidden ones",
    () =>
      Effect.gen(function* () {
        const host = yield* fleetStreams();
        const calling = yield* host.connect("calling_document");
        const hidden = yield* host.connect("hidden_tab_document");
        const colleague = yield* host.connect("colleague_document", undefined, memberRequest);
        for (const document of [calling, hidden, colleague])
          assert.deepStrictEqual(yield* document.next, { type: "ready" });
        yield* TestClock.adjust(window);
        yield* host.settle({ company: 0, versions: 0, connects: 3 });
        // Hidden suspension disconnects the document.
        yield* Scope.close(hidden.scope, Exit.void);
        yield* host.streams.called({
          companyId: DEV_SEED.companyId,
          patchId: Fixtures.patchId,
          versionId: Fixtures.versionId,
          viewerId: DEV_SEED.userId
        });
        yield* host.settle({ company: 1, versions: 1, connects: 4 });
        assert.deepStrictEqual(host.fleet.warmed, [true, true, true, false]);
        // The hidden document comes back still idle.
        const resumed = yield* host.connect("hidden_tab_document", hidden.generation);
        assert.strictEqual(resumed.opened, "ready");
        assert.deepInclude(host.fleet, { company: 1, connects: 4 });
      }).pipe(Effect.scoped)
  );

  it.effect("delivers another viewer's write to an idle document on demand, leaving it idle", () =>
    Effect.gen(function* () {
      const host = yield* fleetStreams();
      const wakes = yield* Wakes.Wakes;
      const document = yield* host.connect("woken_idle_document");
      assert.deepStrictEqual(yield* document.next, { type: "ready" });
      yield* host.update(document, { sequence: 1, type: "subscribe", subscription: items });
      yield* host.answer(document, "items");
      yield* TestClock.adjust(window);
      yield* host.settle({ company: 0, versions: 0 });
      const admissions = host.fleet.admissions;
      host.fleet.revision++;
      yield* wakes.publish([itemsKey]);
      yield* host.until(
        document,
        (next) => next.type === "snapshot" && next.result === host.fleet.revision
      );
      assert.isAbove(host.fleet.admissions, admissions);
      assert.deepInclude(host.fleet, { company: 0, versions: 0, connects: 1 });
    }).pipe(Effect.scoped)
  );

  it.effect("starts active when a reconnect reaches a host that never saw the document", () =>
    Effect.gen(function* () {
      const host = yield* fleetStreams();
      const document = yield* host.connect("moved_host_document", "stream_fromanotherhost00000000");
      assert.strictEqual(document.opened, "starting");
      assert.deepStrictEqual(yield* document.next, { type: "ready" });
      yield* host.settle({ company: 1, versions: 1 });
      assert.deepStrictEqual(host.fleet.warmed, [false]);
    }).pipe(Effect.scoped)
  );

  it.effect("ends a startup the window outlasts in ready, as an idle document", () =>
    Effect.gen(function* () {
      const host = yield* fleetStreams({ idle: 5_000 });
      host.fleet.gated = true;
      const document = yield* host.connect("outlasted_startup_document");
      assert.strictEqual(document.opened, "starting");
      yield* Queue.take(host.attempts);
      yield* TestClock.adjust("5 seconds");
      // Held calls settle: the binding still pending is given up, and dispatch opens.
      assert.deepStrictEqual(yield* document.next, { type: "ready" });
      assert.deepInclude(host.fleet, { company: 0, versions: 0 });
      // Its next activity re-holds in the background, and its work doesn't wait for that.
      yield* host.update(document, { sequence: 1, type: "subscribe", subscription: items });
      yield* Queue.take(host.attempts);
      yield* host.answer(document, "items");
      assert.deepInclude(host.fleet, { company: 1, versions: 0, connects: 2 });
    }).pipe(Effect.scoped)
  );

  it.effect(
    "lands a call's activity on the generation that replaced its document meanwhile, not a departed one",
    () =>
      Effect.gen(function* () {
        const host = yield* fleetStreams();
        const moving = yield* host.connect("moving_call_document");
        const leaving = yield* host.connect("leaving_call_document");
        for (const document of [moving, leaving])
          assert.deepStrictEqual(yield* document.next, { type: "ready" });
        yield* TestClock.adjust(window);
        yield* host.settle({ company: 0, versions: 0 });
        // The call's documents are found, then reauthentication replaces one and the other leaves.
        const activity = host.streams.called({
          companyId: DEV_SEED.companyId,
          patchId: Fixtures.patchId,
          versionId: Fixtures.versionId,
          viewerId: DEV_SEED.userId
        });
        const moved = yield* host.connect("moving_call_document", moving.generation);
        assert.strictEqual(moved.opened, "ready");
        yield* Scope.close(leaving.scope, Exit.void);
        yield* activity;
        yield* host.settle({ company: 1, versions: 1, connects: 3 });
        const resumed = yield* host.connect("leaving_call_document", leaving.generation);
        assert.strictEqual(resumed.opened, "ready");
        assert.strictEqual(host.fleet.connects, 3);
      }).pipe(Effect.scoped)
  );

  it.effect("lands a set change's activity on the generation that replaced it meanwhile", () =>
    Effect.gen(function* () {
      const host = yield* fleetStreams();
      const first = yield* host.connect("handed_over_document");
      assert.deepStrictEqual(yield* first.next, { type: "ready" });
      yield* TestClock.adjust(window);
      yield* host.settle({ company: 0, versions: 0 });
      const landing = yield* Deferred.make<void>();
      host.fleet.landing = landing;
      const updating = yield* host
        .update(first, { sequence: 1, type: "subscribe", subscription: items })
        .pipe(Effect.forkChild);
      assert.deepStrictEqual(yield* first.next, { type: "admitted", sequence: 1 });
      host.fleet.landing = undefined;
      // Admitted, but its activity hasn't landed when reauthentication replaces the generation.
      const second = yield* host.connect("handed_over_document", first.generation);
      assert.strictEqual(second.opened, "ready");
      yield* Deferred.succeed(landing, undefined);
      yield* Fiber.join(updating);
      yield* host.settle({ company: 1, versions: 1, connects: 2 });
    }).pipe(Effect.scoped)
  );

  it.effect(
    "never lets an old owner's expiry, acquisition or finalizer touch its replacement's holds",
    () =>
      Effect.gen(function* () {
        const host = yield* fleetStreams();
        host.fleet.gated = true;
        const first = yield* host.connect("raced_owner_document");
        yield* Deferred.succeed(yield* Queue.take(host.attempts), undefined);
        assert.deepStrictEqual(yield* first.next, { type: "ready" });
        yield* TestClock.adjust(window);
        yield* host.settle({ company: 0, versions: 0 });
        // Expiry cancels a re-hold still acquiring.
        yield* host.update(first, { sequence: 1, type: "subscribe", subscription: items });
        yield* Queue.take(host.attempts);
        assert.deepInclude(host.fleet, { company: 1, versions: 0 });
        yield* TestClock.adjust(window);
        yield* host.settle({ company: 0, versions: 0 });
        // The generation is replaced while a re-hold acquires, and its lock lets go slowly.
        yield* host.update(first, {
          sequence: 2,
          type: "subscribe",
          subscription: { ...items, id: "more" }
        });
        const stale = yield* Queue.take(host.attempts);
        const releasing = yield* Deferred.make<void>();
        host.fleet.releasing = releasing;
        const second = yield* host.connect("raced_owner_document", first.generation);
        assert.strictEqual(second.opened, "starting");
        const current = yield* Queue.take(host.attempts);
        yield* Deferred.succeed(stale, undefined);
        yield* Deferred.succeed(current, undefined);
        assert.deepStrictEqual(yield* second.next, { type: "ready" });
        yield* host.settle({ company: 2, versions: 1 });
        // The old owner's finalizer lands after the new owner took over, letting go of its own.
        host.fleet.releasing = undefined;
        yield* Deferred.succeed(releasing, undefined);
        yield* host.settle({ company: 1, versions: 1 });
        // The new owner still holds: a change to its set takes nothing more.
        const connects = host.fleet.connects;
        yield* host.update(second, { sequence: 0, type: "replace", subscriptions: [] });
        yield* Scope.close(second.scope, Exit.void);
        yield* host.settle({ company: 0, versions: 0 });
        let summary = yield* Queue.take(host.recorded);
        while (summary.eventId !== second.generation) summary = yield* Queue.take(host.recorded);
        assert.deepInclude(summary, { reactivated: 0 });
        assert.strictEqual(host.fleet.connects, connects);
      }).pipe(Effect.scoped)
  );

  it.effect("forgets the longest-disconnected records past the bound, never a connected one", () =>
    Effect.gen(function* () {
      const host = yield* fleetStreams({ records: { capacity: 1, retention: 60 * 60_000 } });
      const kept = yield* host.connect("kept_connected_document");
      const evicted = yield* host.connect("evicted_document");
      const remembered = yield* host.connect("remembered_document");
      for (const document of [kept, evicted, remembered])
        assert.deepStrictEqual(yield* document.next, { type: "ready" });
      yield* TestClock.adjust(window);
      yield* Scope.close(evicted.scope, Exit.void);
      yield* Scope.close(remembered.scope, Exit.void);
      const forgotten = yield* host.connect("evicted_document", evicted.generation);
      assert.strictEqual(forgotten.opened, "starting");
      const known = yield* host.connect("remembered_document", remembered.generation);
      assert.strictEqual(known.opened, "ready");
      yield* Scope.close(kept.scope, Exit.void);
      assert.strictEqual(
        (yield* host.connect("kept_connected_document", kept.generation)).opened,
        "ready"
      );
    }).pipe(Effect.scoped)
  );

  it.effect("forgets a disconnected record after retention, never one that reattached", () =>
    Effect.gen(function* () {
      const host = yield* fleetStreams({ records: { capacity: 4096, retention: 60_000 } });
      let document = yield* host.connect("returning_document");
      assert.deepStrictEqual(yield* document.next, { type: "ready" });
      yield* TestClock.adjust(window);
      yield* Scope.close(document.scope, Exit.void);
      yield* TestClock.adjust("30 seconds");
      document = yield* host.connect("returning_document", document.generation);
      assert.strictEqual(document.opened, "ready");
      // Past the first disconnect's retention, another document's departure forgets records.
      yield* TestClock.adjust("2 minutes");
      const other = yield* host.connect("departing_document");
      yield* Scope.close(other.scope, Exit.void);
      yield* Scope.close(document.scope, Exit.void);
      document = yield* host.connect("returning_document", document.generation);
      assert.strictEqual(document.opened, "ready");
      yield* Scope.close(document.scope, Exit.void);
      yield* TestClock.adjust("1 minute");
      const forgotten = yield* host.connect("returning_document", document.generation);
      assert.strictEqual(forgotten.opened, "starting");
    }).pipe(Effect.scoped)
  );
});
