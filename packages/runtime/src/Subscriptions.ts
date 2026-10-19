// @effect-diagnostics nodeBuiltinImport:off -- A digest keeps a document's desired set small across generations.
import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  canonicalArgs,
  type HandlerKind,
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
import * as Invocation from "./Invocation.js";
import * as QuerySubscriptions from "./QuerySubscriptions.js";

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
  /** The signature's digest, which stands for it in the document's logical desired set. */
  readonly digest: string;
  readonly dependencies: Set<string>;
  /** Keys woken during a run, with each one's first arrival; the run's result decides which matter. */
  readonly duringRun: Map<string, number>;
  vector: RevisionVector | undefined;
  result: string | undefined;
  revision: bigint;
  /** A rebind advances it, so a run it overtakes is thrown away. */
  epoch: number;
  /**
   * Same-signature replaces admitted. A replace may recover a write whose wake was lost, so a
   * run it overlaps answers only once the revisions it read match a fence taken afterwards.
   */
  replaces: number;
  /** When a replace the current run has not answered arrived; the run's end makes it dirty. */
  replacedAt: number | undefined;
  dirty: boolean;
  /** The oldest pending dirty transition and why. A recoverable failure is one. */
  dirtyAt: number;
  trigger: WideEvents.RerunTrigger;
  /** The retry backoff holding the pending run back; a wake, replace or rebind ends it early. */
  backoff: { readonly from: number; until: number } | undefined;
  running: boolean;
  failures: number;
  retryAt: number;
  cause: string | undefined;
}
/**
 * A document's logical desired set as it last admitted one: a digest of its subscription ids,
 * operations and canonical args, ignoring order, revisions and vectors. The stream keeps one per
 * document across its generations, so a reconnect's `replace` tells a change from a repeat.
 * Unset until the document admits a set.
 */
export interface Desired {
  value: string | undefined;
}
interface Document {
  readonly generation: string;
  readonly documentId: string;
  readonly binding: () => Binding.Binding["Service"];
  readonly check: Effect.Effect<void, Runtime.RuntimeError>;
  readonly send: (frame: RuntimeStreamFrame) => void;
  readonly checkOperation?: (op: string) => Effect.Effect<void, Runtime.RuntimeError>;
  readonly scope: Scope.Scope;
  readonly ready?: () => boolean;
  readonly desired: Desired;
  /** This generation has admitted a set, so its own subscriptions are the logical set. */
  applied: boolean;
  readonly subscriptions: Map<string, Subscription>;
  readonly buffered: Map<number, RuntimeSubscriptionRequest>;
  readonly gate: Semaphore.Semaphore;
  sequence: number;
  gap: number;
  resync: boolean;
  active: boolean;
  /** When execution became ready, from the `ready` reconcile. Unset for ungated documents. */
  readyAt: number | undefined;
  peak: number;
  reruns: number;
  /** Slots that ended at the revision check without a read while the document was open. */
  checks: number;
  checkMs: number;
  companyRuns: number;
  patchRuns: number;
}
/** What a run waited for, taken with its slot and before new dirt can replace it. */
interface Slot {
  readonly acquiredAt: number;
  readonly trigger: WideEvents.RerunTrigger;
  readonly slotWaitMs: number;
  readonly readyWaitMs?: number;
  readonly backoffMs?: number;
}
export interface DocumentSubscriptions {
  /**
   * Admits a desired-set request, succeeding with whether it changed the document's logical
   * desired set. Stale, buffered and repeated requests change nothing until their deltas apply.
   */
  readonly update: (
    request: RuntimeSubscriptionRequest
  ) => Effect.Effect<boolean, Runtime.RuntimeError>;
  readonly close: () => void;
  readonly metrics: () => {
    readonly peakSubscriptions: number;
    readonly reruns: number;
    readonly checks: number;
    readonly checkMs: number;
  };
  /**
   * Marks subscriptions dirty: those depending on `keys`, or all of them when `keys` is empty.
   * A wake is an `invalidation`; the stream also reconciles on its interval and on `ready`.
   */
  readonly reconcile: (
    trigger: Extract<WideEvents.RerunTrigger, "invalidation" | "periodic" | "ready">,
    keys?: readonly string[],
    cause?: string
  ) => Effect.Effect<void>;
}

export class Subscriptions extends Context.Service<
  Subscriptions,
  {
    readonly attach: (
      options: Pick<
        Document,
        | "generation"
        | "documentId"
        | "binding"
        | "check"
        | "checkOperation"
        | "send"
        | "scope"
        | "ready"
      > & { readonly desired?: Desired }
    ) => DocumentSubscriptions;
    /** Invalidates snapshots, including reads already in flight, after a dev binding swap. */
    readonly rebind: (
      patchId: string,
      kinds: Readonly<Record<string, HandlerKind>>
    ) => Effect.Effect<void>;
    readonly handlerKinds: (patchId: string) => Readonly<Record<string, HandlerKind>> | undefined;
  }
>()("@patchy/runtime/Subscriptions") {}
const equalVector = (left: RevisionVector | undefined, right: RevisionVector) =>
  left !== undefined &&
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(right).every(([key, value]) => left[key] === value);
/** The digest of a logical desired set: its ids with their signatures' digests, in id order. */
const digestOf = (subscriptions: ReadonlyMap<string, Subscription>) => {
  const hash = createHash("sha256");
  for (const id of [...subscriptions.keys()].sort())
    hash.update(`${id.length}:${id}${subscriptions.get(id)!.digest}`);
  return hash.digest("base64");
};
const nothingDesired = digestOf(new Map());
const reachesFence = (vector: RevisionVector, fence: RevisionVector) =>
  Object.entries(fence).every(
    ([key, value]) => vector[key] === undefined || BigInt(vector[key]!) >= BigInt(value)
  );
const encodeResult = Schema.encodeUnknownEffect(Schema.Json);
const encoder = new TextEncoder();
const isCallbackRefusal = Schema.is(Invocation.CallbackRefusal);
const codeOf = (error: Runtime.RuntimeError | SubscriptionReads.HandlerRefusal) =>
  SubscriptionReads.isHandlerRefusal(error) ? error.failure.code : error.code;
/** The oldest pending dirt keeps its time and trigger; dirt dated earlier replaces it. */
const markDirty = (sub: Subscription, trigger: WideEvents.RerunTrigger, at: number) => {
  if (sub.dirty && sub.dirtyAt <= at) return;
  sub.dirty = true;
  sub.dirtyAt = at;
  sub.trigger = trigger;
};
/** A wake, replace or rebind runs a subscription now, ending any retry backoff early. */
const endBackoff = (sub: Subscription, at: number) => {
  sub.retryAt = 0;
  if (sub.backoff !== undefined && sub.backoff.until > at) sub.backoff.until = at;
};
/**
 * Takes the waits off a subscription as it takes a slot. Its slot wait runs from the oldest
 * pending dirt, less the wait for execution ready and any retry backoff, reported apart.
 */
const takeSlot = (doc: Document, sub: Subscription, acquiredAt: number): Slot => {
  const readyWaitMs = Math.max(0, Math.min(doc.readyAt ?? 0, acquiredAt) - sub.dirtyAt);
  const backoffMs =
    sub.backoff === undefined
      ? 0
      : Math.max(
          0,
          Math.min(sub.backoff.until, acquiredAt) - Math.max(sub.backoff.from, sub.dirtyAt)
        );
  sub.backoff = undefined;
  return {
    acquiredAt,
    trigger: sub.trigger,
    slotWaitMs: Math.max(0, acquiredAt - sub.dirtyAt - readyWaitMs - backoffMs),
    ...(readyWaitMs > 0 ? { readyWaitMs } : {}),
    ...(backoffMs > 0 ? { backoffMs } : {})
  };
};
const recoverable: Readonly<Record<string, true>> = {
  busy: true,
  rate_limited: true,
  source_unavailable: true,
  handler_timeout: true,
  unknown_outcome: true,
  timeout: true,
  access_denied: true,
  patch_paused: true
};

/** One registry per host, shared by all its document streams. */
export const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  // Wakes may run inside another owner's transaction. A re-run owns its own context.
  const context = yield* Effect.context<never>();
  const reads = yield* QuerySubscriptions.make;
  const limits = yield* StreamLimits.StreamLimits;
  const events = yield* WideEvents.WideEvents;
  const documentLimit = yield* ContractLimits.get("subscriptions.document");
  const snapshotLimit = yield* ContractLimits.get("subscriptions.snapshot.bytes");
  const bufferLimit = yield* ContractLimits.get("subscriptions.deltas.buffer");
  const gapMs = yield* ContractLimits.get("subscriptions.deltas.gap");
  const deadline = yield* ContractLimits.get("tier2.query.deadline");
  const handlerKinds = new Map<string, Readonly<Record<string, HandlerKind>>>();
  const callBytes = yield* ContractLimits.get("runtime.call.bytes");
  const serverArgsBytes = yield* ContractLimits.get("tier2.args.bytes");
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
      | "runtime.call.bytes"
      | "tier2.args.bytes",
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
  const run = Effect.fnUntraced(function* (doc: Document, sub: Subscription, slot: Slot) {
    if (!present(doc, sub)) return;
    const epoch = sub.epoch;
    // Replaces the run's fence covers; a later one must be checked against a newer fence.
    let replaces = sub.replaces;
    const answerable = () => present(doc, sub) && sub.epoch === epoch && sub.replaces === replaces;
    // Each frame the run sends answers its subscription, including any replace it covers.
    const answer = (frame: RuntimeStreamFrame) => {
      sub.replacedAt = undefined;
      doc.send(frame);
    };
    let binding = doc.binding();
    const check = Effect.gen(function* () {
      yield* doc.check;
      if (doc.checkOperation !== undefined) yield* doc.checkOperation(sub.input.op);
    });
    const attempted = new Set<string>();
    const observe = (key: string) => {
      attempted.add(key);
      sub.dependencies.add(key);
    };
    const { acquiredAt, ...waits } = slot;
    const event = {
      type: "re-run",
      streamId: doc.generation,
      documentId: doc.documentId,
      parentId: doc.generation,
      ...(sub.cause === undefined ? {} : { causedByEventId: sub.cause }),
      companyId: binding.companyId,
      patchId: binding.patchId,
      versionId: binding.versionId,
      ...(binding.principal === null ? {} : { viewerId: binding.principal.userId }),
      tier: binding.manifest.tier,
      handler: sub.input.op === "server.call" ? String(sub.input.args.handler) : sub.input.op,
      kind: "query",
      ...waits
    } satisfies WideEvents.EventSeed;
    const discarded = WideEvents.enrich({ disposition: "discarded" });
    // The event keeps its own start and duration; the slot it ran in is a field of its own.
    let reported = false;
    const report = <A, E>(work: Effect.Effect<A, E>) => {
      reported = true;
      return events.withEvent(
        event,
        work.pipe(
          Effect.ensuring(
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              WideEvents.enrich({ slotOccupancyMs: now - acquiredAt })
            )
          )
        )
      );
    };
    // A slot that ends at the check, without a read, is added to the stream's summary while
    // the document is open. Once it has closed, the summary may be gone, so it reports itself.
    const unreported = Effect.flatMap(Clock.currentTimeMillis, (now) => {
      if (doc.active) {
        doc.checks++;
        doc.checkMs += now - acquiredAt;
        return Effect.void;
      }
      return events.withEvent(
        { ...event, disposition: "discarded", slotOccupancyMs: now - acquiredAt },
        Effect.void
      );
    });
    const failed = Effect.fnUntraced(function* (
      attemptError: Runtime.RuntimeError | SubscriptionReads.HandlerRefusal
    ) {
      const dropped = (error: Runtime.RuntimeError | SubscriptionReads.HandlerRefusal) =>
        WideEvents.enrich({ outcome: "failure", code: codeOf(error), disposition: "discarded" });
      if (!answerable()) return yield* dropped(attemptError);
      const error = yield* check.pipe(
        Effect.as(attemptError),
        Effect.catch((refusal) => Effect.succeed(refusal))
      );
      if (!answerable()) return yield* dropped(error);
      for (const key of attempted) sub.dependencies.add(key);
      const handlerRefusal = SubscriptionReads.isHandlerRefusal(error);
      const code = codeOf(error);
      const permanent = !handlerRefusal && !isCallbackRefusal(error) && recoverable[code] !== true;
      answer({
        type: "error",
        id: sub.input.id,
        permanent,
        error: handlerRefusal ? error.failure : Runtime.toFailure(error)
      });
      yield* WideEvents.enrich({ outcome: "failure", code });
      if (permanent) {
        doc.subscriptions.delete(sub.input.id);
      } else {
        sub.failures++;
        // Business refusals wait for changed dependencies, not an automatic retry.
        if (handlerRefusal) return;
        const delay = Math.max(
          Math.min(30_000, 250 * 2 ** Math.min(sub.failures - 1, 7)),
          "retryAfterSeconds" in error ? (error.retryAfterSeconds ?? 0) * 1000 : 0
        );
        // The failure itself makes the subscription dirty; the pump holds it through the backoff.
        const now = yield* Clock.currentTimeMillis;
        sub.retryAt = now + delay;
        sub.backoff = { from: now, until: sub.retryAt };
        markDirty(sub, "retry", now);
        yield* Effect.sleep(delay).pipe(
          Effect.andThen(Effect.suspend(() => schedule)),
          Effect.forkIn(doc.scope)
        );
      }
    });
    let input: SubscriptionReads.Input = {
      op: sub.input.op,
      args: sub.input.args,
      binding,
      onDependency: observe,
      dependencies: [...new Set([...sub.dependencies, ...Object.keys(sub.vector ?? {})])],
      reauthorize: Effect.gen(function* () {
        yield* doc.check;
        const identity = doc.binding().identity;
        if (identity === null) return yield* new Runtime.AccessDenied({});
        return identity;
      })
    };
    const fence = yield* Effect.gen(function* () {
      yield* check;
      binding = doc.binding();
      input = { ...input, binding };
      const keys = yield* reads.admit(input);
      const fence = yield* reads.revisions(binding.companyId, keys);
      if (!answerable()) return;
      if (sub.failures === 0 && equalVector(sub.vector, fence)) {
        yield* check;
        if (!answerable()) return;
        sub.dependencies.clear();
        for (const key of keys) sub.dependencies.add(key);
        sub.failures = 0;
        answer({
          type: "up-to-date",
          id: sub.input.id,
          revision: String(sub.revision),
          vector: fence
        });
        return;
      }
      return fence;
    }).pipe(
      Effect.catch((error) => report(failed(error)).pipe(Effect.as(undefined))),
      // Settled, refused or interrupted at the check: no read will report this slot.
      Effect.onExit((exit) =>
        reported || (Exit.isSuccess(exit) && exit.value !== undefined) ? Effect.void : unreported
      )
    );
    if (fence === undefined) return;
    yield* report(
      Effect.gen(function* () {
        doc.reruns++;
        // Invocation owns the query deadline and settles retained resources before returning.
        const read = reads.read(input);
        const snapshot = yield* sub.input.op === "server.call"
          ? read
          : read.pipe(
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
        // A replace admitted during the read may recover a write whose wake was lost. The result
        // answers it only if the revisions it read still match one fence taken after the replace.
        // A replace during that fence ends the run, which then runs again and frees its slot.
        if (sub.replaces !== replaces) {
          const seen = sub.replaces;
          const after = yield* reads.revisions(binding.companyId, Object.keys(snapshot.vector));
          if (!equalVector(snapshot.vector, after)) return yield* discarded;
          replaces = seen;
        }
        if (!answerable()) return yield* discarded;
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
        yield* check;
        if (!answerable()) return yield* discarded;
        sub.dependencies.clear();
        for (const key of Object.keys(snapshot.vector)) sub.dependencies.add(key);
        // The pre-read watermark is a fence, not evidence that a stale snapshot is fresh.
        if (!reachesFence(snapshot.vector, fence)) {
          sub.vector = undefined;
          markDirty(sub, "retry", yield* Clock.currentTimeMillis);
          return yield* discarded;
        }
        sub.vector = snapshot.vector;
        sub.failures = 0;
        sub.retryAt = 0;
        if (sub.result === json) {
          answer({
            type: "up-to-date",
            id: sub.input.id,
            revision: String(sub.revision),
            vector: snapshot.vector
          });
          yield* WideEvents.enrich({ disposition: "unchanged" });
        } else {
          sub.result = json;
          sub.revision++;
          answer({
            type: "snapshot",
            id: sub.input.id,
            revision: String(sub.revision),
            result,
            vector: snapshot.vector
          });
          yield* WideEvents.enrich({ disposition: "delivered" });
        }
      }).pipe(Effect.catch(failed))
    );
  });
  const pump: Effect.Effect<void> = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let documentsLeft = documents.size;
    for (const doc of documents) {
      if (documentsLeft-- === 0) break;
      if (!doc.active || doc.ready?.() === false) continue;
      const binding = doc.binding();
      const patchKey = `${binding.companyId}:${binding.patchId}`;
      let subscriptionsLeft = doc.subscriptions.size;
      for (const sub of doc.subscriptions.values()) {
        if (subscriptionsLeft-- === 0) break;
        if (!sub.dirty || sub.running || sub.retryAt > now) continue;
        // Separate limits: a patch runs at the lesser of its own and its company's cap.
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
        yield* run(doc, sub, takeSlot(doc, sub, now)).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              sub.running = false;
              adjust(companyRunning, binding.companyId, -1);
              adjust(patchRunning, patchKey, -1);
              // A wake for a dependency the run discovered counts from when it arrived.
              let wokenAt: number | undefined;
              for (const [key, at] of sub.duringRun)
                if (sub.dependencies.has(key)) wokenAt = Math.min(wokenAt ?? at, at);
              sub.duringRun.clear();
              if (present(doc, sub) && wokenAt !== undefined)
                markDirty(sub, "invalidation", wokenAt);
              // A replace the run could not answer runs it again, dated from its admission.
              if (present(doc, sub) && sub.replacedAt !== undefined)
                markDirty(sub, "replace", sub.replacedAt);
              sub.replacedAt = undefined;
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
          // Disconnect only drops delivery. Keep query slots until Invocation settles.
          Effect.forkIn(sub.input.op === "server.call" ? scope : doc.scope)
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
      Effect.updateContext<never, never>(() => context),
      Effect.forkIn(scope),
      Effect.asVoid
    );
  });

  const attach = (
    options: Pick<
      Document,
      | "generation"
      | "documentId"
      | "binding"
      | "check"
      | "checkOperation"
      | "send"
      | "scope"
      | "ready"
    > & { readonly desired?: Desired }
  ): DocumentSubscriptions => {
    const doc: Document = {
      ...options,
      desired: options.desired ?? { value: undefined },
      applied: false,
      subscriptions: new Map(),
      buffered: new Map(),
      gate: Semaphore.makeUnsafe(1),
      sequence: 0,
      gap: 0,
      resync: false,
      active: true,
      readyAt: undefined,
      peak: 0,
      reruns: 0,
      checks: 0,
      checkMs: 0,
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
    // The subscription POST's request event says why it was refused and how far this host got.
    const stale = WideEvents.enrich({ refusal: "stale_sequence" }).pipe(
      Effect.andThen(Effect.fail(new StaleSequence()))
    );
    const update = (request: RuntimeSubscriptionRequest) =>
      doc.gate.withPermits(1)(
        Effect.gen(function* () {
          yield* WideEvents.enrich({ currentSequence: doc.sequence });
          if (!doc.active) return yield* stale;
          if (
            request.sequence < doc.sequence ||
            (request.type !== "replace" && request.sequence === 0)
          )
            return yield* stale;
          if (request.type !== "replace" && request.sequence <= doc.sequence) {
            doc.send({ type: "admitted", sequence: doc.sequence });
            return false;
          }
          if (request.type !== "replace" && (doc.resync || request.sequence !== doc.sequence + 1)) {
            if (doc.resync) {
              doc.send({ type: "resync_required", sequence: doc.sequence });
              return false;
            }
            doc.buffered.set(request.sequence, request);
            if (doc.buffered.size > bufferLimit) {
              resync();
              return false;
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
            return false;
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
          const now = yield* Clock.currentTimeMillis;
          // From here the request applies in one step, so a generation replacing this one never
          // finds its desired set half written.
          if (!doc.active) return yield* stale;
          for (const other of documents) {
            if (other.binding().companyId !== binding.companyId) continue;
            other.companyRuns = bounds.companyRuns.value;
            other.patchRuns = bounds.patchRuns.value;
          }
          // Until this generation admits a set, the logical set is the one an earlier generation
          // kept. Afterwards it is this generation's own, less any the server has since refused.
          const before = doc.applied
            ? digestOf(doc.subscriptions)
            : (doc.desired.value ?? nothingDesired);
          const install = (input: RuntimeSubscription) => {
            const signature = `${input.op}:${canonicalArgs(input.args)}`;
            const previous = doc.subscriptions.get(input.id);
            if (previous?.signature === signature) {
              // Replacements acknowledge received data, not the last frame we sent.
              previous.vector = input.vector;
              if (input.revision === undefined || BigInt(input.revision) !== previous.revision)
                previous.result = undefined;
              // A running read keeps its work; the run answers this replace or ends dirty.
              previous.replaces++;
              if (previous.running) previous.replacedAt ??= now;
              else markDirty(previous, "replace", now);
              endBackoff(previous, now);
              return;
            }
            if (previous !== undefined) doc.subscriptions.delete(input.id);
            const maximum = input.op === "server.call" ? serverArgsBytes + callBytes : callBytes;
            if (encoder.encode(signature).byteLength > maximum)
              return refuse(
                doc,
                input.id,
                input.op === "server.call" ? "tier2.args.bytes" : "runtime.call.bytes",
                input.op === "server.call" ? serverArgsBytes : callBytes
              );
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
              digest: createHash("sha256").update(signature).digest("base64"),
              dependencies: new Set(),
              duringRun: new Map(),
              vector: input.vector,
              result: undefined,
              revision: BigInt(input.revision ?? "0"),
              dirty: true,
              dirtyAt: now,
              trigger: "initial",
              backoff: undefined,
              running: false,
              failures: 0,
              retryAt: 0,
              cause: undefined,
              epoch: 0,
              replaces: 0,
              replacedAt: undefined
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
          const after = digestOf(doc.subscriptions);
          doc.applied = true;
          doc.desired.value = after;
          yield* schedule;
          return after !== before;
        })
      );
    return {
      update,
      close: () => {
        // The next generation compares its first admitted set with the last one this one kept.
        if (doc.active && doc.applied) doc.desired.value = digestOf(doc.subscriptions);
        doc.active = false;
        doc.gap++;
        doc.subscriptions.clear();
        doc.buffered.clear();
        documents.delete(doc);
      },
      metrics: () => ({
        peakSubscriptions: doc.peak,
        reruns: doc.reruns,
        checks: doc.checks,
        checkMs: doc.checkMs
      }),
      reconcile: (trigger, keys = [], cause) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // Recorded before the limit lookup, so runs the opened gate releases meanwhile
          // still measure their slot waits from ready.
          if (trigger === "ready") doc.readyAt ??= now;
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
            if (sub.running)
              for (const key of keys) if (!sub.duringRun.has(key)) sub.duringRun.set(key, now);
            if (keys.length === 0 || keys.some((key) => sub.dependencies.has(key))) {
              markDirty(sub, trigger, now);
              endBackoff(sub, now);
              sub.cause = cause;
            }
          }
          yield* schedule;
        })
    };
  };
  return Subscriptions.of({
    attach,
    handlerKinds: (patchId) => handlerKinds.get(patchId),
    rebind: (patchId, kinds) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        handlerKinds.set(patchId, kinds);
        for (const doc of documents) {
          if (doc.binding().patchId !== patchId) continue;
          doc.send({ type: "handlers", kinds });
          for (const sub of doc.subscriptions.values()) {
            sub.epoch++;
            sub.vector = undefined;
            markDirty(sub, "rebind", now);
            endBackoff(sub, now);
          }
        }
        yield* schedule;
      })
  });
});

export const layer = Layer.effect(Subscriptions, make);
