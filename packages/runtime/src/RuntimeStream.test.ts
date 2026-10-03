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
import { RuntimeStreamFrame, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session } from "@patchy/auth";
import { PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { DEV_SEED } from "@patchy/auth/seed";
import { ContractLimits, Limits, OperatingLimits } from "@patchy/limits";
import * as LoadedVersions from "./LoadedVersions.js";
import * as ExecutionLifecycle from "./ExecutionLifecycle.js";
import * as Fixtures from "./test/fixtures.js";
import { HandlerFailed } from "./Invocation.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeApi from "./RuntimeApi.js";
import * as RuntimeProduction from "./RuntimeProduction.js";
import * as RuntimeStream from "./RuntimeStream.js";
import * as StreamAdmission from "./StreamAdmission.js";
import * as StreamLimits from "./StreamLimits.js";
import * as SubscriptionReads from "./SubscriptionReads.js";
import * as Subscriptions from "./Subscriptions.js";
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
        tier: 0
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
      assert.strictEqual(event.companyId, DEV_SEED.companyId);
      assert.strictEqual(event.patchId, Fixtures.patchId);
      assert.strictEqual(yield* Queue.size(recorded), 0);
    }).pipe(Effect.scoped)
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
