// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off -- residency uses wall time and OS RSS; tuple keys encode already-validated identities without delimiter collisions.
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  closeAfterAnswer,
  limitRefusal,
  limitRefusalFields,
  type RuntimeFailure
} from "@patchy/api";
import * as GuestProtocol from "@patchy/api/guest";
import * as Management from "@patchy/api/management";
import { registry } from "@patchy/limits/registry";
import * as Executor from "@patchy/runtime/executor";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Engine from "./engine.js";
import * as WorkerHttp from "./workerHttp.js";
import { sampleProcess, startWorkerd, type WorkerdError, type WorkerdProcess } from "./process.js";
import { Cryptography } from "@patchy/core";

export class SupervisorError extends Schema.TaggedError<SupervisorError>()("SupervisorError", {
  operation: Schema.Literals(["bind", "invoke", "stop", "stats", "touch"]),
  reason: Management.Refusal.fields.code,
  limit: Schema.optionalKey(Schema.Struct(limitRefusalFields)),
  limits: Management.Refusal.fields.limits,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `Supervisor ${this.operation} failed: ${this.reason}.`;
  }
}

const strict = { onExcessProperty: "error" } as const;
const decodeBind = Schema.decodeUnknownEffect(Management.BindRequest, strict);
const decodeInvoke = Schema.decodeUnknownEffect(Management.InvokeRequest, strict);
const decodeStop = Schema.decodeUnknownEffect(Management.StopRequest, strict);
const decodeStats = Schema.decodeUnknownEffect(Management.StatsRequest, strict);
const decodeTouch = Schema.decodeUnknownEffect(Management.TouchRequest, strict);
/** Bun's count of fetches at once, when its setting is absent or one it rejects. */
const bunFetches = 256;
/**
 * How many fetches the runtime runs at once, queueing the rest. Under Bun: 256, or
 * `BUN_CONFIG_MAX_HTTP_REQUESTS` read as Bun 1.4.4 reads it, Zig's `parseInt(u16, value, 10)`,
 * so one leading `+` and underscores between digits, then 1 to 65535; Bun warns about anything
 * else and keeps 256, as this does. Under Node, whose fetch queues nothing, there is no count.
 */
export const runtimeFetches = (runtime: {
  readonly bun: string | undefined;
  readonly setting: string | undefined;
}): number => {
  if (runtime.bun === undefined) return Number.POSITIVE_INFINITY;
  const digits = runtime.setting?.startsWith("+") ? runtime.setting.slice(1) : runtime.setting;
  if (digits === undefined || !/^\d(?:_*\d)*$/.test(digits)) return bunFetches;
  const fetches = Number(digits.replaceAll("_", ""));
  return fetches >= 1 && fetches <= 65_535 ? fetches : bunFetches;
};
const fetchSetting = Config.option(Config.String("BUN_CONFIG_MAX_HTTP_REQUESTS")).pipe(
  Effect.map(Option.getOrUndefined),
  Effect.orElseSucceed(() => undefined)
);
/**
 * How many invokes and forwarded callbacks this supervisor has in flight at once, together: the
 * count the runtime's fetch ran at once when every request it made went through it. An invoke
 * takes its place when its request is sent, and a callback when it is forwarded to the host, each
 * until its answer has been read; past the count each waits its turn, first come first served,
 * and while an invoke waits its attempt still counts as active, keeping its process from idle
 * reaping and eviction, as it did in fetch's queue. Binds, health probes and startup checks are
 * outside it. The watchdog's deadline kill exempts only attempts not yet sent; a sent attempt past
 * its deadline still ends its process. Undefined, the default, follows the runtime
 * (`runtimeFetches`); tests inject one.
 */
export const FetchSlots = Context.Reference<number | undefined>(
  "@patchy/execution/supervisor/FetchSlots",
  { defaultValue: () => undefined }
);
const killGrace = 1_000;
const idleWatch = 1_000;
const standbyQuiet = 1_000;
const standbyRetry = 10_000;

class CallbackBodyTooLarge extends Schema.TaggedError<CallbackBodyTooLarge>()(
  "CallbackBodyTooLarge",
  { actual: Schema.Number, max: Schema.Number }
) {
  override get message() {
    return `The callback body has ${this.actual} bytes; the maximum is ${this.max}.`;
  }
}
/** A host's reply past what the proxy reads back: the call reached the host, so its outcome is unknown. */
class CallbackReplyTooLarge extends Schema.TaggedError<CallbackReplyTooLarge>()(
  "CallbackReplyTooLarge",
  { actual: Schema.Number, max: Schema.Number }
) {
  override get message() {
    return `The callback reply has ${this.actual} bytes; the maximum is ${this.max}.`;
  }
}
/**
 * A body read up to `max` and no further. With its length declared, into one buffer of that size,
 * so it is never held twice; otherwise collected, then joined.
 */
const readCallbackBody = Effect.fnUntraced(function* <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  max: number = GuestProtocol.callbackFileLimit.value,
  declared?: number
) {
  if (
    declared !== undefined &&
    Number.isSafeInteger(declared) &&
    declared >= 0 &&
    declared <= max
  ) {
    const bytes = new Uint8Array(declared);
    let length = 0;
    yield* Stream.runForEach(stream, (chunk) => {
      if (length + chunk.byteLength > declared)
        return Effect.fail(new CallbackBodyTooLarge({ actual: length + chunk.byteLength, max }));
      bytes.set(chunk, length);
      length += chunk.byteLength;
      return Effect.void;
    });
    return length === declared ? bytes : bytes.subarray(0, length);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  yield* Stream.runForEach(stream, (chunk) => {
    length += chunk.byteLength;
    if (length > max) return Effect.fail(new CallbackBodyTooLarge({ actual: length, max }));
    chunks.push(chunk);
    return Effect.void;
  });
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, length);
});
const declaredLength = (value: string | undefined) => {
  const length = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
};

/**
 * The header naming a model call's operation, which the loader sets from the operation it
 * decoded. The proxy takes a model permit for the call before reading its body and forwards the
 * header only once it holds one; the host checks it against the body. The loader and the proxy
 * ship in one image, so the header tells the host the call came through both.
 */
const modelCallHeader = "x-patchy-model-call";
const isModelCall = (op: string | undefined): op is "models.decide" | "models.generate" =>
  op === "models.decide" || op === "models.generate";

const operatingLimitIds = [
  "execution.probe.interval",
  "execution.process.rss",
  "execution.residency.processes",
  "execution.residency.bytes",
  "execution.process.idle",
  "execution.process.load",
  "models.execution.inFlight"
] as const;
type SupervisorLimitId = (typeof operatingLimitIds)[number];

export interface Options {
  readonly callbackUrls: readonly string[];
  readonly operatingLimits?: Partial<Readonly<Record<SupervisorLimitId, number>>>;
  /** Dedicated execution tasks include host RSS; local hosts budget only their workerd children. */
  readonly residencyAccounting?: "host-and-workerd" | "workerd-only";
  readonly deploymentRevision?: string;
  readonly taskId?: string;
  readonly configRevision?: {
    readonly deploymentRevision: string;
    readonly overrideRevision: string;
  };
  /** Where the pinned workerd is installed, when not beside this package; see `startWorkerd`. */
  readonly workerdFrom?: string;
  /**
   * Keep one workerd started ahead of the next bind, so a bind only loads its version. Execution
   * tasks set it; the local executor shares its host and starts each process on demand.
   */
  readonly standby?: boolean;
}

/**
 * A workerd started before any version needs it: its own uid, no version, and a callback route
 * nothing serves until a bind adopts it, after which it is that version's process alone.
 */
interface Standby {
  readonly scope: Scope.Closeable;
  /** The callback route its configuration names; the adopting resident registers it. */
  readonly path: string;
  readonly started: Deferred.Deferred<WorkerdProcess, WorkerdError>;
  process?: WorkerdProcess;
  /** False once discarded or adopted; a probe answering after that changes nothing. */
  alive: boolean;
  probing: boolean;
  lastHealthy: number;
  rssBytes: number;
}

interface Invocation {
  readonly attempt: GuestProtocol.Attempt;
  readonly epoch: number;
  readonly capability: string;
  readonly target: string;
  readonly result: Deferred.Deferred<GuestProtocol.InvokeReply, SupervisorError>;
  /** The refusals this proxy gave the attempt's model calls, distinct, returned with its reply. */
  readonly refusals: Map<string, GuestProtocol.ExecutionRefusal>;
  /**
   * When its request was sent, holding its slot. Only then can its deadline end the process: a
   * second past its deadline or, sent late, a second past its sending, so the loader's answer to a
   * late call always arrives first. An attempt not yet sent ends nothing.
   */
  dispatchedAt?: number;
}
interface Resident {
  readonly binding: GuestProtocol.BundleBinding;
  readonly generation: number;
  readonly scope: Scope.Closeable;
  readonly ready: Deferred.Deferred<Management.BindReply, SupervisorError>;
  readonly dead: Deferred.Deferred<never, SupervisorError>;
  readonly reaped: Deferred.Deferred<void>;
  readonly proxyUrl: string;
  readonly invocations: Map<string, Invocation>;
  readonly startedAt: number;
  readonly eventId: string;
  readonly epoch: number;
  /** From its bind to ready for its first call, once it got there. */
  startMs?: number;
  process?: WorkerdProcess;
  engine?: Executor.Executor["Service"];
  alive: boolean;
  loading: boolean;
  /**
   * Loaded by a speculative bind and not yet bound or invoked on demand: eviction takes it
   * before any demanded process, even while it initializes.
   */
  speculative: boolean;
  probing: boolean;
  lastHealthy: number;
  idleSince: number;
  rssBytes: number;
  peakRssBytes: number;
  peakProcesses: number;
  peakAggregateRssBytes: number;
  /** The task's model calls in flight at their highest as this process's calls took a permit. */
  peakModelCalls: number;
  cpuSeconds: number;
  callsServed: number;
}
const versionKey = (binding: GuestProtocol.BundleBinding) =>
  JSON.stringify([binding.patchId, binding.versionId]);
const attemptKey = (attempt: Pick<GuestProtocol.Attempt, "invocationId" | "attemptId">) =>
  JSON.stringify([attempt.invocationId, attempt.attemptId]);

export class Supervisor extends Context.Service<
  Supervisor,
  {
    readonly bind: (
      request: Management.BindRequest
    ) => Effect.Effect<Management.BindReply, SupervisorError>;
    readonly invoke: (
      request: Management.InvokeRequest
    ) => Effect.Effect<GuestProtocol.InvokeReply, SupervisorError>;
    readonly stop: (request: Management.StopRequest) => Effect.Effect<void, SupervisorError>;
    readonly stats: (
      request: Management.StatsRequest
    ) => Effect.Effect<Management.StatsReply, SupervisorError>;
    /** Restarts a ready process's idle clock. It never loads, reserves or evicts anything. */
    readonly touch: (
      request: Management.TouchRequest
    ) => Effect.Effect<Management.TouchReply, SupervisorError>;
  }
>()("@patchy/execution/supervisor") {}

/**
 * The reply with every refusal the task gave the attempt's model calls: the loader's, then this
 * proxy's, distinct and bounded. A reply the task gave none keeps no field, as older hosts read it.
 */
const withRefusals = (
  reply: GuestProtocol.InvokeReply,
  given: ReadonlyMap<string, GuestProtocol.ExecutionRefusal>
): GuestProtocol.InvokeReply => {
  if (reply.outcome !== "returned") return reply;
  const all = new Map<string, GuestProtocol.ExecutionRefusal>();
  for (const refusal of [...(reply.refusals ?? []), ...given.values()]) {
    const key = GuestProtocol.refusalKey(refusal);
    if (!all.has(key) && all.size < GuestProtocol.executionRefusalLimit) all.set(key, refusal);
  }
  return {
    outcome: reply.outcome,
    reply: reply.reply,
    guestMs: reply.guestMs,
    ...(all.size === 0 ? {} : { refusals: [...all.values()] })
  };
};

export const make = Effect.fn("Supervisor.make")(function* (options: Options) {
  const cryptography = yield* Cryptography.Cryptography;
  // Callbacks forwarded to the host go through the runtime's fetch; everything sent to this
  // supervisor's own processes goes through `workers`, outside fetch's queue. Invokes and
  // forwarded callbacks share `slots` below; binds and probes never take one.
  const http = yield* HttpClient.HttpClient;
  const workers = yield* WorkerHttp.WorkerHttp;
  const scope = yield* Effect.scope;
  const operatingLimits = { ...options.operatingLimits };
  for (const [id, value] of Object.entries(operatingLimits)) {
    if (
      !operatingLimitIds.some((key) => key === id) ||
      !Number.isFinite(value) ||
      value <= 0 ||
      ((id === "execution.residency.processes" || id === "models.execution.inFlight") &&
        !Number.isSafeInteger(value)) ||
      (id === "execution.probe.interval" && value >= registry["execution.stall"].default)
    )
      return yield* new SupervisorError({ operation: "bind", reason: "protocol" });
  }
  if (process.platform !== "linux" && process.platform !== "darwin")
    return yield* new SupervisorError({ operation: "bind", reason: "load_failed" });
  yield* sampleProcess(process.pid).pipe(
    Effect.mapError(
      (cause) => new SupervisorError({ operation: "bind", reason: "load_failed", cause })
    )
  );
  const limit = (id: SupervisorLimitId): number => operatingLimits[id] ?? registry[id].default;
  const deploymentRevision = options.deploymentRevision ?? "local";
  let configRevision = options.configRevision ?? {
    deploymentRevision: yield* cryptography.sha256(
      operatingLimitIds.map((id) => `${id}=${limit(id)}`).join("\n")
    ),
    overrideRevision: "0"
  };
  const residents = new Map<string, Resident>();
  const callbacks = new Map<string, Resident>();
  const callbackUrls = new Set(options.callbackUrls);
  const reports = new Map<string, Management.ProcessReport>();
  const admission = yield* Semaphore.make(1);
  const slots = yield* Semaphore.make(
    (yield* FetchSlots) ??
      runtimeFetches({ bun: process.versions.bun, setting: yield* fetchSetting })
  );
  let companyId: string | null = null;
  let bindingEpoch = 0;
  let generation = 0;
  let stopped = false;
  let standby: Standby | undefined;
  /** The last standby's RSS, the headroom a replacement needs; 0 until one has started. */
  let standbyBytes = 0;
  /** When the last standby failed or was discarded: its replacement waits `standbyRetry`. */
  let standbyLostAt = Number.NEGATIVE_INFINITY;

  const aggregateRss = () => {
    let bytes = options.residencyAccounting === "workerd-only" ? 0 : process.memoryUsage.rss();
    for (const resident of residents.values()) bytes += resident.rssBytes;
    return bytes + (standby?.rssBytes ?? 0);
  };
  const stampPeaks = () => {
    const bytes = aggregateRss();
    for (const resident of residents.values()) {
      resident.peakProcesses = Math.max(resident.peakProcesses, residents.size);
      resident.peakAggregateRssBytes = Math.max(resident.peakAggregateRssBytes, bytes);
    }
  };
  const checkEpoch = (epoch: number, operation: SupervisorError["operation"]) =>
    epoch === bindingEpoch
      ? Effect.void
      : Effect.fail(new SupervisorError({ operation, reason: "stale_epoch" }));
  // Every operation checks this first. A task's address can be reused by a task holding the same
  // fleet secret, and a supervisor without an identity cannot be the task a host named.
  const checkTask = (taskId: string | undefined, operation: SupervisorError["operation"]) =>
    taskId === undefined || taskId === options.taskId
      ? Effect.void
      : Effect.fail(new SupervisorError({ operation, reason: "wrong_task" }));
  const sample = Effect.fnUntraced(function* (resident: Resident) {
    if (resident.process?.child.pid === undefined) return;
    const sampled = yield* sampleProcess(resident.process.child.pid);
    if (sampled !== undefined) {
      resident.rssBytes = sampled.rssBytes;
      resident.peakRssBytes = Math.max(
        resident.peakRssBytes,
        sampled.peakRssBytes,
        sampled.rssBytes
      );
      resident.cpuSeconds = Math.max(resident.cpuSeconds, sampled.cpuSeconds);
    }
  });
  const discardStandby = Effect.gen(function* () {
    const previous = standby;
    standby = undefined;
    if (previous === undefined) return;
    previous.alive = false;
    standbyLostAt = Date.now();
    yield* Scope.close(previous.scope, Exit.void);
  });
  const terminate = Effect.fnUntraced(function* (
    resident: Resident,
    cause: Management.ProcessReport["cause"]
  ) {
    if (!resident.alive) return yield* Deferred.await(resident.reaped);
    // Fence before any asynchronous cleanup, including callbacks already reading a body.
    resident.alive = false;
    callbacks.delete(new URL(resident.proxyUrl).pathname);
    const invocations = [...resident.invocations.values()].map(({ attempt }) => attempt);
    const error = new SupervisorError({ operation: "invoke", reason: "process_killed" });
    yield* Deferred.fail(
      resident.ready,
      new SupervisorError({
        operation: "bind",
        reason: cause === "load_failed" ? "load_failed" : "process_killed"
      })
    );
    yield* Deferred.fail(resident.dead, error);
    for (const invocation of resident.invocations.values())
      yield* Deferred.fail(invocation.result, error);
    yield* sample(resident).pipe(
      Effect.catchTags({
        WorkerdError: (error) =>
          Effect.logError(
            "Final process sample unavailable; retaining the previous watchdog sample.",
            { processGeneration: resident.generation, stage: error.stage, reason: error.reason }
          )
      })
    );
    stampPeaks();
    yield* Scope.close(resident.scope, Exit.void);
    residents.delete(versionKey(resident.binding));
    const endedAt = Date.now();
    const report: Management.ProcessReport = {
      reportId: resident.eventId,
      binding: resident.binding,
      bindingEpoch: resident.epoch,
      processGeneration: resident.generation,
      startedAt: resident.startedAt,
      endedAt,
      cause,
      cpuSeconds: resident.cpuSeconds,
      peakRssBytes: resident.peakRssBytes,
      callsServed: resident.callsServed,
      invocations,
      event: {
        type: "process",
        eventId: resident.eventId,
        traceId: resident.eventId,
        replica: `supervisor-${process.pid}`,
        deploymentRevision,
        startedAt: resident.startedAt,
        durationMs: endedAt - resident.startedAt,
        outcome: ["idle", "evicted", "stopped"].includes(cause) ? "success" : "failure",
        sampleProbability: 1,
        companyId: resident.binding.companyId,
        patchId: resident.binding.patchId,
        versionId: resident.binding.versionId,
        tier: 2,
        ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
        processGeneration: resident.generation,
        cause,
        cpuSeconds: resident.cpuSeconds,
        peakRssBytes: resident.peakRssBytes,
        callsServed: resident.callsServed,
        ...(resident.startMs === undefined ? {} : { startMs: resident.startMs }),
        // A supervisor serves one company for its life and counts generations from one.
        firstOnTask: resident.generation === 1,
        limits: [
          {
            limitId: "execution.process.rss",
            value: limit("execution.process.rss"),
            peak: resident.peakRssBytes,
            configRevision
          },
          {
            limitId: "execution.residency.processes",
            value: limit("execution.residency.processes"),
            peak: resident.peakProcesses,
            configRevision
          },
          {
            limitId: "execution.residency.bytes",
            value: limit("execution.residency.bytes"),
            peak: resident.peakAggregateRssBytes,
            configRevision
          },
          // Only a process whose patch asked for a model: the proxy's refusals never reach the
          // host, so this peak is where they show.
          ...(resident.peakModelCalls === 0
            ? []
            : [
                {
                  limitId: "models.execution.inFlight",
                  value: limit("models.execution.inFlight"),
                  peak: resident.peakModelCalls,
                  configRevision
                }
              ])
        ]
      }
    };
    reports.set(report.reportId, report);
    yield* Deferred.succeed(resident.reaped, undefined);
  }, Effect.uninterruptible);

  /** The residency limit `reserve` more processes would leave exceeded, if any. */
  const exceeded = (reserve: number) =>
    aggregateRss() >= limit("execution.residency.bytes")
      ? ("execution.residency.bytes" as const)
      : residents.size + reserve > limit("execution.residency.processes")
        ? ("execution.residency.processes" as const)
        : undefined;
  const evict = Effect.fnUntraced(function* (reserve: number, protectedResident?: Resident) {
    while (exceeded(reserve) !== undefined) {
      const memoryPressure = aggregateRss() >= limit("execution.residency.bytes");
      // A standby is the cheapest memory to give back: no version is loaded in it.
      if (memoryPressure && standby !== undefined) {
        yield* discardStandby;
        continue;
      }
      let victim: Resident | undefined;
      for (const resident of residents.values()) {
        if (
          resident === protectedResident ||
          !resident.alive ||
          (resident.loading && !resident.speculative) ||
          resident.invocations.size !== 0
        )
          continue;
        if (
          victim === undefined ||
          (resident.speculative !== victim.speculative
            ? resident.speculative
            : memoryPressure
              ? resident.rssBytes > victim.rssBytes
              : resident.idleSince < victim.idleSince)
        )
          victim = resident;
      }
      if (victim === undefined)
        return memoryPressure ? "execution.residency.bytes" : "execution.residency.processes";
      yield* terminate(victim, "evicted");
    }
    return undefined;
  });

  const proxy = yield* NodeHttpServer.make(createServer, {
    host: "127.0.0.1",
    port: 0,
    disablePreemptiveShutdown: true,
    gracefulShutdownTimeout: 0
  }).pipe(
    Effect.mapError(
      (cause) => new SupervisorError({ operation: "bind", reason: "transport", cause })
    )
  );
  if (proxy.address._tag === "UnixPathAddress")
    return yield* new SupervisorError({ operation: "bind", reason: "transport" });
  const proxyBase = `http://127.0.0.1:${proxy.address.port}`;
  /**
   * The task's model calls between taking a permit and reading the host's reply, across every
   * process. Each is given back by the call that took it, however that call ends.
   */
  let modelCallsInFlight = 0;
  /**
   * The proxy's own answer. A model call's says nothing was sent when the proxy gives it before
   * forwarding the call; one given after is about a call the host may have made, so it says
   * nothing, which reads as unknown. Every other call's answer is as it always was.
   */
  const shaped = (failure: RuntimeFailure, unsent: boolean): RuntimeFailure =>
    unsent ? { ...failure, details: { ...failure.details, sent: false } } : failure;
  const respond = (failure: RuntimeFailure, status: number | undefined) =>
    HttpServerResponse.jsonUnsafe(failure, status === undefined ? undefined : { status });
  const ended: RuntimeFailure = {
    ok: false,
    source: "patchy",
    code: "access_denied",
    error: "The invocation callback has ended."
  };
  yield* proxy.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Classified before anything can refuse it, so every refusal a model call gets before it
      // reaches the host says nothing was sent. The mark comes from the loader, never the guest.
      const marked = request.headers[modelCallHeader];
      const modelCall = isModelCall(marked) ? marked : undefined;
      const model = modelCall !== undefined;
      const resident = callbacks.get(request.url);
      if (request.method !== "POST" || resident === undefined)
        return respond(shaped(ended, model), 403);
      const invocation = resident.invocations.get(
        attemptKey({
          invocationId: request.headers["x-patchy-invocation-id"] ?? "",
          attemptId: request.headers["x-patchy-attempt-id"] ?? ""
        })
      );
      if (invocation === undefined) return respond(shaped(ended, model), 403);
      /** Set as the call is handed to the host: before it, nothing the call asked for was done. */
      let forwarded = false;
      /**
       * The proxy's own refusal of this call. A model call's is kept on its attempt, as the guest
       * gets it, so the host can relay it when the guest does and tell it from one patch code
       * makes up.
       */
      const refuse = (failure: RuntimeFailure, status?: number) => {
        const given = shaped(failure, model && !forwarded);
        if (modelCall !== undefined) {
          const record = {
            failure: given,
            status: status ?? GuestProtocol.refusalStatus(given.code),
            operation: modelCall
          };
          const key = GuestProtocol.refusalKey(record);
          if (
            !invocation.refusals.has(key) &&
            invocation.refusals.size < GuestProtocol.executionRefusalLimit
          )
            invocation.refusals.set(key, record);
        }
        return respond(given, status);
      };
      const live = () =>
        resident.alive &&
        invocation.epoch === bindingEpoch &&
        resident.invocations.get(attemptKey(invocation.attempt)) === invocation &&
        request.headers["x-patchy-process-generation"] === String(resident.generation) &&
        request.headers.authorization === `Bearer ${invocation.capability}`;
      const refusedCallback = () => refuse(ended, 403);
      const deadlineCallback = () =>
        refuse({
          ok: false,
          source: "patchy",
          code: "timeout",
          error: "The invocation callback deadline has passed."
        });
      const unavailableCallback = () =>
        !live()
          ? refusedCallback()
          : Date.now() >= invocation.attempt.deadline
            ? deadlineCallback()
            : refuse({
                ok: false,
                source: "patchy",
                code: "source_unavailable",
                error: "The invocation callback could not complete."
              });
      if (!live()) return refusedCallback();
      if (Date.now() >= invocation.attempt.deadline) return deadlineCallback();
      const declared = declaredLength(request.headers["content-length"]);
      // A model call declared past its cap is refused unread, before it asks for a permit; its
      // connection closes after, so nothing more of it is taken.
      if (model && declared !== undefined && declared > GuestProtocol.modelIngressLimit.value) {
        yield* closeAfterAnswer;
        return refuse(GuestProtocol.modelIngressAtProxy, 413);
      }
      const proxied = Effect.gen(function* () {
        // A request body over the limit stops being read; its 413 closes the connection.
        const body = yield* readCallbackBody(
          request.stream,
          model ? GuestProtocol.modelIngressLimit.value : GuestProtocol.callbackFileLimit.value,
          declared
        ).pipe(Effect.tapErrorTag("CallbackBodyTooLarge", () => closeAfterAnswer));
        if (!live()) return refusedCallback();
        const headers: Record<string, string> = {
          authorization: `Bearer ${invocation.capability}`,
          "x-patchy-invocation-id": invocation.attempt.invocationId,
          "x-patchy-attempt-id": invocation.attempt.attemptId,
          "x-patchy-process-generation": String(resident.generation),
          "x-patchy-binding-epoch": String(invocation.epoch),
          "content-type": request.headers["content-type"] ?? "application/json"
        };
        if (request.headers["x-patchy-callback"] !== undefined)
          headers["x-patchy-callback"] = request.headers["x-patchy-callback"];
        if (modelCall !== undefined) headers[modelCallHeader] = modelCall;
        // Its slot, in order, from its forward until the host's answer has been read. A call still
        // waiting for one has not been handed to the host, so a model call refused there says so.
        yield* slots.takeScoped(1);
        forwarded = true;
        const response = yield* http
          .execute(
            HttpClientRequest.post(invocation.target).pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.bodyUint8Array(body, headers["content-type"])
            )
          )
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        // The host's reply has its own overflow: the call reached the host by then.
        const bytes = yield* readCallbackBody(
          response.stream,
          GuestProtocol.callbackFileLimit.value,
          declaredLength(response.headers["content-length"])
        ).pipe(
          Effect.catchTag("CallbackBodyTooLarge", (error) =>
            Effect.fail(new CallbackReplyTooLarge({ actual: error.actual, max: error.max }))
          )
        );
        if (!live()) return refusedCallback();
        return HttpServerResponse.uint8Array(bytes, {
          status: response.status,
          contentType: response.headers["content-type"] ?? "application/json",
          headers:
            response.headers["x-patchy-file-body"] === undefined
              ? {}
              : { "x-patchy-file-body": response.headers["x-patchy-file-body"] }
        });
      }).pipe(
        Effect.scoped,
        Effect.raceFirst(Deferred.await(resident.dead)),
        Effect.timeout(Math.max(1, invocation.attempt.deadline - Date.now())),
        Effect.catchTags({
          CallbackBodyTooLarge: () =>
            Effect.succeed(
              model
                ? refuse(GuestProtocol.modelIngressAtProxy, 413)
                : HttpServerResponse.jsonUnsafe(GuestProtocol.callbackFileTooLarge, { status: 413 })
            ),
          // A model call's outcome is unknown; any other call's answer is as it always was.
          CallbackReplyTooLarge: () =>
            Effect.succeed(
              model
                ? unavailableCallback()
                : HttpServerResponse.jsonUnsafe(GuestProtocol.callbackFileTooLarge, { status: 413 })
            ),
          TimeoutError: () => Effect.succeed(deadlineCallback()),
          SupervisorError: () => Effect.succeed(refusedCallback()),
          HttpClientError: () => Effect.succeed(unavailableCallback()),
          HttpServerError: () => Effect.succeed(unavailableCallback())
        })
      );
      if (!model) return yield* proxied;
      // A model call takes its permit here, past the attempt's checks and before its body is
      // read, or is refused at once with nothing sent. The permit is the call's own: it is given
      // back as the call ends, the page's request closing first included, so the proxy stops
      // waiting on the host for a call nobody will read; the host still settles it.
      const limitValue = limit("models.execution.inFlight");
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const admitted = modelCallsInFlight < limitValue;
          if (admitted) modelCallsInFlight++;
          resident.peakModelCalls = Math.max(
            resident.peakModelCalls,
            Math.min(modelCallsInFlight + (admitted ? 0 : 1), limitValue)
          );
          return admitted;
        }),
        (admitted) =>
          admitted
            ? Effect.interruptible(proxied)
            : Effect.succeed(
                refuse(
                  {
                    ok: false,
                    source: "patchy",
                    error:
                      "Too many model calls are running in this company's execution task, so nothing was sent. Try again shortly.",
                    ...limitRefusal("models.execution.inFlight", limitValue, 1)
                  },
                  429
                )
              ),
        (admitted) =>
          Effect.sync(() => {
            if (admitted) modelCallsInFlight--;
          })
      );
    })
  );

  const probe = Effect.fnUntraced(function* (
    resident: Pick<Resident, "process" | "probing" | "alive" | "lastHealthy">
  ) {
    if (resident.process === undefined || resident.probing || !resident.alive) return;
    resident.probing = true;
    yield* workers.get(`${resident.process.url}/healthz`).pipe(
      Effect.tap((response) =>
        response.arrayBuffer.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (response.status === 200 && resident.alive) resident.lastHealthy = Date.now();
            })
          )
        )
      ),
      Effect.timeout(limit("execution.probe.interval")),
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          resident.probing = false;
        })
      ),
      Effect.forkIn(scope)
    );
  });
  const startStandby = Effect.gen(function* () {
    const entry: Standby = {
      scope: yield* Scope.make(),
      path: `/callback/${yield* cryptography.randomUUID}`,
      started: yield* Deferred.make<WorkerdProcess, WorkerdError>(),
      alive: true,
      probing: false,
      lastHealthy: Date.now(),
      rssBytes: 0
    };
    standby = entry;
    // Forked into its own scope: discarding the standby, or reaping the resident that adopted it,
    // stops a start still in progress along with the process.
    yield* startWorkerd({
      callbackUrls: [`${proxyBase}${entry.path}`],
      separateUid: true,
      ...(options.workerdFrom === undefined ? {} : { workerdFrom: options.workerdFrom })
    }).pipe(
      Effect.provideService(Scope.Scope, entry.scope),
      Effect.tap((child) =>
        Effect.gen(function* () {
          entry.process = child;
          entry.lastHealthy = Date.now();
          if (child.child.pid === undefined) return;
          entry.rssBytes = (yield* sampleProcess(child.child.pid))?.rssBytes ?? 0;
          standbyBytes = entry.rssBytes;
        })
      ),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          yield* Deferred.done(entry.started, exit);
          if (Exit.isSuccess(exit)) return;
          standbyLostAt = Date.now();
          if (standby === entry) yield* discardStandby;
        })
      ),
      Effect.forkIn(entry.scope)
    );
  });
  // A healthy standby answers a probe about once a second. One that has missed two, exited or
  // crossed the kill line is not worth a bind's wait to find out.
  const standbyFailing = (entry: Standby, now: number) => {
    const child = entry.process?.child;
    return (
      child !== undefined &&
      (child.exitCode !== null ||
        child.signalCode !== null ||
        entry.rssBytes >= limit("execution.process.rss") ||
        now - entry.lastHealthy >= 2 * idleWatch + 2 * limit("execution.probe.interval"))
    );
  };
  /** The standby for a bind to adopt, unless it has exited or stopped answering. Admission only. */
  const takeStandby = Effect.gen(function* () {
    const taken = standby;
    if (taken === undefined) return undefined;
    if (standbyFailing(taken, Date.now())) {
      yield* discardStandby;
      return undefined;
    }
    standby = undefined;
    taken.alive = false;
    return taken;
  });
  // Watched like an idle resident. Failing, it goes without a report: no version ran in it.
  const watchStandby = Effect.fnUntraced(function* (entry: Standby, now: number) {
    if (entry.process?.child.pid === undefined || now - entry.lastHealthy < idleWatch) return;
    const sampled = yield* sampleProcess(entry.process.child.pid).pipe(
      Effect.catchTags({ WorkerdError: () => Effect.succeed(undefined) })
    );
    if (sampled !== undefined) entry.rssBytes = sampled.rssBytes;
    const { child } = entry.process;
    if (
      sampled === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      entry.rssBytes >= limit("execution.process.rss") ||
      now - entry.lastHealthy >= registry["execution.stall"].default
    ) {
      yield* admission.withPermit(
        Effect.suspend(() => (standby === entry ? discardStandby : Effect.void))
      );
    } else yield* probe(entry);
  });
  // Admission only, judged at the moment it starts: a stop or bind that won the permit first has
  // already changed the answer. A replacement starts only on a quiet box, a second after the last
  // call or load, so its start never competes with either, and only with room for it.
  const standbyWanted = (at: number) =>
    standby === undefined &&
    !stopped &&
    at - standbyLostAt >= standbyRetry &&
    aggregateRss() + standbyBytes < limit("execution.residency.bytes") &&
    [...residents.values()].every(
      (resident) =>
        !resident.loading &&
        resident.invocations.size === 0 &&
        at - resident.idleSince >= standbyQuiet
    );
  const tick = Effect.gen(function* () {
    const now = Date.now();
    for (const resident of residents.values()) {
      if (!resident.alive) continue;
      // A ready process with no call in flight is sampled and probed once its last good probe is
      // a second old, not every tick: a long idle window stays cheap, and a process that stops
      // answering is watched every tick again, toward the same stall kill.
      const watched =
        resident.loading ||
        resident.invocations.size !== 0 ||
        now - resident.lastHealthy >= idleWatch;
      if (watched)
        yield* sample(resident).pipe(
          Effect.catchTags({
            WorkerdError: (cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("Process resource sampling failed; reaping its resident.", {
                  processGeneration: resident.generation,
                  stage: cause.stage,
                  reason: cause.reason
                });
                yield* terminate(resident, "metering_failed");
              })
          })
        );
      if (!resident.alive) continue;
      const child = resident.process?.child;
      if (child !== undefined && (child.exitCode !== null || child.signalCode !== null))
        yield* terminate(resident, "exited");
      else if (resident.rssBytes >= limit("execution.process.rss"))
        yield* terminate(resident, "memory");
      else if (
        [...resident.invocations.values()].some(
          ({ attempt, dispatchedAt }) =>
            dispatchedAt !== undefined &&
            now >= Math.max(attempt.deadline, dispatchedAt) + killGrace
        )
      )
        yield* terminate(resident, "deadline");
      else if (now - resident.lastHealthy >= registry["execution.stall"].default)
        yield* terminate(resident, "stall");
      else if (resident.loading && now - resident.startedAt >= limit("execution.process.load"))
        yield* terminate(resident, "load_failed");
      else if (
        !resident.loading &&
        resident.invocations.size === 0 &&
        now - resident.idleSince >= limit("execution.process.idle")
      )
        yield* terminate(resident, "idle");
      else if (watched) yield* probe(resident);
    }
    if (standby !== undefined) yield* watchStandby(standby, now);
    stampPeaks();
    yield* admission.withPermit(
      Effect.gen(function* () {
        yield* evict(0);
        if (options.standby === true && standbyWanted(Date.now())) yield* startStandby;
      })
    );
  });
  yield* tick.pipe(
    Effect.andThen(Effect.suspend(() => Effect.sleep(limit("execution.probe.interval")))),
    Effect.forever,
    Effect.forkIn(scope)
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      stopped = true;
      yield* discardStandby;
      for (const resident of residents.values()) yield* terminate(resident, "stopped");
    })
  );

  const failLoad = Effect.fnUntraced(function* (
    resident: Resident,
    error: SupervisorError,
    cause: Management.ProcessReport["cause"]
  ) {
    yield* Deferred.fail(resident.ready, error);
    yield* terminate(resident, cause);
  });

  const bind = Effect.fn("Supervisor.bind")(function* (input: Management.BindRequest) {
    const request = yield* decodeBind(input).pipe(
      Effect.mapError(
        (cause) => new SupervisorError({ operation: "bind", reason: "protocol", cause })
      )
    );
    yield* checkTask(request.taskId, "bind");
    const resident = yield* admission.withPermit(
      Effect.gen(function* () {
        if (stopped) return yield* new SupervisorError({ operation: "bind", reason: "stopped" });
        if (companyId !== null && companyId !== request.companyId)
          return yield* new SupervisorError({ operation: "bind", reason: "binding_conflict" });
        if (companyId !== null && request.bindingEpoch < bindingEpoch)
          return yield* new SupervisorError({ operation: "bind", reason: "stale_epoch" });
        // A version bind names its version by bundle, or by hash with only its binding.
        const named = request.bundle ?? request.binding;
        if (named !== undefined && named.companyId !== request.companyId)
          return yield* new SupervisorError({ operation: "bind", reason: "binding_conflict" });
        if ((request.operatingLimits === undefined) !== (request.configRevision === undefined))
          return yield* new SupervisorError({ operation: "bind", reason: "protocol" });
        if (
          request.operatingLimits !== undefined &&
          (request.operatingLimits["execution.probe.interval"] ??
            limit("execution.probe.interval")) >= registry["execution.stall"].default
        )
          return yield* new SupervisorError({ operation: "bind", reason: "protocol" });
        const existing = named === undefined ? undefined : residents.get(versionKey(named));
        if (existing?.alive === true && existing.binding.sha256 !== named?.sha256)
          return yield* new SupervisorError({ operation: "bind", reason: "binding_conflict" });
        const held = existing?.alive === true ? existing : undefined;
        // Refused before any effect, so the host can send the same bind with its bundle.
        if (request.binding !== undefined && held === undefined)
          return yield* new SupervisorError({ operation: "bind", reason: "bundle_required" });
        if (request.operatingLimits !== undefined && request.configRevision !== undefined) {
          // Late acknowledgements cannot restore an older company override snapshot.
          if (
            request.bindingEpoch > bindingEpoch ||
            BigInt(request.configRevision.overrideRevision) >=
              BigInt(configRevision.overrideRevision)
          ) {
            Object.assign(operatingLimits, request.operatingLimits);
            configRevision = request.configRevision;
          }
        }
        for (const url of request.callbackUrls ?? []) callbackUrls.add(url);
        companyId = request.companyId;
        bindingEpoch = request.bindingEpoch;
        // Loading or ready, a held version is returned as it is; the caller awaits its readiness.
        // A demanded bind makes it an ordinary process.
        if (held !== undefined) {
          if (request.speculative !== true) held.speculative = false;
          return held;
        }
        const bundle = request.bundle;
        // Only a company bind gets here without a bundle: a bind by hash was held or refused.
        if (bundle === undefined) return undefined;
        const key = versionKey(bundle);
        // A dying resident of this version finishes its reap before its replacement loads.
        if (existing !== undefined) yield* Deferred.await(existing.reaped);
        // Eviction does not await bundle initialization. A spinning load cannot own the watchdog.
        // A speculative load takes only a free slot; it never evicts anything.
        const blockedBy = request.speculative === true ? exceeded(1) : yield* evict(1);
        if (blockedBy !== undefined)
          return yield* new SupervisorError({
            operation: "bind",
            reason: "busy",
            limit: limitRefusal(blockedBy, limit(blockedBy)),
            limits: [
              {
                limitId: blockedBy,
                value: limit(blockedBy),
                peak: blockedBy === "execution.residency.bytes" ? aggregateRss() : residents.size,
                configRevision
              }
            ]
          });
        yield* checkEpoch(request.bindingEpoch, "bind");
        if (stopped) return yield* new SupervisorError({ operation: "bind", reason: "stopped" });
        const now = Date.now();
        const prestarted = yield* takeStandby;
        const path = prestarted?.path ?? `/callback/${yield* cryptography.randomUUID}`;
        const resident: Resident = {
          binding: {
            companyId: bundle.companyId,
            patchId: bundle.patchId,
            versionId: bundle.versionId,
            sha256: bundle.sha256
          },
          generation: ++generation,
          scope: prestarted?.scope ?? (yield* Scope.make()),
          ready: yield* Deferred.make<Management.BindReply, SupervisorError>(),
          dead: yield* Deferred.make<never, SupervisorError>(),
          reaped: yield* Deferred.make<void>(),
          proxyUrl: `${proxyBase}${path}`,
          invocations: new Map(),
          startedAt: now,
          eventId: yield* cryptography.randomUUID,
          epoch: bindingEpoch,
          alive: true,
          loading: true,
          speculative: request.speculative === true,
          probing: false,
          lastHealthy: now,
          idleSince: now,
          rssBytes: 0,
          peakRssBytes: 0,
          peakProcesses: 0,
          peakAggregateRssBytes: 0,
          peakModelCalls: 0,
          cpuSeconds: 0,
          callsServed: 0
        };
        callbacks.set(path, resident);
        residents.set(key, resident);
        stampPeaks();
        yield* Effect.gen(function* () {
          const child = yield* prestarted === undefined
            ? startWorkerd({
                callbackUrls: [resident.proxyUrl],
                separateUid: true,
                ...(options.workerdFrom === undefined ? {} : { workerdFrom: options.workerdFrom })
              }).pipe(Effect.provideService(Scope.Scope, resident.scope))
            : Deferred.await(prestarted.started).pipe(
                Effect.raceFirst(Deferred.await(resident.dead))
              );
          resident.process = child;
          // An adopted standby keeps its health clock: a stall that began before the bind counts.
          resident.lastHealthy = prestarted === undefined ? Date.now() : prestarted.lastHealthy;
          resident.engine = yield* Engine.make({ url: child.url });
          yield* resident.engine.bind(bundle).pipe(Effect.raceFirst(Deferred.await(resident.dead)));
          yield* sample(resident);
          if (!resident.alive) return;
          resident.loading = false;
          resident.idleSince = Date.now();
          resident.startMs = resident.idleSince - resident.startedAt;
          stampPeaks();
          yield* Deferred.succeed(resident.ready, {
            bindingEpoch: request.bindingEpoch,
            binding: resident.binding,
            processGeneration: resident.generation
          });
        }).pipe(
          Effect.catchTags({
            WorkerdError: (cause) =>
              Effect.gen(function* () {
                if (cause.stage === "sample")
                  yield* Effect.logError("Process resource sampling failed during loading.", {
                    processGeneration: resident.generation,
                    stage: cause.stage,
                    reason: cause.reason
                  });
                yield* failLoad(
                  resident,
                  new SupervisorError({ operation: "bind", reason: "load_failed", cause }),
                  cause.stage === "sample" ? "metering_failed" : "load_failed"
                );
              }),
            ExecutionError: (cause) =>
              failLoad(
                resident,
                new SupervisorError({ operation: "bind", reason: cause.reason, cause }),
                "load_failed"
              ),
            SupervisorError: (cause) => failLoad(resident, cause, "load_failed")
          }),
          Effect.provideService(HttpClient.HttpClient, workers),
          Effect.forkIn(scope)
        );
        return resident;
      })
    );
    if (resident === undefined) return { bindingEpoch: request.bindingEpoch };
    yield* Deferred.await(resident.ready);
    yield* checkEpoch(request.bindingEpoch, "bind");
    return { bindingEpoch, binding: resident.binding, processGeneration: resident.generation };
  });

  return Supervisor.of({
    bind,
    invoke: Effect.fn("Supervisor.invoke")(function* (input) {
      const {
        taskId,
        bindingEpoch: epoch,
        request
      } = yield* decodeInvoke(input).pipe(
        Effect.mapError(
          (cause) => new SupervisorError({ operation: "invoke", reason: "protocol", cause })
        )
      );
      yield* checkTask(taskId, "invoke");
      const result = yield* admission.withPermit(
        Effect.gen(function* () {
          const key = attemptKey(request);
          const select = Effect.gen(function* () {
            yield* checkEpoch(epoch, "invoke");
            if (stopped)
              return yield* new SupervisorError({ operation: "invoke", reason: "stopped" });
            if (request.binding.companyId !== companyId)
              return yield* new SupervisorError({
                operation: "invoke",
                reason: "binding_conflict"
              });
            const resident = residents.get(versionKey(request.binding));
            if (
              resident === undefined ||
              !resident.alive ||
              resident.loading ||
              resident.engine === undefined
            )
              return yield* new SupervisorError({
                operation: "invoke",
                reason: "bundle_required"
              });
            if (request.processGeneration !== resident.generation)
              return yield* new SupervisorError({
                operation: "invoke",
                reason: "stale_generation"
              });
            if (request.binding.sha256 !== resident.binding.sha256)
              return yield* new SupervisorError({
                operation: "invoke",
                reason: "binding_conflict"
              });
            if (!callbackUrls.has(request.callback.url) || resident.invocations.has(key))
              return yield* new SupervisorError({ operation: "invoke", reason: "protocol" });
            return { resident, engine: resident.engine, target: resident.proxyUrl };
          });
          const selected = yield* select;
          const blockedBy = yield* evict(0, selected.resident);
          // Reaping an idle sibling yields. Recheck the target and its authority before dispatch.
          const { resident, engine, target } = yield* select;
          if (blockedBy !== undefined)
            return yield* new SupervisorError({
              operation: "invoke",
              reason: "busy",
              limit: limitRefusal(blockedBy, limit(blockedBy)),
              limits: [
                {
                  limitId: blockedBy,
                  value: limit(blockedBy),
                  peak: blockedBy === "execution.residency.bytes" ? aggregateRss() : residents.size,
                  configRevision
                }
              ]
            });
          const result = yield* Deferred.make<GuestProtocol.InvokeReply, SupervisorError>();
          const attempt: GuestProtocol.Attempt = {
            invocationId: request.invocationId,
            attemptId: request.attemptId,
            processGeneration: resident.generation,
            deadline: request.deadline
          };
          const refusals = new Map<string, GuestProtocol.ExecutionRefusal>();
          const registered: Invocation = {
            attempt,
            epoch,
            capability: request.callback.capability,
            target: request.callback.url,
            result,
            refusals
          };
          resident.invocations.set(key, registered);
          resident.callsServed++;
          resident.speculative = false;
          let uncertain = false;
          // Prepared first, its request then waits for a slot, in order, and holds it until the
          // loader's answer is read or the request is abandoned. Waiting, it takes nothing and its
          // deadline ends nothing.
          const send = engine
            .invoke({ ...request, callback: { ...request.callback, url: target } })
            .pipe(
              Effect.provideService(Engine.Dispatch, (sent) =>
                slots.withPermit(
                  Effect.suspend(() => {
                    registered.dispatchedAt = Date.now();
                    return sent;
                  })
                )
              )
            );
          // The supervisor owns dispatch. Losing the HTTP caller must not erase a running deadline.
          yield* send.pipe(
            // The loader's refusals and this proxy's, both the task's own, ride the reply.
            Effect.map((reply) => withRefusals(reply, refusals)),
            Effect.catchTags({
              ExecutionError: (cause) => {
                uncertain = cause.reason === "transport";
                return Effect.fail(
                  new SupervisorError({ operation: "invoke", reason: cause.reason, cause })
                );
              }
            }),
            Effect.raceFirst(Deferred.await(resident.dead)),
            Effect.exit,
            Effect.flatMap((exit) =>
              Effect.gen(function* () {
                if (resident.alive && Exit.isFailure(exit) && uncertain) {
                  // Only transport loss leaves execution uncertain until its deadline or reap.
                  yield* Deferred.done(result, exit);
                  return;
                }
                resident.invocations.delete(key);
                resident.idleSince = Date.now();
                yield* Deferred.done(result, exit);
              })
            ),
            Effect.forkIn(scope)
          );
          return result;
        })
      );
      return yield* Deferred.await(result);
    }),
    stop: Effect.fn("Supervisor.stop")(function* (input) {
      const request = yield* decodeStop(input).pipe(
        Effect.mapError(
          (cause) => new SupervisorError({ operation: "stop", reason: "protocol", cause })
        )
      );
      yield* checkTask(request.taskId, "stop");
      yield* checkEpoch(request.bindingEpoch, "stop");
      if (request.processGeneration === undefined) {
        // Under admission: a bind either finds the task stopped or has registered its resident,
        // standby or not, for this to reap. Nothing it loads outlives the stop.
        yield* admission.withPermit(
          Effect.gen(function* () {
            // Its authority again: a newer host may have bound the task while this waited.
            yield* checkEpoch(request.bindingEpoch, "stop");
            stopped = true;
            yield* discardStandby;
            for (const resident of residents.values()) yield* terminate(resident, "stopped");
          })
        );
      } else {
        const resident = [...residents.values()].find(
          (entry) => entry.generation === request.processGeneration
        );
        if (resident === undefined)
          return yield* new SupervisorError({
            operation: "stop",
            reason: "stale_generation"
          });
        yield* terminate(resident, "stopped");
      }
    }),
    stats: Effect.fn("Supervisor.stats")(function* (input) {
      const request = yield* decodeStats(input).pipe(
        Effect.mapError(
          (cause) => new SupervisorError({ operation: "stats", reason: "protocol", cause })
        )
      );
      yield* checkTask(request.taskId, "stats");
      yield* checkEpoch(request.bindingEpoch, "stats");
      for (const id of request.acknowledgeReports ?? []) reports.delete(id);
      return {
        companyId,
        bindingEpoch,
        stopped,
        aggregateRssBytes: aggregateRss(),
        processes: [...residents.values()].flatMap((resident) =>
          resident.process?.child.pid === undefined
            ? []
            : [
                {
                  binding: resident.binding,
                  processGeneration: resident.generation,
                  pid: resident.process.child.pid,
                  activeInvocations: resident.invocations.size,
                  rssBytes: resident.rssBytes,
                  peakRssBytes: resident.peakRssBytes,
                  cpuSeconds: resident.cpuSeconds,
                  callsServed: resident.callsServed
                }
              ]
        ),
        reports: [...reports.values()]
      };
    }),
    touch: Effect.fn("Supervisor.touch")(function* (input) {
      const request = yield* decodeTouch(input).pipe(
        Effect.mapError(
          (cause) => new SupervisorError({ operation: "touch", reason: "protocol", cause })
        )
      );
      yield* checkTask(request.taskId, "touch");
      yield* checkEpoch(request.bindingEpoch, "touch");
      if (stopped) return yield* new SupervisorError({ operation: "touch", reason: "stopped" });
      if (request.binding.companyId !== companyId)
        return yield* new SupervisorError({ operation: "touch", reason: "binding_conflict" });
      // The window it reaps by, so the host can space its touches within it.
      const idleMs = limit("execution.process.idle");
      const resident = residents.get(versionKey(request.binding));
      if (resident === undefined || !resident.alive) return { outcome: "absent" as const, idleMs };
      if (resident.binding.sha256 !== request.binding.sha256)
        return yield* new SupervisorError({ operation: "touch", reason: "binding_conflict" });
      // Initialization keeps its deadline from spawn, so a touch cannot keep a hung load alive.
      if (resident.loading) return { outcome: "loading" as const, idleMs };
      // Only the idle clock: eviction under residency or memory pressure still picks from it.
      resident.idleSince = Date.now();
      return { outcome: "touched" as const, idleMs };
    })
  });
});

export const layer = (options: Options) => Layer.effect(Supervisor, make(options));
