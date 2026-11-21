/**
 * One host replica's tier 2 action slots. Every action takes an ordinary slot at admission,
 * counted per company (`tier2.actions.company`) and per viewer (`tier2.actions.viewer`). An action
 * that calls a model moves to the model pool once, on its first model call: taking its place
 * there, counted per company (`tier2.models.company`), per person (`tier2.models.viewer`) and
 * across the replica (`tier2.models.replica`), frees its ordinary slot, and it holds that place
 * until it ends. Nothing moves back, so actions waiting on a model never hold the slots quick
 * actions need. The counts live in this replica's memory; two replicas count separately.
 */
import { canonicalArgs } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import type { OperatingLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class InvocationBusy extends Schema.TaggedError<InvocationBusy>()("InvocationBusy", {
  limitId: Schema.Literals(["tier2.actions.company", "tier2.actions.viewer"]),
  value: Schema.Number,
  scope: Schema.Literals(["company", "viewer"])
}) {
  readonly code = "busy" as const;
  readonly status = 429;
  readonly retryAfterSeconds = 1;
  override get message() {
    return "The action concurrency limit is reached. Try again shortly.";
  }
}

/** The model pool refused a transfer: the action keeps its ordinary slot, and nothing was sent. */
export class ModelPoolBusy extends Schema.TaggedError<ModelPoolBusy>()("ModelPoolBusy", {
  limitId: Schema.Literals(["tier2.models.company", "tier2.models.viewer", "tier2.models.replica"]),
  value: Schema.Number
}) {
  readonly code = "busy" as const;
  readonly status = 429;
  readonly retryAfterSeconds = 1;
  get scope() {
    return registry[this.limitId].scope;
  }
  override get message() {
    return "Too many actions are waiting on a model, so nothing was sent. Try again shortly.";
  }
}

/** The action already ended and released its slot, so nothing moved to the model pool. */
export class SlotReleased extends Schema.TaggedError<SlotReleased>()("SlotReleased", {}) {
  override get message() {
    return "The action has ended; its slot was released.";
  }
}

/** Who an action's slots count against. */
export interface Holder {
  readonly companyId: string;
  readonly patchId: string;
  readonly userId: string;
  /** A person's worker agent has ordinary slots of its own beside their pages', across its clients. */
  readonly caller: "page" | "agent";
}

/** A company's effective limits for one pair of scopes, as `OperatingLimits.getMany` answers them. */
export interface Limits {
  readonly company: OperatingLimits.EffectiveLimit;
  readonly viewer: OperatingLimits.EffectiveLimit;
}

/** One admitted action's hold on this replica's slots. */
export interface Slot {
  /**
   * Moves the action from its ordinary slot to the model pool, under the company's
   * `tier2.models.company` and `tier2.models.viewer` limits and the replica's own. Only the
   * first success moves it; later calls succeed and change nothing. A refusal changes nothing
   * either: the action keeps its ordinary slot, and a later model call may try again.
   */
  readonly transfer: (limits: Limits) => Effect.Effect<void, ModelPoolBusy | SlotReleased>;
  /** Frees whichever slot the action holds, once; it runs when the action ends, however it ends. */
  readonly release: Effect.Effect<void>;
}

const bump = (counts: Map<string, number>, key: string, by: 1 | -1) => {
  const next = (counts.get(key) ?? 0) + by;
  if (next === 0) counts.delete(key);
  else counts.set(key, next);
};

/** One replica's slots. `Invocation` makes one; `replica` is `tier2.models.replica`. */
export const make = (options: { readonly replica: number }) => {
  const actionCompanies = new Map<string, number>();
  const actionViewers = new Map<string, number>();
  const modelCompanies = new Map<string, number>();
  const modelPeople = new Map<string, number>();
  let modelReplica = 0;

  /**
   * Takes an ordinary slot, or refuses `busy` naming the first full limit, company before viewer.
   * The check and the take happen in one step; the action's event then records each limit
   * checked with its peak.
   */
  const admit = (holder: Holder, limits: Limits): Effect.Effect<Slot, InvocationBusy> =>
    Effect.suspend(() => {
      const viewer = canonicalArgs([
        holder.companyId,
        holder.patchId,
        holder.userId,
        holder.caller
      ]);
      const used = {
        company: actionCompanies.get(holder.companyId) ?? 0,
        viewer: actionViewers.get(viewer) ?? 0
      };
      const full =
        used.company >= limits.company.value
          ? ("company" as const)
          : used.viewer >= limits.viewer.value
            ? ("viewer" as const)
            : undefined;
      const checked: ReadonlyArray<"company" | "viewer"> =
        full === "company" ? ["company"] : ["company", "viewer"];
      const peaks = WideEvents.enrich({
        limits: checked.map((scope) => ({
          limitId: `tier2.actions.${scope}`,
          value: limits[scope].value,
          peak: Math.min(used[scope] + 1, limits[scope].value),
          configRevision: limits[scope].configRevision
        }))
      });
      if (full !== undefined)
        return Effect.andThen(
          peaks,
          Effect.fail(
            new InvocationBusy({
              limitId: `tier2.actions.${full}`,
              value: limits[full].value,
              scope: full
            })
          )
        );
      bump(actionCompanies, holder.companyId, 1);
      bump(actionViewers, viewer, 1);
      const person = canonicalArgs([holder.companyId, holder.userId]);
      let held: "action" | "model" | "released" = "action";
      const slot: Slot = {
        transfer: (modelLimits) =>
          Effect.suspend((): Effect.Effect<void, ModelPoolBusy | SlotReleased> => {
            if (held === "model") return Effect.void;
            if (held === "released") return Effect.fail(new SlotReleased());
            const refused = (
              [
                [
                  "tier2.models.company",
                  modelCompanies.get(holder.companyId) ?? 0,
                  modelLimits.company.value
                ],
                ["tier2.models.viewer", modelPeople.get(person) ?? 0, modelLimits.viewer.value],
                ["tier2.models.replica", modelReplica, options.replica]
              ] as const
            ).find(([, inPool, limit]) => inPool >= limit);
            if (refused !== undefined)
              return Effect.fail(new ModelPoolBusy({ limitId: refused[0], value: refused[2] }));
            bump(modelCompanies, holder.companyId, 1);
            bump(modelPeople, person, 1);
            modelReplica++;
            bump(actionCompanies, holder.companyId, -1);
            bump(actionViewers, viewer, -1);
            held = "model";
            return Effect.void;
          }),
        release: Effect.sync(() => {
          if (held === "action") {
            bump(actionCompanies, holder.companyId, -1);
            bump(actionViewers, viewer, -1);
          } else if (held === "model") {
            bump(modelCompanies, holder.companyId, -1);
            bump(modelPeople, person, -1);
            modelReplica--;
          }
          held = "released";
        })
      };
      return Effect.as(peaks, slot);
    });

  return { admit };
};
