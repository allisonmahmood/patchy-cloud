// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- Real processes exercise provider identity, execution and stop metering.
import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as LocalTaskProvider from "./localTaskProvider.js";

it.live(
  "keeps one task identity across retries and retains final process metering after stop",
  () =>
    Effect.gen(function* () {
      const provider = yield* LocalTaskProvider.make({
        callbackUrls: ["http://127.0.0.1:1/callback"]
      });
      const input = { taskId: "provider-task", deploymentRevision: "deployment-a" };
      const [first, repeated] = yield* Effect.all([provider.start(input), provider.start(input)], {
        concurrency: "unbounded"
      });
      assert.strictEqual(first.startedAt, repeated.startedAt);
      const source = `export default { async fetch(request) { const input = await request.json(); return Response.json(input.type === "describe" ? {ok:true,handlers:{}} : {ok:true,value:42}); } };`;
      const bound = yield* provider.bind(input.taskId, {
        companyId: "company",
        bindingEpoch: 1,
        bundle: {
          companyId: "company",
          patchId: "patch",
          versionId: "version",
          bundle: source,
          sha256: createHash("sha256").update(source).digest("hex")
        }
      });
      assert.isDefined(bound.binding);
      const result = yield* provider.invoke(input.taskId, {
        bindingEpoch: 1,
        request: {
          wire: 1,
          binding: bound.binding!,
          processGeneration: bound.processGeneration!,
          invocationId: "invocation",
          attemptId: "attempt",
          deadline: Date.now() + 5_000,
          handler: "demo.query",
          args: {},
          viewer: {
            user: { id: "user", name: "Viewer", email: "viewer@example.test" },
            company: { id: "company", name: "Company", handle: "company" },
            admin: false
          },
          callback: { url: "http://127.0.0.1:1/callback", capability: "unused" }
        }
      });
      assert.strictEqual(result.outcome, "returned");
      if (result.outcome !== "returned") return assert.fail("The handler did not return.");
      assert.deepStrictEqual(result.reply, { ok: true, value: 42 });
      const stopped = yield* provider.stop(input.taskId);
      assert.strictEqual(stopped.state, "stopped");
      assert.isAtLeast(stopped.stoppedAt!, first.startedAt);
      const reports = yield* provider.stats(input.taskId, { bindingEpoch: 1 });
      assert.strictEqual(reports.stopped, true);
      assert.strictEqual(reports.reports[0]?.cause, "stopped");
      assert.strictEqual(reports.reports[0]?.callsServed, 1);
      assert.isAbove(reports.reports[0]!.peakRssBytes, 0);
      const ack = yield* provider.stats(input.taskId, {
        bindingEpoch: 1,
        acknowledgeReports: reports.reports.map(({ reportId }) => reportId)
      });
      assert.deepStrictEqual(ack.reports, []);
      assert.strictEqual((yield* provider.start(input)).state, "stopped");
      const refused = yield* provider
        .bind(input.taskId, { companyId: "other-company", bindingEpoch: 2 })
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "stopped");
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  { timeout: 20_000 }
);

it.live(
  "applies company process limits without letting a delayed older bind restore them",
  () =>
    Effect.gen(function* () {
      const provider = yield* LocalTaskProvider.make({ callbackUrls: [] });
      const task = yield* provider.start({
        taskId: "limit-task",
        deploymentRevision: "deployment"
      });
      const source = `export default { async fetch(request) { const input = await request.json(); return Response.json(input.type === "describe" ? {ok:true,handlers:{}} : {ok:true,value:null}); } };`;
      yield* provider.bind(task.taskId, {
        companyId: "company",
        bindingEpoch: 1,
        bundle: {
          companyId: "company",
          patchId: "patch",
          versionId: "version",
          bundle: source,
          sha256: createHash("sha256").update(source).digest("hex")
        }
      });
      yield* provider.bind(task.taskId, {
        companyId: "company",
        bindingEpoch: 1,
        operatingLimits: { "execution.process.rss": 1 },
        configRevision: { deploymentRevision: "limits", overrideRevision: "9" }
      });
      yield* provider.bind(task.taskId, {
        companyId: "company",
        bindingEpoch: 1,
        operatingLimits: { "execution.process.rss": 536870912 },
        configRevision: { deploymentRevision: "limits", overrideRevision: "8" }
      });
      const report = yield* Effect.gen(function* () {
        while (true) {
          const stats = yield* provider.stats(task.taskId, { bindingEpoch: 1 });
          if (stats.reports[0] !== undefined) return stats.reports[0];
          yield* Effect.sleep("20 millis");
        }
      }).pipe(Effect.timeout("5 seconds"));
      assert.strictEqual(report.cause, "memory");
      const limit = report.event.limits?.find((entry) => entry.limitId === "execution.process.rss");
      assert.strictEqual(limit?.value, 1);
      assert.strictEqual(limit?.configRevision.overrideRevision, "9");
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  { timeout: 20_000 }
);

it.live(
  "reaps a task that misses readiness instead of retaining a running fleet slot",
  () =>
    Effect.gen(function* () {
      const provider = yield* LocalTaskProvider.make({ callbackUrls: [] }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ PATCHY_LIMITS_JSON: '{"execution.pool.wait":1}' })
          )
        )
      );
      const task = { taskId: "startup-timeout", deploymentRevision: "deployment" };
      const error = yield* provider.start(task).pipe(Effect.flip);
      assert.strictEqual(error.operation, "start");
      assert.strictEqual(error.reason, "provider");
      assert.instanceOf(error.cause, Error);
      const [stopped] = yield* provider.list;
      assert.strictEqual(stopped?.state, "stopped");
      assert.isAtLeast(stopped!.stoppedAt!, stopped!.startedAt);
      assert.deepStrictEqual(yield* provider.stop(task.taskId), stopped);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  { timeout: 10_000 }
);
