import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import {
  RuntimePrincipal,
  RuntimeStreamFrame,
  RuntimeStreamRequest,
  RuntimeSubscriptionRequest,
  WIRE_VERSION
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { newInternalId } from "@patchy/core";
import { ContractLimits, Limits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import * as StreamAdmission from "./StreamAdmission.js";
import * as Binding from "./Binding.js";
import * as StreamLimits from "./StreamLimits.js";
import * as Subscriptions from "./Subscriptions.js";
import * as Wakes from "./Wakes.js";
import * as SubscriptionReads from "./SubscriptionReads.js";

const decodeRequest = Schema.decodeUnknownEffect(RuntimeStreamRequest);
const decodeSubscriptionRequest = Schema.decodeUnknownEffect(RuntimeSubscriptionRequest);
const decodePrincipal = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimePrincipal), {
  onExcessProperty: "error"
});
const encodeFrame = Schema.encodeSync(Schema.fromJsonString(RuntimeStreamFrame));
const encoder = new TextEncoder();

export class StreamReplaced extends Schema.TaggedError<StreamReplaced>()("StreamReplaced", {}) {
  readonly code = "invalid_request" as const;
  readonly status = 409;
  override get message() {
    return "The stream generation has been replaced.";
  }
}
export class StreamLimit extends Schema.TaggedError<StreamLimit>()("StreamLimit", {
  value: Schema.Number
}) {
  readonly code = "limit_exceeded" as const;
  readonly status = 429;
  readonly scope = "viewer" as const;
  readonly limitId = "stream.documents";
  readonly retryAfterSeconds = 1;
  override get message() {
    return "The viewer has too many open documents for this patch.";
  }
}

export class DirectSubscriptionRequired extends Schema.TaggedError<DirectSubscriptionRequired>()(
  "DirectSubscriptionRequired",
  { loadedTier: Schema.Int, servedTier: Schema.Int }
) {
  readonly code = "server_required" as const;
  readonly status = 403;
  override get message() {
    return "Direct subscriptions require a tier 1 document.";
  }
}

type Entry = {
  readonly companyId: string;
  readonly patchId: string;
  readonly versionId: string;
  readonly viewerId: string;
  readonly generation: string;
  lastServed: { readonly versionId: string; readonly tier: number } | undefined;
  readonly recheck: Effect.Effect<void, Runtime.RuntimeError>;
  readonly subscriptions: Subscriptions.DocumentSubscriptions;
  readonly send: (frame: RuntimeStreamFrame) => void;
  readonly close: (reason: string, frame?: RuntimeStreamFrame) => void;
};

/** Request admission and stream lifetime use the HTTP request's scope.
 * @effect-expect-leaking HttpServerRequest
 */
export class RuntimeStream extends Context.Service<
  RuntimeStream,
  {
    readonly open: (
      input: unknown
    ) => Effect.Effect<
      Stream.Stream<Uint8Array>,
      Runtime.RuntimeError | StreamReplaced | StreamLimit,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >;
    readonly update: (
      input: unknown
    ) => Effect.Effect<
      void,
      Runtime.RuntimeError | StreamReplaced,
      HttpServerRequest.HttpServerRequest
    >;
    readonly notify: (patchId: string) => Effect.Effect<void>;
    readonly connected: (companyId: string, patchId?: string) => Effect.Effect<number>;
    readonly drain: Effect.Effect<void>;
  }
>()("@patchy/runtime/RuntimeStream") {}

type Dependencies =
  | StreamAdmission.StreamAdmission
  | LoadedVersions.LoadedVersions
  | Limits.Limits
  | WideEvents.WideEvents
  | StreamLimits.StreamLimits
  | Wakes.Wakes
  | SubscriptionReads.SubscriptionReads;

export const make: Effect.Effect<RuntimeStream["Service"], never, Dependencies | Scope.Scope> =
  Effect.gen(function* () {
    const admission = yield* StreamAdmission.StreamAdmission;
    const versions = yield* LoadedVersions.LoadedVersions;
    const events = yield* WideEvents.WideEvents;
    const limits = yield* Limits.Limits;
    const callsPerMinute = yield* ContractLimits.get("runtime.calls.perMinute");
    const documentLimit = yield* ContractLimits.get("stream.documents");
    const operatingLimits = yield* StreamLimits.StreamLimits;
    const subscriptions = yield* Subscriptions.make;
    const rootScope = yield* Scope.Scope;
    const context = yield* Effect.context<never>();
    const wakes = yield* Wakes.Wakes;
    const entries = new Map<string, Entry>();
    const companies = new Map<string, number>();
    const patches = new Map<string, number>();
    const viewers = new Map<string, number>();
    let draining = false;
    const lifecycle = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
    const withPatch = (patchId: string, effect: Effect.Effect<void>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          let gate = lifecycle.get(patchId);
          if (gate === undefined) {
            gate = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
            lifecycle.set(patchId, gate);
          }
          gate.users++;
          return gate;
        }),
        (gate) => gate.semaphore.withPermits(1)(effect),
        (gate) =>
          Effect.sync(() => {
            if (--gate.users === 0) lifecycle.delete(patchId);
          })
      );
    const adjust = (map: Map<string, number>, key: string, delta: number) => {
      const count = (map.get(key) ?? 0) + delta;
      if (count === 0) map.delete(key);
      else map.set(key, count);
    };
    const drain = Effect.sync(() => {
      draining = true;
      for (const entry of entries.values()) entry.close("draining");
    });
    yield* Effect.addFinalizer(() => drain);

    // Commit callbacks can arrive out of order. Read authority while holding the same
    // gate as the initial snapshot, so an older read cannot follow a newer frame.
    const refresh = (patchId: string, targets: readonly Entry[], recheck = true) =>
      Effect.gen(function* () {
        if (targets.length === 0) return;
        const served = yield* versions.find(patchId);
        const retained = new Map<string, Option.Option<LoadedVersions.LoadedVersion>>();
        if (Option.isSome(served)) retained.set(served.value.versionId, served);
        for (const entry of targets) {
          if (recheck) {
            const allowed = yield* entry.recheck.pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.sync(() => {
                  if (error.code === "session_refresh_required") entry.close("reauthenticate");
                  else if (error.code === "session_expired")
                    entry.close(error.code, { type: "session_expired" });
                  else if (error.code === "principal_changed")
                    entry.close(error.code, { type: "principal_changed" });
                  else if (error.code === "source_unavailable") entry.close(error.code);
                  else entry.close("access_denied", { type: "access_denied" });
                  return false;
                })
              )
            );
            if (!allowed) continue;
          }
          if (Option.isNone(served) || served.value.companyId !== entry.companyId) {
            entry.close("access_denied", { type: "access_denied" });
            continue;
          }
          let eligible = retained.get(entry.versionId);
          if (eligible === undefined) {
            eligible = yield* versions.find(patchId, entry.versionId);
            retained.set(entry.versionId, eligible);
          }
          if (Option.isNone(eligible) || eligible.value.companyId !== entry.companyId) {
            entry.close("access_denied", { type: "access_denied" });
          } else if (
            entry.lastServed?.versionId !== served.value.versionId ||
            entry.lastServed?.tier !== served.value.manifest.tier
          ) {
            entry.lastServed = {
              versionId: served.value.versionId,
              tier: served.value.manifest.tier
            };
            entry.send({
              type: "served",
              versionId: served.value.versionId,
              tier: served.value.manifest.tier
            });
          }
        }
      }).pipe(
        // A failed lookup must not fail the publish that already committed. EOF
        // releases presence and lets the browser retry admission against authority.
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError(new Runtime.SourceUnavailable({ cause }));
            for (const entry of targets) entry.close("source_unavailable");
          })
        )
      );

    const open = Effect.fn("RuntimeStream.open")(function* (unknownInput: unknown) {
      if (draining) return yield* new Runtime.Draining();
      const input = yield* decodeRequest(unknownInput).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.headers.authorization !== undefined ||
        request.headers["sec-fetch-site"] !== "same-origin"
      )
        return yield* new Runtime.AccessDenied({});
      const wire = yield* Runtime.decodeWire(request.headers["x-patchy-wire"]).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const principal = yield* decodePrincipal(request.headers["x-patchy-principal"]).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const identity = yield* admission.admit;
      if (principal === null || principal.userId !== identity.viewerId)
        return yield* new Runtime.PrincipalChanged({});
      const find = (versionId?: string) =>
        versions
          .find(input.patchId, versionId)
          .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
      const found = yield* find(input.versionId);
      if (Option.isNone(found) || found.value.companyId !== identity.companyId)
        return yield* new Runtime.AccessDenied({});
      const loaded = found.value;
      const { buffer } = yield* operatingLimits.getMany({
        companyId: identity.companyId,
        limits: { buffer: "stream.buffer.bytes" }
      });
      const bufferLimit = buffer.value;
      if (wire !== WIRE_VERSION || wire !== loaded.wireVersion)
        return yield* new Runtime.ShellOutdated({});
      const queue = yield* Queue.make<Uint8Array, Cause.Done>();
      const done = yield* Deferred.make<void>();
      const scope = yield* Scope.Scope;
      const now = yield* Clock.currentTimeMillis;
      const key = `${identity.companyId}:${input.patchId}:${input.documentId}`;
      const viewerKey = `${identity.companyId}:${input.patchId}:${identity.viewerId}`;
      const patchKey = `${identity.companyId}:${input.patchId}`;
      const generation = newInternalId("stream");
      let binding: Binding.Binding["Service"] = {
        ...loaded,
        principal,
        identity: identity.identity,
        correlationId: generation
      };
      let servedTier = loaded.patchTier;
      const recheck = Effect.gen(function* () {
        const current = yield* identity.recheck;
        if (current.companyId !== identity.companyId) return yield* new Runtime.AccessDenied({});
        if (current.viewerId !== identity.viewerId) return yield* new Runtime.PrincipalChanged({});
        binding = { ...binding, identity: current.identity };
      });
      const hello = encoder.encode(
        `data: ${encodeFrame({ type: "hello", generation, serverTime: now })}\n\n`
      );
      let opening = true;
      let buffered = hello.byteLength;
      let peakBuffered = buffered;
      let bytes = 0;
      let closeReason: string | undefined;
      const put = (frame: RuntimeStreamFrame) => {
        const chunk = encoder.encode(`data: ${encodeFrame(frame)}\n\n`);
        if (buffered + chunk.byteLength > bufferLimit) return false;
        buffered += chunk.byteLength;
        peakBuffered = Math.max(peakBuffered, buffered);
        Queue.offerUnsafe(queue, chunk);
        return true;
      };
      const close = (reason: string, frame?: RuntimeStreamFrame) => {
        if (closeReason !== undefined) return;
        closeReason = reason;
        documentSubscriptions.close();
        // Drop stale queued updates so the terminal reason is always next, even at capacity.
        while (Queue.takeUnsafe(queue) !== undefined) {
          /* discard pending frames */
        }
        buffered = opening ? hello.byteLength : 0;
        if (frame !== undefined) put(frame);
        Queue.endUnsafe(queue);
        if (entries.get(key) === entry) {
          entries.delete(key);
          adjust(companies, identity.companyId, -1);
          adjust(patches, patchKey, -1);
          adjust(viewers, viewerKey, -1);
        }
      };
      const documentSubscriptions = subscriptions.attach({
        generation,
        binding: () => binding,
        scope,
        send: (frame: RuntimeStreamFrame) => entry.send(frame),
        check: Effect.gen(function* () {
          yield* recheck;
          const eligible = yield* find(input.versionId);
          if (Option.isNone(eligible) || eligible.value.companyId !== identity.companyId)
            return yield* new Runtime.AccessDenied({});
          binding = { ...binding, ...eligible.value };
          servedTier = eligible.value.patchTier;
          if (eligible.value.scope === "public") return yield* new Runtime.PublicUnavailable({});
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.code === "session_refresh_required") close("reauthenticate");
              else if (error.code === "session_expired")
                close(error.code, { type: "session_expired" });
              else if (error.code === "principal_changed")
                close(error.code, { type: "principal_changed" });
              else if (error.code === "access_denied") close(error.code, { type: "access_denied" });
            })
          )
        ),
        checkOperation: (op) =>
          Effect.gen(function* () {
            if (op === "server.call" && loaded.manifest.tier === 2) return;
            if (op === "server.call" || loaded.manifest.tier !== 1 || servedTier !== 1)
              return yield* new DirectSubscriptionRequired({
                loadedTier: loaded.manifest.tier,
                servedTier
              });
          })
      });
      const entry: Entry = {
        companyId: identity.companyId,
        patchId: input.patchId,
        versionId: input.versionId,
        viewerId: identity.viewerId,
        generation,
        lastServed: undefined,
        recheck,
        subscriptions: documentSubscriptions,
        close,
        send: (frame) => {
          if (closeReason !== undefined) return;
          if (!put(frame)) close("slow_consumer", { type: "closed", reason: "slow_consumer" });
        }
      };
      const disconnect = Effect.sync(() => {
        close("disconnected");
        Deferred.doneUnsafe(done, Effect.void);
      });
      yield* Effect.acquireRelease(
        Effect.suspend(
          (): Effect.Effect<void, Runtime.RuntimeError | StreamReplaced | StreamLimit> => {
            const previous = entries.get(key);
            if (draining) return Effect.fail(new Runtime.Draining());
            if (
              previous !== undefined &&
              (previous.viewerId !== identity.viewerId ||
                previous.versionId !== input.versionId ||
                previous.generation !== request.headers["x-patchy-generation"])
            )
              return Effect.fail(new StreamReplaced());
            if (previous === undefined && (viewers.get(viewerKey) ?? 0) >= documentLimit)
              return Effect.fail(new StreamLimit({ value: documentLimit }));
            previous?.close("replaced", { type: "closed", reason: "replaced" });
            entries.set(key, entry);
            adjust(companies, identity.companyId, 1);
            adjust(patches, patchKey, 1);
            adjust(viewers, viewerKey, 1);
            return Effect.void;
          }
        ),
        () => disconnect
      ).pipe(Effect.onError(() => disconnect));
      const admittedDocuments = viewers.get(viewerKey)!;
      yield* events
        .withEvent(
          {
            type: "stream",
            eventId: generation,
            companyId: identity.companyId,
            patchId: input.patchId,
            versionId: input.versionId,
            viewerId: identity.viewerId,
            tier: loaded.manifest.tier
          },
          Deferred.await(done).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                WideEvents.enrich({
                  ...documentSubscriptions.metrics(),
                  bytes,
                  closeReason: closeReason ?? "disconnected",
                  limits: [
                    {
                      limitId: "stream.documents",
                      value: documentLimit,
                      peak: admittedDocuments,
                      configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
                    },
                    {
                      limitId: "stream.buffer.bytes",
                      value: bufferLimit,
                      peak: peakBuffered,
                      configRevision: buffer.configRevision
                    }
                  ]
                })
              )
            )
          )
        )
        .pipe(Effect.forkIn(scope, { startImmediately: true }));
      yield* withPatch(
        input.patchId,
        Effect.suspend(() =>
          closeReason === undefined ? refresh(input.patchId, [entry], false) : Effect.void
        )
      );
      yield* Effect.gen(function* () {
        while (closeReason === undefined) {
          const interval = yield* operatingLimits
            .getMany({
              companyId: identity.companyId,
              limits: { interval: "subscriptions.reconcile.interval" }
            })
            .pipe(
              Effect.map((limits) => limits.interval.value),
              Effect.catch(() =>
                Effect.succeed(registry["subscriptions.reconcile.interval"].default)
              )
            );
          yield* Effect.sleep(interval);
          if (closeReason !== undefined) return;
          yield* withPatch(input.patchId, refresh(input.patchId, [entry]));
          if (closeReason === undefined) yield* documentSubscriptions.reconcile();
        }
      }).pipe(Effect.forkIn(scope));
      yield* Effect.gen(function* () {
        if (!Number.isFinite(identity.expiresAt)) return;
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(0, identity.expiresAt - now));
        close("reauthenticate");
      }).pipe(Effect.forkIn(scope, { startImmediately: true }));
      return Stream.fromPull(
        Effect.succeed(
          Effect.suspend(() => {
            if (opening) {
              opening = false;
              buffered -= hello.byteLength;
              bytes += hello.byteLength;
              return Effect.succeed([hello] as const);
            }
            return Effect.map(Queue.take(queue), (chunk) => {
              buffered -= chunk.byteLength;
              bytes += chunk.byteLength;
              return [chunk] as const;
            });
          })
        )
      ).pipe(Stream.ensuring(disconnect));
    });
    // Notification delivery must not wait for a document's durable authority lookup.
    const lifecycleWorkers = new Map<string, { pending: boolean }>();
    const wake = Effect.fnUntraced(
      function* (keys: readonly string[], cause?: string) {
        const patches = new Set<string>();
        for (const entry of entries.values()) {
          yield* entry.subscriptions.reconcile(keys, cause);
          if (keys.length === 0 || keys.includes(`patch:${entry.patchId}`))
            patches.add(entry.patchId);
        }
        for (const patchId of patches) {
          const previous = lifecycleWorkers.get(patchId);
          if (previous !== undefined) {
            previous.pending = true;
            continue;
          }
          const worker = { pending: true };
          lifecycleWorkers.set(patchId, worker);
          yield* Effect.gen(function* () {
            while (worker.pending) {
              worker.pending = false;
              yield* withPatch(
                patchId,
                Effect.suspend(() =>
                  refresh(
                    patchId,
                    [...entries.values()].filter((entry) => entry.patchId === patchId)
                  )
                )
              );
            }
            lifecycleWorkers.delete(patchId);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (lifecycleWorkers.get(patchId) === worker) lifecycleWorkers.delete(patchId);
              })
            ),
            Effect.forkIn(rootScope)
          );
        }
      },
      Effect.updateContext<never, never>(() => context)
    );
    yield* wakes.subscribe(wake);
    const update = Effect.fn("RuntimeStream.update")(function* (unknownInput: unknown) {
      if (draining) return yield* new Runtime.Draining();
      const input = yield* decodeSubscriptionRequest(unknownInput).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.headers.authorization !== undefined ||
        request.headers["sec-fetch-site"] !== "same-origin"
      )
        return yield* new Runtime.AccessDenied({});
      const wire = yield* Runtime.decodeWire(request.headers["x-patchy-wire"]).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      if (wire !== WIRE_VERSION) return yield* new Runtime.ShellOutdated({});
      const principal = yield* decodePrincipal(request.headers["x-patchy-principal"]).pipe(
        Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
      );
      const identity = yield* admission.admit;
      if (principal === null || principal.userId !== identity.viewerId)
        return yield* new Runtime.PrincipalChanged({});
      const key = `${identity.companyId}:${input.patchId}:${input.documentId}`;
      const entry = entries.get(key);
      if (
        entry === undefined ||
        entry.generation !== input.generation ||
        entry.viewerId !== identity.viewerId ||
        entry.versionId !== input.versionId
      )
        return yield* new StreamReplaced();
      // Share the call budget across documents and generations for this viewer and patch.
      const attempt = yield* limits.consume({
        key: `runtime:${identity.viewerId}:${input.patchId}`,
        limit: callsPerMinute,
        window: "1 minute"
      });
      if (!attempt.allowed)
        return yield* new Runtime.RateLimited({
          retryAfterSeconds: attempt.retryAfterSeconds,
          limitId: attempt.reason === "capacity" ? "rate.trackedKeys" : "runtime.calls.perMinute",
          value: attempt.reason === "capacity" ? Limits.MAX_TRACKED_KEYS : callsPerMinute
        });
      yield* entry.subscriptions.update(input);
    });
    return RuntimeStream.of({
      open,
      update,
      notify: (patchId) =>
        withPatch(
          patchId,
          Effect.gen(function* () {
            const targets: Entry[] = [];
            for (const entry of entries.values()) {
              if (entry.patchId === patchId) targets.push(entry);
            }
            yield* refresh(patchId, targets);
          })
        ),
      connected: (companyId, patchId) =>
        Effect.sync(() =>
          patchId === undefined
            ? (companies.get(companyId) ?? 0)
            : (patches.get(`${companyId}:${patchId}`) ?? 0)
        ),
      drain
    });
  });

export const layer: Layer.Layer<RuntimeStream, never, Dependencies> = Layer.effect(
  RuntimeStream,
  make
);
