import * as Schema from "effect/Schema";
import * as GuestProtocol from "./guest.js";
import { limitRefusalFields } from "./limits.js";

/** Private host-to-supervisor wire. Never mount these operations on the public HttpApi. */
export const BindingEpoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ProcessGeneration = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const identity = Schema.NonEmptyString;
const nonnegative = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const BindRequest = Schema.Struct({
  companyId: identity,
  bindingEpoch: BindingEpoch,
  bundle: Schema.optionalKey(GuestProtocol.Bundle)
});
export type BindRequest = typeof BindRequest.Type;
export const BindReply = Schema.Struct({
  bindingEpoch: BindingEpoch,
  binding: Schema.optionalKey(GuestProtocol.BundleBinding),
  processGeneration: Schema.optionalKey(ProcessGeneration)
});
export type BindReply = typeof BindReply.Type;
export const InvokeRequest = Schema.Struct({
  bindingEpoch: BindingEpoch,
  request: GuestProtocol.Invoke
});
export type InvokeRequest = typeof InvokeRequest.Type;
export const StopRequest = Schema.Struct({
  bindingEpoch: BindingEpoch,
  processGeneration: Schema.optionalKey(ProcessGeneration)
});
export type StopRequest = typeof StopRequest.Type;
export const StatsRequest = Schema.Struct({
  bindingEpoch: BindingEpoch,
  acknowledgeReports: Schema.optionalKey(Schema.Array(identity))
});
export type StatsRequest = typeof StatsRequest.Type;
export const ProcessStats = Schema.Struct({
  binding: GuestProtocol.BundleBinding,
  processGeneration: ProcessGeneration,
  pid: count,
  activeInvocations: count,
  rssBytes: nonnegative,
  peakRssBytes: nonnegative,
  cpuSeconds: nonnegative,
  callsServed: count
});
export type ProcessStats = typeof ProcessStats.Type;

/** Structural copy of Analytics' process event, without a dependency on host telemetry. */
export const ProcessEvent = Schema.Struct({
  type: Schema.Literal("process"),
  eventId: Schema.String,
  traceId: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  replica: Schema.String,
  deploymentRevision: Schema.String,
  startedAt: Schema.Number,
  durationMs: Schema.Number,
  outcome: Schema.Literals([
    "success",
    "refused",
    "failure",
    "interrupted",
    "handler_error",
    "unknown_outcome"
  ]),
  sampleProbability: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1)),
  code: Schema.optionalKey(Schema.String),
  limitId: Schema.optionalKey(Schema.String),
  limits: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        limitId: Schema.String,
        value: Schema.Number,
        peak: Schema.Number,
        configRevision: Schema.Struct({
          deploymentRevision: Schema.String,
          overrideRevision: Schema.String
        })
      })
    )
  ),
  companyId: Schema.optionalKey(Schema.String),
  patchId: Schema.optionalKey(Schema.String),
  versionId: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.Literals([0, 1, 2, 3])),
  taskId: Schema.optionalKey(Schema.String),
  processGeneration: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.String),
  cpuSeconds: Schema.optionalKey(Schema.Number),
  peakRssBytes: Schema.optionalKey(Schema.Number),
  callsServed: Schema.optionalKey(Schema.Number)
});
export type ProcessEvent = typeof ProcessEvent.Type;
export const ProcessReport = Schema.Struct({
  reportId: identity,
  binding: GuestProtocol.BundleBinding,
  bindingEpoch: BindingEpoch,
  processGeneration: ProcessGeneration,
  startedAt: nonnegative,
  endedAt: nonnegative,
  cause: Schema.Literals([
    "idle",
    "evicted",
    "deadline",
    "stall",
    "memory",
    "stopped",
    "exited",
    "load_failed",
    "metering_failed"
  ]),
  cpuSeconds: nonnegative,
  peakRssBytes: nonnegative,
  callsServed: count,
  invocations: Schema.Array(GuestProtocol.Attempt),
  event: ProcessEvent
});
export type ProcessReport = typeof ProcessReport.Type;
export const StatsReply = Schema.Struct({
  companyId: Schema.NullOr(identity),
  bindingEpoch: BindingEpoch,
  stopped: Schema.Boolean,
  aggregateRssBytes: nonnegative,
  processes: Schema.Array(ProcessStats),
  reports: Schema.Array(ProcessReport)
});
export type StatsReply = typeof StatsReply.Type;
export const Refusal = Schema.Struct({
  ok: Schema.Literal(false),
  code: Schema.Literals([
    "invalid_request",
    "unauthorized",
    "too_large",
    "busy",
    "stale_epoch",
    "stale_generation",
    "stopped",
    "process_killed",
    "bundle_required",
    "invalid_bundle",
    "binding_conflict",
    "load_failed",
    "transport",
    "protocol",
    "production_refused"
  ]),
  limits: ProcessEvent.fields.limits,
  ...limitRefusalFields
});
export type Refusal = typeof Refusal.Type;
