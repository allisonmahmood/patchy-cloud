import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  canonicalArgs,
  type RuntimeStreamFrame,
  type RuntimeSubscription,
  type RuntimeSubscriptionRequest,
  type RevisionVector
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { ContractLimits } from "@patchy/limits";
import { registry } from "@patchy/limits/registry";
import type * as Binding from "./Binding.js";
import * as Runtime from "./Runtime.js";
import * as StreamLimits from "./StreamLimits.js";
import * as SubscriptionReads from "./SubscriptionReads.js";

export class StaleSequence extends Schema.TaggedError<StaleSequence>()("StaleSequence", {}) {
  readonly code = "invalid_request" as const;
  readonly status = 409;
  override get message() {
    return "The desired-set sequence has already been superseded.";
  }
}

export class SubscriptionTimeout extends Schema.TaggedError<SubscriptionTimeout>()(
  "SubscriptionTimeout",
  { deadlineMs: Schema.Int, cause: Schema.Defect() }
) {
  readonly code = "handler_timeout" as const;
  readonly status = 504;
  readonly limitId = "tier2.query.deadline";
  readonly scope = "viewer" as const;
  get value() {
    return this.deadlineMs;
  }
  override get message() {
    return "Subscription read exceeded its deadline.";
  }
}

export class InvalidSnapshot extends Schema.TaggedError<InvalidSnapshot>()("InvalidSnapshot", {
  cause: Schema.Defect()
}) {
  readonly code = "handler_failed" as const;
  readonly status = 500;
  override get message() {
    return "Subscription result is not valid JSON.";
  }
}

interface Subscription {
  readonly input: RuntimeSubscription;
  readonly signature: string;
  readonly dependencies: Set<string>;
  readonly duringRun: Set<string>;
  vector: RevisionVector | undefined;
  result: string | undefined;
  revision: bigint;
  epoch: number;
  dirty: boolean;
  running: boolean;
  failures: number;
  retryAt: number;
  cause: string | undefined;
}
interface Document {
  readonly generation: string;
  readonly binding: () => Binding.Binding["Service"];
  readonly check: Effect.Effect<void, Runtime.RuntimeError>;
  readonly send: (frame: RuntimeStreamFrame) => void;
  readonly scope: Scope.Scope;
  readonly subscriptions: Map<string, Subscription>;
  readonly buffered: Map<number, RuntimeSubscriptionRequest>;
  readonly gate: Semaphore.Semaphore;
  sequence: number;
  gap: number;
  resync: boolean;
  active: boolean;
  peak: number;
  reruns: number;
  companyRuns: number;
  patchRuns: number;
}
export interface DocumentSubscriptions {
  readonly update: (
    request: RuntimeSubscriptionRequest
  ) => Effect.Effect<void, Runtime.RuntimeError>;
  readonly close: () => void;
  readonly metrics: () => { readonly peakSubscriptions: number; readonly reruns: number };
  readonly reconcile: (keys?: readonly string[], cause?: string) => Effect.Effect<void>;
}
const equalVector = (left: RevisionVector | undefined, right: RevisionVector) =>
  left !== undefined &&
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(right).every(([key, value]) => left[key] === value);
const reachesFence = (vector: RevisionVector, fence: RevisionVector) =>
  Object.entries(fence).every(
    ([key, value]) => vector[key] !== undefined && BigInt(vector[key]!) >= BigInt(value)
  );
const encodeResult = Schema.encodeUnknownEffect(Schema.Json);
const encoder = new TextEncoder();
const recoverable: Readonly<Record<string, true>> = {
  busy: true,
  rate_limited: true,
  source_unavailable: true,
  handler_timeout: true,
  timeout: true,
  access_denied: true,
  patch_paused: true
};

/** One registry per host, shared by all its document streams. */
export const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const reads = yield* SubscriptionReads.SubscriptionReads;
  const limits = yield* StreamLimits.StreamLimits;
  const events = yield* WideEvents.WideEvents;
  const documentLimit = yield* ContractLimits.get("subscriptions.document");
  const snapshotLimit = yield* ContractLimits.get("subscriptions.snapshot.bytes");
  const bufferLimit = yield* ContractLimits.get("subscriptions.deltas.buffer");
  const gapMs = yield* ContractLimits.get("subscriptions.deltas.gap");
  const deadline = yield* ContractLimits.get("tier2.query.deadline");
  const callBytes = yield* ContractLimits.get("runtime.call.bytes");
  const documents = new Set<Document>();
  const companyRunning = new Map<string, number>();
  const patchRunning = new Map<string, number>();
  let pumping = false;
  const adjust = (map: Map<string, number>, key: string, change: number) => {
    const value = (map.get(key) ?? 0) + change;
    if (value === 0) map.delete(key);
    else map.set(key, value);
  };
  const present = (doc: Document, sub: Subscription) =>
    doc.active && doc.subscriptions.get(sub.input.id) === sub;
  const refuse = (
    doc: Document,
    id: string,
    limitId:
      | "subscriptions.document"
      | "subscriptions.patch"
      | "subscriptions.company"
      | "subscriptions.snapshot.bytes"
      | "runtime.call.bytes",
    value: number
  ) => {
    doc.send({
      type: "error",
      id,
      permanent: true,
      error: {
        ok: false,
        source: "patchy",
        code: limitId.endsWith(".bytes") ? "too_large" : "limit_exceeded",
        error: `Subscription exceeds ${limitId}.`,
        limitId,
        scope: registry[limitId].scope,
        value
      }
    });
  };
  const run = Effect.fnUntraced(function* (doc: Document, sub: Subscription) {
    if (!present(doc, sub)) return;
    const epoch = sub.epoch;
    const binding = doc.binding();
    const attempted = new Set<string>();
    const observe = (key: string) => {
      attempted.add(key);
      sub.dependencies.add(key);
    };
    const event: WideEvents.EventSeed = {
      type: "re-run",
      streamId: doc.generation,
      parentId: doc.generation,
      ...(sub.cause === undefined ? {} : { causedByEventId: sub.cause }),
      companyId: binding.companyId,
      patchId: binding.patchId,
      versionId: binding.versionId,
      ...(binding.principal === null ? {} : { viewerId: binding.principal.userId }),
      tier: binding.manifest.tier,
      handler: sub.input.op,
      kind: "query"
    };
    const failed = Effect.fnUntraced(function* (error: Runtime.RuntimeError) {
      if (!present(doc, sub) || sub.epoch !== epoch) return;
      for (const key of attempted) sub.dependencies.add(key);
      const permanent = recoverable[error.code] !== true;
      doc.send({
        type: "error",
        id: sub.input.id,
        permanent,
        error: Runtime.toFailure(error)
      });
      yield* WideEvents.enrich({ outcome: "failure", code: error.code });
      if (permanent) {
        doc.subscriptions.delete(sub.input.id);
      } else {
        sub.failures++;
        const delay = Math.max(
          Math.min(30_000, 250 * 2 ** Math.min(sub.failures - 1, 7)),
          "retryAfterSeconds" in error ? (error.retryAfterSeconds ?? 0) * 1000 : 0
        );
        sub.retryAt = (yield* Clock.currentTimeMillis) + delay;
        yield* Effect.sleep(delay).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (present(doc, sub)) sub.dirty = true;
            })
          ),
          Effect.andThen(Effect.suspend(() => schedule)),
          Effect.forkIn(doc.scope)
        );
      }
    });
    const input = { op: sub.input.op, args: sub.input.args, binding, onDependency: observe };
    const fence = yield* Effect.gen(function* () {
      yield* doc.check;
      const keys = yield* reads.admit(input);
      const fence = yield* reads.revisions(binding.companyId, keys);
      if (!present(doc, sub) || sub.epoch !== epoch) return;
      if (equalVector(sub.vector, fence)) {
        yield* doc.check;
        if (!present(doc, sub) || sub.epoch !== epoch) return;
        sub.dependencies.clear();
        for (const key of keys) sub.dependencies.add(key);
        sub.failures = 0;
        doc.send({
          type: "up-to-date",
          id: sub.input.id,
          revision: String(sub.revision),
          vector: fence
        });
        return;
      }
      return fence;
    }).pipe(
      Effect.catch((error) => events.withEvent(event, failed(error)).pipe(Effect.as(undefined)))
    );
    if (fence === undefined) return;
    yield* events.withEvent(
      event,
      Effect.gen(function* () {
        doc.reruns++;
        const snapshot = yield* reads.read(input).pipe(
          Effect.timeout(deadline),
          Effect.catchTags({
            TimeoutError: (cause) =>
              Effect.fail(new SubscriptionTimeout({ deadlineMs: deadline, cause }))
          })
        );
        const result = yield* encodeResult(snapshot.result).pipe(
          Effect.mapError((cause) => new InvalidSnapshot({ cause }))
        );
        const json = canonicalArgs(result);
        const size = encoder.encode(json).byteLength;
        yield* WideEvents.enrich({
          resultBytes: size,
          limits: [
            {
              limitId: "subscriptions.snapshot.bytes",
              value: snapshotLimit,
              peak: size,
              configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
            }
          ]
        });
        if (!present(doc, sub) || sub.epoch !== epoch) return;
        if (size > snapshotLimit) {
          refuse(doc, sub.input.id, "subscriptions.snapshot.bytes", snapshotLimit);
          doc.subscriptions.delete(sub.input.id);
          yield* WideEvents.enrich({
            outcome: "refused",
            code: "too_large",
            limitId: "subscriptions.snapshot.bytes"
          });
          return;
        }
        // The pre-read watermark is a fence, not evidence that a stale snapshot is fresh.
        if (!reachesFence(snapshot.vector, fence)) {
          sub.dirty = true;
          return;
        }
        yield* doc.check;
        if (!present(doc, sub) || sub.epoch !== epoch) return;
        sub.dependencies.clear();
        for (const key of Object.keys(snapshot.vector)) sub.dependencies.add(key);
        sub.vector = snapshot.vector;
        sub.failures = 0;
        sub.retryAt = 0;
        if (sub.result === json) {
          doc.send({
            type: "up-to-date",
            id: sub.input.id,
            revision: String(sub.revision),
            vector: snapshot.vector
          });
        } else {
          sub.result = json;
          sub.revision++;
          doc.send({
            type: "snapshot",
            id: sub.input.id,
            revision: String(sub.revision),
            result,
            vector: snapshot.vector
          });
        }
      }).pipe(Effect.catch(failed))
    );
  });
  const pump: Effect.Effect<void> = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let documentsLeft = documents.size;
    for (const doc of documents) {
      if (documentsLeft-- === 0) break;
      const binding = doc.binding();
      const patchKey = `${binding.companyId}:${binding.patchId}`;
      let subscriptionsLeft = doc.subscriptions.size;
      for (const sub of doc.subscriptions.values()) {
        if (subscriptionsLeft-- === 0) break;
        if (!sub.dirty || sub.running || sub.retryAt > now) continue;
        if (
          (companyRunning.get(binding.companyId) ?? 0) >= doc.companyRuns ||
          (patchRunning.get(patchKey) ?? 0) >= doc.patchRuns
        )
          continue;
        sub.dirty = false;
        sub.running = true;
        sub.duringRun.clear();
        adjust(companyRunning, binding.companyId, 1);
        adjust(patchRunning, patchKey, 1);
        yield* run(doc, sub).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              sub.running = false;
              adjust(companyRunning, binding.companyId, -1);
              adjust(patchRunning, patchKey, -1);
              if (present(doc, sub) && [...sub.duringRun].some((key) => sub.dependencies.has(key)))
                sub.dirty = true;
              if (present(doc, sub)) {
                // Rotate after completion so subscriptions added during the run get a turn.
                doc.subscriptions.delete(sub.input.id);
                doc.subscriptions.set(sub.input.id, sub);
                documents.delete(doc);
                documents.add(doc);
              }
              yield* Effect.suspend(() => schedule);
            })
          ),
          Effect.forkIn(doc.scope)
        );
      }
    }
  });
  const schedule: Effect.Effect<void> = Effect.suspend(() => {
    if (pumping) return Effect.void;
    pumping = true;
    return Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.sync(() => {
          pumping = false;
        })
      ),
      Effect.andThen(pump),
      Effect.forkIn(scope),
      Effect.asVoid
    );
  });

  const attach = (
    options: Pick<Document, "generation" | "binding" | "check" | "send" | "scope">
  ): DocumentSubscriptions => {
    const doc: Document = {
      ...options,
      subscriptions: new Map(),
      buffered: new Map(),
      gate: Semaphore.makeUnsafe(1),
      sequence: 0,
      gap: 0,
      resync: false,
      active: true,
      peak: 0,
      reruns: 0,
      companyRuns: registry["subscriptions.reruns.company"].default,
      patchRuns: registry["subscriptions.reruns.patch"].default
    };
    documents.add(doc);
    const resync = () => {
      doc.resync = true;
      doc.buffered.clear();
      doc.gap++;
      doc.send({ type: "resync_required", sequence: doc.sequence });
    };
    const update = (request: RuntimeSubscriptionRequest) =>
      doc.gate.withPermits(1)(
        Effect.gen(function* () {
          if (!doc.active) return yield* new StaleSequence();
          if (
            request.sequence < doc.sequence ||
            (request.type !== "replace" && request.sequence === 0)
          )
            return yield* new StaleSequence();
          if (request.type !== "replace" && request.sequence <= doc.sequence) {
            doc.send({ type: "admitted", sequence: doc.sequence });
            return;
          }
          if (request.type !== "replace" && (doc.resync || request.sequence !== doc.sequence + 1)) {
            if (doc.resync) {
              doc.send({ type: "resync_required", sequence: doc.sequence });
              return;
            }
            doc.buffered.set(request.sequence, request);
            if (doc.buffered.size > bufferLimit) {
              resync();
              return;
            }
            if (doc.buffered.size === 1) {
              const gap = ++doc.gap;
              yield* Effect.sleep(gapMs).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (doc.active && gap === doc.gap && doc.buffered.size > 0) resync();
                  })
                ),
                Effect.forkIn(doc.scope)
              );
            }
            return;
          }
          const binding = doc.binding();
          const bounds = yield* limits.getMany({
            companyId: binding.companyId,
            limits: {
              patch: "subscriptions.patch",
              company: "subscriptions.company",
              companyRuns: "subscriptions.reruns.company",
              patchRuns: "subscriptions.reruns.patch"
            }
          });
          if (!doc.active) return yield* new StaleSequence();
          for (const other of documents) {
            if (other.binding().companyId !== binding.companyId) continue;
            other.companyRuns = bounds.companyRuns.value;
            other.patchRuns = bounds.patchRuns.value;
          }
          const install = (input: RuntimeSubscription) => {
            const signature = `${input.op}:${canonicalArgs(input.args)}`;
            const previous = doc.subscriptions.get(input.id);
            if (previous?.signature === signature) {
              // Replacements acknowledge received data, not the last frame we sent.
              previous.vector = input.vector;
              if (input.revision === undefined || BigInt(input.revision) !== previous.revision)
                previous.result = undefined;
              previous.epoch++;
              previous.dirty = true;
              previous.retryAt = 0;
              return;
            }
            if (previous !== undefined) doc.subscriptions.delete(input.id);
            if (encoder.encode(signature).byteLength > callBytes)
              return refuse(doc, input.id, "runtime.call.bytes", callBytes);
            let companyCount = 0;
            let patchCount = 0;
            for (const other of documents) {
              const otherBinding = other.binding();
              if (otherBinding.companyId !== binding.companyId) continue;
              companyCount += other.subscriptions.size;
              if (otherBinding.patchId === binding.patchId) patchCount += other.subscriptions.size;
            }
            if (doc.subscriptions.size >= documentLimit)
              return refuse(doc, input.id, "subscriptions.document", documentLimit);
            if (patchCount >= bounds.patch.value)
              return refuse(doc, input.id, "subscriptions.patch", bounds.patch.value);
            if (companyCount >= bounds.company.value)
              return refuse(doc, input.id, "subscriptions.company", bounds.company.value);
            doc.subscriptions.set(input.id, {
              input,
              signature,
              dependencies: new Set(),
              duringRun: new Set(),
              vector: input.vector,
              result: undefined,
              revision: BigInt(input.revision ?? "0"),
              dirty: true,
              running: false,
              failures: 0,
              retryAt: 0,
              cause: undefined,
              epoch: 0
            });
            doc.peak = Math.max(doc.peak, doc.subscriptions.size);
          };
          const apply = (delta: RuntimeSubscriptionRequest) => {
            if (delta.type === "subscribe") install(delta.subscription);
            else if (delta.type === "unsubscribe") doc.subscriptions.delete(delta.id);
            doc.sequence = delta.sequence;
          };
          if (request.type === "replace") {
            const desired = new Set(request.subscriptions.map((sub) => sub.id));
            for (const id of doc.subscriptions.keys())
              if (!desired.has(id)) doc.subscriptions.delete(id);
            for (const input of request.subscriptions) install(input);
            doc.sequence = request.sequence;
            doc.resync = false;
            for (const sequence of doc.buffered.keys())
              if (sequence <= request.sequence) doc.buffered.delete(sequence);
          } else apply(request);
          while (doc.buffered.has(doc.sequence + 1)) {
            const delta = doc.buffered.get(doc.sequence + 1)!;
            doc.buffered.delete(doc.sequence + 1);
            apply(delta);
          }
          if (doc.buffered.size === 0) doc.gap++;
          doc.send({ type: "admitted", sequence: doc.sequence });
          yield* schedule;
        })
      );
    return {
      update,
      close: () => {
        doc.active = false;
        doc.gap++;
        doc.subscriptions.clear();
        doc.buffered.clear();
        documents.delete(doc);
      },
      metrics: () => ({ peakSubscriptions: doc.peak, reruns: doc.reruns }),
      reconcile: (keys: readonly string[] = [], cause?: string) =>
        Effect.gen(function* () {
          if (keys.length === 0) {
            const companyId = doc.binding().companyId;
            yield* limits
              .getMany({
                companyId,
                limits: {
                  companyRuns: "subscriptions.reruns.company",
                  patchRuns: "subscriptions.reruns.patch"
                }
              })
              .pipe(
                Effect.tap((bounds) =>
                  Effect.sync(() => {
                    for (const other of documents) {
                      if (other.binding().companyId !== companyId) continue;
                      other.companyRuns = bounds.companyRuns.value;
                      other.patchRuns = bounds.patchRuns.value;
                    }
                  })
                ),
                Effect.catch(() => Effect.void)
              );
          }
          for (const sub of doc.subscriptions.values()) {
            if (sub.running) for (const key of keys) sub.duringRun.add(key);
            if (keys.length === 0 || keys.some((key) => sub.dependencies.has(key))) {
              sub.dirty = true;
              sub.retryAt = 0;
              sub.cause = cause;
            }
          }
          yield* schedule;
        })
    };
  };
  return { attach };
});
