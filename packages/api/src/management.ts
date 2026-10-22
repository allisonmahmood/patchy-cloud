import * as Schema from "effect/Schema";
import * as GuestProtocol from "./guest.js";
import { limitRefusalFields } from "./limits.js";

/** Private host-to-supervisor wire. Never mount these operations on the public HttpApi. */
export const BindingEpoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ProcessGeneration = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const identity = Schema.NonEmptyString;
const nonnegative = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positive = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));
export const SupervisorLimits = Schema.Struct({
  "execution.probe.interval": Schema.optionalKey(positive),
  "execution.process.rss": Schema.optionalKey(positive),
  "execution.residency.processes": Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  "execution.residency.bytes": Schema.optionalKey(positive),
  "execution.process.idle": Schema.optionalKey(positive)
});
export const LimitRevision = Schema.Struct({
  deploymentRevision: identity,
  overrideRevision: Schema.String.check(Schema.isPattern(/^\d+$/))
});
export const CallbackUrls = Schema.Array(
  Schema.String.check(
    Schema.isPattern(
      /^http:\/\/(?:10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+):\d+\/callback$/
    )
  )
).check(Schema.isMaxLength(64));

/**
 * The task the host resolved, on every request. A supervisor that is not that task refuses
 * `wrong_task` before any effect, so a reused private address cannot reach another task.
 * Optional for rollout: older hosts omit it, and older supervisors refuse it as an unknown key,
 * so hosts send it only to supervisors of their own release.
 */
const expectedTask = { taskId: Schema.optionalKey(identity) };

export const BindRequest = Schema.Struct({
  ...expectedTask,
  companyId: identity,
  bindingEpoch: BindingEpoch,
  bundle: Schema.optionalKey(GuestProtocol.Bundle),
  /**
   * A bind by hash: the version without its bytes, never beside `bundle`. A supervisor that
   * doesn't hold it refuses `bundle_required` before any effect, and the host sends the bundle.
   * Older supervisors refuse it as an unknown key, also before any effect, and get the bundle
   * too; fleet hosts send it only to their own release, so that costs nothing in a rollout.
   */
  binding: Schema.optionalKey(GuestProtocol.BundleBinding),
  operatingLimits: Schema.optionalKey(SupervisorLimits),
  configRevision: Schema.optionalKey(LimitRevision),
  /** Authenticated hosts register their private callback address during rolling replacement. */
  callbackUrls: Schema.optionalKey(CallbackUrls)
}).check(
  Schema.makeFilter(
    (request) =>
      request.bundle === undefined ||
      request.binding === undefined ||
      "A bind names its version by bundle or by binding, not both."
  )
);
export type BindRequest = typeof BindRequest.Type;
export const BindReply = Schema.Struct({
  bindingEpoch: BindingEpoch,
  binding: Schema.optionalKey(GuestProtocol.BundleBinding),
  processGeneration: Schema.optionalKey(ProcessGeneration)
});
export type BindReply = typeof BindReply.Type;
export const InvokeRequest = Schema.Struct({
  ...expectedTask,
  bindingEpoch: BindingEpoch,
  request: GuestProtocol.Invoke
});
export type InvokeRequest = typeof InvokeRequest.Type;
export const StopRequest = Schema.Struct({
  ...expectedTask,
  bindingEpoch: BindingEpoch,
  processGeneration: Schema.optionalKey(ProcessGeneration)
});
export type StopRequest = typeof StopRequest.Type;
/**
 * Restarts the idle clock of a ready process for exactly this version and hash, at the current
 * epoch. It never loads, reserves or changes anything else. Older supervisors have no route for
 * it, so fleet hosts send it only to supervisors of their own release.
 */
export const TouchRequest = Schema.Struct({
  ...expectedTask,
  bindingEpoch: BindingEpoch,
  binding: GuestProtocol.BundleBinding
});
export type TouchRequest = typeof TouchRequest.Type;
export const TouchReply = Schema.Struct({
  /**
   * `touched`: a ready process's idle clock restarted. `loading`: left to its initialization
   * deadline. `absent`: no live process for the version, and none was started.
   */
  outcome: Schema.Literals(["touched", "loading", "absent"]),
  /**
   * The `execution.process.idle` window, in milliseconds, this supervisor reaps by: the value its
   * last bind set, which a changed limit reaches only with the next bind.
   */
  idleMs: positive
});
export type TouchReply = typeof TouchReply.Type;
export const StatsRequest = Schema.Struct({
  ...expectedTask,
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
  callsServed: Schema.optionalKey(Schema.Number),
  // Optional so hosts and supervisors of neighbouring releases keep decoding each other's reports.
  startMs: Schema.optionalKey(Schema.Number),
  firstOnTask: Schema.optionalKey(Schema.Boolean)
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
    "production_refused",
    "wrong_task"
  ]),
  limits: ProcessEvent.fields.limits,
  ...limitRefusalFields
});
export type Refusal = typeof Refusal.Type;
