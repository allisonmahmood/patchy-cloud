/** Release bounds and operating defaults. Keep this module browser-safe. */
export type LimitScope = "viewer" | "patch" | "company" | "host";
export type LimitRefusalCode =
  | "rate_limited"
  | "too_many_requests"
  | "too_large"
  | "timeout"
  | "handler_timeout"
  | "handler_failed"
  | "unknown_outcome"
  | "limit_exceeded"
  | "write_conflict"
  | "busy"
  | "patch_paused"
  | "not_found";

export interface LimitDefinition {
  readonly kind: "contract" | "operating";
  readonly default: number;
  readonly unit: string;
  readonly scope: LimitScope;
  readonly measure: string;
  readonly refusal: LimitRefusalCode | null;
  readonly overridable: boolean;
  /** Legacy enforcers read their own configuration; the override controller must refuse these IDs. */
  readonly configuration?: "legacy";
}

export const registry = {
  "runtime.calls.perMinute": {
    kind: "contract",
    default: 300,
    unit: "calls/minute",
    scope: "viewer",
    measure: "Calls per viewer per patch, excluding callbacks and subscription re-runs",
    refusal: "rate_limited",
    overridable: false
  },
  "frame.outstanding": {
    kind: "contract",
    default: 32,
    unit: "requests",
    scope: "viewer",
    measure: "Outstanding requests per document, including calls held while starting",
    refusal: "too_many_requests",
    overridable: false
  },
  "frame.heldBytes": {
    kind: "contract",
    default: 67108864,
    unit: "bytes",
    scope: "viewer",
    measure: "Total bytes held by one frame",
    refusal: "too_large",
    overridable: false
  },
  "runtime.call.bytes": {
    kind: "contract",
    default: 65536,
    unit: "bytes",
    scope: "viewer",
    measure: "Tier 1 operation envelope",
    refusal: "too_large",
    overridable: false
  },
  "runtime.row.bytes": {
    kind: "contract",
    default: 1048576,
    unit: "bytes",
    scope: "viewer",
    measure: "Encoded row per insert or update",
    refusal: "too_large",
    overridable: false
  },
  "runtime.batch.bytes": {
    kind: "contract",
    default: 8388608,
    unit: "bytes",
    scope: "viewer",
    measure: "Encoded insertMany batch",
    refusal: "too_large",
    overridable: false
  },
  "runtime.postgres.bytes": {
    kind: "contract",
    default: 262144,
    unit: "bytes",
    scope: "viewer",
    measure: "Postgres operation arguments",
    refusal: "too_large",
    overridable: false
  },
  "runtime.result.bytes": {
    kind: "contract",
    default: 8388608,
    unit: "bytes",
    scope: "viewer",
    measure: "Tier 1 operation result",
    refusal: "too_large",
    overridable: false
  },
  "runtime.file.bytes": {
    kind: "contract",
    default: 20971520,
    unit: "bytes",
    scope: "viewer",
    measure: "File bytes per operation",
    refusal: "too_large",
    overridable: false
  },
  "runtime.mutation.deadline": {
    kind: "contract",
    default: 30000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Tier 1 mutation deadline",
    refusal: "timeout",
    overridable: false
  },
  "integration.deadline": {
    kind: "contract",
    default: 15000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Each integration call within its parent deadline",
    refusal: "timeout",
    overridable: false
  },
  "tier2.query.deadline": {
    kind: "contract",
    default: 3000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Query caller deadline; read transaction cancellation starts at this deadline",
    refusal: "handler_timeout",
    overridable: false
  },
  "tier2.mutation.deadline": {
    kind: "contract",
    default: 5000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Mutation deadline including queue wait and all attempts; cancellation starts here",
    refusal: "handler_timeout",
    overridable: false
  },
  "tier2.action.deadline": {
    kind: "contract",
    default: 60000,
    unit: "milliseconds",
    scope: "viewer",
    measure:
      "Action caller deadline; children use the lesser of their deadline and the remaining parent budget",
    refusal: "handler_timeout",
    overridable: false
  },
  "tier2.query.kill": {
    kind: "contract",
    default: 4000,
    unit: "milliseconds",
    scope: "patch",
    measure: "Terminate query guest if still running, one second after caller deadline",
    refusal: null,
    overridable: false
  },
  "tier2.mutation.kill": {
    kind: "contract",
    default: 6000,
    unit: "milliseconds",
    scope: "patch",
    measure: "Terminate mutation guest if still running, one second after caller deadline",
    refusal: null,
    overridable: false
  },
  "tier2.action.kill": {
    kind: "contract",
    default: 61000,
    unit: "milliseconds",
    scope: "patch",
    measure: "Terminate action guest if still running, one second after caller deadline",
    refusal: null,
    overridable: false
  },
  "tier2.settlement.cleanup": {
    kind: "contract",
    default: 5000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Settlement cleanup after deadline; unresolved connections are destroyed",
    refusal: "unknown_outcome",
    overridable: false
  },
  "execution.stall": {
    kind: "contract",
    default: 6000,
    unit: "milliseconds",
    scope: "patch",
    measure: "Process event-loop stall before termination",
    refusal: null,
    overridable: false
  },
  "execution.probe.interval": {
    kind: "operating",
    default: 250,
    unit: "milliseconds",
    scope: "company",
    measure: "Supervisor health and resource sampling interval",
    refusal: null,
    overridable: true
  },
  "tier2.args.bytes": {
    kind: "contract",
    default: 1048576,
    unit: "bytes",
    scope: "viewer",
    measure: "Encoded server.call arguments",
    refusal: "too_large",
    overridable: false
  },
  "tier2.query.resultBytes": {
    kind: "contract",
    default: 8388608,
    unit: "bytes",
    scope: "viewer",
    measure: "Encoded query result",
    refusal: "handler_failed",
    overridable: false
  },
  "tier2.action.resultBytes": {
    kind: "contract",
    default: 8388608,
    unit: "bytes",
    scope: "viewer",
    measure: "Encoded action result",
    refusal: "handler_failed",
    overridable: false
  },
  "tier2.mutation.resultBytes": {
    kind: "contract",
    default: 65536,
    unit: "bytes",
    scope: "viewer",
    measure: "Encoded mutation result, also the stored replay result cap",
    refusal: "handler_failed",
    overridable: false
  },
  "tier2.callbacks.count": {
    kind: "contract",
    default: 1000,
    unit: "callbacks",
    scope: "viewer",
    measure: "Callbacks per invocation; nested invocations count separately",
    refusal: "limit_exceeded",
    overridable: false
  },
  "tier2.callbacks.outstanding": {
    kind: "contract",
    default: 8,
    unit: "callbacks",
    scope: "viewer",
    measure: "Outstanding callbacks per invocation; excess work queues",
    refusal: null,
    overridable: false
  },
  "tier2.callbacks.bytes": {
    kind: "contract",
    default: 67108864,
    unit: "bytes",
    scope: "viewer",
    measure: "Callback bytes per call tree across attempts and children",
    refusal: "limit_exceeded",
    overridable: false
  },
  "tier2.callbacks.fileBytes": {
    kind: "contract",
    default: 20971520,
    unit: "bytes",
    scope: "viewer",
    measure: "File bytes per callback body",
    refusal: "too_large",
    overridable: false
  },
  "tier2.log.bytes": {
    kind: "contract",
    default: 32768,
    unit: "bytes",
    scope: "viewer",
    measure: "ctx.log bytes per invocation",
    refusal: "limit_exceeded",
    overridable: false
  },
  "tier2.mutation.keyLifetime": {
    kind: "contract",
    default: 86400000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Mutation key retention and validity window",
    refusal: null,
    overridable: false
  },
  "tier2.mutation.keyFutureSkew": {
    kind: "contract",
    default: 300000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Maximum mutation key timestamp ahead of server clock",
    refusal: null,
    overridable: false
  },
  "tier2.mutation.attempts": {
    kind: "contract",
    default: 3,
    unit: "attempts",
    scope: "viewer",
    measure: "Maximum full handler attempts after serialization failures",
    refusal: "write_conflict",
    overridable: false
  },
  "tier2.capability.tombstone": {
    kind: "operating",
    default: 300000,
    unit: "milliseconds",
    scope: "host",
    measure: "Expired capability replay tombstone lifetime",
    refusal: null,
    overridable: false
  },
  "company.connections": {
    kind: "operating",
    default: 4,
    unit: "connections",
    scope: "company",
    measure: "Company connections per host replica",
    refusal: "busy",
    overridable: true
  },
  "company.connections.hostBackends": {
    kind: "operating",
    configuration: "legacy",
    default: 200,
    unit: "connections",
    scope: "host",
    measure: "Company database backend budget per host replica; PATCHY_COMPANY_DB_MAX_BACKENDS",
    refusal: "busy",
    overridable: false
  },
  "company.connections.pools": {
    kind: "operating",
    configuration: "legacy",
    default: 100,
    unit: "pools",
    scope: "host",
    measure: "Retained company pools per host replica",
    refusal: "busy",
    overridable: false
  },
  "company.connections.waiters": {
    kind: "operating",
    default: 32,
    unit: "waiters",
    scope: "company",
    measure: "Queued company connection acquisitions per host replica",
    refusal: "busy",
    overridable: true
  },
  "company.connections.wait": {
    kind: "operating",
    default: 1000,
    unit: "milliseconds",
    scope: "company",
    measure: "Maximum connection queue wait within caller deadline",
    refusal: "busy",
    overridable: true
  },
  "subscriptions.reruns.company": {
    kind: "operating",
    default: 2,
    unit: "connections",
    scope: "company",
    measure: "Company connections occupied by subscription re-runs per host replica",
    refusal: "busy",
    overridable: true
  },
  "subscriptions.reruns.patch": {
    kind: "operating",
    default: 1,
    unit: "runs",
    scope: "patch",
    measure: "Simultaneous subscription re-runs per patch per host replica",
    refusal: null,
    overridable: true
  },
  "tier2.actions.company": {
    kind: "operating",
    default: 8,
    unit: "actions",
    scope: "company",
    measure: "Actions in flight per company per host replica",
    refusal: "busy",
    overridable: true
  },
  "tier2.actions.viewer": {
    kind: "operating",
    default: 2,
    unit: "actions",
    scope: "viewer",
    measure: "Actions in flight per viewer per patch per host replica",
    refusal: "busy",
    overridable: true
  },
  "company.admission.rate": {
    kind: "operating",
    default: 100,
    unit: "calls/second",
    scope: "company",
    measure:
      "Company tier 1 operations and tier 2 calls per host replica; excludes public me, callbacks and re-runs",
    refusal: "limit_exceeded",
    overridable: true
  },
  "company.admission.burst": {
    kind: "operating",
    default: 200,
    unit: "calls",
    scope: "company",
    measure: "Company admission burst per host replica",
    refusal: "limit_exceeded",
    overridable: true
  },
  "execution.management.bodyBytes": {
    kind: "operating",
    default: 16777216,
    unit: "bytes",
    scope: "host",
    measure: "Serialized private management request, including pushed bundle source",
    refusal: "too_large",
    overridable: false
  },
  "execution.process.rss": {
    kind: "operating",
    default: 536870912,
    unit: "bytes",
    scope: "patch",
    measure: "Process RSS at termination; memory configured in MiB",
    refusal: null,
    overridable: true
  },
  "execution.breaker.kills": {
    kind: "operating",
    default: 3,
    unit: "kills",
    scope: "patch",
    measure: "Kills across all versions of one patch within the breaker window",
    refusal: "patch_paused",
    overridable: true
  },
  "execution.breaker.window": {
    kind: "operating",
    default: 600000,
    unit: "milliseconds",
    scope: "patch",
    measure: "Window counting process kills; breaker is off in dev",
    refusal: null,
    overridable: true
  },
  "execution.breaker.pause": {
    kind: "operating",
    default: 600000,
    unit: "milliseconds",
    scope: "patch",
    measure: "Pause after repeated kills; a publish clears it",
    refusal: "patch_paused",
    overridable: true
  },
  "execution.task.cpu": {
    kind: "operating",
    default: 0.5,
    unit: "vCPU",
    scope: "company",
    measure: "Fargate CPU allocation",
    refusal: null,
    overridable: true
  },
  "execution.task.memory": {
    kind: "operating",
    default: 2147483648,
    unit: "bytes",
    scope: "company",
    measure: "Fargate memory allocation, 2048 MiB",
    refusal: null,
    overridable: true
  },
  "execution.residency.processes": {
    kind: "operating",
    default: 12,
    unit: "processes",
    scope: "company",
    measure: "Loaded version processes; idle processes evicted first",
    refusal: "busy",
    overridable: true
  },
  "execution.residency.bytes": {
    kind: "operating",
    default: 1610612736,
    unit: "bytes",
    scope: "company",
    measure: "Aggregate RSS including supervisor, bundles and overlapping versions",
    refusal: "busy",
    overridable: true
  },
  "execution.process.idle": {
    kind: "operating",
    default: 60000,
    unit: "milliseconds",
    scope: "company",
    measure: "Process idle window before reap",
    refusal: null,
    overridable: true
  },
  "execution.pool.spares": {
    kind: "operating",
    default: 2,
    unit: "tasks",
    scope: "host",
    measure:
      "Global spare floor; target is max(floor, wake rate times measured cold start) within fleet budget",
    refusal: null,
    overridable: false
  },
  "execution.pool.wakeWindow": {
    kind: "operating",
    default: 900000,
    unit: "milliseconds",
    scope: "host",
    measure: "Observation window for company wake rate",
    refusal: null,
    overridable: false
  },
  "execution.pool.wait": {
    kind: "operating",
    default: 40000,
    unit: "milliseconds",
    scope: "company",
    measure: "Empty-pool wait before start_failed; held calls are never replayed",
    refusal: "busy",
    overridable: true
  },
  "execution.company.idle": {
    kind: "operating",
    default: 1800000,
    unit: "milliseconds",
    scope: "company",
    measure: "Release after no connected tier 2 documents and no in-flight work",
    refusal: null,
    overridable: true
  },
  "execution.deploy.drain": {
    kind: "operating",
    default: 90000,
    unit: "milliseconds",
    scope: "host",
    measure: "Deployment deregistration delay",
    refusal: null,
    overridable: false
  },
  "files.handle.length": {
    kind: "contract",
    default: 57,
    unit: "characters",
    scope: "viewer",
    measure: "Fixed authorised handle size; included in page and result bounds",
    refusal: null,
    overridable: false
  },
  "files.stage.bytes": {
    kind: "contract",
    default: 20971520,
    unit: "bytes",
    scope: "viewer",
    measure: "Bytes per staged upload",
    refusal: "too_large",
    overridable: false
  },
  "files.stage.count": {
    kind: "contract",
    default: 16,
    unit: "stages",
    scope: "viewer",
    measure: "Outstanding stages per viewer per patch",
    refusal: "limit_exceeded",
    overridable: false
  },
  "files.stage.viewerBytes": {
    kind: "contract",
    default: 104857600,
    unit: "bytes",
    scope: "viewer",
    measure: "Outstanding staged bytes per viewer per patch",
    refusal: "limit_exceeded",
    overridable: false
  },
  "files.stage.companyBytes": {
    kind: "operating",
    default: 1073741824,
    unit: "bytes",
    scope: "company",
    measure: "Outstanding staged bytes per company",
    refusal: "limit_exceeded",
    overridable: true
  },
  "files.stage.lifetime": {
    kind: "contract",
    default: 3600000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Unadopted stage lifetime before sweep",
    refusal: "not_found",
    overridable: false
  },
  "download.bytes": {
    kind: "contract",
    default: 20971520,
    unit: "bytes",
    scope: "viewer",
    measure: "Generated-file download encoded bytes held by shell",
    refusal: "too_large",
    overridable: false
  },
  "csv.characters": {
    kind: "contract",
    default: 10000000,
    unit: "characters",
    scope: "viewer",
    measure: "Decoded CSV input characters, enforced while parsing",
    refusal: "limit_exceeded",
    overridable: false
  },
  "csv.cells": {
    kind: "contract",
    default: 1000000,
    unit: "cells",
    scope: "viewer",
    measure: "CSV input cells, enforced while parsing",
    refusal: "limit_exceeded",
    overridable: false
  },
  "members.page": {
    kind: "contract",
    default: 50,
    unit: "members",
    scope: "viewer",
    measure: "Candidate list and prefix search page size",
    refusal: null,
    overridable: false
  },
  "members.getMany": {
    kind: "contract",
    default: 1000,
    unit: "ids",
    scope: "viewer",
    measure: "Member ids per getMany call",
    refusal: "limit_exceeded",
    overridable: false
  },
  "subscriptions.document": {
    kind: "contract",
    default: 64,
    unit: "subscriptions",
    scope: "viewer",
    measure: "Subscriptions per document",
    refusal: "limit_exceeded",
    overridable: false
  },
  "subscriptions.patch": {
    kind: "operating",
    default: 256,
    unit: "subscriptions",
    scope: "patch",
    measure: "Subscriptions per patch",
    refusal: "limit_exceeded",
    overridable: true
  },
  "subscriptions.company": {
    kind: "operating",
    default: 1024,
    unit: "subscriptions",
    scope: "company",
    measure: "Subscriptions per company",
    refusal: "limit_exceeded",
    overridable: true
  },
  "stream.documents": {
    kind: "contract",
    default: 8,
    unit: "documents",
    scope: "viewer",
    measure: "Connected documents per viewer per patch",
    refusal: "limit_exceeded",
    overridable: false
  },
  "subscriptions.snapshot.bytes": {
    kind: "contract",
    default: 8388608,
    unit: "bytes",
    scope: "viewer",
    measure: "Snapshot result; frame held-byte cap still applies",
    refusal: "too_large",
    overridable: false
  },
  "stream.buffer.bytes": {
    kind: "operating",
    default: 16777216,
    unit: "bytes",
    scope: "viewer",
    measure: "Stream output buffer; slow consumers close and resume by revision",
    refusal: null,
    overridable: true
  },
  "subscriptions.deltas.buffer": {
    kind: "contract",
    default: 64,
    unit: "deltas",
    scope: "viewer",
    measure: "Out-of-order stream deltas before resync_required",
    refusal: null,
    overridable: false
  },
  "subscriptions.deltas.gap": {
    kind: "contract",
    default: 5000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Open sequence gap before resync_required",
    refusal: null,
    overridable: false
  },
  "subscriptions.reconcile.interval": {
    kind: "operating",
    default: 30000,
    unit: "milliseconds",
    scope: "host",
    measure: "Reconcile durable revisions and document authority",
    refusal: null,
    overridable: false
  },
  "stream.hidden.suspend": {
    kind: "contract",
    default: 30000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Hidden document delay before suspension",
    refusal: null,
    overridable: false
  },
  "stream.remount.grace": {
    kind: "contract",
    default: 1000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Document remount grace",
    refusal: null,
    overridable: false
  },
  "rate.protectedApi.perMinute": {
    kind: "operating",
    configuration: "legacy",
    default: 60,
    unit: "attempts/minute",
    scope: "host",
    measure: "Protected API attempts per source address",
    refusal: "rate_limited",
    overridable: false
  },
  "rate.deviceLogin.perMinute": {
    kind: "operating",
    configuration: "legacy",
    default: 5,
    unit: "attempts/minute",
    scope: "host",
    measure: "Device login starts per source address",
    refusal: "rate_limited",
    overridable: false
  },
  "rate.patchCreate.perMinute": {
    kind: "operating",
    configuration: "legacy",
    default: 10,
    unit: "attempts/minute",
    scope: "viewer",
    measure: "Patch creates per machine token; deployment-wide configuration",
    refusal: "rate_limited",
    overridable: false
  },
  "rate.publish.perMinute": {
    kind: "operating",
    configuration: "legacy",
    default: 20,
    unit: "attempts/minute",
    scope: "viewer",
    measure:
      "New publish attempts per machine token after replay lookup; deployment-wide configuration",
    refusal: "rate_limited",
    overridable: false
  },
  "rate.deviceLookup.perMinute": {
    kind: "operating",
    configuration: "legacy",
    default: 10,
    unit: "attempts/minute",
    scope: "viewer",
    measure: "Device login lookups per user; deployment-wide configuration",
    refusal: "rate_limited",
    overridable: false
  },
  "rate.devicePoll.attempts": {
    kind: "operating",
    configuration: "legacy",
    default: 1,
    unit: "attempts/window",
    scope: "viewer",
    measure: "Device login polls per device code",
    refusal: "rate_limited",
    overridable: false
  },
  "rate.devicePoll.window": {
    kind: "operating",
    configuration: "legacy",
    default: 5000,
    unit: "milliseconds",
    scope: "viewer",
    measure: "Device login poll fixed window",
    refusal: null,
    overridable: false
  },
  "rate.trackedKeys": {
    kind: "operating",
    configuration: "legacy",
    default: 10000,
    unit: "keys",
    scope: "host",
    measure: "In-memory limiter key capacity; new keys fail closed when full",
    refusal: "rate_limited",
    overridable: false
  }
} as const satisfies Readonly<Record<string, LimitDefinition>>;

export type LimitId = keyof typeof registry;
export type OperatingLimitId = {
  [Id in LimitId]: (typeof registry)[Id]["kind"] extends "operating" ? Id : never;
}[LimitId];
export type ContractLimitId = Exclude<LimitId, OperatingLimitId>;
