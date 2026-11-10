import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { TestClock } from "effect/testing";
import * as HttpRouter from "effect/http/HttpRouter";
import { RequireSession } from "@patchy/auth";
import { Patches } from "@patchy/patches";
import { Prewarm } from "@patchy/runtime";
import {
  routes,
  services,
  socket,
  DAY,
  type Person,
  company,
  actor,
  publish,
  request,
  invoke,
  seedOf,
  publishTier2
} from "../test/fixtures.js";
import { callSummary } from "./handlers.js";

/** Each prewarm a page asked for, in order; a host beside the fleet would start each. */
const prewarms: Array<Parameters<Prewarm.Prewarm["Service"]["prewarm"]>[0]> = [];
const prewarmLayer = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(services),
  Layer.provideMerge(
    Layer.succeed(Prewarm.Prewarm)({
      prewarm: (request) =>
        Effect.sync(() => {
          prewarms.push(request);
        })
    })
  ),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
);

it.layer(prewarmLayer)("prewarms on a socket", (it) => {
  it.effect("readies the viewer's likeliest live tier 2 tools from Home and All patches", () =>
    Effect.gen(function* () {
      const workspace = yield* company();
      const patches = yield* Patches.Patches;
      const quiet = yield* publishTier2(workspace.owner, "quiet-tool");
      const popular = yield* publishTier2(workspace.owner, "popular-tool");
      const theirs = yield* publishTier2(workspace.owner, "their-tool");
      const retired = yield* publishTier2(workspace.owner, "old-tool");
      yield* patches.retire(retired.patchId, actor(workspace.owner));
      yield* publish(workspace.owner, "weekly-recap");
      for (let visit = 0; visit < 3; visit++) yield* patches.recordVisit(popular.patchId);
      // Their own opens come first, then everyone's visits; pages and retired tools never.
      yield* patches.recordOpen(workspace.member.id, theirs.patchId, theirs.versionId);
      const expected = {
        companyId: workspace.id,
        viewerId: workspace.member.id,
        candidates: [theirs, popular, quiet].map(({ patchId, versionId }) => ({
          patchId,
          versionId
        }))
      };
      prewarms.length = 0;
      yield* (yield* request("/", workspace.member)).text;
      yield* (yield* request("/patches", workspace.member)).text;
      assert.deepStrictEqual(prewarms, [expected, expected]);

      // A company without a live tier 2 tool has nothing to ready.
      const other = yield* company();
      yield* publish(other.owner, "just-a-page");
      yield* (yield* request("/", other.member)).text;
      assert.strictEqual(prewarms.length, 2);
    })
  );
});

/** The call summary `person` gets for every patch in their company. */
const summaryFor = Effect.fn("HandlersTest.summaryFor")(function* (person: Person, handle: string) {
  const rows = yield* (yield* Patches.Patches).read({
    companyId: person.companyId,
    userId: person.id,
    canOpen: () => true,
    state: "all"
  });
  const summary = yield* callSummary(rows).pipe(
    Effect.provideService(RequireSession.Viewer, {
      user: { id: person.id, email: person.email, name: person.name },
      company: { id: person.companyId, handle, name: "Northwind" },
      role: person.role,
      whatsNewSeen: 0
    })
  );
  return summary === undefined
    ? undefined
    : Object.fromEntries(
        [...summary].map(([patchId, counts]) => [
          rows.find((row) => row.patch.id === patchId)!.patch.name,
          counts
        ])
      );
});

it.layer(socket)("the call summary", (it) => {
  it.effect(
    "tells no calls yet from calls without failures, for the patches a viewer manages",
    () =>
      Effect.gen(function* () {
        const workspace = yield* company();
        const quiet = yield* publishTier2(workspace.owner, "quiet-tool");
        const fine = yield* publishTier2(workspace.owner, "fine-tool");
        const failing = yield* publishTier2(workspace.owner, "failing-tool");
        yield* publish(workspace.owner, "weekly-recap");
        const retired = yield* publishTier2(workspace.owner, "retired-tool");
        yield* (yield* Patches.Patches).retire(retired.patchId, actor(workspace.owner));
        yield* publishTier2(workspace.admin, "admin-tool");
        // A day and more ago, so outside the window.
        yield* invoke(seedOf(workspace.id, quiet), workspace.member, {
          handler: "stock.load",
          kind: "query",
          outcome: "handler_error"
        });
        yield* TestClock.adjust(2 * DAY);
        yield* invoke(seedOf(workspace.id, fine), workspace.member, {
          handler: "visits.load",
          kind: "query"
        });
        for (const outcome of ["handler_error", "success", "failure"] as const)
          yield* invoke(seedOf(workspace.id, failing), workspace.member, {
            handler: "accounts.burn",
            kind: "action",
            outcome
          });

        // Live tier 2 patches the viewer manages, whether or not anyone called them; never a page or
        // a retired patch.
        assert.deepStrictEqual(yield* summaryFor(workspace.owner, workspace.handle), {
          "quiet-tool": { calls: 0, failures: 0 },
          "fine-tool": { calls: 1, failures: 0 },
          "failing-tool": { calls: 3, failures: 2 }
        });
        // An admin manages every one; a member who manages none never reads the log.
        assert.deepStrictEqual(yield* summaryFor(workspace.admin, workspace.handle), {
          "quiet-tool": { calls: 0, failures: 0 },
          "fine-tool": { calls: 1, failures: 0 },
          "failing-tool": { calls: 3, failures: 2 },
          "admin-tool": { calls: 0, failures: 0 }
        });
        assert.isUndefined(yield* summaryFor(workspace.member, workspace.handle));
      })
  );
});
