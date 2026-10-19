import { canonicalArgs, type GuestProtocol } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import type * as Scope from "effect/Scope";
import * as Executor from "./Executor.js";
import * as ExecutionLifecycle from "./ExecutionLifecycle.js";
import type { LoadedVersion } from "./LoadedVersions.js";
import * as ServerBundles from "./ServerBundles.js";
import * as StreamLimits from "./StreamLimits.js";

/**
 * What a warmup came to: the process was `resident` or `loading` already, a bind `loaded` it,
 * a supervisor without touches took a normal bind (`bound`), or `paused`, `unbound` and
 * `failed`, which leave the version to load on demand.
 */
export type WarmupOutcome =
  "resident" | "loading" | "loaded" | "bound" | "paused" | "unbound" | "failed";

/**
 * Fractions of the idle window the supervisor reaps by. Each touch starts 30 to 40 % of it after
 * the previous one started, whatever that one cost, and gives up after 10 %. A touch that is
 * lost still leaves the next to land within 90 % of the window after the last that landed, so
 * the supervisor never reaps between them; the jitter spreads versions out.
 */
const touchSpacing = { from: 0.3, to: 0.4 } as const;
const touchTimeout = 0.1;

/** What a warmup comes to without a bind, or `undefined` when the touch left it to bind. */
const settled = (touched: ExecutionLifecycle.TouchOutcome): WarmupOutcome | undefined => {
  switch (touched) {
    case "touched":
      return "resident";
    case "loading":
    case "paused":
    case "unbound":
      return touched;
    case "absent":
    case "unsupported":
    case "failed":
      return undefined;
  }
};

/**
 * One version's keepalive on this host: its active connected documents, and a loop that touches
 * the version's process until the last of them goes idle or leaves.
 */
interface Keepalive {
  readonly version: LoadedVersion;
  documents: number;
  peakDocuments: number;
  /** Why the last document let go: it went idle, or it left. */
  endReason: "idle" | "left" | undefined;
  /** A document's first stream asked for a warmup the loop has not tried yet. */
  warm: boolean;
  /** Rings the loop to touch, and warm if asked, before its next turn. */
  wake: Deferred.Deferred<void>;
  readonly closed: Deferred.Deferred<void>;
  readonly touches: Partial<Record<ExecutionLifecycle.TouchOutcome, number>>;
  readonly warmups: Partial<Record<WarmupOutcome, number>>;
}

/**
 * The tier 2 versions with an active connected document on this host, kept loaded on their
 * company task while one is. Present only beside the execution fleet.
 */
export class ConnectedVersions extends Context.Service<
  ConnectedVersions,
  {
    /**
     * Holds the version warm for the caller's scope, which an active document's warm-hold owner
     * owns. Its first holder on this host starts touching the version's process before each idle
     * window ends; the last one to let go, by going idle, disconnecting or suspending while
     * hidden, stops it. A touch never loads, so an evicted version waits for demand. With
     * `warm`, a document's first stream also loads the version now, unless a touch finds it
     * loaded. `idle`, asked as the hold ends, says whether its document went idle rather than
     * left. Never fails or waits.
     */
    readonly connect: (
      version: LoadedVersion,
      options: { readonly warm: boolean; readonly idle?: () => boolean }
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@patchy/runtime/ConnectedVersions") {}

export const make = Effect.gen(function* () {
  const lifecycle = yield* ExecutionLifecycle.ExecutionLifecycle;
  const executor = yield* Executor.Executor;
  const bundles = yield* ServerBundles.ServerBundles;
  const limits = yield* StreamLimits.StreamLimits;
  const events = yield* WideEvents.WideEvents;
  const scope = yield* Effect.scope;
  const keepalives = new Map<string, Keepalive>();

  // A bind under a call's admission, so it follows the current binding and the patch's pause,
  // and is bounded and may evict like a call's: it loads only what that first call would. As a
  // call's, admission stays interruptible, so a keepalive that ends while it waits claims and
  // binds nothing; once admitted, its release always runs.
  const load = (version: LoadedVersion) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const admission = yield* restore(lifecycle.acquire(version.companyId, version.patchId));
        yield* restore(
          bundles
            .load(version)
            .pipe(Effect.flatMap((bundle) => executor.bind(bundle, admission.binding)))
        ).pipe(Effect.ensuring(admission.release));
      })
    ).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    );

  const run = (keepalive: Keepalive) =>
    Effect.gen(function* () {
      const { version } = keepalive;
      // A version's bundle never changes, so its hash is read once it is needed.
      let binding: GuestProtocol.BundleBinding | undefined;
      // The company's configured window, read within a touch's timeout of the window in force.
      const readIdle = (previous: number, window: number) =>
        limits
          .getMany({ companyId: version.companyId, limits: { idle: "execution.process.idle" } })
          .pipe(
            Effect.map((limits) => limits.idle.value),
            Effect.timeoutOption(window * touchTimeout),
            Effect.map(Option.getOrElse(() => previous)),
            Effect.catch(() => Effect.succeed(previous))
          );
      const fallback = registry["execution.process.idle"].default;
      let configured = yield* readIdle(fallback, fallback);
      // The window the supervisor last answered that it reaps by. A changed limit reaches it only
      // with its next bind, so touches keep to the smaller of the two: a raise waits until the
      // supervisor has it, and a cut applies from the next turn, whether or not it has.
      let acknowledged: number | undefined;
      let window = configured;
      let warming = false;
      const count = (outcome: WarmupOutcome) => {
        keepalive.warmups[outcome] = (keepalive.warmups[outcome] ?? 0) + 1;
      };
      while (true) {
        const started = yield* Clock.currentTimeMillis;
        // Replaced in the step that reads the warm request, so a later request rings the new one.
        keepalive.wake = Deferred.makeUnsafe<void>();
        const warm = keepalive.warm && !warming;
        if (warm) keepalive.warm = false;
        const touch = yield* Effect.gen(function* () {
          binding ??= yield* bundles.load(version).pipe(
            Effect.map((bundle): GuestProtocol.BundleBinding => ({
              companyId: bundle.companyId,
              patchId: bundle.patchId,
              versionId: bundle.versionId,
              sha256: bundle.sha256
            }))
          );
          return yield* lifecycle.touch(binding);
        }).pipe(
          Effect.timeoutOption(window * touchTimeout),
          Effect.map(Option.getOrElse((): ExecutionLifecycle.Touch => ({ outcome: "failed" }))),
          Effect.catch(() => Effect.succeed<ExecutionLifecycle.Touch>({ outcome: "failed" }))
        );
        if (touch.idleMs !== undefined) acknowledged = touch.idleMs;
        const touched = touch.outcome;
        keepalive.touches[touched] = (keepalive.touches[touched] ?? 0) + 1;
        const outcome = warm ? settled(touched) : undefined;
        if (outcome !== undefined) count(outcome);
        else if (warm) {
          // A load runs beside the touches, which keep their schedule; one warmup at a time.
          warming = true;
          yield* load(version).pipe(
            Effect.flatMap((bound) =>
              Effect.sync(() => {
                count(bound ? (touched === "unsupported" ? "bound" : "loaded") : "failed");
                warming = false;
                // A warm request held back while this one ran is served at once.
                if (keepalive.warm) Deferred.doneUnsafe(keepalive.wake, Effect.void);
              })
            ),
            Effect.forkChild
          );
        }
        configured = yield* readIdle(configured, window);
        window = Math.min(configured, acknowledged ?? configured);
        const spacing =
          touchSpacing.from + (touchSpacing.to - touchSpacing.from) * (yield* Random.next);
        const remaining = started + window * spacing - (yield* Clock.currentTimeMillis);
        yield* Effect.sleep(Math.max(0, remaining)).pipe(
          Effect.raceFirst(Deferred.await(keepalive.wake))
        );
      }
    });

  const start = (keepalive: Keepalive) =>
    events
      .withEvent(
        {
          type: "keepalive",
          companyId: keepalive.version.companyId,
          patchId: keepalive.version.patchId,
          versionId: keepalive.version.versionId,
          tier: 2
        },
        run(keepalive).pipe(
          Effect.raceFirst(Deferred.await(keepalive.closed)),
          Effect.ensuring(
            Effect.suspend(() =>
              WideEvents.enrich({
                peakDocuments: keepalive.peakDocuments,
                touches: keepalive.touches,
                warmups: keepalive.warmups,
                ...(keepalive.endReason === undefined ? {} : { endReason: keepalive.endReason })
              })
            )
          )
        )
      )
      .pipe(Effect.forkIn(scope));

  return ConnectedVersions.of({
    connect: (version, options) =>
      Effect.acquireRelease(
        // One synchronous step, so concurrent first holders find each other's keepalive.
        Effect.suspend(() => {
          const key = canonicalArgs([version.companyId, version.patchId, version.versionId]);
          const existing = keepalives.get(key);
          const keepalive: Keepalive = existing ?? {
            version,
            documents: 0,
            peakDocuments: 0,
            endReason: undefined,
            warm: options.warm,
            wake: Deferred.makeUnsafe<void>(),
            closed: Deferred.makeUnsafe<void>(),
            touches: {},
            warmups: {}
          };
          if (existing === undefined) keepalives.set(key, keepalive);
          else if (options.warm) {
            keepalive.warm = true;
            Deferred.doneUnsafe(keepalive.wake, Effect.void);
          }
          keepalive.documents++;
          keepalive.peakDocuments = Math.max(keepalive.peakDocuments, keepalive.documents);
          const held = { key, keepalive };
          return existing === undefined ? Effect.as(start(keepalive), held) : Effect.succeed(held);
        }),
        ({ key, keepalive }) =>
          Effect.suspend(() => {
            if (--keepalive.documents > 0) return Effect.void;
            keepalive.endReason = options.idle?.() === true ? "idle" : "left";
            if (keepalives.get(key) === keepalive) keepalives.delete(key);
            return Deferred.succeed(keepalive.closed, undefined);
          })
      ).pipe(Effect.asVoid)
  });
});

export const layer = Layer.effect(ConnectedVersions, make);
