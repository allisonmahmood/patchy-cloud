import { canonicalArgs, type GuestProtocol } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { registry } from "@patchy/limits/registry";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
 * Each touch lands between these fractions of the company's `execution.process.idle`, so one
 * lost touch still leaves another before the supervisor reaps, and versions spread out.
 */
const touchSpacing = { from: 0.35, to: 0.45 } as const;

/**
 * One version's keepalive on this host: its connected documents, and a loop that touches the
 * version's process until the last of them leaves.
 */
interface Keepalive {
  readonly version: LoadedVersion;
  documents: number;
  peakDocuments: number;
  /** A document's first stream asked for a warmup the loop has not tried yet. */
  warm: boolean;
  /** Rings the loop to touch, and warm if asked, before its next turn. */
  wake: Deferred.Deferred<void>;
  readonly closed: Deferred.Deferred<void>;
  readonly touches: Partial<Record<ExecutionLifecycle.TouchOutcome, number>>;
  readonly warmups: Partial<Record<WarmupOutcome, number>>;
}

/**
 * The tier 2 versions with a connected document on this host, kept loaded on their company task
 * while connected. Present only beside the execution fleet.
 */
export class ConnectedVersions extends Context.Service<
  ConnectedVersions,
  {
    /**
     * Holds the version warm for the caller's scope, which a document's ready stream owns. Its
     * first holder on this host starts touching the version's process before each idle window
     * ends; the last one to leave, by disconnect or hidden suspension, stops it. A touch never
     * loads, so an evicted version waits for demand. With `warm`, a document's first stream
     * also loads the version now, unless a touch finds it loaded. Never fails or waits.
     */
    readonly connect: (
      version: LoadedVersion,
      options: { readonly warm: boolean }
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
  // and is bounded and may evict like a call's: it loads only what that first call would.
  const load = (version: LoadedVersion) =>
    Effect.acquireUseRelease(
      lifecycle.acquire(version.companyId, version.patchId),
      (admission) =>
        bundles
          .load(version)
          .pipe(Effect.flatMap((bundle) => executor.bind(bundle, admission.binding))),
      (admission) => admission.release
    ).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    );

  const warmup = Effect.fnUntraced(function* (
    version: LoadedVersion,
    touched: ExecutionLifecycle.TouchOutcome
  ) {
    switch (touched) {
      case "touched":
        return "resident" as const;
      case "loading":
      case "paused":
      case "unbound":
        return touched;
      case "unsupported":
        return (yield* load(version)) ? ("bound" as const) : ("failed" as const);
      case "absent":
      case "failed":
        return (yield* load(version)) ? ("loaded" as const) : ("failed" as const);
    }
  });

  const run = (keepalive: Keepalive) =>
    Effect.gen(function* () {
      const { version } = keepalive;
      // A version's bundle never changes, so its hash is read once it is needed.
      let binding: GuestProtocol.BundleBinding | undefined;
      while (true) {
        keepalive.wake = yield* Deferred.make<void>();
        const warm = keepalive.warm;
        keepalive.warm = false;
        binding ??= yield* bundles.load(version).pipe(
          Effect.map((bundle): GuestProtocol.BundleBinding => ({
            companyId: bundle.companyId,
            patchId: bundle.patchId,
            versionId: bundle.versionId,
            sha256: bundle.sha256
          })),
          Effect.catch(() => Effect.undefined)
        );
        const touched = binding === undefined ? "failed" : yield* lifecycle.touch(binding);
        keepalive.touches[touched] = (keepalive.touches[touched] ?? 0) + 1;
        if (warm) {
          const outcome = yield* warmup(version, touched);
          keepalive.warmups[outcome] = (keepalive.warmups[outcome] ?? 0) + 1;
        }
        const idle = yield* limits
          .getMany({ companyId: version.companyId, limits: { idle: "execution.process.idle" } })
          .pipe(
            Effect.map((limits) => limits.idle.value),
            Effect.catch(() => Effect.succeed(registry["execution.process.idle"].default))
          );
        const spacing =
          touchSpacing.from + (touchSpacing.to - touchSpacing.from) * (yield* Random.next);
        yield* Effect.sleep(idle * spacing).pipe(Effect.raceFirst(Deferred.await(keepalive.wake)));
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
                warmups: keepalive.warmups
              })
            )
          )
        )
      )
      .pipe(Effect.forkIn(scope));

  return ConnectedVersions.of({
    connect: (version, options) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const key = canonicalArgs([version.companyId, version.patchId, version.versionId]);
          let keepalive = keepalives.get(key);
          if (keepalive === undefined) {
            keepalive = {
              version,
              documents: 0,
              peakDocuments: 0,
              warm: options.warm,
              wake: yield* Deferred.make<void>(),
              closed: yield* Deferred.make<void>(),
              touches: {},
              warmups: {}
            };
            keepalives.set(key, keepalive);
            yield* start(keepalive);
          } else if (options.warm) {
            keepalive.warm = true;
            yield* Deferred.succeed(keepalive.wake, undefined);
          }
          keepalive.documents++;
          keepalive.peakDocuments = Math.max(keepalive.peakDocuments, keepalive.documents);
          return { key, keepalive };
        }),
        ({ key, keepalive }) =>
          Effect.suspend(() => {
            if (--keepalive.documents > 0) return Effect.void;
            keepalives.delete(key);
            return Deferred.succeed(keepalive.closed, undefined);
          })
      ).pipe(Effect.asVoid)
  });
});

export const layer = Layer.effect(ConnectedVersions, make);
