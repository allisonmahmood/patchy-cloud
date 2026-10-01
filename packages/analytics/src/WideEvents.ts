import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

export const Outcome = Schema.Literals([
  "success",
  "refused",
  "failure",
  "interrupted",
  "handler_error",
  "unknown_outcome"
]);
export type Outcome = typeof Outcome.Type;

/** The configured bound and the highest observed use under that configuration. */
export const LimitPeak = Schema.Struct({
  limitId: Schema.String,
  value: Schema.Number,
  peak: Schema.Number,
  configRevision: Schema.Struct({
    deploymentRevision: Schema.String,
    overrideRevision: Schema.String
  })
});
export type LimitPeak = typeof LimitPeak.Type;

const attribution = {
  companyId: Schema.optionalKey(Schema.String),
  patchId: Schema.optionalKey(Schema.String),
  versionId: Schema.optionalKey(Schema.String),
  viewerId: Schema.optionalKey(Schema.String),
  handler: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.Literals(["query", "mutation", "action"])),
  tier: Schema.optionalKey(Schema.Literals([0, 1, 2, 3])),
  taskId: Schema.optionalKey(Schema.String),
  processGeneration: Schema.optionalKey(Schema.Number)
};
const outcomeFields = {
  outcome: Schema.optionalKey(Outcome),
  code: Schema.optionalKey(Schema.String),
  limitId: Schema.optionalKey(Schema.String),
  closestLimitId: Schema.optionalKey(Schema.String),
  limits: Schema.optionalKey(Schema.Array(LimitPeak))
};
const invocationMetrics = {
  queueWaitMs: Schema.optionalKey(Schema.Number),
  connectionWaitMs: Schema.optionalKey(Schema.Number),
  guestMs: Schema.optionalKey(Schema.Number),
  dbMs: Schema.optionalKey(Schema.Number),
  callbacks: Schema.optionalKey(Schema.Number),
  attempts: Schema.optionalKey(Schema.Number),
  argsBytes: Schema.optionalKey(Schema.Number),
  resultBytes: Schema.optionalKey(Schema.Number),
  requestBytes: Schema.optionalKey(Schema.Number),
  responseBytes: Schema.optionalKey(Schema.Number),
  commitOutcome: Schema.optionalKey(
    Schema.Literals(["committed", "rolled_back", "unknown_outcome"])
  )
};
const rerunFields = {
  streamId: Schema.optionalKey(Schema.String),
  causedByEventId: Schema.optionalKey(Schema.String)
};
const streamMetrics = {
  peakSubscriptions: Schema.optionalKey(Schema.Number),
  reruns: Schema.optionalKey(Schema.Number),
  bytes: Schema.optionalKey(Schema.Number),
  closeReason: Schema.optionalKey(Schema.String)
};
const processMetrics = {
  cause: Schema.optionalKey(Schema.String),
  cpuSeconds: Schema.optionalKey(Schema.Number),
  peakRssBytes: Schema.optionalKey(Schema.Number),
  callsServed: Schema.optionalKey(Schema.Number)
};
const bindingMetrics = {
  spareWaitMs: Schema.optionalKey(Schema.Number),
  peakProcesses: Schema.optionalKey(Schema.Number),
  releaseCause: Schema.optionalKey(Schema.String)
};

/** Enrichment is local to the current event. Each emitter retains only its own fields. */
export const EventFields = Schema.Struct({
  ...attribution,
  ...outcomeFields,
  ...invocationMetrics,
  ...rerunFields,
  ...streamMetrics,
  ...processMetrics,
  ...bindingMetrics
});
export type EventFields = typeof EventFields.Type;

const common = {
  ...outcomeFields,
  eventId: Schema.String,
  traceId: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  replica: Schema.String,
  deploymentRevision: Schema.String,
  startedAt: Schema.Number,
  durationMs: Schema.Number,
  outcome: Outcome,
  sampleProbability: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
};
const operations = { operations: Schema.optionalKey(Schema.Array(Schema.String)) };
export const RequestEvent = Schema.Struct({
  ...common,
  type: Schema.Literal("request"),
  ...attribution,
  ...invocationMetrics,
  ...operations
});
export type RequestEvent = typeof RequestEvent.Type;
export const RerunEvent = Schema.Struct({
  ...common,
  type: Schema.Literal("re-run"),
  ...attribution,
  ...invocationMetrics,
  ...rerunFields,
  ...operations
});
export type RerunEvent = typeof RerunEvent.Type;
export const StreamEvent = Schema.Struct({
  ...common,
  type: Schema.Literal("stream"),
  companyId: attribution.companyId,
  patchId: attribution.patchId,
  versionId: attribution.versionId,
  viewerId: attribution.viewerId,
  tier: attribution.tier,
  ...streamMetrics
});
export type StreamEvent = typeof StreamEvent.Type;
export const ProcessEvent = Schema.Struct({
  ...common,
  type: Schema.Literal("process"),
  companyId: attribution.companyId,
  patchId: attribution.patchId,
  versionId: attribution.versionId,
  tier: attribution.tier,
  taskId: attribution.taskId,
  processGeneration: attribution.processGeneration,
  ...processMetrics
});
export type ProcessEvent = typeof ProcessEvent.Type;
export const BindingEvent = Schema.Struct({
  ...common,
  type: Schema.Literal("binding"),
  companyId: attribution.companyId,
  taskId: attribution.taskId,
  ...bindingMetrics
});
export type BindingEvent = typeof BindingEvent.Type;
export const WideEvent = Schema.Union([
  RequestEvent,
  RerunEvent,
  StreamEvent,
  ProcessEvent,
  BindingEvent
]);
export type WideEvent = typeof WideEvent.Type;

type Seed<E extends WideEvent> = E extends WideEvent
  ? { readonly type: E["type"]; readonly endedAt?: number } & Partial<
      Omit<E, "type" | "durationMs" | "sampleProbability" | "operations">
    >
  : never;
export type EventSeed = Seed<WideEvent>;

/** An injectable delivery attempt. Caller finalizers never wait for it. */
export class Sink extends Context.Service<
  Sink,
  {
    readonly write: (event: WideEvent) => Effect.Effect<void>;
  }
>()("@patchy/analytics/WideEvents/Sink") {}

export class WideEvents extends Context.Service<
  WideEvents,
  {
    /** Finalizes once on exit, links nested hops, and leaves the caller's Scope open. */
    readonly withEvent: <A, E, R>(
      seed: EventSeed,
      work: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>;
    /** Deliver an already-finalized remote hop without rewriting its identity or timing. */
    readonly emit: (event: WideEvent) => Effect.Effect<void>;
  }
>()("@patchy/analytics/WideEvents") {}

const metadata = Context.Reference<{
  readonly replica: string;
  readonly deploymentRevision: string;
}>("@patchy/analytics/WideEvents/metadata", {
  defaultValue: () => ({ replica: "local", deploymentRevision: "development" })
});
interface Accumulator {
  readonly eventId: string;
  readonly traceId: string;
  readonly fields: Record<string, unknown>;
  readonly operations: Set<string>;
  readonly limits: Map<string, LimitPeak>;
  closed: boolean;
}
const current = Context.Reference<Accumulator | undefined>("@patchy/analytics/WideEvents/current", {
  defaultValue: () => undefined
});

const encodeLimitKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, LimitPeak.fields.configRevision]))
);

const addFields = (event: Accumulator, fields: EventFields) => {
  if (event.closed) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key !== "limits") event.fields[key] = value;
  }
  for (const measurement of fields.limits ?? []) {
    const key = encodeLimitKey([measurement.limitId, measurement.configRevision]);
    const previous = event.limits.get(key);
    event.limits.set(key, {
      ...measurement,
      peak: Math.max(previous?.peak ?? measurement.peak, measurement.peak)
    });
  }
};

/** Links a resource wake to its write without copying request arguments or results. */
export const currentEventId: Effect.Effect<string | undefined> = Effect.map(
  current,
  (event) => event?.eventId
);

export const enrich = (fields: EventFields): Effect.Effect<void> =>
  Effect.map(current, (event) => {
    if (event) addFields(event, fields);
  });

/** Carry only the event accumulator across the private callback transport. */
export const capture = Effect.map(
  current,
  (event) =>
    <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.provideService(work, current, event)
);

/** Add disjoint measurements; elapsed invocation time is never additive. */
export const add = (
  fields: Partial<
    Record<
      | "queueWaitMs"
      | "connectionWaitMs"
      | "dbMs"
      | "callbacks"
      | "attempts"
      | "argsBytes"
      | "resultBytes"
      | "requestBytes"
      | "responseBytes",
      number
    >
  >
): Effect.Effect<void> =>
  Effect.map(current, (event) => {
    if (!event || event.closed) return;
    for (const [key, value] of Object.entries(fields))
      event.fields[key] = Number(event.fields[key] ?? 0) + value;
  });

export const operation = (name: string): Effect.Effect<void> =>
  Effect.map(current, (event) => {
    if (event && !event.closed) event.operations.add(name);
  });

const eventId = Effect.gen(function* () {
  let id = "";
  for (let index = 0; index < 4; index++) {
    id += (yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16).padStart(8, "0");
  }
  return id;
});
const schemas = {
  request: RequestEvent,
  "re-run": RerunEvent,
  stream: StreamEvent,
  process: ProcessEvent,
  binding: BindingEvent
};
const bestEffort = (work: Effect.Effect<void>) =>
  work.pipe(
    Effect.interruptible,
    Effect.timeout("3 seconds"),
    Effect.catchCause(() => Effect.void)
  );

export const make = Effect.gen(function* () {
  const sink = yield* Sink;
  const identity = yield* metadata;
  const emit: WideEvents["Service"]["emit"] = (event) =>
    Effect.forkDetach(bestEffort(Effect.suspend(() => sink.write(event))), {
      startImmediately: false
    }).pipe(Effect.asVoid);
  const withEvent: WideEvents["Service"]["withEvent"] = (seed, work) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const parent = yield* current;
        const id = seed.eventId ?? (yield* eventId);
        const startedAt = seed.startedAt ?? (yield* Clock.currentTimeMillis);
        const event: Accumulator = {
          eventId: id,
          traceId: seed.traceId ?? parent?.traceId ?? id,
          fields: {},
          operations: new Set(),
          limits: new Map(),
          closed: false
        };
        addFields(event, seed);
        return yield* restore(work).pipe(
          Effect.provideService(current, event),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              event.closed = true;
              const finishedAt = seed.endedAt ?? (yield* Clock.currentTimeMillis);
              const draft: Record<string, unknown> = {
                ...event.fields,
                type: seed.type,
                eventId: id,
                traceId: event.traceId,
                parentId: seed.parentId ?? parent?.eventId,
                replica: seed.replica ?? identity.replica,
                deploymentRevision: seed.deploymentRevision ?? identity.deploymentRevision,
                startedAt,
                durationMs: Math.max(0, finishedAt - startedAt),
                sampleProbability: 1,
                outcome: Exit.isFailure(exit)
                  ? Exit.hasInterrupts(exit)
                    ? "interrupted"
                    : "failure"
                  : (event.fields.outcome ?? "success")
              };
              if (event.operations.size > 0) draft.operations = [...event.operations];
              if (event.limits.size > 0) draft.limits = [...event.limits.values()];
              if (event.limits.size > 0) {
                let closest: LimitPeak | undefined;
                for (const limit of event.limits.values())
                  if (
                    limit.value > 0 &&
                    (closest === undefined ||
                      limit.peak / limit.value > closest.peak / closest.value)
                  )
                    closest = limit;
                if (closest !== undefined) draft.closestLimitId = closest.limitId;
              }
              const record: Record<string, unknown> = {};
              for (const key of Object.keys(schemas[seed.type].fields)) {
                if (draft[key] !== undefined) record[key] = draft[key];
              }
              // Scheduling is the only sink work done in the caller's finalizer. A
              // detached, bounded delivery does not close or wait on the request Scope.
              yield* emit(record as WideEvent);
            })
          )
        );
      })
    );
  return WideEvents.of({ withEvent, emit });
});

/** Tests can record through Sink and await their own Queue or Deferred. */
export const layerWithSink = Layer.effect(WideEvents, make);
export const layerNoop = Layer.succeed(
  WideEvents,
  WideEvents.of({ withEvent: (_seed, work) => work, emit: () => Effect.void })
);

export const formatJson = Schema.encodeSync(Schema.fromJsonString(WideEvent));

/** One line for dev; --json callers receive the complete record instead. */
export const formatDev = (event: WideEvent, options: { readonly json?: boolean } = {}): string => {
  if (options.json) return formatJson(event);
  const viewer = "viewerId" in event ? event.viewerId : undefined;
  const handler = "handler" in event ? event.handler : undefined;
  const used = "operations" in event ? event.operations?.join(",") : undefined;
  return [
    viewer,
    handler ?? used ?? event.type,
    event.outcome,
    `${event.durationMs}ms`,
    event.code,
    event.limitId
  ]
    .filter((value) => value !== undefined)
    .join(" ");
};

/** PATCHY_REPLICA overrides a generated boot id; revision defaults to development. */
export const layerMetadata = Layer.effect(
  metadata,
  Effect.gen(function* () {
    const configuredReplica = yield* Config.option(Config.String("PATCHY_REPLICA"));
    return {
      replica: Option.isSome(configuredReplica) ? configuredReplica.value : yield* eventId,
      deploymentRevision: yield* Config.String("PATCHY_DEPLOYMENT_REVISION").pipe(
        Config.withDefault("development")
      )
    };
  })
);

/** The dev runner selects JSON without changing which event is collected. */
export const layerDev = (options: { readonly json?: boolean } = {}) =>
  layerWithSink.pipe(
    Layer.provide(
      Layer.effect(
        Sink,
        Effect.gen(function* () {
          const stdout = yield* Console.Console;
          return Sink.of({
            write: (event) => Effect.sync(() => stdout.log(formatDev(event, options)))
          });
        })
      )
    )
  );
