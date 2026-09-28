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
  WIRE_VERSION
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { newInternalId } from "@patchy/core";
import { ContractLimits, OperatingLimits } from "@patchy/limits";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import * as StreamAdmission from "./StreamAdmission.js";

const decodeRequest = Schema.decodeUnknownEffect(RuntimeStreamRequest);
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

type Entry = {
  readonly companyId: string;
  readonly patchId: string;
  readonly versionId: string;
  readonly viewerId: string;
  readonly generation: string;
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
      Runtime.RuntimeError,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >;
    readonly notify: (
      patchId: string,
      frame: RuntimeStreamFrame,
      versionId?: string
    ) => Effect.Effect<void>;
    readonly connected: (companyId: string, patchId?: string) => Effect.Effect<number>;
    readonly drain: Effect.Effect<void>;
  }
>()("@patchy/runtime/RuntimeStream") {}

type Dependencies =
  | Effect.Services<typeof StreamAdmission.make>
  | LoadedVersions.LoadedVersions
  | WideEvents.WideEvents
  | OperatingLimits.OperatingLimits;

export const make: Effect.Effect<RuntimeStream["Service"], never, Dependencies | Scope.Scope> =
  Effect.gen(function* () {
    const admission = yield* StreamAdmission.make;
    const versions = yield* LoadedVersions.LoadedVersions;
    const events = yield* WideEvents.WideEvents;
    const documentLimit = yield* ContractLimits.get("stream.documents");
    const operatingLimits = yield* OperatingLimits.OperatingLimits;
    const entries = new Map<string, Entry>();
    const companies = new Map<string, number>();
    const patches = new Map<string, number>();
    const viewers = new Map<string, number>();
    let draining = false;
    const lifecycle = yield* Semaphore.make(1);
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
    const refresh = (patchId: string, targets: readonly Entry[], announceServed: boolean) =>
      Effect.gen(function* () {
        if (targets.length === 0) return;
        const served = yield* versions.find(patchId);
        const retained = new Map<string, Option.Option<LoadedVersions.LoadedVersion>>();
        if (Option.isSome(served)) retained.set(served.value.versionId, served);
        for (const entry of targets) {
          if (Option.isNone(served) || served.value.companyId !== entry.companyId) {
            entry.close("access_denied", { type: "access_denied" });
            continue;
          }
          let eligible = retained.get(entry.versionId);
          if (eligible === undefined) {
            eligible = yield* versions.find(patchId, entry.versionId);
            retained.set(entry.versionId, eligible);
          }
          if (
            Option.isNone(eligible) ||
            eligible.value.companyId !== entry.companyId ||
            eligible.value.scope !== "company"
          ) {
            entry.close("access_denied", { type: "access_denied" });
          } else if (eligible.value.revoked) {
            entry.close("revoked", { type: "revoked" });
          } else if (announceServed) {
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
        Effect.catch(() =>
          Effect.sync(() => {
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
      const buffer = yield* operatingLimits
        .get({
          companyId: identity.companyId,
          limitId: "stream.buffer.bytes"
        })
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
      const bufferLimit = buffer.value;
      if (loaded.scope === "public") return yield* new Runtime.PublicUnavailable({});
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
      const entry: Entry = {
        companyId: identity.companyId,
        patchId: input.patchId,
        versionId: input.versionId,
        viewerId: identity.viewerId,
        generation,
        close,
        send: (frame) => {
          if (closeReason !== undefined) return;
          if (!put(frame)) close("slow_consumer", { type: "closed", reason: "slow_consumer" });
        }
      };
      yield* Effect.acquireRelease(
        Effect.suspend((): Effect.Effect<void, Runtime.RuntimeError> => {
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
        }),
        () =>
          Effect.sync(() => {
            close("disconnected");
            Deferred.doneUnsafe(done, Effect.void);
          })
      );
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
                  peakSubscriptions: 0,
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
      yield* lifecycle.withPermits(1)(
        Effect.suspend(() =>
          closeReason === undefined ? refresh(input.patchId, [entry], true) : Effect.void
        )
      );
      const check = Effect.gen(function* () {
        while (closeReason === undefined) {
          yield* Effect.sleep("5 seconds");
          if (closeReason !== undefined) return;
          const result = yield* Effect.result(identity.check);
          if (result._tag === "Success") {
            if (result.success === "reauthenticate") close("reauthenticate");
          } else {
            const code = result.failure.code;
            if (
              code === "session_expired" ||
              code === "access_denied" ||
              code === "principal_changed"
            )
              close(code, { type: code });
            else close("source_unavailable");
          }
        }
      });
      yield* check.pipe(Effect.forkIn(scope, { startImmediately: true }));
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
      ).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            close("disconnected");
            Deferred.doneUnsafe(done, Effect.void);
          })
        )
      );
    });
    return RuntimeStream.of({
      open,
      notify: (patchId, frame, versionId) =>
        lifecycle.withPermits(1)(
          Effect.gen(function* () {
            const targets: Entry[] = [];
            for (const entry of entries.values()) {
              if (
                entry.patchId === patchId &&
                (versionId === undefined || entry.versionId === versionId)
              )
                targets.push(entry);
            }
            if (
              frame.type === "served" ||
              frame.type === "revoked" ||
              frame.type === "access_denied"
            ) {
              yield* refresh(patchId, targets, frame.type === "served");
              return;
            }
            for (const entry of targets) {
              if (frame.type === "session_expired" || frame.type === "principal_changed")
                entry.close(frame.type, frame);
              else entry.send(frame);
            }
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
