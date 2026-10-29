import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { registry } from "@patchy/limits/registry";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectedVersions from "./ConnectedVersions.js";
import * as ExecutionLifecycle from "./ExecutionLifecycle.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Prewarm from "./Prewarm.js";
import * as StreamLimits from "./StreamLimits.js";

const window = registry["execution.prewarm.window"].default;
const companyId = "cmp_prewarm";

type Step =
  | { readonly kind: "hold" | "letGo"; readonly companyId: string }
  | { readonly kind: "connect" | "release"; readonly versionId: string };

/**
 * One host's prewarms over a fleet that finds the company's task as `found` says, versions that
 * serve the tiers in `tiers` (tier 2 unless named), and residency of `processes`. Holds, version
 * connects and their ends arrive in `next`; `followed` is what the prewarm's task reports.
 */
const harness = Effect.gen(function* () {
  const steps = yield* Queue.unbounded<Step>();
  const recorded = yield* Queue.unbounded<WideEvents.WideEvent>();
  const state: {
    found: ExecutionLifecycle.Prewarm["found"];
    tiers: Map<string, number>;
    processes: number;
    followed: boolean;
  } = {
    found: "spare",
    tiers: new Map(),
    processes: registry["execution.residency.processes"].default,
    followed: false
  };
  const local = yield* StreamLimits.StreamLimits.pipe(Effect.provide(StreamLimits.layerLocal));
  const events = yield* WideEvents.make.pipe(
    Effect.provideService(WideEvents.Sink, {
      write: (event) => Queue.offer(recorded, event).pipe(Effect.asVoid)
    })
  );
  const service = yield* Prewarm.make.pipe(
    Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
      connect: () => Effect.die("A prewarm is not a document."),
      acquire: () => Effect.die("A prewarm admits through its versions' keepalives."),
      touch: () => Effect.die("A prewarm touches through its versions' keepalives."),
      prewarm: (company) =>
        Effect.acquireRelease(Queue.offer(steps, { kind: "hold", companyId: company }), () =>
          Queue.offer(steps, { kind: "letGo", companyId: company })
        ).pipe(Effect.as({ found: state.found, followed: Effect.sync(() => state.followed) }))
    }),
    Effect.provideService(ConnectedVersions.ConnectedVersions, {
      connect: (version, options) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            assert.deepStrictEqual(options, { warm: true, holder: "prewarm" });
          }).pipe(
            Effect.andThen(Queue.offer(steps, { kind: "connect", versionId: version.versionId }))
          ),
          () => Queue.offer(steps, { kind: "release", versionId: version.versionId })
        ).pipe(Effect.asVoid)
    }),
    Effect.provideService(LoadedVersions.LoadedVersions, {
      find: (patchId, versionId) =>
        Effect.succeed(
          Option.some({
            companyId,
            patchId,
            versionId: versionId!,
            patchTier: state.tiers.get(versionId!) ?? 2,
            manifest: {
              manifestVersion: 1,
              release: CURRENT_RELEASE,
              tier: 2,
              tables: {},
              files: {},
              uses: {},
              handlers: {}
            },
            scope: "company" as const,
            wireVersion: WIRE_VERSION
          })
        )
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
                    limit.limitId === "execution.residency.processes"
                      ? { ...limit, value: state.processes }
                      : limit
                  ])
                ) as typeof limits
            )
          )
    }),
    Effect.provideService(WideEvents.WideEvents, events)
  );
  const candidates = (...versionIds: ReadonlyArray<string>) =>
    versionIds.map((versionId) => ({ patchId: `pat_${versionId}`, versionId }));
  return {
    state,
    prewarm: (...versionIds: ReadonlyArray<string>) =>
      service.prewarm({
        companyId,
        viewerId: "usr_prewarm",
        candidates: candidates(...versionIds)
      }),
    next: Queue.take(steps),
    pending: Queue.size(steps),
    event: Queue.take(recorded)
  };
});

it.effect("holds the company and its likeliest three versions for the window, then lets go", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    yield* host.prewarm("ver_a", "ver_b", "ver_c", "ver_d");
    assert.deepStrictEqual(yield* host.next, { kind: "hold", companyId });
    for (const versionId of ["ver_a", "ver_b", "ver_c"])
      assert.deepStrictEqual(yield* host.next, { kind: "connect", versionId });
    yield* TestClock.adjust(window - 1);
    assert.strictEqual(yield* host.pending, 0);
    host.state.followed = true;
    yield* TestClock.adjust(1);
    const ended = [yield* host.next, yield* host.next, yield* host.next, yield* host.next];
    assert.sameDeepMembers(ended, [
      { kind: "release", versionId: "ver_a" },
      { kind: "release", versionId: "ver_b" },
      { kind: "release", versionId: "ver_c" },
      { kind: "letGo", companyId }
    ]);
    assert.deepInclude(yield* host.event, {
      type: "prewarm",
      companyId,
      viewerId: "usr_prewarm",
      outcome: "success",
      prewarm: "warmed",
      companyBind: "spare",
      versions: 3,
      followed: true,
      durationMs: window
    });
  }).pipe(Effect.scoped)
);

it.effect("skips a company it prewarmed moments ago, until the cooldown passes", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    yield* host.prewarm("ver_a");
    assert.deepStrictEqual(yield* host.next, { kind: "hold", companyId });
    assert.deepStrictEqual(yield* host.next, { kind: "connect", versionId: "ver_a" });
    yield* TestClock.adjust(Prewarm.cooldownMs - 1);
    yield* host.prewarm("ver_b");
    assert.deepInclude(yield* host.event, { type: "prewarm", prewarm: "cooldown" });
    assert.strictEqual(yield* host.pending, 0);
    yield* TestClock.adjust(1);
    yield* host.prewarm("ver_b");
    assert.deepStrictEqual(yield* host.next, { kind: "hold", companyId });
    assert.deepStrictEqual(yield* host.next, { kind: "connect", versionId: "ver_b" });
  }).pipe(Effect.scoped)
);

it.effect("loads no more versions than the company's residency allows", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    host.state.processes = 1;
    yield* host.prewarm("ver_a", "ver_b");
    assert.deepStrictEqual(yield* host.next, { kind: "hold", companyId });
    assert.deepStrictEqual(yield* host.next, { kind: "connect", versionId: "ver_a" });
    yield* TestClock.adjust(window);
    assert.deepStrictEqual(yield* host.next, { kind: "release", versionId: "ver_a" });
    assert.deepStrictEqual(yield* host.next, { kind: "letGo", companyId });
    assert.deepInclude(yield* host.event, { prewarm: "warmed", versions: 1 });
  }).pipe(Effect.scoped)
);

it.effect("loads nothing when taking a spare would leave none, and lets go at once", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    host.state.found = "full";
    yield* host.prewarm("ver_a");
    assert.deepStrictEqual(yield* host.next, { kind: "hold", companyId });
    assert.deepStrictEqual(yield* host.next, { kind: "letGo", companyId });
    const event = yield* host.event;
    assert.deepInclude(event, { type: "prewarm", prewarm: "full", outcome: "refused" });
    assert.notProperty(event, "versions");
  }).pipe(Effect.scoped)
);

it.effect("holds nothing for versions that no longer serve tier 2", () =>
  Effect.gen(function* () {
    const host = yield* harness;
    host.state.tiers.set("ver_a", 1);
    yield* host.prewarm("ver_a");
    assert.deepInclude(yield* host.event, { type: "prewarm", prewarm: "none" });
    assert.strictEqual(yield* host.pending, 0);
  }).pipe(Effect.scoped)
);
