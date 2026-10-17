import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import { registry } from "@patchy/limits/registry";
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
    gate: undefined as Deferred.Deferred<void> | undefined,
    limitsGate: undefined as Deferred.Deferred<void> | undefined,
    /** A dependency only a read's result reveals, so a wake for it waits on the run. */
    late: undefined as string | undefined,
    /** Revisions the next read trails its fence by. */
    readLag: 0
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
        const snapshot = {
          result: state.value,
          vector: {
            ...vector(),
            [key]: String(state.revision - state.readLag),
            ...(state.late === undefined ? {} : { [state.late]: "0" })
          }
        };
        state.readLag = 0;
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
  const local = yield* Effect.gen(function* () {
    return yield* StreamLimits.StreamLimits;
  }).pipe(Effect.provide(StreamLimits.layerLocal));
  const registry = yield* Subscriptions.make.pipe(
    Effect.provideService(SubscriptionReads.SubscriptionReads, reader),
    Effect.provideService(StreamLimits.StreamLimits, {
      getMany: (input) =>
        Effect.suspend(() =>
          state.limitsGate === undefined ? Effect.void : Deferred.await(state.limitsGate)
        ).pipe(Effect.andThen(local.getMany(input)))
    }),
    Effect.provideService(WideEvents.WideEvents, events)
  );
  const document = registry.attach({
    generation: "generation",
    documentId: "document_subscription",
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
      yield* f.document.reconcile("invalidation", [key], "write-changed");
      assert.strictEqual((yield* f.next).type, "snapshot");
      const changed = yield* Queue.take(f.recorded);
      assert.strictEqual(changed.type, "re-run");
      if (changed.type === "re-run") {
        assert.strictEqual(changed.causedByEventId, "write-changed");
        assert.strictEqual(changed.streamId, "generation");
      }
      f.state.revision++;
      yield* f.document.reconcile("invalidation", [key]);
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
    yield* f.document.reconcile("invalidation", [key]);
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
      yield* f.document.reconcile("invalidation", [key]);
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

it.effect("reruns after a refusal even when the last successful vector is still equal", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* f.next;
    const initial = yield* f.next;
    assert.strictEqual(initial.type, "snapshot");
    f.state.failure = new Runtime.SourceUnavailable({ cause: "temporarily offline" });
    yield* f.document.reconcile("invalidation", [key]);
    const refused = yield* f.next;
    assert.strictEqual(refused.type, "error");
    if (refused.type === "error") assert.isFalse(refused.permanent);
    yield* Queue.take(f.recorded);
    const failed = yield* Queue.take(f.recorded);
    assert.strictEqual(failed.type, "re-run");
    assert.strictEqual(failed.outcome, "failure");
    assert.strictEqual(failed.code, "source_unavailable");
    if (failed.type === "re-run") assert.strictEqual(failed.patchId, binding.patchId);
    f.state.failure = undefined;
    f.state.value = { rows: [{ id: "one", value: "recovered after refusal" }], cursor: null };
    yield* TestClock.adjust("250 millis");
    assert.deepStrictEqual(yield* f.next, {
      type: "snapshot",
      id: query.id,
      revision: "2",
      result: { rows: [{ id: "one", value: "recovered after refusal" }], cursor: null },
      vector: { [key]: "0", [lifecycle]: "0" }
    });
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
        yield* f.document.reconcile("invalidation", [key], `write-${write}`);
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
              documentId: "second_document",
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
        yield* f.document.reconcile("invalidation", [key]);
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
    yield* f.document.reconcile("invalidation", [key]);
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
      documentId: "another_document",
      binding: () => binding,
      check: Effect.void,
      scope: f.scope,
      send: (frame) => {
        Queue.offerUnsafe(f.frames, frame);
      }
    });
    const third = f.registry.attach({
      generation: "third",
      documentId: "another_document",
      binding: () => ({ ...binding, patchId: "other-patch" }),
      check: Effect.void,
      scope: f.scope,
      send: (frame) => {
        Queue.offerUnsafe(f.frames, frame);
      }
    });
    const fourth = f.registry.attach({
      generation: "fourth",
      documentId: "another_document",
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

const reruns = Effect.fnUntraced(function* (
  recorded: Queue.Queue<WideEvents.WideEvent>,
  count: number
) {
  const events: WideEvents.RerunEvent[] = [];
  while (events.length < count) {
    const event = yield* Queue.take(recorded);
    if (event.type === "re-run") events.push(event);
  }
  return events;
});
// Cap-agnostic: the slowest of the company and patch bounds decides how many run at once.
const cap = Math.min(
  registry["subscriptions.reruns.patch"].default,
  registry["subscriptions.reruns.company"].default
);

it.effect("measures slot waits from the first dirty transition, behind capped runs", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const gates = [yield* Deferred.make<void>(), yield* Deferred.make<void>()] as const;
    const subscriptions = Array.from({ length: 2 * cap + 1 }, (_, index) => ({
      ...query,
      id: `queued-${index}`
    }));
    f.state.gate = gates[0];
    yield* f.update({ type: "replace", sequence: 0, subscriptions });
    for (let index = 0; index < cap; index++) yield* Queue.take(f.started);
    yield* TestClock.adjust("100 millis");
    f.state.gate = gates[1];
    yield* Deferred.succeed(gates[0], undefined);
    for (let index = 0; index < cap; index++) yield* Queue.take(f.started);
    yield* TestClock.adjust("100 millis");
    f.state.gate = undefined;
    yield* Deferred.succeed(gates[1], undefined);
    const events = yield* reruns(f.recorded, subscriptions.length);
    // Each batch waits for the one before and holds its slot until its gate opens.
    assert.deepStrictEqual(
      events
        .map((event) => [event.slotWaitMs, event.slotOccupancyMs])
        .sort(([left = 0], [right = 0]) => left - right),
      subscriptions.map((_, index) => {
        const wait = Math.floor(index / cap) * 100;
        return [wait, wait === 200 ? 0 : 100];
      })
    );
    for (const event of events)
      assert.include(event, { trigger: "initial", disposition: "delivered" });
  }).pipe(Effect.scoped)
);

it.effect("keeps a coalesced wait's first trigger and discards a run a replace overtook", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const ops = (["tables.list", "tables.get", "shared.list", "shared.get"] as const).slice(
      0,
      cap + 1
    );
    const subscriptions = ops.map((op) => ({ ...query, id: op, op }));
    const gate = yield* Deferred.make<void>();
    f.state.gate = gate;
    yield* f.update({ type: "replace", sequence: 0, subscriptions });
    for (let index = 0; index < cap; index++) yield* Queue.take(f.started);
    yield* TestClock.adjust("50 millis");
    // The same desired set: running runs change epoch, and the waiting one is already dirty.
    yield* f.update({ type: "replace", sequence: 1, subscriptions });
    yield* TestClock.adjust("50 millis");
    f.state.gate = undefined;
    yield* Deferred.succeed(gate, undefined);
    const events = yield* reruns(f.recorded, 2 * cap + 1);
    const runs = (handler: string) =>
      events
        .filter((event) => event.handler === handler)
        .map(({ trigger, disposition, slotWaitMs }) => ({ trigger, disposition, slotWaitMs }));
    for (const op of ops.slice(0, cap))
      assert.deepStrictEqual(runs(op), [
        { trigger: "initial", disposition: "discarded", slotWaitMs: 0 },
        { trigger: "replace", disposition: "delivered", slotWaitMs: 50 }
      ]);
    assert.deepStrictEqual(runs(ops[cap]!), [
      { trigger: "initial", disposition: "delivered", slotWaitMs: 100 }
    ]);
  }).pipe(Effect.scoped)
);

it.effect("names what made each run dirty and what became of its result", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const next = Effect.map(reruns(f.recorded, 1), ([event]) => event!);
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    assert.include(yield* next, {
      trigger: "initial",
      disposition: "delivered",
      slotWaitMs: 0,
      streamId: "generation",
      documentId: "document_subscription"
    });
    f.state.revision++;
    yield* f.document.reconcile("invalidation", [key], "write-1");
    assert.include(yield* next, {
      trigger: "invalidation",
      disposition: "unchanged",
      causedByEventId: "write-1"
    });
    f.state.revision++;
    f.state.value = { rows: [{ id: "one", value: "changed" }], cursor: null };
    yield* f.document.reconcile("periodic");
    assert.include(yield* next, { trigger: "periodic", disposition: "delivered" });
    f.state.failure = new Runtime.SourceUnavailable({ cause: "temporarily offline" });
    yield* f.document.reconcile("invalidation", [key]);
    const failed = yield* next;
    assert.include(failed, { trigger: "invalidation", outcome: "failure" });
    assert.notProperty(failed, "disposition");
    f.state.failure = undefined;
    yield* TestClock.adjust("250 millis");
    assert.include(yield* next, {
      trigger: "retry",
      backoffMs: 250,
      slotWaitMs: 0,
      disposition: "unchanged"
    });
    yield* f.registry.rebind(binding.patchId, {});
    assert.include(yield* next, { trigger: "rebind", disposition: "unchanged" });
  }).pipe(Effect.scoped)
);

it.effect("reports the wait for execution ready apart from the slot wait", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let ready = false;
    const starting = f.registry.attach({
      generation: "starting",
      documentId: "starting_document",
      binding: () => binding,
      check: Effect.void,
      scope: f.scope,
      ready: () => ready,
      send: (frame) => {
        Queue.offerUnsafe(f.frames, frame);
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(starting.close));
    yield* starting.update({
      type: "subscribe",
      sequence: 1,
      subscription: query,
      patchId: binding.patchId,
      versionId: binding.versionId,
      documentId: "starting_document",
      generation: "starting"
    });
    yield* TestClock.adjust("100 millis");
    assert.strictEqual(f.state.admissions, 0);
    ready = true;
    yield* starting.reconcile("ready");
    // It was dirty before ready, so it keeps its own trigger and waited for no slot.
    assert.include((yield* reruns(f.recorded, 1))[0], {
      trigger: "initial",
      readyWaitMs: 100,
      slotWaitMs: 0
    });
  }).pipe(Effect.scoped)
);

it.effect("adds a revision check that answers without a read to the document's slot time", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* reruns(f.recorded, 1);
    yield* Queue.take(f.admitting);
    f.state.admissionGate = yield* Deferred.make<void>();
    yield* f.document.reconcile("periodic");
    yield* Queue.take(f.admitting);
    yield* TestClock.adjust("30 millis");
    yield* Deferred.succeed(f.state.admissionGate, undefined);
    while ((yield* f.next).type !== "up-to-date") {
      /* skip admission and the first snapshot */
    }
    assert.include(f.document.metrics(), { reruns: 1, checks: 1, checkMs: 30 });
    yield* Effect.yieldNow;
    assert.strictEqual(yield* Queue.size(f.recorded), 0);
  }).pipe(Effect.scoped)
);

it.effect("dates a wake for a dependency the run discovers from when it arrived", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const late = "table:source:late";
    f.state.late = late;
    const gate = yield* Deferred.make<void>();
    f.state.gate = gate;
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* Queue.take(f.started);
    yield* TestClock.adjust("100 millis");
    // Only the read's result names `late`, so the wake waits for the run to finish.
    yield* f.document.reconcile("invalidation", [late], "late-write");
    yield* TestClock.adjust("400 millis");
    f.state.gate = undefined;
    yield* Deferred.succeed(gate, undefined);
    const [first, second] = yield* reruns(f.recorded, 2);
    assert.include(first, { trigger: "initial", disposition: "delivered" });
    assert.include(second, { trigger: "invalidation", slotWaitMs: 400 });
  }).pipe(Effect.scoped)
);

it.effect("reports a retry backoff behind an earlier wake and keeps the wait before it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const gate = yield* Deferred.make<void>();
    f.state.gate = gate;
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* Queue.take(f.started);
    yield* TestClock.adjust("50 millis");
    yield* f.document.reconcile("invalidation", [key], "write-during-run");
    yield* TestClock.adjust("50 millis");
    f.state.failure = new Runtime.SourceUnavailable({ cause: "temporarily offline" });
    f.state.gate = undefined;
    yield* Deferred.succeed(gate, undefined);
    assert.include((yield* reruns(f.recorded, 1))[0], { trigger: "initial", outcome: "failure" });
    f.state.failure = undefined;
    yield* TestClock.adjust("250 millis");
    // Woken at 50, failed at 100, held by a 250 ms backoff and taken at 350.
    assert.include((yield* reruns(f.recorded, 1))[0], {
      trigger: "invalidation",
      backoffMs: 250,
      slotWaitMs: 50,
      disposition: "delivered"
    });
  }).pipe(Effect.scoped)
);

it.effect("names a run the ready reconcile dirtied after the opened gate let it run", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let ready = false;
    const starting = f.registry.attach({
      generation: "starting",
      documentId: "starting_document",
      binding: () => binding,
      check: Effect.void,
      scope: f.scope,
      ready: () => ready,
      send: (frame) => {
        Queue.offerUnsafe(f.frames, frame);
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(starting.close));
    yield* starting.update({
      type: "subscribe",
      sequence: 1,
      subscription: query,
      patchId: binding.patchId,
      versionId: binding.versionId,
      documentId: "starting_document",
      generation: "starting"
    });
    yield* TestClock.adjust("100 millis");
    ready = true;
    // The ready reconcile records ready, then waits on its limit lookup. A pump in that
    // window, here one another patch's rebind starts, runs the subscription first.
    const gate = yield* Deferred.make<void>();
    f.state.limitsGate = gate;
    const reconciling = yield* starting.reconcile("ready").pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* f.registry.rebind("another-patch", {});
    assert.include((yield* reruns(f.recorded, 1))[0], {
      trigger: "initial",
      readyWaitMs: 100,
      slotWaitMs: 0
    });
    f.state.revision++;
    f.state.limitsGate = undefined;
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(reconciling);
    assert.include((yield* reruns(f.recorded, 1))[0], { trigger: "ready", slotWaitMs: 0 });
  }).pipe(Effect.scoped)
);

it.effect("re-runs a read that fell behind its fence as a retry without a backoff", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.state.revision = 1;
    f.state.readLag = 1;
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    const [behind, caughtUp] = yield* reruns(f.recorded, 2);
    assert.include(behind, { trigger: "initial", outcome: "success", disposition: "discarded" });
    assert.include(caughtUp, { trigger: "retry", disposition: "delivered", slotWaitMs: 0 });
    assert.notProperty(caughtUp, "backoffMs");
  }).pipe(Effect.scoped)
);

it.effect("records a result or failure whose document closed during its read as discarded", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const failure of [undefined, new Runtime.SourceUnavailable({ cause: "offline" })]) {
      const documentId = failure === undefined ? "closing_document" : "failing_document";
      const closing = f.registry.attach({
        generation: documentId,
        documentId,
        binding: () => binding,
        check: Effect.void,
        scope: f.scope,
        send: () => {}
      });
      const gate = yield* Deferred.make<void>();
      f.state.gate = gate;
      yield* closing.update({
        type: "subscribe",
        sequence: 1,
        subscription: query,
        patchId: binding.patchId,
        versionId: binding.versionId,
        documentId,
        generation: documentId
      });
      yield* Queue.take(f.started);
      f.state.failure = failure;
      closing.close();
      f.state.gate = undefined;
      yield* Deferred.succeed(gate, undefined);
      assert.include(
        (yield* reruns(f.recorded, 1))[0],
        failure === undefined
          ? { outcome: "success", disposition: "discarded" }
          : { outcome: "failure", code: "source_unavailable", disposition: "discarded" }
      );
    }
  }).pipe(Effect.scoped)
);
