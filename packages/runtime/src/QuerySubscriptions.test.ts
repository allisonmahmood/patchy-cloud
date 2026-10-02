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
    call: (_args, _binding, reauthorize, observation) =>
      Effect.gen(function* () {
        state.calls++;
        yield* reauthorize;
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
      vector: { [ownTable]: "1" }
    });
    assert.strictEqual(f.state.calls, 1);
    assert.deepStrictEqual(f.revisionReads[0], [ownTable]);
    const allowed = new Set([
      ownTable,
      ownStore,
      sharedTable,
      sourcePatch,
      sharedStore,
      storeSource,
      memberDirectory
    ]);
    for (const keys of f.revisionReads) {
      assert.isAtMost(keys.length, allowed.size);
      for (const key of keys) assert.isTrue(allowed.has(key), key);
    }
    yield* f.document.reconcile([ownStore, sharedTable, sourcePatch]);
    yield* Effect.yieldNow;
    assert.strictEqual(f.state.calls, 1);
  }).pipe(Effect.scoped)
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
    yield* f.document.reconcile([sharedStore]);
    assert.deepStrictEqual(yield* f.next, {
      type: "snapshot",
      id: "query",
      revision: "8",
      result: "current",
      vector: { [sharedStore]: "7", [storeSource]: "6" }
    });
    assert.strictEqual(f.state.calls, 1);
  }).pipe(Effect.scoped)
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
        assert.deepStrictEqual(f.revisionReads[0], []);
        assert.strictEqual(f.state.calls, 1);
        f.state.failure = undefined;
        yield* f.document.reconcile([source]);
        assert.deepStrictEqual(yield* f.next, {
          type: "snapshot",
          id: "query",
          revision: "1",
          result: "current",
          vector: { [resource]: f.state.revisions[resource]!, [source]: f.state.revisions[source]! }
        });
        assert.strictEqual(f.state.calls, 2);
        for (const keys of f.revisionReads) {
          assert.notInclude(keys, ownTable);
          assert.notInclude(keys, ownStore);
        }
      }).pipe(Effect.scoped)
  );

it.effect(
  "refuses a member directory revision change during a query, outside its company snapshot",
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
          call: (_args, _binding, _reauthorize, observation) =>
            Effect.sync(() => {
              observation?.onDependency(memberDirectory);
              observation?.onSnapshot({});
              if (changeDuringQuery) revision++;
              return { ok: true as const, value: "members" };
            })
        })
      );
      const input = {
        binding,
        op: "server.call",
        args: { handler: "demo.read", args: {} },
        reauthorize: Effect.succeed(viewer)
      };
      assert.include(yield* readers.read(input).pipe(Effect.flip), { code: "source_unavailable" });
      changeDuringQuery = false;
      assert.deepStrictEqual(yield* readers.read(input), {
        result: "members",
        vector: { [memberDirectory]: "2" }
      });
    })
);
