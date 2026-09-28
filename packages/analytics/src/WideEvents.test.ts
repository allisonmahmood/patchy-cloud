import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import * as Analytics from "./Analytics.js";
import * as PostHogClient from "./PostHogClient.js";
import * as WideEvents from "./WideEvents.js";
import * as WideEventsPostHog from "./WideEventsPostHog.js";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(WideEvents.WideEvent));
const decodeBinding = Schema.decodeUnknownSync(Schema.fromJsonString(WideEvents.BindingEvent));

const recording = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<WideEvents.WideEvent>();
  const records: WideEvents.WideEvent[] = [];
  const layer = WideEvents.layerWithSink.pipe(
    Layer.provide(
      Layer.succeed(WideEvents.Sink, {
        write: (event) =>
          Effect.sync(() => {
            records.push(event);
            Queue.offerUnsafe(queue, event);
          })
      })
    )
  );
  return { layer, records, take: Queue.take(queue) };
});

it.effect(
  "finalizes failure, defect and interruption once without changing the caller's exit",
  () =>
    Effect.gen(function* () {
      const sink = yield* recording;
      yield* Effect.gen(function* () {
        const events = yield* WideEvents.WideEvents;
        const failure = Exit.fail("failed work");
        assert.deepStrictEqual(
          yield* events.withEvent({ type: "request" }, failure).pipe(Effect.exit),
          failure
        );
        const defect = new Error("broken work");
        const died = yield* events
          .withEvent({ type: "request" }, Effect.die(defect))
          .pipe(Effect.exit);
        assert.deepStrictEqual(died, Exit.die(defect));
        const entered = yield* Deferred.make<void>();
        const interrupted = yield* events
          .withEvent(
            { type: "request" },
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(interrupted);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(interrupted)));
        const records = [yield* sink.take, yield* sink.take, yield* sink.take];
        assert.deepStrictEqual(
          records.map((event) => event.outcome),
          ["failure", "failure", "interrupted"]
        );
        yield* Effect.yieldNow;
        assert.strictEqual(sink.records.length, 3);
        assert.strictEqual(new Set(records.map((event) => event.eventId)).size, 3);
        assert.isTrue(records.every((event) => event.sampleProbability === 1));
      }).pipe(Effect.provide(sink.layer));
    })
);

it.effect("keeps simultaneous and nested hops isolated while linking their parent and trace", () =>
  Effect.gen(function* () {
    const sink = yield* recording;
    yield* Effect.gen(function* () {
      const events = yield* WideEvents.WideEvents;
      const firstEntered = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const first = yield* events
        .withEvent(
          { type: "request", viewerId: "viewer-a" },
          Effect.gen(function* () {
            yield* Deferred.succeed(firstEntered, undefined);
            yield* Deferred.await(secondEntered);
            yield* WideEvents.operation("tables.insert");
            yield* events.withEvent(
              { type: "re-run", handler: "rows.list" },
              Effect.gen(function* () {
                yield* WideEvents.enrich({ outcome: "refused", code: "busy" });
                yield* WideEvents.operation("tables.list");
              })
            );
          })
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);
      yield* events.withEvent(
        { type: "request", viewerId: "viewer-b" },
        Effect.gen(function* () {
          yield* WideEvents.operation("members.search");
          yield* Deferred.succeed(secondEntered, undefined);
          yield* Fiber.join(first);
        })
      );
      const records = [yield* sink.take, yield* sink.take, yield* sink.take];
      const child = records.find((event) => event.type === "re-run")!;
      const a = records.find((event) => "viewerId" in event && event.viewerId === "viewer-a")!;
      const b = records.find((event) => "viewerId" in event && event.viewerId === "viewer-b")!;
      assert.strictEqual(child.parentId, a.eventId);
      assert.strictEqual(child.traceId, a.traceId);
      assert.notStrictEqual(a.traceId, b.traceId);
      assert.notProperty(a, "parentId");
      assert.notProperty(b, "parentId");
      assert.notProperty(child, "viewerId");
      assert.strictEqual(child.outcome, "refused");
      assert.strictEqual(a.outcome, "success");
      assert.strictEqual(b.outcome, "success");
      assert.deepStrictEqual("operations" in child && child.operations, ["tables.list"]);
      assert.deepStrictEqual("operations" in a && a.operations, ["tables.insert"]);
      assert.deepStrictEqual("operations" in b && b.operations, ["members.search"]);
    }).pipe(Effect.provide(sink.layer));
  })
);

it.effect("keeps attribution on the hop that can own it", () =>
  Effect.gen(function* () {
    const sink = yield* recording;
    yield* Effect.gen(function* () {
      yield* WideEvents.enrich({ viewerId: "outside", code: "not an event" });
      yield* WideEvents.operation("outside");
      const events = yield* WideEvents.WideEvents;
      yield* events.withEvent(
        { type: "request", viewerId: "caller", patchId: "patch-a" },
        Effect.gen(function* () {
          yield* events.withEvent(
            { type: "process", taskId: "task-a", companyId: "company-a" },
            WideEvents.enrich({
              viewerId: "arbitrary",
              handler: "arbitrary",
              kind: "query",
              peakRssBytes: 512
            })
          );
          yield* events.withEvent(
            { type: "binding", taskId: "unbound-task" },
            WideEvents.enrich({
              viewerId: "arbitrary",
              patchId: "arbitrary",
              versionId: "arbitrary"
            })
          );
          yield* events.withEvent(
            { type: "stream", viewerId: "subscriber", patchId: "patch-a" },
            WideEvents.enrich({
              handler: "arbitrary",
              kind: "query",
              processGeneration: 4,
              peakSubscriptions: 2
            })
          );
        })
      );
      yield* events.withEvent({ type: "request" }, Effect.void);
      const records = [
        yield* sink.take,
        yield* sink.take,
        yield* sink.take,
        yield* sink.take,
        yield* sink.take
      ];
      const process = records.find((event) => event.type === "process")!;
      const binding = records.find((event) => event.type === "binding")!;
      const stream = records.find((event) => event.type === "stream")!;
      assert.include(stream, { viewerId: "subscriber", patchId: "patch-a", peakSubscriptions: 2 });
      for (const key of ["handler", "kind", "processGeneration"]) assert.notProperty(stream, key);
      assert.include(process, { companyId: "company-a", taskId: "task-a", peakRssBytes: 512 });
      for (const key of ["viewerId", "handler", "kind", "patchId", "versionId"])
        assert.notProperty(process, key);
      for (const key of ["companyId", "viewerId", "handler", "kind", "patchId", "versionId"])
        assert.notProperty(binding, key);
      const isolated = records.find((event) => event.type === "request" && !("viewerId" in event))!;
      for (const key of ["viewerId", "companyId", "handler", "parentId", "operations", "code"])
        assert.notProperty(isolated, key);
    }).pipe(Effect.provide(sink.layer));
  })
);

it.effect("keeps peak usage per limit configuration and unique operations", () =>
  Effect.gen(function* () {
    const sink = yield* recording;
    yield* Effect.gen(function* () {
      const events = yield* WideEvents.WideEvents;
      yield* events.withEvent(
        { type: "request", traceId: "external-trace", parentId: "external-parent" },
        Effect.gen(function* () {
          yield* WideEvents.operation("tables.get");
          yield* WideEvents.operation("tables.get");
          yield* WideEvents.operation("members.get");
          for (const peak of [3, 1, 4, 2]) {
            yield* WideEvents.enrich({
              limits: [
                {
                  limitId: "company.connections",
                  value: 4,
                  peak,
                  configRevision: { deploymentRevision: "deployment-a", overrideRevision: "one" }
                }
              ]
            });
          }
          yield* WideEvents.enrich({
            limits: [
              {
                limitId: "company.connections",
                value: 8,
                peak: 5,
                configRevision: { deploymentRevision: "deployment-a", overrideRevision: "two" }
              },
              {
                limitId: "company.connections",
                value: 6,
                peak: 2,
                configRevision: { deploymentRevision: "deployment-b", overrideRevision: "one" }
              }
            ]
          });
          yield* WideEvents.enrich({
            outcome: "refused",
            code: "busy",
            limitId: "company.connections"
          });
          yield* TestClock.adjust(17);
        })
      );
      const record = yield* sink.take;
      assert.include(record, {
        traceId: "external-trace",
        parentId: "external-parent",
        durationMs: 17,
        outcome: "refused",
        code: "busy"
      });
      assert.deepStrictEqual("operations" in record && record.operations, [
        "tables.get",
        "members.get"
      ]);
      assert.deepStrictEqual(record.limits, [
        {
          limitId: "company.connections",
          value: 4,
          peak: 4,
          configRevision: { deploymentRevision: "deployment-a", overrideRevision: "one" }
        },
        {
          limitId: "company.connections",
          value: 8,
          peak: 5,
          configRevision: { deploymentRevision: "deployment-a", overrideRevision: "two" }
        },
        {
          limitId: "company.connections",
          value: 6,
          peak: 2,
          configRevision: { deploymentRevision: "deployment-b", overrideRevision: "one" }
        }
      ]);
    }).pipe(Effect.provide(sink.layer));
  })
);

it("rejects a limit measurement without a complete configuration revision", () => {
  const decode = Schema.decodeUnknownSync(WideEvents.LimitPeak);
  for (const configRevision of [
    "one",
    { deploymentRevision: "deployment-a" },
    { overrideRevision: "one" }
  ]) {
    assert.throws(() =>
      decode({ limitId: "company.connections", value: 4, peak: 3, configRevision })
    );
  }
});

it.effect("does not close the request Scope when the event is finalized", () =>
  Effect.gen(function* () {
    const sink = yield* recording;
    const scope = yield* Scope.make();
    let closed = false;
    yield* Effect.gen(function* () {
      const events = yield* WideEvents.WideEvents;
      yield* events.withEvent(
        { type: "request" },
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          })
        )
      );
    }).pipe(Effect.provide(sink.layer), Effect.provideService(Scope.Scope, scope));
    yield* sink.take;
    assert.isFalse(closed);
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(closed);
  })
);

it.effect("never waits for sink delivery or changes a successful result when the sink throws", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const hanging = WideEvents.layerWithSink.pipe(
      Layer.provide(
        Layer.succeed(WideEvents.Sink, {
          write: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, undefined))
            )
        })
      )
    );
    const result = yield* Effect.flatMap(WideEvents.WideEvents, (events) =>
      events.withEvent({ type: "request" }, Effect.succeed("response"))
    ).pipe(Effect.provide(hanging));
    assert.strictEqual(result, "response");
    yield* Deferred.await(started);
    assert.isFalse(yield* Deferred.isDone(stopped));
    yield* TestClock.adjust("3 seconds");
    yield* Deferred.await(stopped);

    const failed = yield* Deferred.make<void>();
    const broken = WideEvents.layerWithSink.pipe(
      Layer.provide(
        Layer.succeed(WideEvents.Sink, {
          write: () =>
            Deferred.succeed(failed, undefined).pipe(Effect.andThen(Effect.die("broken sink")))
        })
      )
    );
    assert.strictEqual(
      yield* Effect.flatMap(WideEvents.WideEvents, (events) =>
        events.withEvent({ type: "request" }, Effect.succeed("another response"))
      ).pipe(Effect.provide(broken)),
      "another response"
    );
    yield* Deferred.await(failed);
  })
);

it.effect("keeps stdout available with no PostHog key and offers compact or full dev output", () =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>();
    const stdout = yield* Console.Console;
    const output = {
      ...stdout,
      log: (line: string) => {
        Queue.offerUnsafe(lines, line);
      }
    };
    yield* Effect.flatMap(WideEvents.WideEvents, (events) =>
      events.withEvent({ type: "request", viewerId: "viewer", handler: "rows.save" }, Effect.void)
    ).pipe(
      Effect.provide(WideEventsPostHog.layer),
      Effect.provideService(Console.Console, output),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
    );
    const line = yield* Queue.take(lines);
    assert.notInclude(line, "\n");
    const record = decodeEvent(line);
    assert.include(record, {
      type: "request",
      viewerId: "viewer",
      handler: "rows.save",
      outcome: "success"
    });
    assert.strictEqual(WideEvents.formatDev(record), "viewer rows.save success 0ms");
    assert.deepStrictEqual(decodeEvent(WideEvents.formatDev(record, { json: true })), record);
  })
);

it.effect("attempts PostHog despite broken stdout and stdout despite hanging PostHog", () =>
  Effect.gen(function* () {
    const messages = yield* Queue.unbounded<PostHogClient.CaptureMessage>();
    const stdout = yield* Console.Console;
    const postHog = Layer.succeed(PostHogClient.PostHogClient, {
      capture: (message: PostHogClient.CaptureMessage) =>
        Queue.offer(messages, message).pipe(Effect.asVoid),
      shutdown: Effect.void
    });
    yield* Effect.flatMap(WideEvents.WideEvents, (events) =>
      events.withEvent({ type: "request", viewerId: "viewer" }, Effect.void)
    ).pipe(
      Effect.provide(
        WideEvents.layerWithSink.pipe(
          Layer.provide(WideEventsPostHog.layerSink.pipe(Layer.provide(postHog)))
        )
      ),
      Effect.provideService(Console.Console, {
        ...stdout,
        log: () => {
          throw new Error("broken stdout");
        }
      })
    );
    const message = yield* Queue.take(messages);
    assert.strictEqual(message.distinctId, "viewer");
    assert.strictEqual(message.properties.$process_person_profile, false);

    const lines = yield* Queue.unbounded<string>();
    const stopped = yield* Deferred.make<void>();
    const unavailable = Layer.succeed(PostHogClient.PostHogClient, {
      capture: () => Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
      shutdown: Effect.void
    });
    yield* Effect.flatMap(WideEvents.WideEvents, (events) =>
      events.withEvent({ type: "binding", taskId: "task" }, Effect.void)
    ).pipe(
      Effect.provide(
        WideEvents.layerWithSink.pipe(
          Layer.provide(WideEventsPostHog.layerSink.pipe(Layer.provide(unavailable)))
        )
      ),
      Effect.provideService(Console.Console, {
        ...stdout,
        log: (line: string) => {
          Queue.offerUnsafe(lines, line);
        }
      })
    );
    const line = yield* Queue.take(lines);
    assert.include(decodeBinding(line), { taskId: "task" });
    yield* TestClock.adjust("3 seconds");
    yield* Deferred.await(stopped);
  })
);

it.effect("attributes wide events to viewers or the instance, never the company", () =>
  Effect.gen(function* () {
    const messages = yield* Queue.unbounded<PostHogClient.CaptureMessage>();
    const stdout = yield* Console.Console;
    const postHog = Layer.succeed(PostHogClient.PostHogClient, {
      capture: (message: PostHogClient.CaptureMessage) =>
        Queue.offer(messages, message).pipe(Effect.asVoid),
      shutdown: Effect.void
    });
    yield* Effect.gen(function* () {
      const events = yield* WideEvents.WideEvents;
      for (const viewerId of [undefined, "viewer"]) {
        yield* events.withEvent(
          {
            type: "request",
            companyId: "company",
            outcome: "refused",
            ...(viewerId === undefined ? {} : { viewerId })
          },
          Effect.void
        );
        const message = yield* Queue.take(messages);
        assert.strictEqual(message.distinctId, viewerId ?? Analytics.INSTANCE_DISTINCT_ID);
        assert.include(message.properties, {
          companyId: "company",
          outcome: "refused",
          $process_person_profile: false
        });
        if (viewerId === undefined) assert.notProperty(message.properties, "viewerId");
        else assert.strictEqual(message.properties.viewerId, viewerId);
      }
    }).pipe(
      Effect.provide(
        WideEvents.layerWithSink.pipe(
          Layer.provide(WideEventsPostHog.layerSink.pipe(Layer.provide(postHog)))
        )
      ),
      Effect.provideService(Console.Console, { ...stdout, log: () => {} })
    );
  })
);

it.effect("shares one PostHog acquisition and shutdown between business and wide events", () =>
  Effect.gen(function* () {
    const captured = yield* Queue.unbounded<PostHogClient.CaptureMessage>();
    let acquired = 0;
    let shutdowns = 0;
    const shared = PostHogClient.layerShutdown.pipe(
      Layer.provideMerge(
        Layer.effect(
          PostHogClient.PostHogClient,
          Effect.sync(() => {
            acquired++;
            return {
              capture: (message: PostHogClient.CaptureMessage) =>
                Queue.offer(captured, message).pipe(Effect.asVoid),
              shutdown: Effect.sync(() => {
                shutdowns++;
              })
            };
          })
        )
      )
    );
    const stdout = yield* Console.Console;
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      Layer.merge(
        Analytics.layerPostHog.pipe(Layer.provide(shared)),
        WideEvents.layerWithSink.pipe(
          Layer.provide(WideEventsPostHog.layerSink.pipe(Layer.provide(shared)))
        )
      ),
      scope
    ).pipe(Effect.provideService(Console.Console, { ...stdout, log: () => {} }));
    yield* Context.get(context, Analytics.Analytics).track({
      name: "patch.created",
      principalId: "owner",
      properties: {}
    });
    yield* Context.get(context, WideEvents.WideEvents).withEvent({ type: "request" }, Effect.void);
    assert.deepStrictEqual(
      [(yield* Queue.take(captured)).event, (yield* Queue.take(captured)).event],
      ["patch.created", "wide.request"]
    );
    assert.strictEqual(acquired, 1);
    assert.strictEqual(shutdowns, 0);
    yield* Scope.close(scope, Exit.void);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(shutdowns, 1);
  })
);
