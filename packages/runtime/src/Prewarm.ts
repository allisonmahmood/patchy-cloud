import * as WideEvents from "@patchy/analytics/wide-events";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ConnectedVersions from "./ConnectedVersions.js";
import * as ExecutionLifecycle from "./ExecutionLifecycle.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as StreamLimits from "./StreamLimits.js";

/** The most versions one prewarm loads, and never more than the company's residency allows. */
export const versionCap = 3;
/** How long a prewarm on this host skips the company's next ones. */
export const cooldownMs = 30_000;

/** A tier 2 version someone may open: a patch's current version as the portal listed it. */
export interface Candidate {
  readonly patchId: string;
  readonly versionId: string;
}

/**
 * Readies a company's task and the tier 2 versions a member is likeliest to open, ahead of the
 * open, from their portal view. Present only beside the execution fleet.
 */
export class Prewarm extends Context.Service<
  Prewarm,
  {
    /**
     * Holds the company's task, claiming a spare only while capacity allows, and loads the
     * first of `candidates`, likeliest first, for `execution.prewarm.window`; a task nobody
     * used meanwhile is then released, and one someone used follows its clocks as before. A
     * company prewarmed on this host within the cooldown is skipped. It starts the work and
     * returns: it never fails or waits.
     */
    readonly prewarm: (request: {
      readonly companyId: string;
      readonly viewerId: string;
      readonly candidates: ReadonlyArray<Candidate>;
    }) => Effect.Effect<void>;
  }
>()("@patchy/runtime/Prewarm") {}

export const make = Effect.gen(function* () {
  const lifecycle = yield* ExecutionLifecycle.ExecutionLifecycle;
  const connectedVersions = yield* ConnectedVersions.ConnectedVersions;
  const versions = yield* LoadedVersions.LoadedVersions;
  const limits = yield* StreamLimits.StreamLimits;
  const events = yield* WideEvents.WideEvents;
  const clock = yield* Clock.Clock;
  const scope = yield* Effect.scope;
  // When each company's last prewarm on this host began, oldest first.
  const started = new Map<string, number>();

  const run = (request: Parameters<Prewarm["Service"]["prewarm"]>[0], cooling: boolean) =>
    Effect.gen(function* () {
      if (cooling) return yield* WideEvents.enrich({ prewarm: "cooldown" });
      const { window, processes } = yield* limits.getMany({
        companyId: request.companyId,
        limits: { window: "execution.prewarm.window", processes: "execution.residency.processes" }
      });
      const loaded = yield* Effect.forEach(
        request.candidates.slice(0, Math.min(versionCap, processes.value)),
        (candidate) => versions.find(candidate.patchId, candidate.versionId)
      );
      const serving = loaded.flatMap((version) =>
        Option.isSome(version) &&
        version.value.patchTier === 2 &&
        version.value.companyId === request.companyId
          ? [version.value]
          : []
      );
      if (serving.length === 0) return yield* WideEvents.enrich({ prewarm: "none" });
      const held = yield* lifecycle.prewarm(request.companyId);
      if (held.found === "full")
        return yield* WideEvents.enrich({ prewarm: "full", outcome: "refused" });
      yield* WideEvents.enrich({
        prewarm: "warmed",
        companyBind: held.found,
        versions: serving.length
      });
      yield* Effect.forEach(
        serving,
        (version) => connectedVersions.connect(version, { warm: true, holder: "prewarm" }),
        { discard: true }
      );
      yield* Effect.sleep(window.value);
      yield* WideEvents.enrich({ followed: yield* held.followed });
    }).pipe(Effect.scoped);

  return Prewarm.of({
    prewarm: (request) =>
      Effect.suspend(() => {
        const now = clock.currentTimeMillisUnsafe();
        for (const [companyId, at] of started) {
          if (now - at < cooldownMs) break;
          started.delete(companyId);
        }
        const cooling = started.has(request.companyId);
        if (!cooling) started.set(request.companyId, now);
        return events
          .withEvent(
            { type: "prewarm", companyId: request.companyId, viewerId: request.viewerId },
            run(request, cooling)
          )
          .pipe(
            Effect.catch(() => Effect.void),
            Effect.forkIn(scope),
            Effect.asVoid
          );
      })
  });
});

export const layer = Layer.effect(Prewarm, make);
