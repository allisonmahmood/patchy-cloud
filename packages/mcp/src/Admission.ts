/**
 * The door's admission of a `read_patch` or `change_patch` call that reached its target
 * (docs/product.md › Bounds › Rates and concurrency), in order: the person's calls a minute on
 * the patch (`mcp.calls.perMinute`), beside their page's own; their calls in flight across all
 * their agents (`mcp.inFlight`); then their company's admission, which its pages spend too.
 * Every counter is per host replica and keyed by the person, never an address or a connection,
 * so reconnecting gains an agent nothing. Each row takes the person's company's override.
 *
 * Admission comes before a change key is claimed and before anything runs, so a refusal writes
 * no log row and leaves the key free. It is a tool result naming its limit in the request's
 * event; the door answers it over HTTP 200.
 *
 * An admitted call holds its slot until its work settles, so the cap bounds work, not open
 * requests. The request holds it while it runs, and Runtime retains it when it dispatches the
 * work, letting go when that work settles. A client that goes away before dispatch, such as
 * during the wait for the company's server, gives the slot back at once; one that goes away
 * after leaves it held until Runtime's work ends.
 */
import * as Effect from "effect/Effect";
import * as WideEvents from "@patchy/analytics/wide-events";
import { type ToolCallResult, toolRefusal } from "@patchy/api";
import type { AgentConnections } from "@patchy/auth";
import { Limits, OperatingLimits } from "@patchy/limits";
import type { Patches } from "@patchy/patches";
import { CompanyAdmission } from "@patchy/runtime";

const seconds = (count: number) => `${count} second${count === 1 ? "" : "s"}`;

/**
 * Holds an admitted call's slot once more, answering how to let that hold go: what Runtime runs
 * as it dispatches the call's work (`Invocation.AgentCall`'s `retain`).
 */
export type Retain = Effect.Effect<Effect.Effect<void>>;

/**
 * Runs `work` for `identity`'s call of `patch` once it is admitted, holding the person's
 * in-flight slot while it runs and for as long as Runtime retains it; or answers the refusal
 * without running it.
 */
export type Admit = <E, R>(
  identity: AgentConnections.AgentIdentity,
  patch: Patches.ReadPatch,
  work: (retain: Retain) => Effect.Effect<ToolCallResult, E, R>
) => Effect.Effect<ToolCallResult, E, R>;

/** One host's admission, with its in-flight counts. The door makes one. */
export const make = Effect.gen(function* () {
  const limits = yield* Limits.Limits;
  const operating = yield* OperatingLimits.OperatingLimits;
  const company = yield* CompanyAdmission.CompanyAdmission;
  const inFlight = new Map<string, number>();

  /**
   * Takes one of `person`'s slots, held once: answers the request's own let-go and Runtime's way
   * to hold it again, or undefined when every slot is taken. The slot comes back when every hold
   * has let go; each let-go counts once, and a slot already back can't be held again.
   */
  const take = (person: string, slots: number) => {
    const used = inFlight.get(person) ?? 0;
    if (used >= slots) return undefined;
    inFlight.set(person, used + 1);
    let holds = 1;
    const hold = () => {
      let held = true;
      return Effect.sync(() => {
        if (!held) return;
        held = false;
        if (--holds > 0) return;
        const left = (inFlight.get(person) ?? 1) - 1;
        if (left === 0) inFlight.delete(person);
        else inFlight.set(person, left);
      });
    };
    const retain: Retain = Effect.sync(() => {
      if (holds === 0) return Effect.void;
      holds++;
      return hold();
    });
    return { used: used + 1, release: hold(), retain };
  };

  /** The company's admission, shared with its pages: undefined once spent, else the refusal. */
  const companyAdmission = (identity: AgentConnections.AgentIdentity) =>
    company.admit(identity.company.id).pipe(
      Effect.as(undefined),
      Effect.catchTags({
        LimitExceeded: (error) =>
          WideEvents.enrich({ limitId: error.limitId }).pipe(
            Effect.as(
              toolRefusal({
                code: "limit_exceeded",
                from: "patchy",
                message: `${identity.company.name} is making calls faster than Patchy admits them; try again in ${seconds(error.retryAfterSeconds ?? 1)}.`,
                retryAfterSeconds: error.retryAfterSeconds ?? 1
              })
            )
          ),
        RateLimited: (error) =>
          WideEvents.enrich({ limitId: error.limitId }).pipe(
            Effect.as(
              toolRefusal({
                code: "rate_limited",
                from: "patchy",
                message: `Patchy can't count another company's calls on this server right now; try again in ${seconds(error.retryAfterSeconds)}.`,
                retryAfterSeconds: error.retryAfterSeconds
              })
            )
          ),
        // As the door's own reads of its limits do.
        SourceUnavailable: Effect.die
      })
    );

  const admit: Admit = (identity, patch, work) =>
    Effect.gen(function* () {
      const person = identity.user.id;
      const { calls, slots } = yield* operating
        .getMany({
          companyId: identity.company.id,
          limits: { calls: "mcp.calls.perMinute", slots: "mcp.inFlight" }
        })
        .pipe(
          Effect.catchTags({
            InvalidLimit: Effect.die,
            CompanyNotFound: Effect.die,
            SqlError: Effect.die
          })
        );

      const minute = yield* limits.consume({
        key: `mcp-calls:${person}:${patch.patch.id}`,
        limit: calls.value,
        window: "1 minute"
      });
      yield* WideEvents.enrich({
        limits: [
          {
            limitId: calls.limitId,
            value: calls.value,
            peak: calls.value - minute.remaining,
            configRevision: calls.configRevision
          }
        ]
      });
      if (!minute.allowed) {
        const capacity = minute.reason === "capacity";
        yield* WideEvents.enrich({ limitId: capacity ? "rate.trackedKeys" : calls.limitId });
        return toolRefusal({
          code: "rate_limited",
          from: "patchy",
          message: capacity
            ? `Patchy can't count another person's calls on this server right now; try again in ${seconds(minute.retryAfterSeconds)}.`
            : `${identity.user.name}'s agents called ${patch.patch.name} more than ${calls.value} times in a minute; try again in ${seconds(minute.retryAfterSeconds)}. Bulk work wants a tool that takes a list; if ${patch.patch.name} has none, its owner, ${patch.owner.name}, can add one.`,
          retryAfterSeconds: minute.retryAfterSeconds
        });
      }

      // Taken and its release attached in one step, so no taken slot misses its release.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const slot = take(person, slots.value);
          yield* WideEvents.enrich({
            limits: [
              {
                limitId: slots.limitId,
                value: slots.value,
                peak: slot?.used ?? slots.value,
                configRevision: slots.configRevision
              }
            ]
          });
          if (slot === undefined) {
            yield* WideEvents.enrich({ limitId: slots.limitId });
            return toolRefusal({
              code: "busy",
              from: "patchy",
              message: `${identity.user.name} already has ${slots.value} calls in flight through their agents; try again in a second, once one has finished.`,
              retryAfterSeconds: 1
            });
          }
          return yield* restore(
            Effect.flatMap(companyAdmission(identity), (refused) =>
              refused === undefined ? work(slot.retain) : Effect.succeed(refused)
            )
          ).pipe(Effect.ensuring(slot.release));
        })
      );
    });
  return admit;
});
