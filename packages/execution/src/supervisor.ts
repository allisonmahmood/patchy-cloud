// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off -- residency uses wall time and OS RSS; tuple keys encode already-validated identities without delimiter collisions.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { limitRefusal, limitRefusalFields } from "@patchy/api";
import * as GuestProtocol from "@patchy/api/guest";
import * as Management from "@patchy/api/management";
import { registry } from "@patchy/limits/registry";
import * as Executor from "@patchy/runtime/executor";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Engine from "./engine.js";
import { sampleProcess, startWorkerd, type WorkerdProcess } from "./process.js";

export class SupervisorError extends Schema.TaggedError<SupervisorError>()("SupervisorError", {
  operation: Schema.Literals(["bind", "invoke", "stop", "stats"]),
  reason: Management.Refusal.fields.code,
  limit: Schema.optionalKey(Schema.Struct(limitRefusalFields)),
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
const killGrace = 1_000;

class CallbackBodyTooLarge extends Schema.TaggedError<CallbackBodyTooLarge>()(
  "CallbackBodyTooLarge",
  { actual: Schema.Number, max: Schema.Number }
) {
  override get message() {
    return `The callback body has ${this.actual} bytes; the maximum is ${this.max}.`;
  }
}
const readCallbackBody = Effect.fnUntraced(function* <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>
) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  yield* Stream.runForEach(stream, (chunk) => {
    length += chunk.byteLength;
    if (length > GuestProtocol.callbackFileLimit.value)
      return Effect.fail(
        new CallbackBodyTooLarge({ actual: length, max: GuestProtocol.callbackFileLimit.value })
      );
    chunks.push(chunk);
    return Effect.void;
  });
  return Buffer.concat(chunks, length);
});

const operatingLimitIds = [
  "execution.probe.interval",
  "execution.process.rss",
  "execution.residency.processes",
  "execution.residency.bytes",
  "execution.process.idle"
] as const;
type SupervisorLimitId = (typeof operatingLimitIds)[number];

export interface Options {
  readonly callbackUrls: readonly string[];
  readonly operatingLimits?: Partial<Readonly<Record<SupervisorLimitId, number>>>;
  readonly deploymentRevision?: string;
  readonly taskId?: string;
  readonly configRevision?: {
    readonly deploymentRevision: string;
    readonly overrideRevision: string;
  };
}

interface Invocation {
  readonly attempt: GuestProtocol.Attempt;
  readonly epoch: number;
  readonly capability: string;
  readonly target: string;
  readonly result: Deferred.Deferred<GuestProtocol.InvokeReply, SupervisorError>;
}
interface Resident {
  readonly binding: GuestProtocol.BundleBinding;
  readonly generation: number;
  readonly scope: Scope.Closeable;
  readonly ready: Deferred.Deferred<Management.BindReply, SupervisorError>;
  readonly dead: Deferred.Deferred<never, SupervisorError>;
  readonly reaped: Deferred.Deferred<void>;
  readonly proxyUrls: ReadonlyMap<string, string>;
  readonly invocations: Map<string, Invocation>;
  readonly startedAt: number;
  readonly eventId: string;
  readonly epoch: number;
  process?: WorkerdProcess;
  engine?: Executor.Executor["Service"];
  alive: boolean;
  loading: boolean;
  probing: boolean;
  lastHealthy: number;
  idleSince: number;
  rssBytes: number;
  peakRssBytes: number;
  peakProcesses: number;
  peakAggregateRssBytes: number;
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
  }
>()("@patchy/execution/supervisor") {}

export const make = Effect.fn("Supervisor.make")(function* (options: Options) {
  const http = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;
  const operatingLimits = { ...options.operatingLimits };
  for (const [id, value] of Object.entries(operatingLimits)) {
    if (
      !operatingLimitIds.some((key) => key === id) ||
      !Number.isFinite(value) ||
      value <= 0 ||
      (id === "execution.residency.processes" && !Number.isSafeInteger(value)) ||
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
  const interval = limit("execution.probe.interval");
  const deploymentRevision = options.deploymentRevision ?? "local";
  const configRevision = options.configRevision ?? {
    deploymentRevision: createHash("sha256")
      .update(operatingLimitIds.map((id) => `${id}=${limit(id)}`).join("\n"))
      .digest("hex"),
    overrideRevision: "0"
  };
  const residents = new Map<string, Resident>();
  const callbacks = new Map<string, { resident: Resident; target: string }>();
  const reports = new Map<string, Management.ProcessReport>();
  const admission = yield* Semaphore.make(1);
  let companyId: string | null = null;
  let bindingEpoch = 0;
  let generation = 0;
  let stopped = false;

  const aggregateRss = () => {
    let bytes = process.memoryUsage.rss();
    for (const resident of residents.values()) bytes += resident.rssBytes;
    return bytes;
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
  const terminate = Effect.fnUntraced(function* (
    resident: Resident,
    cause: Management.ProcessReport["cause"]
  ) {
    if (!resident.alive) return yield* Deferred.await(resident.reaped);
    // Fence before any asynchronous cleanup, including callbacks already reading a body.
    resident.alive = false;
    for (const url of resident.proxyUrls.values()) callbacks.delete(new URL(url).pathname);
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
          }
        ]
      }
    };
    reports.set(report.reportId, report);
    yield* Deferred.succeed(resident.reaped, undefined);
  }, Effect.uninterruptible);

  const evict = Effect.fnUntraced(function* (reserve: number, protectedResident?: Resident) {
    while (
      residents.size + reserve > limit("execution.residency.processes") ||
      aggregateRss() >= limit("execution.residency.bytes")
    ) {
      const memoryPressure = aggregateRss() >= limit("execution.residency.bytes");
      let victim: Resident | undefined;
      for (const resident of residents.values()) {
        if (
          resident === protectedResident ||
          !resident.alive ||
          resident.loading ||
          resident.invocations.size !== 0
        )
          continue;
        if (
          victim === undefined ||
          (memoryPressure
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
  const refusedCallback = () =>
    HttpServerResponse.jsonUnsafe(
      {
        ok: false,
        source: "patchy",
        code: "access_denied",
        error: "The invocation callback has ended."
      },
      { status: 403 }
    );
  yield* proxy.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const route = callbacks.get(request.url);
      if (request.method !== "POST" || route === undefined) return refusedCallback();
      const resident = route.resident;
      const invocation = resident.invocations.get(
        attemptKey({
          invocationId: request.headers["x-patchy-invocation-id"] ?? "",
          attemptId: request.headers["x-patchy-attempt-id"] ?? ""
        })
      );
      if (invocation === undefined) return refusedCallback();
      const live = () =>
        resident.alive &&
        invocation.epoch === bindingEpoch &&
        invocation.target === route.target &&
        resident.invocations.get(attemptKey(invocation.attempt)) === invocation &&
        request.headers["x-patchy-process-generation"] === String(resident.generation) &&
        request.headers.authorization === `Bearer ${invocation.capability}`;
      const deadlineCallback = () =>
        HttpServerResponse.jsonUnsafe({
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
            : HttpServerResponse.jsonUnsafe({
                ok: false,
                source: "patchy",
                code: "source_unavailable",
                error: "The invocation callback could not complete."
              });
      if (!live()) return refusedCallback();
      if (Date.now() >= invocation.attempt.deadline) return deadlineCallback();
      return yield* Effect.gen(function* () {
        const body = yield* readCallbackBody(request.stream);
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
        const response = yield* http
          .execute(
            HttpClientRequest.post(route.target).pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.bodyUint8Array(body, headers["content-type"])
            )
          )
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const bytes = yield* readCallbackBody(response.stream);
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
        Effect.raceFirst(Deferred.await(resident.dead)),
        Effect.timeout(Math.max(1, invocation.attempt.deadline - Date.now())),
        Effect.catchTags({
          CallbackBodyTooLarge: () =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                {
                  ok: false,
                  source: "patchy",
                  error: "The file exceeds the callback byte limit.",
                  ...GuestProtocol.callbackFileLimit
                },
                { status: 413 }
              )
            ),
          TimeoutError: () => Effect.succeed(deadlineCallback()),
          SupervisorError: () => Effect.succeed(refusedCallback()),
          HttpClientError: () => Effect.succeed(unavailableCallback()),
          HttpServerError: () => Effect.succeed(unavailableCallback())
        })
      );
    })
  );

  const probe = Effect.fnUntraced(function* (resident: Resident) {
    if (resident.process === undefined || resident.probing || !resident.alive) return;
    resident.probing = true;
    yield* http.get(`${resident.process.url}/healthz`).pipe(
      Effect.tap((response) =>
        response.arrayBuffer.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (response.status === 200 && resident.alive) resident.lastHealthy = Date.now();
            })
          )
        )
      ),
      Effect.timeout(interval),
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          resident.probing = false;
        })
      ),
      Effect.forkIn(scope)
    );
  });
  const tick = Effect.gen(function* () {
    const now = Date.now();
    for (const resident of residents.values()) {
      if (!resident.alive) continue;
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
          ({ attempt }) => now >= attempt.deadline + killGrace
        )
      )
        yield* terminate(resident, "deadline");
      else if (now - resident.lastHealthy >= registry["execution.stall"].default)
        yield* terminate(resident, "stall");
      else if (
        resident.invocations.size === 0 &&
        now - (resident.loading ? resident.startedAt : resident.idleSince) >=
          limit("execution.process.idle")
      )
        yield* terminate(resident, resident.loading ? "load_failed" : "idle");
      else yield* probe(resident);
    }
    stampPeaks();
    yield* admission.withPermit(evict(0));
  });
  yield* tick.pipe(Effect.andThen(Effect.sleep(interval)), Effect.forever, Effect.forkIn(scope));
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      stopped = true;
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
    const resident = yield* admission.withPermit(
      Effect.gen(function* () {
        if (stopped) return yield* new SupervisorError({ operation: "bind", reason: "stopped" });
        if (companyId !== null && companyId !== request.companyId)
          return yield* new SupervisorError({ operation: "bind", reason: "binding_conflict" });
        if (companyId !== null && request.bindingEpoch < bindingEpoch)
          return yield* new SupervisorError({ operation: "bind", reason: "stale_epoch" });
        if (request.bundle !== undefined && request.bundle.companyId !== request.companyId)
          return yield* new SupervisorError({ operation: "bind", reason: "binding_conflict" });
        companyId = request.companyId;
        bindingEpoch = request.bindingEpoch;
        if (request.bundle === undefined) return undefined;
        const bundle = request.bundle;
        const key = versionKey(bundle);
        const existing = residents.get(key);
        if (existing !== undefined && !existing.alive) {
          yield* Deferred.await(existing.reaped);
        } else if (existing !== undefined) {
          if (existing.binding.sha256 !== bundle.sha256)
            return yield* new SupervisorError({
              operation: "bind",
              reason: "binding_conflict"
            });
          return existing;
        }
        // Eviction does not await bundle initialization. A spinning load cannot own the watchdog.
        const blockedBy = yield* evict(1);
        if (blockedBy !== undefined)
          return yield* new SupervisorError({
            operation: "bind",
            reason: "busy",
            limit: limitRefusal(blockedBy, limit(blockedBy))
          });
        yield* checkEpoch(request.bindingEpoch, "bind");
        if (stopped) return yield* new SupervisorError({ operation: "bind", reason: "stopped" });
        const now = Date.now();
        const proxyUrls = new Map<string, string>();
        const resident: Resident = {
          binding: {
            companyId: bundle.companyId,
            patchId: bundle.patchId,
            versionId: bundle.versionId,
            sha256: bundle.sha256
          },
          generation: ++generation,
          scope: yield* Scope.make(),
          ready: yield* Deferred.make<Management.BindReply, SupervisorError>(),
          dead: yield* Deferred.make<never, SupervisorError>(),
          reaped: yield* Deferred.make<void>(),
          proxyUrls,
          invocations: new Map(),
          startedAt: now,
          eventId: randomUUID(),
          epoch: bindingEpoch,
          alive: true,
          loading: true,
          probing: false,
          lastHealthy: now,
          idleSince: now,
          rssBytes: 0,
          peakRssBytes: 0,
          peakProcesses: 0,
          peakAggregateRssBytes: 0,
          cpuSeconds: 0,
          callsServed: 0
        };
        for (const target of options.callbackUrls) {
          const path = `/callback/${resident.generation}/${randomUUID()}`;
          proxyUrls.set(target, `${proxyBase}${path}`);
          callbacks.set(path, { resident, target });
        }
        residents.set(key, resident);
        stampPeaks();
        yield* Effect.gen(function* () {
          const child = yield* startWorkerd({
            callbackUrls: [...proxyUrls.values()],
            separateUid: true
          }).pipe(Effect.provideService(Scope.Scope, resident.scope));
          resident.process = child;
          resident.lastHealthy = Date.now();
          resident.engine = yield* Engine.make({ url: child.url });
          yield* resident.engine.bind(bundle).pipe(Effect.raceFirst(Deferred.await(resident.dead)));
          yield* sample(resident);
          if (!resident.alive) return;
          resident.loading = false;
          resident.idleSince = Date.now();
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
          Effect.provideService(HttpClient.HttpClient, http),
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
      const { bindingEpoch: epoch, request } = yield* decodeInvoke(input).pipe(
        Effect.mapError(
          (cause) => new SupervisorError({ operation: "invoke", reason: "protocol", cause })
        )
      );
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
            const target = resident.proxyUrls.get(request.callback.url);
            if (target === undefined || resident.invocations.has(key))
              return yield* new SupervisorError({ operation: "invoke", reason: "protocol" });
            return { resident, engine: resident.engine, target };
          });
          const selected = yield* select;
          const blockedBy = yield* evict(0, selected.resident);
          // Reaping an idle sibling yields. Recheck the target and its authority before dispatch.
          const { resident, engine, target } = yield* select;
          if (blockedBy !== undefined)
            return yield* new SupervisorError({
              operation: "invoke",
              reason: "busy",
              limit: limitRefusal(blockedBy, limit(blockedBy))
            });
          const result = yield* Deferred.make<GuestProtocol.InvokeReply, SupervisorError>();
          const attempt: GuestProtocol.Attempt = {
            invocationId: request.invocationId,
            attemptId: request.attemptId,
            processGeneration: resident.generation,
            deadline: request.deadline
          };
          resident.invocations.set(key, {
            attempt,
            epoch,
            capability: request.callback.capability,
            target: request.callback.url,
            result
          });
          resident.callsServed++;
          let uncertain = false;
          // The supervisor owns dispatch. Losing the HTTP caller must not erase a running deadline.
          yield* engine.invoke({ ...request, callback: { ...request.callback, url: target } }).pipe(
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
      yield* checkEpoch(request.bindingEpoch, "stop");
      if (request.processGeneration === undefined) {
        stopped = true;
        for (const resident of residents.values()) yield* terminate(resident, "stopped");
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
    })
  });
});

export const layer = (options: Options) => Layer.effect(Supervisor, make(options));
