// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off -- real child processes, callback sockets and wall-clock watchdog deadlines are the acceptance boundary.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { expect, it } from "@effect/vitest";
import * as GuestProtocol from "@patchy/api/guest";
import * as Management from "@patchy/api/management";
import { registry } from "@patchy/limits/registry";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Supervisor from "./supervisor.js";
import { NodeCryptography } from "@patchy/core";

const source = `
const memory = [];
export default { async fetch(request, env, ctx) {
  const input = await request.json();
  if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
  if (input.handler === "demo.spin") { while (true) {} }
  if (input.handler === "demo.leak") {
    while (true) {
      memory.push(new Uint8Array(8 * 1024 * 1024).fill(165));
      await ctx.props.callbacks.call({ op: "tick", args: {} });
    }
  }
  if (input.handler === "demo.callback") return Response.json(await ctx.props.callbacks.call({ op: "hold", args: {} }));
  if (input.handler === "demo.grow") memory.push(new Uint8Array(input.args.bytes).fill(165));
  if (input.handler === "demo.growAndHold") {
    memory.push(new Uint8Array(input.args.bytes).fill(165));
    return Response.json(await ctx.props.callbacks.call({ op: "hold", args: {} }));
  }
  return Response.json({ ok: true, value: input.args.value ?? "alive" });
}};`;
const bundle = (versionId: string, code = source): GuestProtocol.Bundle => ({
  companyId: "com_supervisor",
  patchId: "pat_supervisor",
  versionId,
  sha256: createHash("sha256").update(code).digest("hex"),
  bundle: code
});
const invocation = (
  bound: Management.BindReply,
  url: string,
  handler = "reply",
  overrides: Partial<GuestProtocol.Invoke> = {}
): Management.InvokeRequest => {
  if (bound.binding === undefined || bound.processGeneration === undefined)
    throw new Error("Missing loaded binding");
  return {
    bindingEpoch: bound.bindingEpoch,
    request: {
      wire: 1,
      binding: bound.binding,
      processGeneration: bound.processGeneration,
      invocationId: `inv_${bound.processGeneration}`,
      attemptId: "attempt_one",
      deadline: Date.now() + 20_000,
      handler: `demo.${handler}`,
      args: {},
      viewer: {
        user: { id: "usr_supervisor", name: "Reader", email: "reader@example.test" },
        company: { id: "com_supervisor", name: "Example", handle: "example" },
        admin: false
      },
      callback: { url, capability: "host-attempt-capability" },
      ...overrides
    }
  };
};
const listener = (handle: (request: IncomingMessage, response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = createServer(handle);
      const ready = Promise.withResolvers<void>();
      server.once("error", ready.reject);
      server.listen(0, "127.0.0.1", ready.resolve);
      await ready.promise;
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing callback listener address");
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
const bind = (supervisor: Supervisor.Supervisor["Service"], versionId: string, code = source) =>
  supervisor.bind({
    companyId: "com_supervisor",
    bindingEpoch: 1,
    bundle: bundle(versionId, code)
  });
const touch = (supervisor: Supervisor.Supervisor["Service"], versionId: string, code = source) => {
  const { companyId, patchId, sha256 } = bundle(versionId, code);
  return supervisor.touch({ bindingEpoch: 1, binding: { companyId, patchId, versionId, sha256 } });
};
// Guest timers use workerd's clock, which the host test clock cannot advance.
const unfinishedDescribe = `export default { async fetch() {
  while (true) {
    const tick = Promise.withResolvers();
    setTimeout(tick.resolve, 10);
    await tick.promise;
  }
}};`;
const statsWhen = Effect.fnUntraced(function* (
  supervisor: Supervisor.Supervisor["Service"],
  ready: (stats: Management.StatsReply) => boolean
) {
  for (let i = 0; i < 800; i++) {
    const stats = yield* supervisor.stats({ bindingEpoch: 1 });
    if (ready(stats)) return stats;
    yield* Effect.sleep(25);
  }
  throw new Error("Supervisor did not reach the expected resident state");
});

const reportFor = Effect.fnUntraced(function* (
  supervisor: Supervisor.Supervisor["Service"],
  generation: number
) {
  for (let i = 0; i < 800; i++) {
    const report = (yield* supervisor.stats({ bindingEpoch: 1 })).reports.find(
      (report) => report.processGeneration === generation
    );
    if (report !== undefined) return report;
    yield* Effect.sleep(25);
  }
  throw new Error(`No report for generation ${generation}`);
});
const idleHost = (_request: IncomingMessage, response: ServerResponse) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, value: null }));
};
const largeAggregate = { "execution.residency.bytes": 8 * 1024 ** 3 } as const;

it.live("keeps a loaded process callable across issuing-host replacement", () =>
  Effect.gen(function* () {
    const first = yield* listener((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, value: "first host" }));
    });
    const replacement = yield* listener((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, value: "replacement host" }));
    });
    const supervisor = yield* Supervisor.make({
      callbackUrls: [first.url],
      operatingLimits: largeAggregate
    });
    const loaded = yield* bind(supervisor, "ver_host_rollout");
    expect(yield* supervisor.invoke(invocation(loaded, first.url, "callback"))).toMatchObject({
      outcome: "returned",
      reply: { ok: true, value: "first host" }
    });
    expect(
      yield* supervisor.invoke(invocation(loaded, replacement.url, "callback")).pipe(Effect.result)
    ).toMatchObject({ _tag: "Failure", failure: { reason: "protocol" } });
    yield* supervisor.bind({
      companyId: "com_supervisor",
      bindingEpoch: 1,
      callbackUrls: [replacement.url]
    });
    expect(yield* supervisor.invoke(invocation(loaded, replacement.url, "callback"))).toMatchObject(
      {
        outcome: "returned",
        reply: { ok: true, value: "replacement host" }
      }
    );
    expect(yield* supervisor.invoke(invocation(loaded, first.url, "callback"))).toMatchObject({
      outcome: "returned",
      reply: { ok: true, value: "first host" }
    });
  }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer]))
);

/** This test process's live workerd children, by pid. */
const workerdChildren = () =>
  Effect.promise(async () => {
    const output = await new Promise<string>((resolve) =>
      execFile("ps", ["-o", "pid=,comm=", "--ppid", String(process.pid)], (_error, stdout) =>
        resolve(stdout)
      )
    );
    return new Set(
      output
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter(([, command]) => command === "workerd")
        .map(([pid]) => Number(pid))
    );
  });
const childrenWhen = Effect.fnUntraced(function* (ready: (pids: Set<number>) => boolean) {
  for (let i = 0; i < 400; i++) {
    const pids = yield* workerdChildren();
    if (ready(pids)) return pids;
    yield* Effect.sleep(25);
  }
  throw new Error("Workerd children never reached the expected state");
});

it.live.skipIf(process.platform !== "linux")(
  "binds into the standby process, replaces it once the box is quiet and stops it with the task",
  () =>
    Effect.gen(function* () {
      const host = yield* listener((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, value: "through the standby's route" }));
      });
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: { ...largeAggregate, "execution.probe.interval": 25 },
        standby: true
      });
      // Started before any company or version asks for it.
      const [standby] = yield* childrenWhen((pids) => pids.size === 1);
      const loaded = yield* bind(supervisor, "ver_standby");
      const stats = yield* supervisor.stats({ bindingEpoch: 1 });
      expect(stats.processes).toEqual([expect.objectContaining({ pid: standby })]);
      expect(yield* supervisor.invoke(invocation(loaded, host.url, "callback"))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: "through the standby's route" }
      });
      // Its replacement waits for a quiet second, then is nobody's until the next bind.
      const replaced = yield* childrenWhen((pids) => pids.size === 2);
      const [replacement] = [...replaced].filter((pid) => pid !== standby);
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).processes).toEqual([
        expect.objectContaining({ pid: standby })
      ]);
      const second = yield* bind(supervisor, "ver_standby_second");
      expect(
        (yield* supervisor.stats({ bindingEpoch: 1 })).processes.find(
          (entry) => entry.processGeneration === second.processGeneration
        )
      ).toMatchObject({ pid: replacement });
      yield* supervisor.stop({ bindingEpoch: 1 });
      expect(yield* workerdChildren()).toEqual(new Set());
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

/** A supervisor counting only workerd RSS, so its aggregate is the standby's until a bind. */
const withStandby = (limits: Partial<Record<"execution.residency.bytes", number>> = {}) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.make({
      callbackUrls: [],
      operatingLimits: { ...largeAggregate, "execution.probe.interval": 25, ...limits },
      residencyAccounting: "workerd-only",
      standby: true
    });
    // Sampled once it answers its readiness probe.
    while ((yield* supervisor.stats({ bindingEpoch: 0 })).aggregateRssBytes === 0)
      yield* Effect.sleep(25);
    const [pid] = yield* workerdChildren();
    return { supervisor, pid: pid! };
  });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const reaped = (pid: number) =>
  Effect.gen(function* () {
    while (alive(pid)) yield* Effect.sleep(10);
  });

it.live.skipIf(process.platform !== "linux")(
  "leaves nothing running when a task-wide stop races a bind that finds its standby dead",
  () =>
    Effect.gen(function* () {
      const { supervisor, pid } = yield* withStandby();
      process.kill(pid, "SIGKILL");
      yield* reaped(pid);
      // The bind discards the dead standby asynchronously; the stop arrives meanwhile.
      const binding = yield* bind(supervisor, "ver_raced").pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* supervisor.stop({ bindingEpoch: 1 });
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).processes).toEqual([]);
      const result = yield* Fiber.join(binding);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(["stopped", "process_killed"]).toContain(result.failure.reason);
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).processes).toEqual([]);
      yield* childrenWhen((pids) => pids.size === 0);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live.skipIf(process.platform !== "linux")(
  "binds into a fresh process rather than a standby that stopped answering",
  () =>
    Effect.gen(function* () {
      const { supervisor, pid } = yield* withStandby();
      process.kill(pid, "SIGSTOP");
      // Past two missed probes, well before the six-second stall kill.
      yield* Effect.sleep(2_500);
      const started = Date.now();
      const loaded = yield* bind(supervisor, "ver_after_stall");
      expect(Date.now() - started).toBeLessThan(3_000);
      const [resident] = (yield* supervisor.stats({ bindingEpoch: 1 })).processes;
      expect(resident).toMatchObject({ processGeneration: loaded.processGeneration });
      expect(resident!.pid).not.toBe(pid);
      yield* reaped(pid);
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).reports).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live.skipIf(process.platform !== "linux")(
  "discards a standby that exits, without a report, and a bind then starts its own process",
  () =>
    Effect.gen(function* () {
      const { supervisor, pid } = yield* withStandby();
      process.kill(pid, "SIGKILL");
      // The watchdog lets it go: its memory leaves the aggregate, and no version reports.
      let stats = yield* supervisor.stats({ bindingEpoch: 0 });
      while (stats.aggregateRssBytes !== 0) {
        yield* Effect.sleep(25);
        stats = yield* supervisor.stats({ bindingEpoch: 0 });
      }
      expect(stats.reports).toEqual([]);
      const loaded = yield* bind(supervisor, "ver_after_exit");
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).processes).toEqual([
        expect.objectContaining({ processGeneration: loaded.processGeneration })
      ]);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live.skipIf(process.platform !== "linux")(
  "gives back the standby first under memory pressure, and replaces it ten seconds later once there is room",
  () =>
    Effect.gen(function* () {
      const { supervisor } = yield* withStandby();
      const loaded = yield* bind(supervisor, "ver_kept_under_pressure");
      const both = yield* childrenWhen((pids) => pids.size === 2);
      const { aggregateRssBytes } = yield* statsWhen(
        supervisor,
        (stats) =>
          stats.processes[0]!.rssBytes > 0 && stats.aggregateRssBytes > stats.processes[0]!.rssBytes
      );
      const ceiling = (value: number, overrideRevision: string) =>
        supervisor.bind({
          companyId: "com_supervisor",
          bindingEpoch: 1,
          operatingLimits: { "execution.residency.bytes": value },
          configRevision: { deploymentRevision: "pressure", overrideRevision }
        });
      // Just below the version and its standby together.
      yield* ceiling(aggregateRssBytes - 1, "1");
      const [resident] = (yield* supervisor.stats({ bindingEpoch: 1 })).processes;
      const remaining = yield* childrenWhen((pids) => pids.size === 1);
      const discarded = Date.now();
      expect([...remaining]).toEqual([resident!.pid]);
      expect([...both]).toContain(resident!.pid);
      const after = yield* supervisor.stats({ bindingEpoch: 1 });
      expect(after.processes).toEqual([
        expect.objectContaining({ processGeneration: loaded.processGeneration })
      ]);
      expect(after.reports).toEqual([]);
      // Room again at once, yet a discarded standby's replacement waits out its ten seconds.
      yield* ceiling(largeAggregate["execution.residency.bytes"], "2");
      while (Date.now() - discarded < 9_000) {
        expect((yield* workerdChildren()).size).toBe(1);
        yield* Effect.sleep(250);
      }
      yield* childrenWhen((pids) => pids.size === 2);
      expect(Date.now() - discarded).toBeGreaterThanOrEqual(9_000);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  30_000
);

it.live.skipIf(process.platform !== "linux")(
  "refuses an older host's task-wide stop that waited while a newer host bound the task",
  () =>
    Effect.gen(function* () {
      const { supervisor, pid } = yield* withStandby();
      yield* supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 1 });
      process.kill(pid, "SIGKILL");
      yield* reaped(pid);
      // This bind holds admission while it discards the dead standby; the newer host's bind
      // and the older host's stop queue behind it, in that order.
      const slow = yield* bind(supervisor, "ver_slow").pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      const newer = yield* supervisor
        .bind({ companyId: "com_supervisor", bindingEpoch: 2 })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const older = yield* supervisor
        .stop({ bindingEpoch: 1 })
        .pipe(Effect.result, Effect.forkChild);
      expect(yield* Fiber.join(newer)).toEqual({ bindingEpoch: 2 });
      expect(yield* Fiber.join(older)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale_epoch" }
      });
      yield* Fiber.join(slow);
      expect((yield* supervisor.stats({ bindingEpoch: 2 })).stopped).toBe(false);
      // Admission still serves the newer host.
      const loaded = yield* supervisor.bind({
        companyId: "com_supervisor",
        bindingEpoch: 2,
        bundle: bundle("ver_after_refused_stop")
      });
      expect(loaded).toMatchObject({ bindingEpoch: 2 });
      yield* supervisor.stop({ bindingEpoch: 2 });
      yield* childrenWhen((pids) => pids.size === 0);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live.skipIf(process.platform !== "linux")(
  "starts no standby once a task-wide stop has won admission",
  () =>
    Effect.gen(function* () {
      // A small operation budget preempts the watchdog between deciding to start a standby and
      // taking admission, which is where a stop can slip in.
      for (let trial = 0; trial < 3; trial++)
        yield* Effect.gen(function* () {
          const supervisor = yield* Supervisor.make({
            callbackUrls: [],
            operatingLimits: { ...largeAggregate, "execution.probe.interval": 25 },
            residencyAccounting: "workerd-only",
            standby: true
          }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 8));
          yield* supervisor.stop({ bindingEpoch: 0 });
          yield* Effect.sleep(1_000);
          expect(yield* workerdChildren()).toEqual(new Set());
          expect((yield* supervisor.stats({ bindingEpoch: 0 })).aggregateRssBytes).toBe(0);
        }).pipe(Effect.scoped);
    }).pipe(Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live("rejects a probe interval that cannot enforce the six-second stall bound", () =>
  Supervisor.make({
    callbackUrls: [],
    operatingLimits: { "execution.probe.interval": 6_000 }
  }).pipe(
    Effect.result,
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "protocol" } });
      })
    ),
    Effect.scoped,
    Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])
  )
);

it.live(
  "counts only supervised workerd RSS locally and refuses genuine aggregate pressure",
  () =>
    Effect.gen(function* () {
      const reached = Promise.withResolvers<void>();
      const host = yield* listener(() => reached.resolve());
      const ceiling = 256 * 1024 ** 2;
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        residencyAccounting: "workerd-only",
        operatingLimits: {
          "execution.residency.bytes": ceiling,
          "execution.probe.interval": 25
        }
      });
      yield* supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 1 });
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).aggregateRssBytes).toBe(0);
      const loaded = yield* bind(supervisor, "ver_local_pressure");
      yield* supervisor
        .invoke(invocation(loaded, host.url, "growAndHold", { args: { bytes: ceiling } }))
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      const pressured = yield* statsWhen(supervisor, (stats) => stats.aggregateRssBytes >= ceiling);
      expect(pressured.aggregateRssBytes).toBe(
        pressured.processes.reduce((bytes, resident) => bytes + resident.rssBytes, 0)
      );
      expect(pressured.processes).toEqual([
        expect.objectContaining({
          processGeneration: loaded.processGeneration,
          activeInvocations: 1
        })
      ]);
      const refusal = {
        _tag: "Failure",
        failure: {
          reason: "busy",
          limit: { scope: "company", limitId: "execution.residency.bytes", value: ceiling }
        }
      };
      expect(yield* bind(supervisor, "ver_local_overflow").pipe(Effect.result)).toMatchObject(
        refusal
      );
      expect(
        yield* supervisor
          .invoke(invocation(loaded, host.url, "reply", { invocationId: "inv_pressure_refused" }))
          .pipe(Effect.result)
      ).toMatchObject(refusal);
      yield* supervisor.stop({ bindingEpoch: 1, processGeneration: loaded.processGeneration });
      const report = yield* reportFor(supervisor, loaded.processGeneration!);
      expect(report.cause).toBe("stopped");
      expect(
        report.event.limits?.find((entry) => entry.limitId === "execution.residency.bytes")?.peak
      ).toBeGreaterThanOrEqual(ceiling);
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).aggregateRssBytes).toBe(0);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "keeps tuple identities distinct and makes concurrent same-epoch binds idempotent",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: largeAggregate
      });
      const firstBundle = { ...bundle("b\0c"), patchId: "a" };
      const secondBundle = { ...bundle("c"), patchId: "a\0b" };
      const loaded = yield* Effect.all(
        [
          supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 1, bundle: firstBundle }),
          supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 1, bundle: firstBundle }),
          supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 1, bundle: secondBundle })
        ],
        { concurrency: "unbounded" }
      );
      expect(loaded[0].processGeneration).toBe(loaded[1].processGeneration);
      expect(loaded[2].processGeneration).not.toBe(loaded[0].processGeneration);
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).processes).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "makes a bind by hash wait for a loading version and check its epoch after the wait",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: largeAggregate
      });
      // Describing takes a second, so each version stays loading while a bind by hash arrives.
      const slow = `export default { async fetch(request) {
        const input = await request.json();
        if (input.type === "describe") {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return Response.json({ ok: true, handlers: {} });
        }
        return Response.json({ ok: true, value: "alive" });
      }};`;
      const byHash = (versionId: string, bindingEpoch: number) => {
        const { companyId, patchId, sha256 } = bundle(versionId, slow);
        return supervisor.bind({
          companyId,
          bindingEpoch,
          binding: { companyId, patchId, versionId, sha256 }
        });
      };
      yield* supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 1 });
      const loading = yield* bind(supervisor, "ver_slow", slow).pipe(Effect.forkChild);
      yield* statsWhen(supervisor, (stats) => stats.processes.length === 1);
      const held = yield* byHash("ver_slow", 1);
      expect(held).toEqual(yield* Fiber.join(loading));
      expect(yield* supervisor.invoke(invocation(held, host.url))).toMatchObject({
        outcome: "returned"
      });

      const replaced = yield* bind(supervisor, "ver_adopted", slow).pipe(
        Effect.result,
        Effect.forkChild
      );
      yield* statsWhen(supervisor, (stats) => stats.processes.length === 2);
      const waiting = yield* byHash("ver_adopted", 1).pipe(Effect.result, Effect.forkChild);
      yield* Effect.sleep(200);
      // Adoption raises the epoch while both binds wait for the load.
      yield* supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 2 });
      for (const fiber of [replaced, waiting])
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "stale_epoch" }
        });
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "preserves callback transport, timeout, and file-size refusals through the fence",
  () =>
    Effect.gen(function* () {
      let mode: "disconnect" | "oversize" | "hold" = "disconnect";
      const host = yield* listener((request, response) => {
        if (mode === "disconnect") request.socket.destroy();
        else if (mode === "oversize") {
          response.writeHead(200, {
            "x-patchy-file-body": "1",
            "content-type": "application/octet-stream"
          });
          response.end(Buffer.alloc(GuestProtocol.callbackFileLimit.value + 1, 165));
        }
      });
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: largeAggregate
      });
      const loaded = yield* bind(supervisor, "ver_callback_failures");
      expect(yield* supervisor.invoke(invocation(loaded, host.url, "callback"))).toMatchObject({
        outcome: "returned",
        reply: { ok: false, source: "patchy", code: "source_unavailable" }
      });
      mode = "oversize";
      expect(yield* supervisor.invoke(invocation(loaded, host.url, "callback"))).toMatchObject({
        outcome: "returned",
        reply: { ok: false, source: "patchy", ...GuestProtocol.callbackFileLimit }
      });
      mode = "hold";
      expect(
        yield* supervisor.invoke(
          invocation(loaded, host.url, "callback", { deadline: Date.now() + 200 })
        )
      ).toMatchObject({
        outcome: "returned",
        reply: { ok: false, source: "patchy", code: "timeout" }
      });
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "clears a completed loader refusal so the resident idles instead of dying at its old deadline",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      let refuse = false;
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          refuse && request.url.endsWith("/invoke")
            ? HttpClientRequest.setUrl(request, request.url.replace(/\/invoke$/, "/unknown"))
            : request
        )
      );
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: {
          ...largeAggregate,
          "execution.process.idle": 2_000,
          "execution.probe.interval": 25
        }
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const loaded = yield* bind(supervisor, "ver_refused");
      refuse = true;
      const rejected = invocation(loaded, host.url, "reply", { deadline: Date.now() + 200 });
      expect(yield* supervisor.invoke(rejected).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "protocol" }
      });
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).processes).toEqual([
        expect.objectContaining({ activeInvocations: 0 })
      ]);
      refuse = false;
      yield* Effect.sleep(1_500);
      expect(yield* supervisor.invoke(invocation(loaded, host.url))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: "alive" }
      });
      expect(yield* reportFor(supervisor, loaded.processGeneration!)).toMatchObject({
        cause: "idle",
        callsServed: 2,
        invocations: []
      });
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "kills every call in a spinning version at deadline plus one second, preserving its sibling and exact report",
  () =>
    Effect.gen(function* () {
      const reached = Promise.withResolvers<void>();
      const host = yield* listener(() => reached.resolve());
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: largeAggregate
      });
      const bad = yield* bind(supervisor, "ver_spin");
      const sibling = yield* bind(supervisor, "ver_sibling");
      const pid = (yield* supervisor.stats({ bindingEpoch: 1 })).processes.find(
        (entry) => entry.processGeneration === bad.processGeneration
      )!.pid;
      const directory =
        process.platform === "linux"
          ? yield* Effect.promise(async () => {
              const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
              return dirname(args.find((arg) => arg.endsWith("config.capnp"))!);
            })
          : undefined;
      if (directory !== undefined)
        expect(yield* Effect.promise(async () => (await stat(directory)).isDirectory())).toBe(true);
      const held = invocation(bad, host.url, "callback", { invocationId: "inv_held" });
      const heldFiber = yield* supervisor.invoke(held).pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      const deadline = Date.now() + 250;
      const spinning = invocation(bad, host.url, "spin", { invocationId: "inv_spin", deadline });
      const killed = yield* supervisor.invoke(spinning).pipe(Effect.result);
      expect(killed).toMatchObject({ _tag: "Failure", failure: { reason: "process_killed" } });
      expect(Date.now()).toBeGreaterThanOrEqual(deadline + 1_000);
      expect(yield* Fiber.join(heldFiber)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "process_killed" }
      });
      expect(yield* supervisor.invoke(invocation(sibling, host.url))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: "alive" }
      });
      const report = yield* reportFor(supervisor, bad.processGeneration!);
      expect(report).toMatchObject({ cause: "deadline", callsServed: 2, binding: bad.binding });
      if (directory !== undefined)
        yield* Effect.promise(() =>
          expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
        );
      expect(report.invocations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ invocationId: "inv_spin", deadline }),
          expect.objectContaining({ invocationId: "inv_held" })
        ])
      );
      expect(report.cpuSeconds).toBeGreaterThan(0);
      expect(report.peakRssBytes).toBeGreaterThan(0);
      expect(report.event).toMatchObject({
        type: "process",
        cause: "deadline",
        cpuSeconds: report.cpuSeconds,
        peakRssBytes: report.peakRssBytes,
        callsServed: 2,
        sampleProbability: 1
      });
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).reports).toContainEqual(report);
      expect(
        (yield* supervisor.stats({ bindingEpoch: 1, acknowledgeReports: [report.reportId] }))
          .reports
      ).not.toContainEqual(report);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  30_000
);

it.live(
  "keeps the watchdog deadline after the caller disconnects",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: largeAggregate
      });
      const loaded = yield* bind(supervisor, "ver_disconnected");
      const request = invocation(loaded, host.url, "spin", { deadline: Date.now() + 300 });
      const caller = yield* supervisor.invoke(request).pipe(Effect.forkChild);
      yield* Effect.sleep(100);
      yield* Fiber.interrupt(caller);
      const report = yield* reportFor(supervisor, loaded.processGeneration!);
      expect(report.cause).toBe("deadline");
      expect(report.invocations).toEqual([
        expect.objectContaining({ invocationId: request.request.invocationId })
      ]);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "kills a real resident-memory leak at the registry's 512 MiB limit",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: { ...largeAggregate, "execution.probe.interval": 25 }
      });
      const loaded = yield* bind(supervisor, "ver_leak");
      const result = yield* supervisor
        .invoke(invocation(loaded, host.url, "leak", { deadline: Date.now() + 30_000 }))
        .pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "process_killed" } });
      const report = yield* reportFor(supervisor, loaded.processGeneration!);
      expect(report.cause).toBe("memory");
      expect(report.peakRssBytes).toBeGreaterThanOrEqual(registry["execution.process.rss"].default);
      expect(report.invocations).toEqual([
        expect.objectContaining({ processGeneration: loaded.processGeneration })
      ]);
      expect(report.event.limits).toContainEqual(
        expect.objectContaining({
          limitId: "execution.process.rss",
          value: 536_870_912,
          peak: report.peakRssBytes
        })
      );
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  45_000
);

it.live(
  "reports how long each process took to start, and whether it was its task's first",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: largeAggregate
      });
      const started = Date.now();
      const first = yield* bind(supervisor, "ver_first");
      const firstBindMs = Date.now() - started;
      const second = yield* bind(supervisor, "ver_second");
      for (const loaded of [first, second])
        yield* supervisor.stop({ bindingEpoch: 1, processGeneration: loaded.processGeneration });
      const firstEvent = (yield* reportFor(supervisor, first.processGeneration!)).event;
      const secondEvent = (yield* reportFor(supervisor, second.processGeneration!)).event;
      expect(firstEvent.firstOnTask).toBe(true);
      expect(firstEvent.startMs).toBeGreaterThan(0);
      expect(firstEvent.startMs).toBeLessThanOrEqual(firstBindMs);
      expect(firstEvent.startMs).toBeLessThanOrEqual(firstEvent.durationMs);
      expect(secondEvent.firstOnTask).toBe(false);
      expect(secondEvent.startMs).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "evicts a speculative process before an older demanded one, until demand binds it",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const make = Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: { ...largeAggregate, "execution.residency.processes": 2 }
      });
      const speculative = (supervisor: Supervisor.Supervisor["Service"], versionId: string) =>
        supervisor.bind({
          companyId: "com_supervisor",
          bindingEpoch: 1,
          bundle: bundle(versionId),
          speculative: true
        });
      const resident = (supervisor: Supervisor.Supervisor["Service"]) =>
        supervisor
          .stats({ bindingEpoch: 1 })
          .pipe(
            Effect.map((stats) => stats.processes.map((entry) => entry.binding.versionId).sort())
          );
      const supervisor = yield* make;
      yield* bind(supervisor, "ver_demanded");
      const guessed = yield* speculative(supervisor, "ver_guessed");
      // At the limit a speculative bind evicts nothing; a demanded one takes the guess first.
      expect(yield* speculative(supervisor, "ver_another").pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "busy" }
      });
      yield* bind(supervisor, "ver_clicked");
      expect(yield* resident(supervisor)).toEqual(["ver_clicked", "ver_demanded"]);
      expect(yield* reportFor(supervisor, guessed.processGeneration!)).toMatchObject({
        cause: "evicted"
      });
      // Bound on demand, a guessed version is an ordinary process: the oldest idle one goes.
      const claimed = yield* make;
      yield* bind(claimed, "ver_old");
      yield* speculative(claimed, "ver_guessed");
      yield* bind(claimed, "ver_guessed");
      yield* bind(claimed, "ver_new");
      expect(yield* resident(claimed)).toEqual(["ver_guessed", "ver_new"]);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "evicts the oldest idle version past the process limit and fences its replaced generation",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: { ...largeAggregate, "execution.residency.processes": 2 }
      });
      const first = yield* bind(supervisor, "ver_0");
      for (let i = 1; i <= 2; i++) yield* bind(supervisor, `ver_${i}`);
      const stats = yield* supervisor.stats({ bindingEpoch: 1 });
      expect(stats.processes).toHaveLength(2);
      expect(
        stats.processes.some((entry) => entry.processGeneration === first.processGeneration)
      ).toBe(false);
      expect(yield* reportFor(supervisor, first.processGeneration!)).toMatchObject({
        cause: "evicted"
      });
      const replacement = yield* bind(supervisor, "ver_0");
      expect(replacement.processGeneration).not.toBe(first.processGeneration);
      expect(
        yield* supervisor.invoke(invocation(first, host.url)).pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stale_generation" } });
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "probes an idle process about once a second and a process with a call in flight every tick",
  () =>
    Effect.gen(function* () {
      const reached = Promise.withResolvers<void>();
      let held: ServerResponse | undefined;
      // Holds only the callback: a stray local request must not replace the response it ends.
      const host = yield* listener((request, response) => {
        if (request.method !== "POST") return void response.end();
        held = response;
        reached.resolve();
      });
      let probes = 0;
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) => {
          if (request.url.endsWith("/healthz")) probes++;
          return request;
        })
      );
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: { ...largeAggregate, "execution.probe.interval": 25 }
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const loaded = yield* bind(supervisor, "ver_watched");
      probes = 0;
      yield* Effect.sleep(3_000);
      const idle = probes;
      const running = yield* supervisor
        .invoke(invocation(loaded, host.url, "callback"))
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      probes = 0;
      yield* Effect.sleep(2_000);
      const busy = probes;
      held!.setHeader("content-type", "application/json");
      held!.end(JSON.stringify({ ok: true, value: "released" }));
      yield* Fiber.join(running);
      // A probe a second over 120 idle ticks; nearly one a tick over 80 busy ones.
      expect(idle).toBeGreaterThanOrEqual(2);
      expect(idle).toBeLessThanOrEqual(4);
      expect(busy).toBeGreaterThan(40);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "keeps a touched process past its idle window and loads nothing for a version it doesn't hold",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: {
          ...largeAggregate,
          "execution.process.idle": 2_000,
          // A ready process answers to its idle window alone; this deadline passes mid-test.
          "execution.process.load": 2_500,
          "execution.probe.interval": 25
        }
      });
      const kept = yield* bind(supervisor, "ver_kept");
      expect(yield* touch(supervisor, "ver_missing")).toEqual({ outcome: "absent", idleMs: 2_000 });
      // Touched well inside each window for more than one and a half windows.
      for (let round = 0; round < 8; round++) {
        yield* Effect.sleep(400);
        expect(yield* touch(supervisor, "ver_kept")).toEqual({ outcome: "touched", idleMs: 2_000 });
      }
      const stats = yield* supervisor.stats({ bindingEpoch: 1 });
      expect(stats.processes).toEqual([
        expect.objectContaining({ processGeneration: kept.processGeneration, callsServed: 0 })
      ]);
      expect(stats.reports).toEqual([]);
      // A touch names its exact hash and the current epoch.
      expect(yield* touch(supervisor, "ver_kept", `${source}\n`).pipe(Effect.flip)).toMatchObject({
        reason: "binding_conflict"
      });
      expect(
        yield* supervisor.touch({ bindingEpoch: 2, binding: kept.binding! }).pipe(Effect.flip)
      ).toMatchObject({ reason: "stale_epoch" });
      // Untouched, it idles out, and a touch then finds nothing and starts nothing.
      expect(yield* reportFor(supervisor, kept.processGeneration!)).toMatchObject({
        cause: "idle"
      });
      expect(yield* touch(supervisor, "ver_kept")).toEqual({ outcome: "absent", idleMs: 2_000 });
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).processes).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "expires an unfinished load at its deadline from spawn while touches keep arriving",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: {
          ...largeAggregate,
          "execution.process.load": 2_000,
          "execution.probe.interval": 25
        }
      });
      yield* supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 1 });
      const loading = yield* bind(supervisor, "ver_touched_load", unfinishedDescribe).pipe(
        Effect.result,
        Effect.forkChild
      );
      const pending = yield* statsWhen(supervisor, (stats) => stats.processes.length === 1);
      const outcomes: string[] = [];
      const touching = yield* Effect.gen(function* () {
        while (true) {
          outcomes.push((yield* touch(supervisor, "ver_touched_load", unfinishedDescribe)).outcome);
          yield* Effect.sleep(100);
        }
      }).pipe(Effect.forkChild);
      expect(yield* Fiber.join(loading)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "load_failed" }
      });
      yield* Fiber.interrupt(touching);
      expect(yield* reportFor(supervisor, pending.processes[0]!.processGeneration)).toMatchObject({
        cause: "load_failed",
        callsServed: 0
      });
      expect(outcomes).toContain("loading");
      expect(outcomes).not.toContain("touched");
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

// The production cap is 12. Touches never reserve, so the property is the same at any cap, and
// twelve workerd processes would dominate the suite.
it.live(
  "keeps one more touched version than the process cap allows without evicting or reloading any",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: {
          ...largeAggregate,
          "execution.residency.processes": 2,
          "execution.process.idle": 2_000,
          "execution.probe.interval": 25
        }
      });
      const open = ["ver_open_0", "ver_open_1", "ver_open_2"] as const;
      const first = yield* bind(supervisor, open[0]);
      const second = yield* bind(supervisor, open[1]);
      const touchAll = Effect.fnUntraced(function* (rounds: number) {
        const outcomes = new Map<string, Set<string>>(open.map((version) => [version, new Set()]));
        for (let round = 0; round < rounds; round++) {
          for (const version of open)
            outcomes.get(version)!.add((yield* touch(supervisor, version)).outcome);
          yield* Effect.sleep(400);
        }
        return outcomes;
      });
      // Every open version is touched for two idle windows; the third holds no process.
      expect(yield* touchAll(10)).toEqual(
        new Map([
          [open[0], new Set(["touched"])],
          [open[1], new Set(["touched"])],
          [open[2], new Set(["absent"])]
        ])
      );
      const generations = (stats: Management.StatsReply) =>
        stats.processes.map((entry) => entry.processGeneration).sort((a, b) => a - b);
      const touched = yield* supervisor.stats({ bindingEpoch: 1 });
      expect(generations(touched)).toEqual([first.processGeneration, second.processGeneration]);
      expect(touched.reports).toEqual([]);
      // Demand still wins: loading the third evicts the least recently touched, once, and that
      // version's touches then find nothing rather than load it back.
      const third = yield* bind(supervisor, open[2]);
      expect(yield* touchAll(6)).toEqual(
        new Map([
          [open[0], new Set(["absent"])],
          [open[1], new Set(["touched"])],
          [open[2], new Set(["touched"])]
        ])
      );
      const after = yield* supervisor.stats({ bindingEpoch: 1 });
      expect(generations(after)).toEqual([second.processGeneration, third.processGeneration]);
      expect(after.reports).toEqual([
        expect.objectContaining({ processGeneration: first.processGeneration, cause: "evicted" })
      ]);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  30_000
);

it.live(
  "continuously evicts the largest idle process under aggregate memory pressure without killing a busy version",
  () =>
    Effect.gen(function* () {
      const reached = Promise.withResolvers<void>();
      const host = yield* listener(() => reached.resolve());
      const ceiling = process.memoryUsage.rss() + 768 * 1024 ** 2;
      const pressureMargin = 256 * 1024 ** 2;
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: {
          "execution.residency.bytes": ceiling,
          "execution.process.rss": ceiling + 2 * pressureMargin,
          "execution.probe.interval": 25
        }
      });
      const small = yield* bind(supervisor, "ver_small_oldest");
      const large = yield* bind(supervisor, "ver_large_idle");
      const busy = yield* bind(supervisor, "ver_memory_busy");
      yield* supervisor.invoke(
        invocation(large, host.url, "grow", { args: { bytes: 192 * 1024 ** 2 } })
      );
      const before = yield* statsWhen(supervisor, (stats) =>
        stats.processes.some(
          (entry) =>
            entry.processGeneration === large.processGeneration && entry.rssBytes >= 192 * 1024 ** 2
        )
      );
      expect(
        before.processes.find((entry) => entry.processGeneration === large.processGeneration)!
          .rssBytes
      ).toBeGreaterThan(
        before.processes.find((entry) => entry.processGeneration === small.processGeneration)!
          .rssBytes
      );
      yield* supervisor
        .invoke(
          invocation(busy, host.url, "growAndHold", {
            args: { bytes: ceiling + pressureMargin }
          })
        )
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      const report = yield* reportFor(supervisor, large.processGeneration!);
      expect(report.cause).toBe("evicted");
      const after = yield* statsWhen(supervisor, (stats) =>
        stats.processes.some(
          (entry) =>
            entry.processGeneration === busy.processGeneration &&
            entry.rssBytes >= ceiling + pressureMargin
        )
      );
      expect(after.reports[0]!.processGeneration).toBe(large.processGeneration);
      expect(after.processes).toContainEqual(
        expect.objectContaining({ processGeneration: busy.processGeneration, activeInvocations: 1 })
      );
      expect(report.event.limits).toContainEqual(
        expect.objectContaining({
          limitId: "execution.residency.bytes",
          value: ceiling,
          peak: expect.any(Number)
        })
      );
      for (const resident of (yield* supervisor.stats({ bindingEpoch: 1 })).processes)
        yield* supervisor.stop({ bindingEpoch: 1, processGeneration: resident.processGeneration });
      const fresh = yield* bind(supervisor, "ver_after_pressure");
      yield* supervisor.stop({ bindingEpoch: 1, processGeneration: fresh.processGeneration });
      const freshReport = yield* reportFor(supervisor, fresh.processGeneration!);
      expect(freshReport.event.limits).toContainEqual(
        expect.objectContaining({ limitId: "execution.residency.processes", peak: 1 })
      );
      expect(
        freshReport.event.limits?.find((entry) => entry.limitId === "execution.residency.bytes")
          ?.peak
      ).toBeLessThan(ceiling);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  30_000
);

it.live(
  "evicts an idle sibling during invocation admission without evicting the larger target",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const ceiling = process.memoryUsage.rss() + 768 * 1024 ** 2;
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: {
          "execution.residency.bytes": ceiling,
          "execution.process.rss": ceiling,
          "execution.probe.interval": 5_000
        }
      });
      const target = yield* bind(supervisor, "ver_protected");
      const sibling = yield* bind(supervisor, "ver_evict_on_invoke");
      yield* supervisor.invoke(
        invocation(target, host.url, "grow", { args: { bytes: 192 * 1024 ** 2 } })
      );
      const sampled = yield* statsWhen(supervisor, (stats) =>
        stats.processes.some(
          (entry) =>
            entry.processGeneration === target.processGeneration &&
            entry.rssBytes >= 192 * 1024 ** 2
        )
      );
      const targetStats = sampled.processes.find(
        (entry) => entry.processGeneration === target.processGeneration
      )!;
      const siblingStats = sampled.processes.find(
        (entry) => entry.processGeneration === sibling.processGeneration
      )!;
      expect(targetStats.rssBytes).toBeGreaterThan(siblingStats.rssBytes);
      // Real host allocations cross the budget between child samples. No accounting is stubbed.
      const pressure: Buffer[] = [];
      const childRss = targetStats.rssBytes + siblingStats.rssBytes;
      const pressuredRss = ceiling + Math.floor(siblingStats.rssBytes / 4);
      let missing = pressuredRss - process.memoryUsage.rss() - childRss;
      while (missing > 0) {
        pressure.push(Buffer.alloc(missing, 165));
        missing = pressuredRss - process.memoryUsage.rss() - childRss;
      }
      expect(yield* supervisor.invoke(invocation(target, host.url))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: "alive" }
      });
      expect(yield* reportFor(supervisor, sibling.processGeneration!)).toMatchObject({
        cause: "evicted",
        callsServed: 0
      });
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).processes).toEqual([
        expect.objectContaining({ processGeneration: target.processGeneration })
      ]);
      pressure.length = 0;
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "does not reap active calls as idle and returns busy instead of killing them for residency",
  () =>
    Effect.gen(function* () {
      const reached = Promise.withResolvers<void>();
      let held: ServerResponse | undefined;
      const host = yield* listener((_request, response) => {
        held = response;
        reached.resolve();
      });
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: {
          ...largeAggregate,
          "execution.residency.processes": 1,
          "execution.process.idle": 1_500,
          "execution.probe.interval": 25
        }
      });
      const loaded = yield* bind(supervisor, "ver_busy");
      const running = yield* supervisor
        .invoke(invocation(loaded, host.url, "callback"))
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      yield* Effect.sleep(1_750);
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).processes).toEqual([
        expect.objectContaining({
          processGeneration: loaded.processGeneration,
          activeInvocations: 1
        })
      ]);
      expect(yield* bind(supervisor, "ver_overflow").pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "busy",
          limit: { scope: "company", limitId: "execution.residency.processes", value: 1 }
        }
      });
      held!.setHeader("content-type", "application/json");
      held!.end(JSON.stringify({ ok: true, value: "released" }));
      expect(yield* Fiber.join(running)).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: "released" }
      });
      const report = yield* reportFor(supervisor, loaded.processGeneration!);
      expect(report).toMatchObject({ cause: "idle", callsServed: 1, invocations: [] });
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "reports an in-flight attempt when its supervisor scope shuts down",
  () =>
    Effect.gen(function* () {
      const reached = Promise.withResolvers<void>();
      const host = yield* listener(() => reached.resolve());
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: largeAggregate
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const loaded = yield* bind(supervisor, "ver_shutdown");
      const request = invocation(loaded, host.url, "callback");
      const pending = yield* supervisor.invoke(request).pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      yield* Scope.close(scope, Exit.void);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "process_killed" }
      });
      const report = yield* reportFor(supervisor, loaded.processGeneration!);
      expect(report).toMatchObject({
        cause: "stopped",
        invocations: [
          {
            invocationId: request.request.invocationId,
            attemptId: request.request.attemptId,
            processGeneration: loaded.processGeneration,
            deadline: request.request.deadline
          }
        ]
      });
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  15_000
);

it.live(
  "expires a responsive unfinished describe load and admits a replacement",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      // The load deadline is its own: the ten-minute idle window never comes into it.
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: {
          ...largeAggregate,
          "execution.residency.processes": 1,
          "execution.process.load": 2_000,
          "execution.probe.interval": 25
        }
      });
      yield* supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 1 });
      const started = Date.now();
      const loading = yield* bind(supervisor, "ver_async_describe", unfinishedDescribe).pipe(
        Effect.result,
        Effect.forkChild
      );
      const pending = yield* statsWhen(supervisor, (stats) => stats.processes.length === 1);
      expect(yield* bind(supervisor, "ver_full").pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "busy" }
      });
      expect(yield* Fiber.join(loading)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "load_failed" }
      });
      const report = yield* reportFor(supervisor, pending.processes[0]!.processGeneration);
      expect(report).toMatchObject({ cause: "load_failed", callsServed: 0, invocations: [] });
      expect(report.endedAt - started).toBeGreaterThanOrEqual(2_000);
      // It never became ready, so it never finished starting.
      expect(report.event.startMs).toBeUndefined();
      const replacement = yield* bind(supervisor, "ver_replacement");
      expect(yield* supervisor.invoke(invocation(replacement, host.url))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: "alive" }
      });
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "kills an unresponsive load after six seconds while bind, stats, and sibling invocations keep running",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: largeAggregate
      });
      const sibling = yield* bind(supervisor, "ver_healthy");
      const started = Date.now();
      const loading = yield* bind(
        supervisor,
        "ver_bad_load",
        "while (true) {} export default {};"
      ).pipe(Effect.result, Effect.forkChild);
      yield* Effect.sleep(500);
      expect(yield* supervisor.invoke(invocation(sibling, host.url))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: "alive" }
      });
      expect((yield* supervisor.stats({ bindingEpoch: 1 })).processes).toHaveLength(2);
      expect(yield* Fiber.join(loading)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "process_killed" }
      });
      const stats = yield* supervisor.stats({ bindingEpoch: 1 });
      const generation =
        stats.reports.find((report) => report.binding.versionId === "ver_bad_load")
          ?.processGeneration ?? sibling.processGeneration! + 1;
      const report = yield* reportFor(supervisor, generation);
      expect(report.cause).toBe("stall");
      expect(report.endedAt - started).toBeGreaterThanOrEqual(6_000);
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "fences old epochs and killed generations before forwarding callbacks",
  () =>
    Effect.gen(function* () {
      const reached = Promise.withResolvers<void>();
      const headers: IncomingMessage["headers"][] = [];
      const host = yield* listener((request) => {
        headers.push(request.headers);
        reached.resolve();
      });
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: largeAggregate
      });
      const loaded = yield* bind(supervisor, "ver_fenced");
      const request = invocation(loaded, host.url, "callback");
      const pending = yield* supervisor.invoke(request).pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      expect(headers[0]).toMatchObject({
        "x-patchy-binding-epoch": "1",
        "x-patchy-process-generation": String(loaded.processGeneration)
      });
      const pid = (yield* supervisor.stats({ bindingEpoch: 1 })).processes[0]!.pid;
      const proxyUrl = yield* Effect.promise(async () => {
        const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
        const config = await readFile(
          args.find((arg) => arg.endsWith("config.capnp"))!,
          "utf8"
        );
        const url = /http:\/\/127\.0\.0\.1:\d+\/callback\/[\da-f-]+/.exec(config)?.[0];
        if (url === undefined) throw new Error("Missing private callback route");
        return url;
      });
      const staleCallback = () =>
        Effect.promise(async () => {
          const response = await fetch(proxyUrl, {
            method: "POST",
            headers: {
              authorization: "Bearer host-attempt-capability",
              "content-type": "application/json",
              "x-patchy-invocation-id": request.request.invocationId,
              "x-patchy-attempt-id": request.request.attemptId,
              "x-patchy-process-generation": String(loaded.processGeneration)
            },
            body: JSON.stringify({ op: "late", args: {} })
          });
          await response.body?.cancel();
          return response.status;
        });
      yield* supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 2 });
      expect(yield* staleCallback()).toBe(403);
      expect(yield* supervisor.stats({ bindingEpoch: 1 }).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale_epoch" }
      });
      expect(yield* supervisor.stop({ bindingEpoch: 1 }).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale_epoch" }
      });
      expect(yield* supervisor.invoke(request).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale_epoch" }
      });
      expect(
        yield* supervisor.bind({ companyId: "com_supervisor", bindingEpoch: 1 }).pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stale_epoch" } });
      yield* supervisor.stop({ bindingEpoch: 2, processGeneration: loaded.processGeneration });
      expect(yield* staleCallback()).toBe(403);
      expect(headers).toHaveLength(1);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "process_killed" }
      });
      yield* supervisor.stop({ bindingEpoch: 2 });
      expect(
        yield* supervisor.bind({ companyId: "com_other", bindingEpoch: 3 }).pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stopped" } });
    }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);

it.live(
  "retains the last CPU and RSS sample when a child exits externally and reaps every child on scope close",
  () =>
    Effect.gen(function* () {
      let survivingPid = 0;
      yield* Effect.gen(function* () {
        const host = yield* listener(idleHost);
        const supervisor = yield* Supervisor.make({
          callbackUrls: [host.url],
          operatingLimits: { ...largeAggregate, "execution.probe.interval": 25 }
        });
        const exited = yield* bind(supervisor, "ver_external_exit");
        const survivor = yield* bind(supervisor, "ver_scoped");
        yield* supervisor.invoke(invocation(exited, host.url));
        yield* Effect.sleep(100);
        const stats = yield* supervisor.stats({ bindingEpoch: 1 });
        const before = stats.processes.find(
          (entry) => entry.processGeneration === exited.processGeneration
        )!;
        survivingPid = stats.processes.find(
          (entry) => entry.processGeneration === survivor.processGeneration
        )!.pid;
        const uids = yield* Effect.promise(async () =>
          Promise.all(
            [before.pid, survivingPid].map(async (pid) =>
              Number(/^Uid:\s+(\d+)/m.exec(await readFile(`/proc/${pid}/status`, "utf8"))?.[1])
            )
          )
        );
        if (process.getuid?.() === 0) {
          expect(uids[0]).not.toBe(0);
          expect(uids[1]).not.toBe(0);
          expect(uids[0]).not.toBe(uids[1]);
        } else expect(uids).toEqual([process.getuid?.(), process.getuid?.()]);
        process.kill(before.pid, "SIGKILL");
        const report = yield* reportFor(supervisor, exited.processGeneration!);
        expect(report).toMatchObject({ cause: "exited", callsServed: 1 });
        expect(report.cpuSeconds).toBeGreaterThanOrEqual(before.cpuSeconds);
        expect(report.peakRssBytes).toBeGreaterThanOrEqual(before.peakRssBytes);
        expect(report.peakRssBytes).toBeGreaterThan(0);
        expect(yield* supervisor.invoke(invocation(survivor, host.url))).toMatchObject({
          outcome: "returned",
          reply: { ok: true, value: "alive" }
        });
        const replacement = yield* bind(supervisor, "ver_after_external_exit");
        expect(yield* supervisor.invoke(invocation(replacement, host.url))).toMatchObject({
          outcome: "returned",
          reply: { ok: true, value: "alive" }
        });
      }).pipe(Effect.scoped);
      expect(() => process.kill(survivingPid, 0)).toThrow();
    }).pipe(Effect.provide([FetchHttpClient.layer, NodeCryptography.layer])),
  20_000
);
