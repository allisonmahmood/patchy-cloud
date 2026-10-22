/**
 * Company admission: the one token bucket per company and host replica that every company
 * tier 1 operation and tier 2 call spends once, pages' and agents' alike, before anything runs
 * (`company.admission.rate` and `company.admission.burst`). Callbacks and subscription re-runs
 * never spend it, and nor does public `me`. Production Runtime admits pages through it, and
 * Patchy MCP's door admits agents' calls through the same instance.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Limits, OperatingLimits, TokenBucket } from "@patchy/limits";
import * as Runtime from "./Runtime.js";

export class CompanyAdmission extends Context.Service<
  CompanyAdmission,
  {
    /**
     * Spends one of the company's tokens, recording the burst's peak on the request's event, or
     * refuses `limit_exceeded` with the wait, or `rate_limited` when the host tracks too many
     * companies to count another.
     */
    readonly admit: (
      companyId: string
    ) => Effect.Effect<
      void,
      Runtime.LimitExceeded | Runtime.RateLimited | Runtime.SourceUnavailable
    >;
  }
>()("@patchy/runtime/CompanyAdmission") {}

export const make = Effect.gen(function* () {
  const operatingLimits = yield* OperatingLimits.OperatingLimits;
  const companyTokens = yield* TokenBucket.make;

  const admit = Effect.fn("CompanyAdmission.admit")(function* (companyId: string) {
    const { rate, burst } = yield* operatingLimits
      .getMany({
        companyId,
        limits: { rate: "company.admission.rate", burst: "company.admission.burst" }
      })
      .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
    const attempt = yield* companyTokens.consume({
      key: `company.admission:${companyId}`,
      rate: rate.value,
      burst: burst.value
    });
    if (!attempt.allowed && attempt.reason === "capacity")
      return yield* new Runtime.RateLimited({
        retryAfterSeconds: attempt.retryAfterSeconds,
        limitId: "rate.trackedKeys",
        value: Limits.MAX_TRACKED_KEYS
      });
    yield* WideEvents.enrich({
      limits: [
        {
          limitId: burst.limitId,
          value: burst.value,
          // Whole-token capacity depleted at admission; refused calls spend no token.
          peak: burst.value - attempt.remaining,
          configRevision: burst.configRevision
        }
      ]
    });
    if (!attempt.allowed)
      return yield* new Runtime.LimitExceeded({
        retryAfterSeconds: attempt.retryAfterSeconds,
        limitId: "company.admission.rate",
        value: rate.value
      });
  });

  return CompanyAdmission.of({ admit });
});

export const layer = Layer.effect(CompanyAdmission, make);
