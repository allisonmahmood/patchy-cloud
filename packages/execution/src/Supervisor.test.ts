// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off -- real child processes, callback sockets and wall-clock watchdog deadlines are the acceptance boundary.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, it } from "@effect/vitest";
import * as GuestProtocol from "@patchy/api/guest";
import * as Management from "@patchy/api/management";
import { registry } from "@patchy/limits/registry";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Supervisor from "./supervisor.js";

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
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
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
      const held = invocation(bad, host.url, "callback", { invocationId: "inv_held" });
      const heldFiber = yield* supervisor.invoke(held).pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      const deadline = Date.now() + 250;
      const spinning = invocation(bad, host.url, "spin", { invocationId: "inv_spin", deadline });
      const killed = yield* supervisor.invoke(spinning).pipe(Effect.result);
      expect(killed).toMatchObject({ _tag: "Failure", failure: { reason: "process_killed" } });
      expect(Date.now()).toBeGreaterThanOrEqual(deadline + 1_000);
      expect(Date.now()).toBeLessThan(deadline + 3_000);
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
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  45_000
);

it.live(
  "evicts the oldest idle version on the thirteenth load and fences its replaced generation",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(idleHost);
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: largeAggregate
      });
      const first = yield* bind(supervisor, "ver_0");
      for (let i = 1; i <= 12; i++) yield* bind(supervisor, `ver_${i}`);
      const stats = yield* supervisor.stats({ bindingEpoch: 1 });
      expect(stats.processes).toHaveLength(12);
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
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  60_000
);

it.live(
  "continuously evicts the largest idle process under aggregate memory pressure without killing a busy version",
  () =>
    Effect.gen(function* () {
      const reached = Promise.withResolvers<void>();
      const host = yield* listener(() => reached.resolve());
      const ceiling = process.memoryUsage.rss() + 512 * 1024 ** 2;
      const supervisor = yield* Supervisor.make({
        callbackUrls: [host.url],
        operatingLimits: {
          "execution.residency.bytes": ceiling,
          "execution.process.rss": 2 * 1024 ** 3,
          "execution.probe.interval": 25
        }
      });
      const small = yield* bind(supervisor, "ver_small_oldest");
      const large = yield* bind(supervisor, "ver_large_idle");
      const busy = yield* bind(supervisor, "ver_memory_busy");
      yield* supervisor.invoke(
        invocation(large, host.url, "grow", { args: { bytes: 96 * 1024 ** 2 } })
      );
      yield* Effect.sleep(100);
      const before = yield* supervisor.stats({ bindingEpoch: 1 });
      expect(
        before.processes.find((entry) => entry.processGeneration === large.processGeneration)!
          .rssBytes
      ).toBeGreaterThan(
        before.processes.find((entry) => entry.processGeneration === small.processGeneration)!
          .rssBytes
      );
      yield* supervisor
        .invoke(invocation(busy, host.url, "growAndHold", { args: { bytes: 480 * 1024 ** 2 } }))
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      const report = yield* reportFor(supervisor, large.processGeneration!);
      expect(report.cause).toBe("evicted");
      const after = yield* supervisor.stats({ bindingEpoch: 1 });
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
      expect(yield* bind(supervisor, "ver_memory_overflow").pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "busy",
          limit: { scope: "company", limitId: "execution.residency.bytes", value: ceiling }
        }
      });
      expect(
        yield* supervisor
          .invoke(invocation(busy, host.url, "reply", { invocationId: "inv_refused" }))
          .pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "busy",
          limit: { scope: "company", limitId: "execution.residency.bytes", value: ceiling }
        }
      });
      for (const resident of (yield* supervisor.stats({ bindingEpoch: 1 })).processes)
        yield* supervisor.stop({ bindingEpoch: 1, processGeneration: resident.processGeneration });
      const fresh = yield* bind(supervisor, "ver_after_pressure");
      yield* supervisor.stop({ bindingEpoch: 1, processGeneration: fresh.processGeneration });
      const freshReport = yield* reportFor(supervisor, fresh.processGeneration!);
      expect(freshReport.event.limits).toContainEqual(
        expect.objectContaining({ limitId: "execution.residency.processes", peak: 1 })
      );
      expect(
        freshReport.event.limits.find((entry) => entry.limitId === "execution.residency.bytes")!
          .peak
      ).toBeLessThan(ceiling);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
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
          "execution.process.idle": 200,
          "execution.probe.interval": 25
        }
      });
      const loaded = yield* bind(supervisor, "ver_busy");
      const running = yield* supervisor
        .invoke(invocation(loaded, host.url, "callback"))
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => reached.promise);
      yield* Effect.sleep(350);
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
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
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
      expect(report.endedAt - started).toBeLessThan(9_000);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
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
        const url = /http:\/\/127\.0\.0\.1:\d+\/callback\/\d+\/[\da-f-]+/.exec(config)?.[0];
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
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
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
      }).pipe(Effect.scoped);
      expect(() => process.kill(survivingPid, 0)).toThrow();
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  20_000
);
