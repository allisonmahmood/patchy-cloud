// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- Real processes exercise provider identity, execution and stop metering.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as LocalTaskProvider from "./localTaskProvider.js";

const listener = (headers: IncomingMessage["headers"][]) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = createServer((request, response) => {
        headers.push(request.headers);
        response.setHeader("content-type", "application/json");
        response.end('{"ok":true,"value":42}');
      });
      const ready = Promise.withResolvers<void>();
      server.once("error", ready.reject);
      server.listen(0, "127.0.0.1", ready.resolve);
      await ready.promise;
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing callback address");
      return { server, url: `http://127.0.0.1:${address.port}/callback` };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          })
      )
  );

it.live(
  "routes independent providers to one task after its creating host closes and retains final metering",
  () =>
    Effect.gen(function* () {
      const hostScope = yield* Scope.make();
      const firstHeaders: IncomingMessage["headers"][] = [];
      const otherHeaders: IncomingMessage["headers"][] = [];
      const firstHost = yield* listener(firstHeaders).pipe(
        Effect.provideService(Scope.Scope, hostScope)
      );
      const otherHost = yield* listener(otherHeaders);
      const options = yield* LocalTaskProvider.resource({
        callbackUrls: [firstHost.url, otherHost.url]
      });
      const provider = yield* LocalTaskProvider.make(options).pipe(
        Effect.provideService(Scope.Scope, hostScope)
      );
      const other = yield* LocalTaskProvider.make(options);
      const input = { taskId: "provider-task", deploymentRevision: "deployment-a" };
      const [first, repeated] = yield* Effect.all([provider.start(input), other.start(input)], {
        concurrency: "unbounded"
      });
      assert.strictEqual(first.startedAt, repeated.startedAt);
      yield* Scope.close(hostScope, Exit.void);
      assert.deepStrictEqual(yield* other.list, [first]);
      const source = `export default { async fetch(request, env, ctx) { const input = await request.json(); return Response.json(input.type === "describe" ? {ok:true,handlers:{}} : await ctx.props.callbacks.call({op:"read",args:{}})); } };`;
      const bound = yield* other.bind(input.taskId, {
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
      const result = yield* other.invoke(input.taskId, {
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
          callback: { url: otherHost.url, capability: "other-host-capability" }
        }
      });
      assert.strictEqual(result.outcome, "returned");
      if (result.outcome !== "returned") return assert.fail("The handler did not return.");
      assert.deepStrictEqual(result.reply, { ok: true, value: 42 });
      assert.deepStrictEqual(firstHeaders, []);
      assert.strictEqual(otherHeaders[0]?.authorization, "Bearer other-host-capability");
      assert.strictEqual(otherHeaders[0]?.["x-patchy-binding-epoch"], "1");
      assert.strictEqual(
        otherHeaders[0]?.["x-patchy-process-generation"],
        String(bound.processGeneration)
      );
      const stopped = yield* other.stop(input.taskId);
      assert.strictEqual(stopped.state, "stopped");
      assert.isAtLeast(stopped.stoppedAt!, first.startedAt);
      const restarted = yield* LocalTaskProvider.make(options);
      assert.deepStrictEqual(yield* restarted.stop(input.taskId), stopped);
      const reports = yield* restarted.stats(input.taskId, { bindingEpoch: 1 });
      assert.strictEqual(reports.stopped, true);
      assert.strictEqual(reports.reports[0]?.cause, "stopped");
      assert.strictEqual(reports.reports[0]?.callsServed, 1);
      assert.isAbove(reports.reports[0]!.peakRssBytes, 0);
      const ack = yield* provider.stats(input.taskId, {
        bindingEpoch: 1,
        acknowledgeReports: reports.reports.map(({ reportId }) => reportId)
      });
      assert.deepStrictEqual(ack.reports, []);
      assert.deepStrictEqual(
        (yield* restarted.stats(input.taskId, { bindingEpoch: 1 })).reports,
        []
      );
      assert.strictEqual((yield* provider.start(input)).state, "stopped");
      const refused = yield* provider
        .bind(input.taskId, { companyId: "other-company", bindingEpoch: 2 })
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "stopped");
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  { timeout: 20_000 }
);

it.live(
  "keeps exact identity after interrupted start and lost stop acknowledgement on another client",
  () =>
    Effect.gen(function* () {
      const options = yield* LocalTaskProvider.resource({ callbackUrls: [] });
      const left = yield* LocalTaskProvider.make(options);
      const right = yield* LocalTaskProvider.make(options);
      const input = { taskId: "ambiguous-task", deploymentRevision: "deployment" };
      const starting = yield* left.start(input).pipe(Effect.forkChild);
      const observed = yield* Effect.gen(function* () {
        while (true) {
          const [task] = yield* right.list;
          if (task !== undefined) return task;
          yield* Effect.sleep(10);
        }
      }).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.interrupt(starting);
      const ready = yield* right.start(input);
      assert.strictEqual(ready.startedAt, observed.startedAt);
      assert.strictEqual(ready.taskId, observed.taskId);
      assert.deepStrictEqual(yield* left.list, [ready]);
      const stopping = yield* left
        .stop(input.taskId)
        .pipe(Effect.andThen(Effect.never), Effect.forkChild);
      const stopped = yield* right.stop(input.taskId);
      yield* Fiber.interrupt(stopping);
      assert.strictEqual(stopped.state, "stopped");
      assert.deepStrictEqual(yield* left.start(input), stopped);
      assert.deepStrictEqual(yield* right.stop(input.taskId), stopped);
      assert.deepStrictEqual(yield* left.list, [stopped]);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  { timeout: 20_000 }
);

it.live(
  "applies company process limits without letting a delayed older bind restore them",
  () =>
    Effect.gen(function* () {
      const options = yield* LocalTaskProvider.resource({ callbackUrls: [] });
      const provider = yield* LocalTaskProvider.make(options);
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
      const options = yield* LocalTaskProvider.resource({ callbackUrls: [] });
      const provider = yield* LocalTaskProvider.make(options).pipe(
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
