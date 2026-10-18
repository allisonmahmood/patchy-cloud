import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectedVersions from "./ConnectedVersions.js";
import * as ExecutionLifecycle from "./ExecutionLifecycle.js";
import * as Executor from "./Executor.js";
import type { LoadedVersion } from "./LoadedVersions.js";
import * as ServerBundles from "./ServerBundles.js";
import * as StreamLimits from "./StreamLimits.js";

const idle = registry["execution.process.idle"].default;
const version = (versionId: string): LoadedVersion => ({
  companyId: "cmp_connected",
  patchId: "pat_connected",
  versionId,
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {},
    handlers: {}
  },
  scope: "company",
  wireVersion: WIRE_VERSION
});

type Step =
  | {
      readonly kind: "touch";
      readonly versionId: string;
      readonly outcome: ExecutionLifecycle.TouchOutcome;
    }
  | { readonly kind: "bind"; readonly versionId: string };

/**
 * One host's connected versions over a supervisor that holds `resident`. Touches and binds
 * arrive in `next` in the order they reach it; `outcomes` overrides what a touch finds.
 */
const harness = Effect.gen(function* () {
  const steps = yield* Queue.unbounded<Step>();
  const touchedAt = new Map<string, number[]>();
  const resident = new Set<string>();
  const outcomes = new Map<string, ExecutionLifecycle.TouchOutcome>();
  const recorded = yield* Queue.unbounded<WideEvents.WideEvent>();
  const events = yield* WideEvents.make.pipe(
    Effect.provideService(WideEvents.Sink, {
      write: (event) => Queue.offer(recorded, event).pipe(Effect.asVoid)
    })
  );
  const connected = yield* ConnectedVersions.make.pipe(
    Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
      connect: () => Effect.void,
      acquire: () =>
        Effect.succeed({
          binding: { taskId: "task_connected", bindingEpoch: 1 },
          release: Effect.void
        }),
      touch: Effect.fnUntraced(function* ({ versionId }) {
        const outcome = outcomes.get(versionId) ?? (resident.has(versionId) ? "touched" : "absent");
        touchedAt.set(versionId, [
          ...(touchedAt.get(versionId) ?? []),
          yield* Clock.currentTimeMillis
        ]);
        yield* Queue.offer(steps, { kind: "touch", versionId, outcome });
        return outcome;
      })
    }),
    Effect.provideService(Executor.Executor, {
      bind: Effect.fnUntraced(function* ({ companyId, patchId, versionId, sha256 }) {
        resident.add(versionId);
        yield* Queue.offer(steps, { kind: "bind", versionId });
        return { binding: { companyId, patchId, versionId, sha256 }, processGeneration: 1 };
      }),
      invoke: () => Effect.die("A keepalive never invokes a handler.")
    }),
    Effect.provideService(ServerBundles.ServerBundles, {
      load: (loaded) =>
        Effect.succeed({
          companyId: loaded.companyId,
          patchId: loaded.patchId,
          versionId: loaded.versionId,
          sha256: "0".repeat(64),
          bundle: "export default {};"
        })
    }),
    Effect.provide(StreamLimits.layerLocal),
    Effect.provideService(WideEvents.WideEvents, events)
  );
  /** A document's ready stream on this host, until `Scope.close`. */
  const open = Effect.fnUntraced(function* (versionId: string, warm: boolean) {
    const scope = yield* Scope.make();
    yield* connected.connect(version(versionId), { warm }).pipe(Scope.provide(scope));
    return scope;
  });
  return {
    open,
    resident,
    outcomes,
    touchedAt,
    next: Queue.take(steps),
    event: Queue.take(recorded)
  };
});

it.effect("warms a version once per document and only touches it for renewals", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    // Nothing holds the version, so the first document's first stream loads it.
    const first = yield* host.open("ver_a", true);
    assert.deepStrictEqual(yield* host.next, {
      kind: "touch",
      versionId: "ver_a",
      outcome: "absent"
    });
    assert.deepStrictEqual(yield* host.next, { kind: "bind", versionId: "ver_a" });
    // Another document's first stream finds it loaded, and only touches it.
    const second = yield* host.open("ver_a", true);
    assert.deepStrictEqual(yield* host.next, {
      kind: "touch",
      versionId: "ver_a",
      outcome: "touched"
    });
    yield* Scope.close(first, Exit.void);
    yield* Scope.close(second, Exit.void);
    assert.deepInclude(yield* host.event, {
      type: "keepalive",
      versionId: "ver_a",
      outcome: "success",
      peakDocuments: 2,
      touches: { absent: 1, touched: 1 },
      warmups: { loaded: 1, resident: 1 }
    });
    // Evicted under pressure, the version waits for demand: a renewal only touches it.
    host.resident.delete("ver_a");
    const renewal = yield* host.open("ver_a", false);
    for (let touch = 0; touch < 3; touch++) {
      assert.deepStrictEqual(yield* host.next, {
        kind: "touch",
        versionId: "ver_a",
        outcome: "absent"
      });
      yield* TestClock.adjust(idle / 2);
    }
    assert.isFalse(host.resident.has("ver_a"));
    yield* Scope.close(renewal, Exit.void);
    assert.deepInclude(yield* host.event, {
      type: "keepalive",
      peakDocuments: 1,
      warmups: {}
    });
  }).pipe(Effect.scoped)
);

it.effect("neither loads nor wakes a paused patch's version", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    host.outcomes.set("ver_paused", "paused");
    const document = yield* host.open("ver_paused", true);
    assert.deepStrictEqual(yield* host.next, {
      kind: "touch",
      versionId: "ver_paused",
      outcome: "paused"
    });
    yield* TestClock.adjust(idle / 2);
    assert.deepStrictEqual(yield* host.next, {
      kind: "touch",
      versionId: "ver_paused",
      outcome: "paused"
    });
    yield* Scope.close(document, Exit.void);
    assert.deepInclude(yield* host.event, {
      touches: { paused: 2 },
      warmups: { paused: 1 }
    });
  }).pipe(Effect.scoped)
);

it.effect("touches each version once per turn before its idle window ends, until it's left", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    host.resident.add("ver_a");
    host.resident.add("ver_b");
    const a = [yield* host.open("ver_a", false), yield* host.open("ver_a", false)];
    const b = yield* host.open("ver_b", false);
    const span = 10 * 60_000;
    for (let elapsed = 0; elapsed < span; elapsed += 1_000) yield* TestClock.adjust(1_000);
    for (const versionId of ["ver_a", "ver_b"]) {
      const times = host.touchedAt.get(versionId)!;
      // Each version's touches are its own, however many documents hold it.
      assert.isAtLeast(times.length, Math.floor(span / (idle * 0.45)), versionId);
      assert.isAtMost(times.length, Math.ceil(span / (idle * 0.35)) + 1, versionId);
      // The stepped clock can register a sleep up to one step late.
      for (let index = 1; index < times.length; index++)
        assert.isAtMost(times[index]! - times[index - 1]!, idle * 0.45 + 1_000, versionId);
    }
    // One document leaving keeps the version touched; the last one stops it.
    yield* Scope.close(a[0]!, Exit.void);
    const before = host.touchedAt.get("ver_a")!.length;
    yield* TestClock.adjust(idle);
    assert.isAbove(host.touchedAt.get("ver_a")!.length, before);
    yield* Scope.close(a[1]!, Exit.void);
    yield* Scope.close(b, Exit.void);
    // Each keepalive reports itself once its loop has ended.
    const ended = [yield* host.event, yield* host.event];
    assert.sameMembers(
      ended.map((event) => ("peakDocuments" in event ? event.peakDocuments : undefined)),
      [2, 1]
    );
    const stopped = new Map(
      [...host.touchedAt].map(([versionId, times]) => [versionId, times.length])
    );
    for (let elapsed = 0; elapsed < 5 * idle; elapsed += 1_000) yield* TestClock.adjust(1_000);
    assert.deepStrictEqual(
      new Map([...host.touchedAt].map(([versionId, times]) => [versionId, times.length])),
      stopped
    );
  }).pipe(Effect.scoped)
);
