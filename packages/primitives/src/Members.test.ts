import { assert, it } from "@effect/vitest";
import type { Member } from "@patchy/api";
import { CompanyDatabases } from "@patchy/company-database";
import * as Testing from "@patchy/company-database/testing";
import { Binding, InvocationCapabilities, LoadedVersions, Runtime } from "@patchy/runtime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as MemberDirectory from "./MemberDirectory.js";
import * as Members from "./Members.js";
import * as SubscriptionReads from "./SubscriptionReads.js";
import * as QuerySnapshot from "./QuerySnapshot.js";
import * as TestWakes from "./test/wakes.js";
import { manifest } from "./test/operationsContract.js";

const member: typeof Member.Type = {
  id: "owner",
  name: "Owner",
  email: "owner@example.test",
  admin: true,
  active: false
};
const binding = Binding.Binding.of({
  companyId: "cmp_dev",
  patchId: "memberdirectory",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  wireVersion: 1,
  scope: "company",
  manifest: { ...manifest, tier: 1, tables: {}, uses: { members: { kind: "members" } } },
  principal: { userId: "viewer" },
  identity: {
    user: { id: "viewer", name: "Viewer", email: "viewer@example.test" },
    company: { id: "cmp_dev", name: "Company", handle: "company" },
    admin: false
  },
  correlationId: "member-directory-test"
});
const services = Testing.layer().pipe(
  Layer.provideMerge(TestWakes.layer),
  Layer.provideMerge(
    Layer.succeed(LoadedVersions.LoadedVersions, {
      find: () => Effect.succeed(Option.none())
    })
  )
);
const fixture = Effect.gen(function* () {
  const state = { revision: 1, changeDuringRead: false, reads: 0, active: false };
  const read = Effect.sync(() => {
    state.reads++;
    if (state.changeDuringRead) state.revision++;
    return { ...member, active: state.active };
  });
  const directory = MemberDirectory.MemberDirectory.of({
    list: () => read.pipe(Effect.as({ rows: [], cursor: null })),
    search: () => read.pipe(Effect.as({ rows: [], cursor: null })),
    get: () => read,
    getMany: (_companyId, ids) =>
      read.pipe(Effect.as(ids.map((id) => (id === member.id ? member : null)))),
    isCandidate: () => Effect.succeed(false),
    revision: () => Effect.sync(() => String(state.revision))
  });
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const storage = CompanyDatabases.CompanyDatabases.of({
    ...databases,
    withCompany: () => () => Effect.die("Member directory reads must not acquire company storage"),
    lease: () => Effect.die("Member directory reads must not lease company storage")
  });
  const readers = yield* SubscriptionReads.makeDev.pipe(
    Effect.provideService(MemberDirectory.MemberDirectory, directory),
    Effect.provideService(CompanyDatabases.CompanyDatabases, storage)
  );
  const handlers = yield* Members.make.pipe(
    Effect.provideService(MemberDirectory.MemberDirectory, directory)
  );
  return { state, readers, handlers, storage };
});

it.layer(services)("Members", (it) => {
  it.effect("keeps member-only query callbacks outside company storage and its read snapshot", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const capabilities = yield* InvocationCapabilities.make;
      const snapshots = yield* QuerySnapshot.make.pipe(
        Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
        Effect.provideService(CompanyDatabases.CompanyDatabases, f.storage)
      );
      const capability = yield* capabilities.issue({
        binding: { ...binding, manifest: { ...binding.manifest, tier: 2 } },
        kind: "query",
        attempt: {
          invocationId: "member-snapshot",
          attemptId: "one",
          processGeneration: 1,
          deadline: (yield* Clock.currentTimeMillis) + 3000
        },
        reauthorize: Effect.succeed(binding.identity!)
      });
      const snapshot = yield* snapshots.open(capability);
      yield* Effect.addFinalizer(() => snapshot.cancel);
      const read = f.handlers["members.get"]
        .run({ id: member.id })
        .pipe(Effect.provideService(Binding.Binding, capability.binding));
      assert.deepStrictEqual(yield* snapshot.run(read), member);
      f.state.active = true;
      f.state.revision++;
      assert.deepStrictEqual(yield* snapshot.run(read), { ...member, active: true });
      assert.deepStrictEqual(snapshot.watermark, {});
      yield* snapshot.cancel;
      yield* capabilities.settle(capability.token, "returned");
    }).pipe(Effect.scoped)
  );

  it.effect("refuses undeclared, anonymous and other-company readers before directory access", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const bindings = [
        { ...binding, manifest: { ...binding.manifest, uses: {} } },
        { ...binding, scope: "public" as const, identity: null, principal: null },
        {
          ...binding,
          identity: {
            ...binding.identity!,
            company: { ...binding.identity!.company, id: "outside" }
          }
        }
      ];
      for (const denied of bindings) {
        const error = yield* f.handlers["members.list"]
          .run({})
          .pipe(Effect.provideService(Binding.Binding, denied), Effect.flip);
        assert.strictEqual(error.code, "access_denied");
      }
      assert.strictEqual(f.state.reads, 0);
      const tooMany = yield* f.handlers["members.getMany"]
        .run({ ids: Array(1001).fill("owner") })
        .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip);
      assert.instanceOf(tooMany, Runtime.LimitExceeded);
      assert.include(tooMany, { limitId: "members.getMany" });
      assert.strictEqual(f.state.reads, 0);
    })
  );

  it.effect(
    "subscribes every member read without company storage and rejects a changing directory fence",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const key = "members:cmp_dev";
        const cases = [
          { op: "members.list", args: {}, result: { rows: [], cursor: null } },
          { op: "members.search", args: { text: "own" }, result: { rows: [], cursor: null } },
          { op: "members.get", args: { id: "owner" }, result: member },
          {
            op: "members.getMany",
            args: { ids: ["owner", "missing", "owner"] },
            result: [member, null, member]
          }
        ];
        for (const operation of cases) {
          const dependencies: string[] = [];
          const input = {
            binding,
            ...operation,
            onDependency: (resource: string) => dependencies.push(resource)
          };
          assert.deepStrictEqual(yield* f.readers.admit(input), [key]);
          assert.deepStrictEqual(yield* f.readers.read(input), {
            result: operation.result,
            vector: { [key]: "1" }
          });
          assert.deepStrictEqual(dependencies, [key, key]);
        }
        f.state.changeDuringRead = true;
        const changed = yield* f.readers
          .read({ binding, op: "members.list", args: {} })
          .pipe(Effect.flip);
        assert.strictEqual(changed.code, "source_unavailable");
        f.state.changeDuringRead = false;
        assert.deepStrictEqual(yield* f.readers.revisions("cmp_dev", [key]), { [key]: "2" });
        assert.deepStrictEqual(yield* f.readers.read({ binding, op: "members.list", args: {} }), {
          result: { rows: [], cursor: null },
          vector: { [key]: "2" }
        });
        assert.strictEqual(
          (yield* f.readers.revisions("cmp_dev", ["members:outside"]).pipe(Effect.flip)).code,
          "access_denied"
        );
      })
  );
});
