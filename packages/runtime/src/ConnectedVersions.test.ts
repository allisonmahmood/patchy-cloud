import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Scheduler from "effect/Scheduler";
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
  | { readonly kind: "bind"; readonly versionId: string }
  | { readonly kind: "admission"; readonly versionId: string };

/** How long a lost management request takes to fail: the ECS provider's own timeout. */
const lostMs = registry["tier2.settlement.cleanup"].default + 5_000;

/**
 * One host's connected versions over a supervisor that holds `resident`. Touches and binds
 * arrive in `next` in the order they reach it; `outcomes` overrides what a touch finds. The
 * touches numbered in `lost`, counting from zero, never arrive and fail after `lostMs`.
 * `touchedAt` records when each touch was sent, `landedAt` when one restarted an idle clock.
 * `windows` holds the company's configured idle window and the one the supervisor reaps by,
 * which its answers report. A warmup's admission waits for `admissions.gate` when it is set.
 */
const harness = Effect.gen(function* () {
  const steps = yield* Queue.unbounded<Step>();
  const touchedAt = new Map<string, number[]>();
  const landedAt = new Map<string, number[]>();
  const lost = new Set<number>();
  let sent = 0;
  const resident = new Set<string>();
  const outcomes = new Map<string, ExecutionLifecycle.TouchOutcome>();
  const windows: { configured: number; supervisor: number } = {
    configured: idle,
    supervisor: idle
  };
  const admissions = {
    gate: undefined as Deferred.Deferred<void> | undefined,
    admitted: 0,
    interrupted: 0
  };
  const local = yield* StreamLimits.StreamLimits.pipe(Effect.provide(StreamLimits.layerLocal));
  const recorded = yield* Queue.unbounded<WideEvents.WideEvent>();
  const events = yield* WideEvents.make.pipe(
    Effect.provideService(WideEvents.Sink, {
      write: (event) => Queue.offer(recorded, event).pipe(Effect.asVoid)
    })
  );
  const connected = yield* ConnectedVersions.make.pipe(
    Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
      connect: () => Effect.void,
      acquire: (_companyId, patchId) =>
        Effect.gen(function* () {
          yield* Queue.offer(steps, { kind: "admission", versionId: patchId });
          if (admissions.gate !== undefined) yield* Deferred.await(admissions.gate);
          admissions.admitted++;
          return { binding: { taskId: "task_connected", bindingEpoch: 1 }, release: Effect.void };
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              admissions.interrupted++;
            })
          )
        ),
      touch: Effect.fnUntraced(function* ({ versionId }) {
        const now = yield* Clock.currentTimeMillis;
        touchedAt.set(versionId, [...(touchedAt.get(versionId) ?? []), now]);
        if (lost.has(sent++)) {
          yield* Effect.sleep(lostMs);
          yield* Queue.offer(steps, { kind: "touch", versionId, outcome: "failed" });
          return { outcome: "failed" as const };
        }
        const override = outcomes.get(versionId);
        if (override !== undefined) {
          yield* Queue.offer(steps, { kind: "touch", versionId, outcome: override });
          return { outcome: override };
        }
        const outcome = resident.has(versionId) ? ("touched" as const) : ("absent" as const);
        if (outcome === "touched")
          landedAt.set(versionId, [...(landedAt.get(versionId) ?? []), now]);
        yield* Queue.offer(steps, { kind: "touch", versionId, outcome });
        return { outcome, idleMs: windows.supervisor };
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
    Effect.provideService(StreamLimits.StreamLimits, {
      getMany: (input) =>
        local
          .getMany(input)
          .pipe(
            Effect.map(
              (limits) =>
                Object.fromEntries(
                  Object.entries(limits).map(([name, limit]) => [
                    name,
                    limit.limitId === "execution.process.idle"
                      ? { ...limit, value: windows.configured }
                      : limit
                  ])
                ) as typeof limits
            )
          )
    }),
    Effect.provideService(WideEvents.WideEvents, events)
  );
  /** An active document's hold on this host, until `Scope.close`; `idle` says why it let go. */
  const open = Effect.fnUntraced(function* (
    versionId: string,
    warm: boolean,
    idle?: () => boolean
  ) {
    const scope = yield* Scope.make();
    yield* connected
      .connect(version(versionId), { warm, ...(idle === undefined ? {} : { idle }) })
      .pipe(Scope.provide(scope));
    return scope;
  });
  return {
    open,
    resident,
    outcomes,
    touchedAt,
    landedAt,
    lost,
    windows,
    admissions,
    next: Queue.take(steps),
    event: Queue.take(recorded),
    pendingEvents: Queue.size(recorded)
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
    assert.deepStrictEqual(yield* host.next, { kind: "admission", versionId: "pat_connected" });
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

it.effect("says whether its last document went idle or left", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    host.resident.add("ver_a");
    let wentIdle = false;
    const leaving = yield* host.open("ver_a", false);
    const idling = yield* host.open("ver_a", false, () => wentIdle);
    assert.deepStrictEqual(yield* host.next, {
      kind: "touch",
      versionId: "ver_a",
      outcome: "touched"
    });
    yield* Scope.close(leaving, Exit.void);
    wentIdle = true;
    yield* Scope.close(idling, Exit.void);
    assert.deepInclude(yield* host.event, {
      type: "keepalive",
      peakDocuments: 2,
      endReason: "idle"
    });
    yield* Scope.close(yield* host.open("ver_a", false, () => false), Exit.void);
    assert.deepInclude(yield* host.event, { type: "keepalive", endReason: "left" });
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
      assert.isAtLeast(times.length, Math.floor(span / (idle * 0.4)), versionId);
      assert.isAtMost(times.length, Math.ceil(span / (idle * 0.3)) + 1, versionId);
      // The stepped clock can register a sleep up to one step late.
      for (let index = 1; index < times.length; index++)
        assert.isAtMost(times[index]! - times[index - 1]!, idle * 0.4 + 1_000, versionId);
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

/** The widest spacing the jitter allows. */
const widestSpacing = { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => 1 - 1e-9 };

it.effect("lands a touch before the reap even when the one before it is lost", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    host.resident.add("ver_a");
    // Every second touch is lost and fails only at the provider's timeout.
    for (let touch = 1; touch < 40; touch += 2) host.lost.add(touch);
    // The widest spacing the jitter allows, the worst case for a lost touch.
    const document = yield* host
      .open("ver_a", false)
      .pipe(Effect.provideService(Random.Random, widestSpacing));
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 1_000) yield* TestClock.adjust(1_000);
    const landed = host.landedAt.get("ver_a")!;
    assert.isAtLeast(landed.length, 10);
    // The supervisor reaps a process idle for `idle`; each landing restarts that clock.
    for (let index = 1; index < landed.length; index++)
      assert.isBelow(landed[index]! - landed[index - 1]!, idle, `landing ${index}`);
    yield* Scope.close(document, Exit.void);
  }).pipe(Effect.scoped)
);

it.effect("starts one keepalive for concurrent first holders of a version", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    host.resident.add("ver_a");
    // A small operation budget makes every fiber yield every few steps, so the four connects
    // interleave wherever a step of theirs lets them.
    const documents = yield* Effect.all(
      Array.from({ length: 4 }, () => host.open("ver_a", true)),
      { concurrency: "unbounded" }
    ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 4));
    // One keepalive holds all four, and reports them once the last has left.
    for (const document of documents) yield* Scope.close(document, Exit.void);
    assert.deepInclude(yield* host.event, { type: "keepalive", peakDocuments: 4 });
  }).pipe(Effect.scoped)
);

/** The gaps between landings since `since`, in milliseconds. */
const gapsSince = (landed: readonly number[], since: number) => {
  const recent = landed.filter((at) => at >= since);
  return recent.slice(1).map((at, index) => at - recent[index]!);
};

it.effect("spaces touches by the window the supervisor reaps by, not a limit it hasn't taken", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    host.resident.add("ver_a");
    const document = yield* host
      .open("ver_a", false)
      .pipe(Effect.provideService(Random.Random, widestSpacing));
    const wait = Effect.fnUntraced(function* (span: number) {
      for (let elapsed = 0; elapsed < span; elapsed += 1_000) yield* TestClock.adjust(1_000);
      return yield* Clock.currentTimeMillis;
    });
    const landed = () => host.landedAt.get("ver_a")!;
    // A raised override the supervisor hasn't taken: it still reaps by the old window.
    host.windows.configured = 5 * idle;
    const raised = yield* wait(idle);
    yield* wait(10 * idle);
    for (const gap of gapsSince(landed(), raised)) assert.isBelow(gap, idle);
    // Once a bind brings the supervisor the new window, its answers let touches spread out.
    host.windows.supervisor = 5 * idle;
    const taken = yield* wait(idle);
    yield* wait(10 * idle);
    const spread = gapsSince(landed(), taken);
    assert.isAbove(Math.max(...spread), idle);
    for (const gap of spread) assert.isBelow(gap, 5 * idle);
    // A cut applies from the next turn, before a call's bind can bring it to the supervisor.
    host.windows.configured = idle / 3;
    const cut = yield* wait(5 * idle);
    yield* wait(5 * idle);
    for (const gap of gapsSince(landed(), cut)) assert.isBelow(gap, idle / 3);
    yield* Scope.close(document, Exit.void);
  }).pipe(Effect.scoped)
);

it.effect("cancels a warmup waiting for admission when its last document leaves", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    host.admissions.gate = yield* Deferred.make<void>();
    const document = yield* host.open("ver_a", true);
    assert.deepStrictEqual(yield* host.next, {
      kind: "touch",
      versionId: "ver_a",
      outcome: "absent"
    });
    assert.deepStrictEqual(yield* host.next, { kind: "admission", versionId: "pat_connected" });
    yield* Scope.close(document, Exit.void);
    // The keepalive ends at once, its warmup's admission cancelled rather than left to claim.
    assert.deepInclude(yield* host.event, { type: "keepalive", warmups: {} });
    assert.strictEqual(host.admissions.interrupted, 1);
    yield* Deferred.succeed(host.admissions.gate, undefined);
    yield* TestClock.adjust(idle);
    assert.strictEqual(host.admissions.admitted, 0);
    assert.isFalse(host.resident.has("ver_a"));
    assert.strictEqual(yield* host.pendingEvents, 0);
  }).pipe(Effect.scoped)
);
