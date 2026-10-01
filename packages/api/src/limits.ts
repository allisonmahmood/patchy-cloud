import * as Schema from "effect/Schema";
import { registry, type LimitId } from "@patchy/limits/registry";

type RefusingLimitId = {
  [Id in LimitId]: (typeof registry)[Id]["refusal"] extends string ? Id : never;
}[LimitId];

/** Optional on older refusal bodies; values describe the enforced bound, not observed usage. */
export const limitRefusalFields = {
  scope: Schema.optionalKey(Schema.Literals(["viewer", "patch", "company", "host"])),
  limitId: Schema.optionalKey(Schema.NonEmptyString),
  value: Schema.optionalKey(Schema.Finite),
  retryAfter: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))
};

/** Retry delays are seconds. Timeouts and unknown outcomes must never advertise a safe retry. */
export function limitRefusal<Id extends RefusingLimitId>(
  limitId: Id,
  value: number = registry[limitId].default,
  retryAfter?: number
): {
  readonly code: (typeof registry)[Id]["refusal"];
  readonly scope: (typeof registry)[Id]["scope"];
  readonly limitId: Id;
  readonly value: number;
  readonly retryAfter?: number;
} {
  const { refusal: code, scope } = registry[limitId];
  const safe =
    code === "rate_limited" ||
    code === "too_many_requests" ||
    code === "busy" ||
    code === "write_conflict" ||
    code === "patch_paused";
  return {
    code,
    scope,
    limitId,
    value,
    ...(safe && retryAfter !== undefined ? { retryAfter } : {})
  };
}
