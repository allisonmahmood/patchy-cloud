import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import {
  CURRENT_RELEASE,
  WIRE_VERSION,
  type RuntimeStreamFrame,
  type RuntimeSubscription,
  type RuntimeSubscriptionRequest
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { ContractLimits } from "@patchy/limits";
import type * as Binding from "./Binding.js";
import * as Runtime from "./Runtime.js";
import * as StreamLimits from "./StreamLimits.js";
import * as SubscriptionReads from "./SubscriptionReads.js";
import * as Subscriptions from "./Subscriptions.js";

const key = "table:source:items";
const lifecycle = "patch:source";
const query: RuntimeSubscription = { id: "items", op: "shared.list", args: { alias: "items" } };
const binding: Binding.Binding["Service"] = {
  patchId: "consumer",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  companyId: "company",
  wireVersion: WIRE_VERSION,
  scope: "company",
  principal: { userId: "viewer" },
  identity: null,
  correlationId: "stream-test",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 1,
    tables: {},
    files: {},
    uses: {}
  }
};
const fixture = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const frames = yield* Queue.make<RuntimeStreamFrame>();
  const started = yield* Queue.make<number>();
  const admitting = yield* Queue.make<number>();
  const recorded = yield* Queue.make<WideEvents.WideEvent>();
  const state = {
    revision: 0,
    lifecycle: 0,
    reads: 0,
    admissions: 0,
    value: { rows: [{ id: "one", value: "initial" }], cursor: null },
    failure: undefined as Runtime.RuntimeError | undefined,
    admissionGate: undefined as Deferred.Deferred<void> | undefined,
    gate: undefined as Deferred.Deferred<void> | undefined
  };
  const vector = () => ({ [key]: String(state.revision), [lifecycle]: String(state.lifecycle) });
  const reader: SubscriptionReads.SubscriptionReads["Service"] = {
    admit: (input) =>
      Effect.gen(function* () {
        state.admissions++;
        input.onDependency?.(key);
        input.onDependency?.(lifecycle);
        yield* Queue.offer(admitting, state.admissions);
        if (state.admissionGate !== undefined) yield* Deferred.await(state.admissionGate);
        if (state.failure !== undefined) return yield* Effect.fail(state.failure);
        return [key, lifecycle];
      }),
    read: () =>
      Effect.gen(function* () {
        state.reads++;
        const snapshot = { result: state.value, vector: vector() };
        yield* Queue.offer(started, state.reads);
        if (state.gate !== undefined) yield* Deferred.await(state.gate);
        if (state.failure !== undefined) return yield* Effect.fail(state.failure);
        return snapshot;
      }),
    revisions: () => Effect.sync(vector)
  };
  const events = yield* WideEvents.make.pipe(
    Effect.provideService(WideEvents.Sink, {
      write: (event) => Queue.offer(recorded, event).pipe(Effect.asVoid)
    })
  );
  const registry = yield* Subscriptions.make.pipe(
    Effect.provideService(SubscriptionReads.SubscriptionReads, reader),
    Effect.provide(StreamLimits.layerLocal),
    Effect.provideService(WideEvents.WideEvents, events)
  );
  const document = registry.attach({
    generation: "generation",
    binding: () => binding,
    check: Effect.void,
    scope,
    send: (frame) => {
      Queue.offerUnsafe(frames, frame);
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(document.close));
  const update = (
    command:
      | Omit<
          Extract<RuntimeSubscriptionRequest, { type: "subscribe" }>,
          "patchId" | "versionId" | "documentId" | "generation"
        >
      | Omit<
          Extract<RuntimeSubscriptionRequest, { type: "unsubscribe" }>,
          "patchId" | "versionId" | "documentId" | "generation"
        >
      | Omit<
          Extract<RuntimeSubscriptionRequest, { type: "replace" }>,
          "patchId" | "versionId" | "documentId" | "generation"
        >
  ) =>
    document.update({
      ...command,
      patchId: binding.patchId,
      versionId: binding.versionId,
      documentId: "document_subscription",
      generation: "generation"
    });
  return {
    state,
    frames,
    started,
    admitting,
    recorded,
    document,
    update,
    next: Queue.take(frames),
    vector,
    registry,
    scope
  };
});

it.effect(
  "applies deltas in sequence, supersedes buffered work and refuses older replacements",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.update({ type: "unsubscribe", sequence: 2, id: query.id });
      yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
      assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 2 });
      assert.strictEqual(f.state.reads, 0);
      assert.instanceOf(
        yield* f.update({ type: "replace", sequence: 1, subscriptions: [query] }).pipe(Effect.flip),
        Subscriptions.StaleSequence
      );
      yield* f.update({ type: "subscribe", sequence: 3, subscription: query });
      assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 3 });
      const snapshot = yield* f.next;
      assert.strictEqual(snapshot.type, "snapshot");
      if (snapshot.type === "snapshot") assert.deepStrictEqual(snapshot.result, f.state.value);
    }).pipe(Effect.scoped)
);

it.effect("requires a full desired set after five seconds or a 65th buffered delta", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.update({ type: "subscribe", sequence: 2, subscription: query });
    yield* TestClock.adjust("5 seconds");
    assert.deepStrictEqual(yield* f.next, { type: "resync_required", sequence: 0 });
    yield* f.update({ type: "replace", sequence: 2, subscriptions: [] });
    assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 2 });
    for (let sequence = 4; sequence <= 68; sequence++) {
      yield* f.update({ type: "unsubscribe", sequence, id: "absent" });
    }
    assert.deepStrictEqual(yield* f.next, { type: "resync_required", sequence: 2 });
    yield* f.update({ type: "replace", sequence: 68, subscriptions: [query] });
    assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 68 });
    assert.strictEqual((yield* f.next).type, "snapshot");
  }).pipe(Effect.scoped)
);

it.effect(
  "re-admits an equal resume vector without executing and suppresses unchanged results",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.update({
        type: "replace",
        sequence: 0,
        subscriptions: [{ ...query, vector: f.vector(), revision: "7" }]
      });
      yield* f.next;
      assert.deepStrictEqual(yield* f.next, {
        type: "up-to-date",
        id: query.id,
        revision: "7",
        vector: f.vector()
      });
      assert.strictEqual(f.state.admissions, 1);
      assert.strictEqual(f.state.reads, 0);
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Queue.size(f.recorded), 0);
      f.state.revision++;
      yield* f.document.reconcile([key], "write-changed");
      assert.strictEqual((yield* f.next).type, "snapshot");
      const changed = yield* Queue.take(f.recorded);
      assert.strictEqual(changed.type, "re-run");
      if (changed.type === "re-run") {
        assert.strictEqual(changed.causedByEventId, "write-changed");
        assert.strictEqual(changed.streamId, "generation");
      }
      f.state.revision++;
      yield* f.document.reconcile([key]);
      assert.deepStrictEqual(yield* f.next, {
        type: "up-to-date",
        id: query.id,
        revision: "8",
        vector: f.vector()
      });
    }).pipe(Effect.scoped)
);

it.effect("repairs a dropped snapshot using the client's received vector and revision", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* f.next;
    const received = yield* f.next;
    assert.strictEqual(received.type, "snapshot");
    if (received.type !== "snapshot") return;
    f.state.revision++;
    f.state.value = { rows: [{ id: "one", value: "newest" }], cursor: null };
    yield* f.document.reconcile([key]);
    const dropped = yield* f.next;
    assert.strictEqual(dropped.type, "snapshot");
    yield* f.update({
      type: "replace",
      sequence: 1,
      subscriptions: [{ ...query, vector: received.vector, revision: received.revision }]
    });
    yield* f.next;
    const repaired = yield* f.next;
    assert.strictEqual(repaired.type, "snapshot");
    if (repaired.type !== "snapshot") return;
    assert.deepStrictEqual(repaired.result, f.state.value);
    assert.deepStrictEqual(repaired.vector, f.vector());
    const reads = f.state.reads;
    yield* f.update({
      type: "replace",
      sequence: 1,
      subscriptions: [{ ...query, vector: repaired.vector, revision: repaired.revision }]
    });
    yield* f.next;
    assert.deepStrictEqual(yield* f.next, {
      type: "up-to-date",
      id: query.id,
      vector: repaired.vector,
      revision: repaired.revision
    });
    assert.strictEqual(f.state.reads, reads);
  }).pipe(Effect.scoped)
);

it.effect(
  "keeps unchanged-result suppression when the client missed only an up-to-date frame",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
      yield* f.next;
      const received = yield* f.next;
      assert.strictEqual(received.type, "snapshot");
      if (received.type !== "snapshot") return;
      f.state.revision++;
      yield* f.document.reconcile([key]);
      assert.strictEqual((yield* f.next).type, "up-to-date");
      yield* f.update({
        type: "replace",
        sequence: 1,
        subscriptions: [{ ...query, vector: received.vector, revision: received.revision }]
      });
      yield* f.next;
      assert.deepStrictEqual(yield* f.next, {
        type: "up-to-date",
        id: query.id,
        vector: f.vector(),
        revision: received.revision
      });
    }).pipe(Effect.scoped)
);

it.effect("keeps failed access dependencies and recovers on a source reshare", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.state.failure = new Runtime.AccessDenied({});
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* f.next;
    const denied = yield* f.next;
    assert.strictEqual(denied.type, "error");
    if (denied.type === "error") {
      assert.isFalse(denied.permanent);
      assert.strictEqual(denied.error.code, "access_denied");
    }
    const event = yield* Queue.take(f.recorded);
    assert.strictEqual(event.type, "re-run");
    assert.strictEqual(event.outcome, "failure");
    assert.strictEqual(event.code, "access_denied");
    if (event.type === "re-run") assert.strictEqual(event.patchId, binding.patchId);
    assert.strictEqual(f.state.reads, 0);
    f.state.failure = undefined;
    f.state.lifecycle++;
    yield* f.document.reconcile([lifecycle]);
    assert.strictEqual((yield* f.next).type, "snapshot");
    assert.strictEqual(f.state.reads, 1);
  }).pipe(Effect.scoped)
);

it.effect(
  "retains a wake received during a read and coalesces a burst into one following read",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.state.gate = yield* Deferred.make<void>();
      yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
      yield* f.next;
      yield* Queue.take(f.started);
      for (let write = 1; write <= 50; write++) {
        f.state.revision = write;
        f.state.value = { rows: [{ id: "one", value: String(write) }], cursor: null };
        yield* f.document.reconcile([key], `write-${write}`);
      }
      const gate = f.state.gate;
      f.state.gate = undefined;
      yield* Deferred.succeed(gate, undefined);
      assert.strictEqual((yield* f.next).type, "snapshot");
      const newest = yield* f.next;
      assert.strictEqual(newest.type, "snapshot");
      if (newest.type === "snapshot") {
        assert.deepStrictEqual(newest.result, f.state.value);
        assert.strictEqual(newest.vector[key], "50");
      }
      assert.strictEqual(f.state.reads, 2);
    }).pipe(Effect.scoped)
);

for (const sameDocument of [true, false]) {
  it.effect(
    `serves a pending subscription ${sameDocument ? "in the same document" : "in another document"} before a dirty subscription runs again`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.state.gate = yield* Deferred.make<void>();
        yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
        yield* f.next;
        yield* Queue.take(f.started);
        const second = sameDocument
          ? f.document
          : f.registry.attach({
              generation: "second",
              binding: () => binding,
              check: Effect.void,
              scope: f.scope,
              send: (frame) => {
                Queue.offerUnsafe(f.frames, frame);
              }
            });
        if (!sameDocument) yield* Effect.addFinalizer(() => Effect.sync(second.close));
        yield* second.update({
          type: "subscribe",
          sequence: sameDocument ? 2 : 1,
          subscription: { ...query, id: "second" },
          patchId: binding.patchId,
          versionId: binding.versionId,
          documentId: "second_document",
          generation: sameDocument ? "generation" : "second"
        });
        yield* f.next;
        f.state.revision++;
        f.state.value = { rows: [{ id: "one", value: "newest" }], cursor: null };
        yield* f.document.reconcile([key]);
        const gate = f.state.gate;
        f.state.gate = undefined;
        yield* Deferred.succeed(gate, undefined);
        const initial = yield* f.next;
        assert.strictEqual(initial.type, "snapshot");
        if (initial.type === "snapshot") assert.strictEqual(initial.id, query.id);
        const pending = yield* f.next;
        assert.strictEqual(pending.type, "snapshot");
        if (pending.type === "snapshot") {
          assert.strictEqual(pending.id, "second");
          assert.deepStrictEqual(pending.result, f.state.value);
        }
        const refreshed = yield* f.next;
        assert.strictEqual(refreshed.type, "snapshot");
        if (refreshed.type === "snapshot") {
          assert.strictEqual(refreshed.id, query.id);
          assert.deepStrictEqual(refreshed.result, f.state.value);
        }
      }).pipe(Effect.scoped)
  );
}

it.effect("permanent failures end only their subscription and a fresh subscribe can retry", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.state.failure = { code: "handler_failed", status: 500, message: "Invalid result." };
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* f.next;
    const failed = yield* f.next;
    assert.strictEqual(failed.type, "error");
    if (failed.type === "error") assert.isTrue(failed.permanent);
    const admissions = f.state.admissions;
    f.state.failure = undefined;
    yield* f.document.reconcile([key]);
    yield* Effect.yieldNow;
    assert.strictEqual(f.state.admissions, admissions);
    yield* f.update({ type: "subscribe", sequence: 2, subscription: query });
    yield* f.next;
    assert.strictEqual((yield* f.next).type, "snapshot");
  }).pipe(Effect.scoped)
);

it.effect("refuses the newest query at the document limit without evicting its predecessor", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.update({
      type: "replace",
      sequence: 0,
      subscriptions: [query, { ...query, id: "newest" }]
    });
    const refused = yield* f.next;
    assert.strictEqual(refused.type, "error");
    if (refused.type === "error") {
      assert.strictEqual(refused.id, "newest");
      assert.isTrue(refused.permanent);
      assert.strictEqual(refused.error.source, "patchy");
      if (refused.error.source === "patchy")
        assert.strictEqual(refused.error.limitId, "subscriptions.document");
    }
    yield* f.next;
    const snapshot = yield* f.next;
    assert.strictEqual(snapshot.type, "snapshot");
    if (snapshot.type === "snapshot") assert.strictEqual(snapshot.id, query.id);
  }).pipe(
    Effect.provideService(ContractLimits.overrides, { "subscriptions.document": 1 }),
    Effect.scoped
  )
);

it.effect("bounds admission and reads to two company runs and one run per patch", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.state.admissionGate = yield* Deferred.make<void>();
    f.state.gate = yield* Deferred.make<void>();
    const second = f.registry.attach({
      generation: "second",
      binding: () => binding,
      check: Effect.void,
      scope: f.scope,
      send: (frame) => {
        Queue.offerUnsafe(f.frames, frame);
      }
    });
    const third = f.registry.attach({
      generation: "third",
      binding: () => ({ ...binding, patchId: "other-patch" }),
      check: Effect.void,
      scope: f.scope,
      send: (frame) => {
        Queue.offerUnsafe(f.frames, frame);
      }
    });
    const fourth = f.registry.attach({
      generation: "fourth",
      binding: () => ({ ...binding, patchId: "last-patch" }),
      check: Effect.void,
      scope: f.scope,
      send: (frame) => {
        Queue.offerUnsafe(f.frames, frame);
      }
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        second.close();
        third.close();
        fourth.close();
      })
    );
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    const request = {
      type: "subscribe" as const,
      sequence: 1,
      subscription: query,
      patchId: binding.patchId,
      versionId: binding.versionId,
      documentId: "another_document",
      generation: "second"
    };
    yield* second.update(request);
    yield* third.update({ ...request, generation: "third" });
    yield* fourth.update({ ...request, generation: "fourth" });
    yield* Queue.take(f.admitting);
    yield* Queue.take(f.admitting);
    yield* Effect.yieldNow;
    assert.strictEqual(f.state.admissions, 2);
    assert.strictEqual(f.state.reads, 0);
    const admissionGate = f.state.admissionGate;
    f.state.admissionGate = undefined;
    yield* Deferred.succeed(admissionGate, undefined);
    yield* Queue.take(f.started);
    yield* Queue.take(f.started);
    yield* Effect.yieldNow;
    assert.strictEqual(f.state.reads, 2);
    const gate = f.state.gate;
    f.state.gate = undefined;
    yield* Deferred.succeed(gate, undefined);
    let snapshots = 0;
    while (snapshots < 4) if ((yield* f.next).type === "snapshot") snapshots++;
    assert.strictEqual(f.state.reads, 4);
  }).pipe(Effect.scoped)
);

it.effect("retries a transient failure without another wake", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.state.failure = new Runtime.SourceUnavailable({ cause: "offline" });
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* f.next;
    const failed = yield* f.next;
    assert.strictEqual(failed.type, "error");
    if (failed.type === "error") assert.isFalse(failed.permanent);
    f.state.failure = undefined;
    yield* TestClock.adjust("250 millis");
    assert.strictEqual((yield* f.next).type, "snapshot");
  }).pipe(Effect.scoped)
);

it.effect("ends an oversized snapshot without closing the document", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* f.next;
    const failed = yield* f.next;
    assert.strictEqual(failed.type, "error");
    if (failed.type === "error") {
      assert.isTrue(failed.permanent);
      assert.strictEqual(failed.error.code, "too_large");
    }
    f.state.value = { rows: [], cursor: null };
    yield* f.update({ type: "subscribe", sequence: 2, subscription: { ...query, id: "smaller" } });
    yield* f.next;
    const snapshot = yield* f.next;
    assert.strictEqual(snapshot.type, "snapshot");
    if (snapshot.type === "snapshot") assert.strictEqual(snapshot.id, "smaller");
  }).pipe(
    Effect.provideService(ContractLimits.overrides, { "subscriptions.snapshot.bytes": 30 }),
    Effect.scoped
  )
);
