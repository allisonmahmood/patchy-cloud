import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type RuntimeStreamFrame } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import type * as Binding from "./Binding.js";
import * as Invocation from "./Invocation.js";
import * as Runtime from "./Runtime.js";
import * as StreamLimits from "./StreamLimits.js";
import * as SubscriptionReads from "./SubscriptionReads.js";
import * as Subscriptions from "./Subscriptions.js";
import * as QuerySubscriptions from "./QuerySubscriptions.js";
import { NodeCryptography } from "@patchy/core";

const ownTable = "table:consumer:notes";
const ownStore = "store:consumer:images";
const sharedTable = "table:source:items";
const sourcePatch = "patch:source";
const sharedStore = "store:filesource:assets";
const storeSource = "patch:filesource";
const memberDirectory = "members:company";
const viewer = {
  user: { id: "viewer", name: "Viewer", email: "viewer@patchy.local" },
  company: { id: "company", name: "Company", handle: "company" },
  admin: false
};
const shared = {
  kind: "sharedTable" as const,
  patchId: "source",
  table: "items",
  id: "source/items",
  revision: 1
};
const binding: Binding.Binding["Service"] = {
  patchId: "consumer",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  companyId: "company",
  wireVersion: WIRE_VERSION,
  scope: "company",
  principal: { userId: viewer.user.id },
  identity: viewer,
  reauthorize: Effect.succeed(viewer),
  correlationId: "query-subscription-test",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {
      notes: { description: "Notes", columns: { title: { kind: "text" } }, indexes: {} }
    },
    files: { images: { description: "Images" } },
    uses: {
      members: { kind: "members" },
      catalog: shared,
      duplicate: shared,
      assets: {
        kind: "sharedStore",
        patchId: "filesource",
        store: "assets",
        id: "filesource/assets",
        revision: 1
      },
      warehouse: { kind: "postgres", handle: "warehouse", id: "connection", revision: 1 }
    },
    handlers: { "demo.read": { kind: "query", args: {}, result: { kind: "text" } } }
  }
};

const fixture = Effect.gen(function* () {
  const frames = yield* Queue.unbounded<RuntimeStreamFrame>();
  const revisionReads: Array<readonly string[]> = [];
  const state = {
    calls: 0,
    dependencies: [ownTable],
    failure: undefined as Runtime.RuntimeError | undefined,
    revisions: {
      "patch:consumer": "0",
      [ownTable]: "1",
      [ownStore]: "2",
      [sharedTable]: "3",
      [sourcePatch]: "4",
      [sharedStore]: "5",
      [storeSource]: "6",
      [memberDirectory]: "7"
    } as Record<string, string>
  };
  const storage: SubscriptionReads.SubscriptionReads["Service"] = {
    admit: () => Effect.die("Query admission must use the hosted-query adapter"),
    read: () => Effect.die("Query reads must use the hosted-query adapter"),
    revisions: (_companyId, keys) =>
      Effect.sync(() => {
        revisionReads.push([...keys]);
        return Object.fromEntries(keys.map((key) => [key, state.revisions[key] ?? "0"]));
      })
  };
  const invocations: Invocation.Invocation["Service"] = {
    call: (_args, called, observation) =>
      Effect.gen(function* () {
        state.calls++;
        yield* called.reauthorize;
        for (const key of state.dependencies) observation?.onDependency(key);
        if (state.failure !== undefined) return yield* Effect.fail(state.failure);
        observation?.onSnapshot(state.revisions);
        return { ok: true as const, value: "current" };
      })
  };
  const registry = yield* Subscriptions.make.pipe(
    Effect.provideService(SubscriptionReads.SubscriptionReads, storage),
    Effect.provideService(Invocation.Invocation, invocations),
    Effect.provide(StreamLimits.layerLocal),
    Effect.provide(WideEvents.layerNoop)
  );
  const document = registry.attach({
    generation: "generation",
    documentId: "query_document",
    binding: () => binding,
    check: Effect.void,
    scope: yield* Scope.Scope,
    send: (frame) => {
      Queue.offerUnsafe(frames, frame);
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(document.close));
  const subscribe = (vector?: Readonly<Record<string, string>>) =>
    document.update({
      type: "replace",
      patchId: binding.patchId,
      versionId: binding.versionId,
      documentId: "document_query_subscriptions",
      generation: "generation",
      sequence: 0,
      subscriptions: [
        {
          id: "query",
          op: "server.call",
          args: { handler: "demo.read", args: {} },
          ...(vector === undefined ? {} : { vector: { ...vector }, revision: "7" })
        }
      ]
    });
  return { state, revisionReads, document, subscribe, next: Queue.take(frames) };
});

it.effect("discards unrelated resume keys before reading revisions and repairs the snapshot", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const vector: Record<string, string> = { [ownTable]: "1" };
    for (let index = 0; index < 10_000; index++) {
      vector[`table:unrelated${index}:items`] = "0";
      vector[`patch:unrelated${index}`] = "0";
    }
    for (const key of [
      "table:consumer:undeclared",
      "store:consumer:undeclared",
      "table:source:private",
      "store:source:images",
      "table:source:catalog",
      "table:consumer:catalog",
      "patch:consumer",
      "patch:connection"
    ])
      vector[key] = "0";
    yield* f.subscribe(vector);
    assert.strictEqual((yield* f.next).type, "admitted");
    assert.deepStrictEqual(yield* f.next, {
      type: "snapshot",
      id: "query",
      revision: "8",
      result: "current",
      vector: { "patch:consumer": "0", [memberDirectory]: "7", [ownTable]: "1" }
    });
    assert.strictEqual(f.state.calls, 1);
    assert.deepStrictEqual(f.revisionReads[0], ["patch:consumer", memberDirectory, ownTable]);
    const allowed = new Set([
      "patch:consumer",
      ownTable,
      ownStore,
      sharedTable,
      sourcePatch,
      sharedStore,
      storeSource,
      memberDirectory,
      "connection:connection"
    ]);
    for (const keys of f.revisionReads) {
      assert.isAtMost(keys.length, allowed.size);
      for (const key of keys) assert.isTrue(allowed.has(key), key);
    }
    yield* f.document.reconcile("invalidation", [ownStore, sharedTable, sourcePatch]);
    yield* Effect.yieldNow;
    assert.strictEqual(f.state.calls, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);

it.effect("resumes equal owned and canonical shared revisions without invoking the query", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.subscribe(f.state.revisions);
    assert.strictEqual((yield* f.next).type, "admitted");
    assert.deepStrictEqual(yield* f.next, {
      type: "up-to-date",
      id: "query",
      revision: "7",
      vector: f.state.revisions
    });
    assert.strictEqual(f.state.calls, 0);
    assert.deepStrictEqual(new Set(f.revisionReads[0]), new Set(Object.keys(f.state.revisions)));
    f.state.dependencies = [sharedStore, storeSource];
    f.state.revisions[sharedStore] = "7";
    yield* f.document.reconcile("invalidation", [sharedStore]);
    assert.deepStrictEqual(yield* f.next, {
      type: "snapshot",
      id: "query",
      revision: "8",
      result: "current",
      vector: {
        "patch:consumer": "0",
        [memberDirectory]: "7",
        [sharedStore]: "7",
        [storeSource]: "6"
      }
    });
    assert.strictEqual(f.state.calls, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);

for (const [resource, source] of [
  [sharedTable, sourcePatch],
  [sharedStore, storeSource],
  [memberDirectory, memberDirectory]
] as const)
  it.effect(
    `keeps failed first ${resource} accesses recoverable without tracing unused declarations`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.state.dependencies = [resource, source];
        f.state.failure = new Runtime.AccessDenied({});
        yield* f.subscribe();
        assert.strictEqual((yield* f.next).type, "admitted");
        const refused = yield* f.next;
        assert.strictEqual(refused.type, "error");
        if (refused.type === "error") {
          assert.isFalse(refused.permanent);
          assert.strictEqual(refused.error.code, "access_denied");
        }
        assert.deepStrictEqual(f.revisionReads[0], ["patch:consumer", memberDirectory]);
        assert.strictEqual(f.state.calls, 1);
        f.state.failure = undefined;
        yield* f.document.reconcile("invalidation", [source]);
        assert.deepStrictEqual(yield* f.next, {
          type: "snapshot",
          id: "query",
          revision: "1",
          result: "current",
          vector: {
            "patch:consumer": "0",
            [memberDirectory]: "7",
            [resource]: f.state.revisions[resource]!,
            [source]: f.state.revisions[source]!
          }
        });
        assert.strictEqual(f.state.calls, 2);
        for (const keys of f.revisionReads) {
          assert.notInclude(keys, ownTable);
          assert.notInclude(keys, ownStore);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
  );

it.effect(
  "fences membership changes even when the query declares and reads no member directory",
  () =>
    Effect.gen(function* () {
      let revision = 1;
      let changeDuringQuery = true;
      const readers = yield* QuerySubscriptions.make.pipe(
        Effect.provideService(SubscriptionReads.SubscriptionReads, {
          admit: () => Effect.die("Unexpected direct admission"),
          read: () => Effect.die("Unexpected direct read"),
          revisions: (_companyId, keys) =>
            Effect.succeed(
              Object.fromEntries(
                keys.map((key) => [key, key === memberDirectory ? String(revision) : "0"])
              )
            )
        }),
        Effect.provideService(Invocation.Invocation, {
          call: (_args, _binding, observation) =>
            Effect.sync(() => {
              observation?.onSnapshot({});
              if (changeDuringQuery) revision++;
              return { ok: true as const, value: "members" };
            })
        })
      );
      const input = {
        binding: { ...binding, manifest: { ...binding.manifest, uses: {} } },
        op: "server.call",
        args: { handler: "demo.read", args: {} }
      };
      assert.include(yield* readers.read(input).pipe(Effect.flip), { code: "source_unavailable" });
      changeDuringQuery = false;
      assert.deepStrictEqual(yield* readers.read(input), {
        result: "members",
        vector: { "patch:consumer": "0", [memberDirectory]: "2" }
      });
    }).pipe(Effect.provide(NodeCryptography.layer))
);

it.effect(
  "rechecks traced connection authority and recovers after a connection grant is restored",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const key = "connection:connection";
      f.state.dependencies = [key];
      f.state.revisions[key] = "0";
      yield* f.subscribe();
      assert.equal((yield* f.next).type, "admitted");
      const snapshot = yield* f.next;
      assert.equal(snapshot.type, "snapshot");
      if (snapshot.type === "snapshot") assert.equal(snapshot.vector[key], "0");
      f.state.failure = new Runtime.AccessDenied({});
      f.state.revisions[key] = "1";
      yield* f.document.reconcile("invalidation", [key]);
      const denied = yield* f.next;
      assert.equal(denied.type, "error");
      if (denied.type === "error") {
        assert.equal(denied.error.code, "access_denied");
        assert.equal(denied.permanent, false);
      }
      f.state.failure = undefined;
      f.state.revisions[key] = "2";
      yield* f.document.reconcile("invalidation", [key]);
      const restored = yield* f.next;
      assert.equal(restored.type, "up-to-date");
      if (restored.type === "up-to-date") assert.equal(restored.vector[key], "2");
      assert.equal(f.state.calls, 3);
    }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);
