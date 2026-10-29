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
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import {
  RuntimePrincipal,
  runtimePrincipal,
  sameRuntimePrincipal,
  RuntimeStreamFrame,
  RuntimeStreamRequest,
  RuntimeSubscriptionRequest,
  handlerKinds,
  isMemberOperation,
  type HandlerKind,
  WIRE_VERSION
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { newInternalId } from "@patchy/core";
import { ContractLimits, Limits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import * as ConnectedVersions from "./ConnectedVersions.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as ExecutionLifecycle from "./ExecutionLifecycle.js";
import * as Runtime from "./Runtime.js";
import * as StreamAdmission from "./StreamAdmission.js";
import * as Binding from "./Binding.js";
import * as StreamLimits from "./StreamLimits.js";
import * as Subscriptions from "./Subscriptions.js";
import * as Wakes from "./Wakes.js";

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

/** One warm-hold owner, compared by identity. */
interface Owner {
  /** The window passed with no activity, so this owner let go because its document went idle. */
  idle: boolean;
}

/**
 * What a host keeps of a tier 2 document beside the fleet, across its stream generations: when
 * its viewer was last active, the logical desired set it last admitted, and the one owner of its
 * warm holds, the company task and the version's process, while it is active. Bound to the
 * viewer and version it was admitted for.
 */
interface Activity {
  readonly viewerId: string;
  readonly versionId: string;
  desired: string | undefined;
  lastActive: number;
  /** The connected generation; unset while the record waits among the disconnected. */
  entry: Entry | undefined;
  owner: Owner | undefined;
  detachedAt: number;
}

type Entry = {
  readonly companyId: string;
  readonly patchId: string;
  readonly versionId: string;
  readonly viewerId: string;
  readonly generation: string;
  lastServed: { readonly versionId: string; readonly tier: number } | undefined;
  lastHandlerKinds: Readonly<Record<string, HandlerKind>> | undefined;
  /** Set once admitted, for a tier 2 document beside the fleet. */
  activity: Activity | undefined;
  readonly recheck: Effect.Effect<void, Runtime.RuntimeError>;
  readonly subscriptions: Subscriptions.DocumentSubscriptions;
  readonly send: (frame: RuntimeStreamFrame) => void;
  readonly close: (reason: string, frame?: RuntimeStreamFrame) => void;
  /**
   * Marks the document active at `now` in one step, for its record's current generation, and
   * returns the background re-hold to start if it was idle.
   */
  readonly activate: (now: number) => Effect.Effect<void>;
};

/** A host forgets the longest-disconnected documents past 4096, and any after an hour. */
export const ActivityRecords = Context.Reference<{
  readonly capacity: number;
  readonly retention: number;
}>("@patchy/runtime/RuntimeStream/ActivityRecords", {
  defaultValue: () => ({ capacity: 4096, retention: 60 * 60_000 })
});

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
    /**
     * Marks the viewer's connected documents of the version on this host active, for a
     * `server.call` Runtime admitted from that viewer.
     */
    readonly called: (call: {
      readonly companyId: string;
      readonly patchId: string;
      readonly versionId: string;
      readonly viewerId: string;
    }) => Effect.Effect<void>;
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
  | Subscriptions.Subscriptions;

export const make: Effect.Effect<RuntimeStream["Service"], never, Dependencies | Scope.Scope> =
  Effect.gen(function* () {
    const admission = yield* StreamAdmission.StreamAdmission;
    const executionLifecycle = yield* Effect.serviceOption(ExecutionLifecycle.ExecutionLifecycle);
    const connectedVersions = yield* Effect.serviceOption(ConnectedVersions.ConnectedVersions);
    const versions = yield* LoadedVersions.LoadedVersions;
    const events = yield* WideEvents.WideEvents;
    const limits = yield* Limits.Limits;
    const callsPerMinute = yield* ContractLimits.get("runtime.calls.perMinute");
    const documentLimit = yield* ContractLimits.get("stream.documents");
    const records = yield* ActivityRecords;
    const clock = yield* Clock.Clock;
    const operatingLimits = yield* StreamLimits.StreamLimits;
    const subscriptions = yield* Subscriptions.Subscriptions;
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
    // Activity records by document key. A connected document keeps its record; the disconnected
    // wait in `detached`, longest gone first, until the bound or retention forgets them.
    const activities = new Map<string, Activity>();
    const detached = new Map<string, Activity>();
    const forget = (now: number) => {
      for (const [key, activity] of detached) {
        if (detached.size <= records.capacity && activity.detachedAt + records.retention > now)
          return;
        detached.delete(key);
        if (activities.get(key) === activity) activities.delete(key);
      }
    };
    /**
     * The admitted document's record, which its first stream marks active. A document this host
     * does not remember, or remembers for another viewer or version, starts active.
     */
    const attach = (key: string, entry: Entry, first: boolean): Activity => {
      const now = clock.currentTimeMillisUnsafe();
      forget(now);
      detached.delete(key);
      let activity = activities.get(key);
      if (
        activity === undefined ||
        activity.viewerId !== entry.viewerId ||
        activity.versionId !== entry.versionId
      ) {
        activity = {
          viewerId: entry.viewerId,
          versionId: entry.versionId,
          desired: undefined,
          lastActive: now,
          entry,
          owner: undefined,
          detachedAt: now
        };
        activities.set(key, activity);
      } else if (first) activity.lastActive = now;
      activity.entry = entry;
      return activity;
    };
    /**
     * Marks a document active for its viewer's call or set change. It lands on whichever
     * generation is connected when it runs, so a replacement meanwhile doesn't lose it; a
     * document that disconnected meanwhile keeps none.
     */
    const activate = (activity: Activity) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.suspend(() => activity.entry?.activate(now) ?? Effect.void)
      );
    const detach = (key: string, activity: Activity) => {
      activity.entry = undefined;
      activity.owner = undefined;
      activity.detachedAt = clock.currentTimeMillisUnsafe();
      detached.delete(key);
      detached.set(key, activity);
      forget(activity.detachedAt);
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
            continue;
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
          // Rebinding updates this registry synchronously. A lookup begun before a
          // swap must not overwrite the newer kinds already delivered to the document.
          const kinds =
            subscriptions.handlerKinds(patchId) ??
            (eligible.value.executionVersionId === undefined
              ? undefined
              : handlerKinds(eligible.value.manifest.handlers));
          if (kinds !== undefined && entry.lastHandlerKinds !== kinds)
            entry.send({ type: "handlers", kinds });
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
      const find = (versionId?: string) =>
        versions
          .find(input.patchId, versionId)
          .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
      const found = yield* find(input.versionId);
      if (Option.isNone(found)) return yield* new Runtime.AccessDenied({});
      const identity = yield* principal !== null && "guestId" in principal
        ? (admission.forVersion?.(found.value) ?? admission.admit)
        : admission.admit;
      if (
        principal === null ||
        !sameRuntimePrincipal(principal, runtimePrincipal(identity.identity))
      )
        return yield* new Runtime.PrincipalChanged({});
      if (found.value.companyId !== identity.companyId) return yield* new Runtime.AccessDenied({});
      const loaded = found.value;
      const { buffer, idle } = yield* operatingLimits.getMany({
        companyId: identity.companyId,
        limits: { buffer: "stream.buffer.bytes", idle: "execution.document.idle" }
      });
      const bufferLimit = buffer.value;
      // Only a tier 2 document beside the fleet holds a company task, so only it keeps activity.
      const execution =
        loaded.manifest.tier === 2 ? Option.getOrUndefined(executionLifecycle) : undefined;
      if (wire !== WIRE_VERSION || wire !== loaded.wireVersion)
        return yield* new Runtime.ShellOutdated({});
      const queue = yield* Queue.make<Uint8Array, Cause.Done>();
      const done = yield* Deferred.make<void>();
      const lifecycleClosed = yield* Deferred.make<void>();
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
        if (!sameRuntimePrincipal(runtimePrincipal(current.identity), principal))
          return yield* new Runtime.PrincipalChanged({});
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
      let executionReady = loaded.manifest.tier !== 2;
      // Whether the generation has decided how it starts; activity before then only counts.
      let started = false;
      let idled = 0;
      let reactivated = 0;
      // The longest stretch without activity this generation saw, the window's peak.
      let quietest = 0;
      const desired: Subscriptions.Desired = { value: undefined };
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
        Deferred.doneUnsafe(lifecycleClosed, Effect.void);
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
        // Leaving, by disconnect, replacement or hidden suspension, lets the warm holds go at
        // once; the record keeps only what the next generation compares against.
        if (entry.activity?.entry === entry) {
          entry.activity.desired = desired.value;
          detach(key, entry.activity);
        }
      };
      const documentSubscriptions = subscriptions.attach({
        generation,
        documentId: input.documentId,
        binding: () => binding,
        scope,
        ready: () => executionReady,
        desired,
        send: (frame: RuntimeStreamFrame) => entry.send(frame),
        check: Effect.gen(function* () {
          yield* recheck;
          const eligible = yield* find(input.versionId);
          if (Option.isNone(eligible) || eligible.value.companyId !== identity.companyId)
            return yield* new Runtime.AccessDenied({});
          binding = { ...binding, ...eligible.value };
          servedTier = eligible.value.patchTier;
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
            if (!Binding.allowsOperation(binding, op)) return yield* new Runtime.AccessDenied({});
            if (binding.scope === "public" && !isMemberOperation(op))
              return yield* new Runtime.PublicUnavailable({});
            if (op === "server.call" && loaded.manifest.tier === 2) return;
            if (op === "server.call" || loaded.manifest.tier !== 1 || servedTier !== 1)
              return yield* new DirectSubscriptionRequired({
                loadedTier: loaded.manifest.tier,
                servedTier
              });
          })
      });
      // Ends once the window passes with no activity, letting go of the owner in the same step,
      // so an activity after it re-holds instead of finding an owner on its way out.
      const untilIdle = (activity: Activity, owner: Owner) =>
        Effect.gen(function* () {
          while (true) {
            const now = yield* Clock.currentTimeMillis;
            const remaining = activity.lastActive + idle.value - now;
            if (remaining <= 0) break;
            yield* Effect.sleep(remaining);
          }
          // An owner already let go ends with its generation, as a document that left.
          if (activity.owner !== owner) return yield* Effect.never;
          owner.idle = true;
          activity.owner = undefined;
          idled++;
        });
      /**
       * Holds the company task and keeps the version warm for one owner, until the window passes
       * with no activity or the generation ends. The generation's startup hold settles held
       * calls with `ready` or `start_failed`; a background re-hold sends nothing, warms nothing,
       * and on failure leaves the next activity to retry.
       */
      const hold = (
        fleet: ExecutionLifecycle.ExecutionLifecycle["Service"],
        activity: Activity,
        owner: Owner,
        startup: boolean
      ) =>
        Effect.gen(function* () {
          const { wait } = yield* operatingLimits.getMany({
            companyId: identity.companyId,
            limits: { wait: "execution.pool.wait" }
          });
          yield* fleet.connect(identity.companyId).pipe(
            Effect.timeoutOption(wait.value),
            Effect.flatMap((connected) =>
              Option.isSome(connected)
                ? Effect.void
                : Effect.fail(
                    new ExecutionLifecycle.LifecycleError({
                      code: "busy",
                      status: 503,
                      retryAfterSeconds: 1,
                      limitId: "execution.pool.wait",
                      scope: "company",
                      value: wait.value
                    })
                  )
            )
          );
          if (closeReason !== undefined) return;
          if (startup) {
            executionReady = true;
            entry.send({ type: "ready" });
          }
          // The version loads while the client boots. A reconnect, reauthentication or resume
          // names its previous generation and only keeps the version warm, as does a document
          // that comes back from idle: a document warms once, so its renewals never reload a
          // version evicted under pressure.
          if (Option.isSome(connectedVersions))
            yield* connectedVersions.value.connect(loaded, {
              warm: startup && request.headers["x-patchy-generation"] === undefined,
              idle: () => owner.idle
            });
          if (startup) yield* documentSubscriptions.reconcile("ready");
          return yield* Effect.never;
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              if (startup && closeReason === undefined)
                entry.send({
                  type: "start_failed",
                  code: "busy",
                  retryAfter: "retryAfterSeconds" in error ? (error.retryAfterSeconds ?? 1) : 1,
                  ...("scope" in error && error.scope !== undefined ? { scope: error.scope } : {}),
                  ...("limitId" in error && error.limitId !== undefined
                    ? { limitId: error.limitId }
                    : {}),
                  ...("value" in error && error.value !== undefined ? { value: error.value } : {})
                });
            })
          ),
          Effect.raceFirst(untilIdle(activity, owner)),
          Effect.raceFirst(Deferred.await(lifecycleClosed)),
          Effect.scoped,
          Effect.ensuring(
            Effect.suspend(() => {
              if (activity.owner === owner) activity.owner = undefined;
              // A startup the window outlasted still settles held calls: an idle document is ready.
              if (!owner.idle || executionReady || closeReason !== undefined) return Effect.void;
              executionReady = true;
              entry.send({ type: "ready" });
              return documentSubscriptions.reconcile("ready");
            })
          ),
          Effect.forkIn(scope),
          Effect.asVoid
        );
      const entry: Entry = {
        companyId: identity.companyId,
        patchId: input.patchId,
        versionId: input.versionId,
        viewerId: identity.viewerId,
        generation,
        lastServed: undefined,
        lastHandlerKinds: undefined,
        activity: undefined,
        recheck,
        subscriptions: documentSubscriptions,
        close,
        send: (frame) => {
          if (closeReason !== undefined) return;
          if (frame.type === "handlers") entry.lastHandlerKinds = frame.kinds;
          if (!put(frame)) close("slow_consumer", { type: "closed", reason: "slow_consumer" });
        },
        activate: (now) => {
          const activity = entry.activity;
          if (execution === undefined || activity?.entry !== entry) return Effect.void;
          quietest = Math.max(quietest, now - activity.lastActive);
          activity.lastActive = Math.max(activity.lastActive, now);
          if (!started || activity.owner !== undefined) return Effect.void;
          const owner: Owner = { idle: false };
          activity.owner = owner;
          reactivated++;
          return hold(execution, activity, owner, false);
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
            if (execution !== undefined) {
              entry.activity = attach(
                key,
                entry,
                request.headers["x-patchy-generation"] === undefined
              );
              desired.value = entry.activity.desired;
            }
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
            ...("guest" in identity.identity
              ? { guestId: identity.identity.guest.id, grantId: identity.identity.grantId }
              : {}),
            tier: loaded.manifest.tier,
            documentId: input.documentId
          },
          Deferred.await(done).pipe(
            Effect.ensuring(
              Effect.flatMap(Clock.currentTimeMillis, (now) => {
                // Closed before its totals are read, so a check settling later reports itself.
                close("disconnected");
                const activity = entry.activity;
                return WideEvents.enrich({
                  ...documentSubscriptions.metrics(),
                  bytes,
                  closeReason: closeReason ?? "disconnected",
                  ...(activity === undefined ? {} : { idled, reactivated }),
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
                    },
                    ...(activity === undefined
                      ? []
                      : [
                          {
                            limitId: "execution.document.idle",
                            value: idle.value,
                            peak: Math.max(quietest, now - activity.lastActive),
                            configRevision: idle.configRevision
                          }
                        ])
                  ]
                });
              })
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
      if (loaded.manifest.tier === 2 && closeReason === undefined) {
        const decidedAt = yield* Clock.currentTimeMillis;
        yield* Effect.suspend(() => {
          started = true;
          const activity = entry.activity;
          if (closeReason !== undefined) return Effect.void;
          if (execution !== undefined && activity !== undefined) {
            // An active document binds its company and keeps its version warm before `ready`.
            if (activity.lastActive + idle.value > decidedAt) {
              const owner: Owner = { idle: false };
              activity.owner = owner;
              entry.send({ type: "starting" });
              return hold(execution, activity, owner, true);
            }
            // An idle document's reconnect opens dispatch without binding its company or warming.
            executionReady = true;
            entry.send({ type: "ready" });
            return documentSubscriptions
              .reconcile("ready")
              .pipe(Effect.forkIn(scope), Effect.asVoid);
          }
          executionReady = true;
          entry.send({ type: "ready" });
          return Effect.void;
        });
      }
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
          if (closeReason === undefined) yield* documentSubscriptions.reconcile("periodic");
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
          yield* entry.subscriptions.reconcile("invalidation", keys, cause);
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
      const forVersion = admission.forVersion;
      const identity = yield* principal !== null &&
      "guestId" in principal &&
      forVersion !== undefined
        ? Effect.gen(function* () {
            const found = yield* versions
              .find(input.patchId, input.versionId)
              .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
            if (Option.isNone(found)) return yield* new Runtime.AccessDenied({});
            return yield* forVersion(found.value);
          })
        : admission.admit;
      if (
        principal === null ||
        !sameRuntimePrincipal(principal, runtimePrincipal(identity.identity))
      )
        return yield* new Runtime.PrincipalChanged({});
      const key = `${identity.companyId}:${input.patchId}:${input.documentId}`;
      const entry = entries.get(key);
      // Whether this host holds the document, and under which generation, tells a request
      // routed to the wrong replica from one naming a replaced stream. The patch and version
      // come from the admitted stream, never the request; a generation is kept only in
      // the form this host mints.
      yield* WideEvents.enrich({
        companyId: identity.companyId,
        viewerId: identity.viewerId,
        ...("guest" in identity.identity
          ? { guestId: identity.identity.guest.id, grantId: identity.identity.grantId }
          : {}),
        documentId: input.documentId,
        ...(/^stream_[a-z0-9]{24}$/.test(input.generation) ? { streamId: input.generation } : {}),
        subscriptionRequest: input.type,
        sequence: input.sequence,
        documentConnected: entry !== undefined,
        ...(entry === undefined
          ? {}
          : {
              patchId: entry.patchId,
              versionId: entry.versionId,
              currentStreamId: entry.generation
            })
      });
      if (
        entry === undefined ||
        entry.generation !== input.generation ||
        entry.viewerId !== identity.viewerId ||
        entry.versionId !== input.versionId
      ) {
        yield* WideEvents.enrich({ refusal: "stream_replaced" });
        return yield* new StreamReplaced();
      }
      yield* entry.recheck;
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
      // A change to the logical desired set is the viewer's activity; a repeat is not.
      if ((yield* entry.subscriptions.update(input)) && entry.activity !== undefined)
        yield* activate(entry.activity);
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
      called: (call) =>
        Effect.forEach(
          [...entries.values()].flatMap((entry) =>
            entry.activity !== undefined &&
            entry.companyId === call.companyId &&
            entry.patchId === call.patchId &&
            entry.versionId === call.versionId &&
            entry.viewerId === call.viewerId
              ? [entry.activity]
              : []
          ),
          activate,
          { discard: true }
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
