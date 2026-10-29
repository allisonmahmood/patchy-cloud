import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
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
import { NodeCryptography } from "@patchy/core";

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
  const fencing = yield* Queue.make<void>();
  const checking = yield* Queue.make<void>();
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
    /** Holds a revision read after taking its fence, so a write can land just after it. */
    revisionsGate: undefined as Deferred.Deferred<void> | undefined,
    /** Holds the document's authority check. */
    checkGate: undefined as Deferred.Deferred<void> | undefined,
    limitsGate: undefined as Deferred.Deferred<void> | undefined,
    /** Dependencies only a read's result reveals, so a wake for one waits on the run. */
    revealed: [] as string[],
    /** Revisions beyond the source table's and its lifecycle's; a missing one reads as -1. */
    others: {} as Record<string, string>,
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
            ...Object.fromEntries(state.revealed.map((name) => [name, state.others[name] ?? "-1"]))
          }
        };
        state.readLag = 0;
        yield* Queue.offer(started, state.reads);
        if (state.gate !== undefined) yield* Deferred.await(state.gate);
        if (state.failure !== undefined) return yield* Effect.fail(state.failure);
        return snapshot;
      }),
    revisions: (_, keys) =>
      Effect.gen(function* () {
        const current: Record<string, string> = { ...vector(), ...state.others };
        const fence = Object.fromEntries(keys.map((name) => [name, current[name] ?? "-1"]));
        if (state.revisionsGate !== undefined) {
          yield* Queue.offer(fencing, undefined);
          yield* Deferred.await(state.revisionsGate);
        }
        if (state.failure !== undefined) return yield* Effect.fail(state.failure);
        return fence;
      })
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
    Effect.provideService(WideEvents.WideEvents, events),
    Effect.provide(NodeCryptography.layer)
  );
  const document = registry.attach({
    generation: "generation",
    documentId: "document_subscription",
    binding: () => binding,
    check: Effect.suspend(() => {
      const gate = state.checkGate;
      return gate === undefined
        ? Effect.void
        : Queue.offer(checking, undefined).pipe(Effect.andThen(Deferred.await(gate)));
    }),
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
    fencing,
    checking,
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

it.effect("reports a change to the logical desired set only as its deltas apply", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const other: RuntimeSubscription = { id: "other", op: "shared.list", args: { alias: "other" } };
    assert.isTrue(yield* f.update({ type: "replace", sequence: 0, subscriptions: [query, other] }));
    // Order, revisions and vectors are not the logical set; ids, operations and args are.
    assert.isFalse(
      yield* f.update({
        type: "replace",
        sequence: 1,
        subscriptions: [{ ...other, revision: "3", vector: { [key]: "3" } }, query]
      })
    );
    assert.isTrue(
      yield* f.update({
        type: "replace",
        sequence: 2,
        subscriptions: [query, { ...other, args: { alias: "renamed" } }]
      })
    );
    // Repeated, stale and buffered deltas change nothing until they apply.
    assert.isFalse(yield* f.update({ type: "unsubscribe", sequence: 2, id: other.id }));
    assert.instanceOf(
      yield* f.update({ type: "unsubscribe", sequence: 1, id: other.id }).pipe(Effect.flip),
      Subscriptions.StaleSequence
    );
    assert.isFalse(yield* f.update({ type: "unsubscribe", sequence: 4, id: query.id }));
    assert.isTrue(yield* f.update({ type: "unsubscribe", sequence: 3, id: other.id }));
  }).pipe(Effect.scoped)
);

it.effect("compares a generation's first set with the one its document last admitted", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const desired: Subscriptions.Desired = { value: undefined };
    const generation = (name: string) => {
      const document = f.registry.attach({
        generation: name,
        documentId: "document_generations",
        binding: () => binding,
        check: Effect.void,
        scope: f.scope,
        send: () => {},
        desired
      });
      const replace = (subscriptions: readonly RuntimeSubscription[]) =>
        document.update({
          patchId: binding.patchId,
          versionId: binding.versionId,
          documentId: "document_generations",
          generation: name,
          type: "replace",
          sequence: 0,
          subscriptions
        });
      return { document, replace };
    };
    const first = generation("first");
    assert.isTrue(yield* first.replace([query]));
    first.document.close();
    // A reconnect's replace repeats the set with what it received meanwhile.
    const second = generation("second");
    assert.isFalse(yield* second.replace([{ ...query, revision: "1", vector: f.vector() }]));
    second.document.close();
    // One that carries changes made while disconnected is a change.
    const third = generation("third");
    assert.isTrue(yield* third.replace([]));
    third.document.close();
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

it.effect("bounds admission and reads to two company runs, which one patch may fill", () =>
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

it.effect("starts two runs at once for a document with several dirty subscriptions", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.state.gate = yield* Deferred.make<void>();
    const ids = ["first", "second", "third", "fourth"];
    yield* f.update({
      type: "replace",
      sequence: 0,
      subscriptions: ids.map((id) => ({ ...query, id }))
    });
    yield* f.next;
    yield* Queue.take(f.started);
    yield* Queue.take(f.started);
    yield* Effect.yieldNow;
    assert.strictEqual(f.state.reads, 2);
    const gate = f.state.gate;
    f.state.gate = undefined;
    yield* Deferred.succeed(gate, undefined);
    const delivered = new Set<string>();
    while (delivered.size < ids.length) {
      const frame = yield* f.next;
      if (frame.type === "snapshot") delivered.add(frame.id);
    }
    assert.strictEqual(f.state.reads, ids.length);
  }).pipe(Effect.scoped)
);

it.effect("serves every document of two patches under sustained invalidation", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const readMs = 100;
    let revision = 0;
    const running = new Map<string, number>();
    const peaks = { company: 0, patch: 0 };
    const starts = new Map<string, number[]>();
    const reader: SubscriptionReads.SubscriptionReads["Service"] = {
      admit: () => Effect.succeed([key]),
      revisions: () => Effect.sync(() => ({ [key]: String(revision) })),
      read: (input) => {
        const patchId = input.binding.patchId;
        const label = `${patchId}/${String(input.args.label)}`;
        return Effect.gen(function* () {
          const vector = { [key]: String(revision) };
          starts.set(label, [...(starts.get(label) ?? []), yield* Clock.currentTimeMillis]);
          running.set(patchId, (running.get(patchId) ?? 0) + 1);
          peaks.patch = Math.max(peaks.patch, running.get(patchId)!);
          peaks.company = Math.max(
            peaks.company,
            [...running.values()].reduce((sum, count) => sum + count, 0)
          );
          yield* Effect.sleep(readMs);
          return { result: vector[key], vector };
        }).pipe(
          Effect.ensuring(Effect.sync(() => running.set(patchId, running.get(patchId)! - 1)))
        );
      }
    };
    const registry = yield* Subscriptions.make.pipe(
      Effect.provideService(SubscriptionReads.SubscriptionReads, reader),
      Effect.provide([StreamLimits.layerLocal, NodeCryptography.layer]),
      Effect.provide(WideEvents.layerNoop)
    );
    // Two documents of one patch and one of another, all in one company.
    const documents = ["alpha", "alpha", "beta"].map((patchId, index) => {
      const generation = `generation-${index}`;
      const document = registry.attach({
        generation,
        documentId: generation,
        binding: () => ({ ...binding, patchId }),
        check: Effect.void,
        scope,
        send: () => {}
      });
      const subscriptions = ["one", "two", "three"].map((name) => ({
        ...query,
        id: name,
        args: { ...query.args, label: `${index}-${name}` }
      }));
      return { document, patchId, generation, subscriptions };
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const { document } of documents) document.close();
      })
    );
    for (const { document, patchId, generation, subscriptions } of documents)
      yield* document.update({
        type: "replace",
        sequence: 0,
        subscriptions,
        patchId,
        versionId: binding.versionId,
        documentId: generation,
        generation
      });
    // Writes land four times per read, so every subscription stays dirty throughout.
    const durationMs = 3_000;
    for (let elapsed = 0; elapsed < durationMs; elapsed += readMs / 4) {
      revision++;
      for (const { document } of documents) yield* document.reconcile("invalidation", [key]);
      yield* TestClock.adjust(readMs / 4);
    }
    assert.deepStrictEqual(peaks, { company: 2, patch: 2 });
    assert.strictEqual(starts.size, 9);
    // Documents take turns with both slots, and a turn runs two of its document's three
    // subscriptions, so none waits more than two rounds. Patches share by document count.
    for (const [label, times] of starts) {
      const gaps = times.slice(1).map((time, index) => time - times[index]!);
      assert.isAtMost(Math.max(...gaps), 2 * documents.length * readMs, label);
      assert.isAtLeast(times.length, 6, label);
    }
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

it.effect("keeps a coalesced wait's first trigger and the runs a replace overlapped", () =>
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
    // The same desired set: running reads answer it unchanged, and the waiting one is dirty.
    yield* f.update({ type: "replace", sequence: 1, subscriptions });
    yield* TestClock.adjust("50 millis");
    f.state.gate = undefined;
    yield* Deferred.succeed(gate, undefined);
    const events = yield* reruns(f.recorded, cap + 1);
    const runs = (handler: string) =>
      events
        .filter((event) => event.handler === handler)
        .map(({ trigger, disposition, slotWaitMs }) => ({ trigger, disposition, slotWaitMs }));
    for (const op of ops.slice(0, cap))
      assert.deepStrictEqual(runs(op), [
        { trigger: "initial", disposition: "delivered", slotWaitMs: 0 }
      ]);
    assert.deepStrictEqual(runs(ops[cap]!), [
      { trigger: "initial", disposition: "delivered", slotWaitMs: 100 }
    ]);
    assert.strictEqual(f.state.reads, cap + 1);
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
    f.state.revealed = [late];
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

/** Subscribes `query` and holds its read once it starts; the returned effect lets it finish. */
const holdRead = Effect.fnUntraced(function* (f: Effect.Success<typeof fixture>) {
  const gate = yield* Deferred.make<void>();
  f.state.gate = gate;
  yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
  assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 1 });
  yield* Queue.take(f.started);
  f.state.gate = undefined;
  return Deferred.succeed(gate, undefined);
});

it.effect("answers a replace that overlaps a read with that read when nothing changed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const release = yield* holdRead(f);
    yield* f.update({ type: "replace", sequence: 1, subscriptions: [query] });
    assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 1 });
    yield* release;
    assert.include((yield* reruns(f.recorded, 1))[0], {
      trigger: "initial",
      disposition: "delivered"
    });
    assert.deepStrictEqual(yield* f.next, {
      type: "snapshot",
      id: query.id,
      revision: "1",
      result: f.state.value,
      vector: f.vector()
    });
    // An unchanged reconcile answers from revisions alone: the replace left no read behind.
    yield* f.document.reconcile("periodic");
    assert.strictEqual((yield* f.next).type, "up-to-date");
    assert.strictEqual(f.state.reads, 1);
  }).pipe(Effect.scoped)
);

it.effect("runs again when a write whose wake was lost precedes a replace during the read", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const release = yield* holdRead(f);
    f.state.revision++;
    f.state.value = { rows: [{ id: "one", value: "written during the read" }], cursor: null };
    yield* f.update({ type: "replace", sequence: 1, subscriptions: [query] });
    assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 1 });
    yield* release;
    assert.include((yield* reruns(f.recorded, 1))[0], {
      trigger: "initial",
      disposition: "discarded"
    });
    assert.include((yield* reruns(f.recorded, 1))[0], {
      trigger: "replace",
      disposition: "delivered"
    });
    // The first answer after the replace's admission carries the write.
    assert.deepStrictEqual(yield* f.next, {
      type: "snapshot",
      id: query.id,
      revision: "1",
      result: f.state.value,
      vector: f.vector()
    });
  }).pipe(Effect.scoped)
);

it.effect("sends a full snapshot when an unchanged read overlaps a replace that missed one", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* f.next;
    const received = yield* f.next;
    assert(received.type === "snapshot");
    f.state.revision++;
    f.state.value = { rows: [{ id: "one", value: "missed" }], cursor: null };
    yield* f.document.reconcile("invalidation", [key]);
    assert.strictEqual((yield* f.next).type, "snapshot");
    // A write that leaves the result as it was starts a read, and the client's repair overlaps it.
    const gate = yield* Deferred.make<void>();
    f.state.gate = gate;
    f.state.revision++;
    yield* f.document.reconcile("invalidation", [key]);
    while ((yield* Queue.take(f.started)) < 3) {
      /* skip the reads before this one */
    }
    yield* f.update({
      type: "replace",
      sequence: 1,
      subscriptions: [{ ...query, vector: received.vector, revision: received.revision }]
    });
    assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 1 });
    f.state.gate = undefined;
    yield* Deferred.succeed(gate, undefined);
    assert.deepStrictEqual(yield* f.next, {
      type: "snapshot",
      id: query.id,
      revision: "3",
      result: f.state.value,
      vector: f.vector()
    });
    assert.strictEqual(f.state.reads, 3);
  }).pipe(Effect.scoped)
);

it.effect("checks overlapping replaces against a fence taken after the last one", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const release = yield* holdRead(f);
    for (const sequence of [1, 2]) {
      yield* f.update({ type: "replace", sequence, subscriptions: [query] });
      assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence });
    }
    const checking = yield* Deferred.make<void>();
    f.state.revisionsGate = checking;
    yield* release;
    yield* Queue.take(f.fencing);
    f.state.revisionsGate = undefined;
    // That fence still matches the read. A write whose wake is lost lands after it, then a
    // third replace, so the read can't answer the third.
    f.state.revision++;
    f.state.value = { rows: [{ id: "one", value: "written during the check" }], cursor: null };
    yield* f.update({ type: "replace", sequence: 3, subscriptions: [query] });
    assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 3 });
    yield* Deferred.succeed(checking, undefined);
    assert.include((yield* reruns(f.recorded, 1))[0], {
      trigger: "initial",
      disposition: "discarded"
    });
    assert.include((yield* reruns(f.recorded, 1))[0], {
      trigger: "replace",
      disposition: "delivered"
    });
    assert.deepStrictEqual(yield* f.next, {
      type: "snapshot",
      id: query.id,
      revision: "1",
      result: f.state.value,
      vector: f.vector()
    });
  }).pipe(Effect.scoped)
);

it.effect("discards a replaced read that a rebind overtakes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const release = yield* holdRead(f);
    yield* f.update({ type: "replace", sequence: 1, subscriptions: [query] });
    yield* f.next;
    yield* f.registry.rebind(binding.patchId, {});
    assert.deepStrictEqual(yield* f.next, { type: "handlers", kinds: {} });
    yield* release;
    const [overtaken, rebound] = yield* reruns(f.recorded, 2);
    assert.include(overtaken, { trigger: "initial", disposition: "discarded" });
    assert.include(rebound, { disposition: "delivered" });
    assert.strictEqual((yield* f.next).type, "snapshot");
    assert.strictEqual(f.state.reads, 2);
  }).pipe(Effect.scoped)
);

it.effect("discards a read whose subscription was removed and added again meanwhile", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const release = yield* holdRead(f);
    yield* f.update({ type: "unsubscribe", sequence: 2, id: query.id });
    assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 2 });
    yield* f.update({ type: "subscribe", sequence: 3, subscription: query });
    assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 3 });
    assert.include((yield* reruns(f.recorded, 1))[0], { disposition: "delivered" });
    assert.strictEqual((yield* f.next).type, "snapshot");
    yield* release;
    assert.include((yield* reruns(f.recorded, 1))[0], { disposition: "discarded" });
    // The removed read sent nothing, so the next frame answers this reconcile.
    yield* f.document.reconcile("periodic");
    assert.strictEqual((yield* f.next).type, "up-to-date");
    assert.strictEqual(f.state.reads, 2);
  }).pipe(Effect.scoped)
);

it.effect("sends nothing for a replaced read whose document closed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const release = yield* holdRead(f);
    yield* f.update({ type: "replace", sequence: 1, subscriptions: [query] });
    yield* f.next;
    f.document.close();
    yield* release;
    assert.include((yield* reruns(f.recorded, 1))[0], { disposition: "discarded" });
    assert.strictEqual(yield* Queue.size(f.frames), 0);
    assert.strictEqual(f.state.reads, 1);
  }).pipe(Effect.scoped)
);

it.effect("ends a run after one freshness check so a queued document gets its slot", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const gate = yield* Deferred.make<void>();
    f.state.gate = gate;
    const noisy = Array.from({ length: cap }, (_, index) => ({ ...query, id: `noisy-${index}` }));
    yield* f.update({ type: "replace", sequence: 0, subscriptions: noisy });
    yield* f.next;
    yield* Effect.forEach(noisy, () => Queue.take(f.started), { discard: true });
    f.state.gate = undefined;
    // Another document's subscription waits for a slot the noisy reads hold.
    const quietChecks = yield* Queue.make<void>();
    const quietFrames = yield* Queue.make<RuntimeStreamFrame>();
    const quiet = f.registry.attach({
      generation: "quiet",
      documentId: "quiet_document",
      binding: () => binding,
      check: Queue.offer(quietChecks, undefined).pipe(Effect.asVoid),
      scope: f.scope,
      send: (frame) => {
        Queue.offerUnsafe(quietFrames, frame);
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(quiet.close));
    yield* quiet.update({
      type: "subscribe",
      sequence: 1,
      subscription: query,
      patchId: binding.patchId,
      versionId: binding.versionId,
      documentId: "quiet_document",
      generation: "quiet"
    });
    assert.deepStrictEqual(yield* Queue.take(quietFrames), { type: "admitted", sequence: 1 });
    // A replace during the reads sends each to a freshness check, and another lands during it.
    yield* f.update({ type: "replace", sequence: 1, subscriptions: noisy });
    yield* f.next;
    const fences = yield* Deferred.make<void>();
    f.state.revisionsGate = fences;
    yield* Deferred.succeed(gate, undefined);
    yield* Effect.forEach(noisy, () => Queue.take(f.fencing), { discard: true });
    const later = yield* Deferred.make<void>();
    f.state.revisionsGate = later;
    yield* f.update({ type: "replace", sequence: 2, subscriptions: noisy });
    yield* f.next;
    yield* Deferred.succeed(fences, undefined);
    // Checking again would hold every slot; ending frees them, so the quiet document runs.
    const first = yield* Effect.raceFirst(
      Queue.take(quietChecks).pipe(Effect.as("quiet")),
      Effect.forEach(noisy, () => Queue.take(f.fencing), { discard: true }).pipe(Effect.as("noisy"))
    );
    assert.strictEqual(first, "quiet");
    f.state.revisionsGate = undefined;
    yield* Deferred.succeed(later, undefined);
    assert.strictEqual((yield* Queue.take(quietFrames)).type, "snapshot");
  }).pipe(Effect.scoped)
);

it.effect("discards a fresh result when a replace lands during its final authority check", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const release = yield* holdRead(f);
    yield* f.update({ type: "replace", sequence: 1, subscriptions: [query] });
    yield* f.next;
    const check = yield* Deferred.make<void>();
    f.state.checkGate = check;
    yield* release;
    yield* Queue.take(f.checking);
    f.state.checkGate = undefined;
    yield* f.update({ type: "replace", sequence: 2, subscriptions: [query] });
    assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 2 });
    yield* Deferred.succeed(check, undefined);
    assert.include((yield* reruns(f.recorded, 1))[0], {
      trigger: "initial",
      disposition: "discarded"
    });
    assert.include((yield* reruns(f.recorded, 1))[0], {
      trigger: "replace",
      disposition: "delivered"
    });
    assert.strictEqual((yield* f.next).type, "snapshot");
    assert.strictEqual(f.state.reads, 2);
  }).pipe(Effect.scoped)
);

it.effect("sends no revision-only up-to-date when a replace lands during its authority check", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.update({ type: "subscribe", sequence: 1, subscription: query });
    yield* f.next;
    const received = yield* f.next;
    assert(received.type === "snapshot");
    // An unchanged reconcile reaches its revision check and waits at the authority check.
    const admission = yield* Deferred.make<void>();
    f.state.admissionGate = admission;
    yield* f.document.reconcile("periodic");
    while ((yield* Queue.take(f.admitting)) < 2) {
      /* skip the first run's admission */
    }
    const check = yield* Deferred.make<void>();
    f.state.checkGate = check;
    f.state.admissionGate = undefined;
    yield* Deferred.succeed(admission, undefined);
    yield* Queue.take(f.checking);
    f.state.checkGate = undefined;
    yield* f.update({
      type: "replace",
      sequence: 1,
      subscriptions: [{ ...query, vector: received.vector, revision: received.revision }]
    });
    assert.deepStrictEqual(yield* f.next, { type: "admitted", sequence: 1 });
    yield* Deferred.succeed(check, undefined);
    assert.deepStrictEqual(yield* f.next, {
      type: "up-to-date",
      id: query.id,
      revision: received.revision,
      vector: f.vector()
    });
    // The held check sent nothing; a second revision check answered the replace.
    assert.strictEqual(f.state.admissions, 3);
    assert.strictEqual(f.state.reads, 1);
  }).pipe(Effect.scoped)
);

for (const stage of ["read", "freshness check"] as const)
  it.effect(`drops a ${stage} failure a replace overlapped and runs again at once`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const release = yield* holdRead(f);
      yield* f.update({ type: "replace", sequence: 1, subscriptions: [query] });
      yield* f.next;
      const fence = yield* Deferred.make<void>();
      if (stage === "freshness check") f.state.revisionsGate = fence;
      else f.state.failure = new Runtime.SourceUnavailable({ cause: "offline" });
      // The next run's admission waits, so the failure can clear before it reads.
      const admission = yield* Deferred.make<void>();
      f.state.admissionGate = admission;
      yield* release;
      if (stage === "freshness check") {
        yield* Queue.take(f.fencing);
        f.state.revisionsGate = undefined;
        f.state.failure = new Runtime.SourceUnavailable({ cause: "offline" });
        yield* Deferred.succeed(fence, undefined);
      }
      assert.include((yield* reruns(f.recorded, 1))[0], {
        outcome: "failure",
        code: "source_unavailable",
        disposition: "discarded"
      });
      // Admitted again without any time passing: no retry backoff and no reconcile timer.
      while ((yield* Queue.take(f.admitting)) < 2) {
        /* skip the first run's admission */
      }
      f.state.failure = undefined;
      f.state.admissionGate = undefined;
      yield* Deferred.succeed(admission, undefined);
      assert.strictEqual((yield* f.next).type, "snapshot");
    }).pipe(Effect.scoped)
  );

for (const change of ["nothing", "a dependency only the read revealed", "an absent resource"])
  it.effect(`checks a replaced read against its own dependencies when ${change} changed`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const revealed = "table:source:revealed";
      const absent = "table:source:absent";
      f.state.revealed = [revealed, absent];
      f.state.others = { [revealed]: "4" };
      const release = yield* holdRead(f);
      // Each write's wake is lost; only the replace's fence can see it.
      if (change === "a dependency only the read revealed") f.state.others = { [revealed]: "5" };
      if (change === "an absent resource") f.state.others = { [revealed]: "4", [absent]: "0" };
      yield* f.update({ type: "replace", sequence: 1, subscriptions: [query] });
      yield* f.next;
      yield* release;
      const answer = yield* f.next;
      assert(answer.type === "snapshot");
      assert.deepStrictEqual(answer.vector, {
        ...f.vector(),
        [revealed]: f.state.others[revealed]!,
        [absent]: f.state.others[absent] ?? "-1"
      });
      assert.strictEqual(f.state.reads, change === "nothing" ? 1 : 2);
    }).pipe(Effect.scoped)
  );
