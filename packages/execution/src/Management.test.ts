// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- Real sockets and workerd exercise the private management wire.
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, it } from "@effect/vitest";
import * as GuestProtocol from "@patchy/api/guest";
import * as Protocol from "@patchy/api/management";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Management from "./management.js";
import * as Supervisor from "./supervisor.js";

const secret = "deployment-current-secret";
const previousSecret = "deployment-previous-secret";
const callbackUrl = "http://127.0.0.1:32123/callback";
const source = `let calls = 0;
export default { async fetch(request) {
  const input = await request.json();
  if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
  return Response.json({ ok: true, value: ++calls });
}};`;
const bundle: GuestProtocol.Bundle = {
  companyId: "com_management",
  patchId: "pat_management",
  versionId: "ver_management",
  sha256: createHash("sha256").update(source).digest("hex"),
  bundle: source
};
const start = Effect.fn("ManagementTest.start")(function* (
  options: Partial<Management.Options> = {}
) {
  const supervisor = yield* Supervisor.make({ callbackUrls: [callbackUrl] });
  return yield* Management.serve({
    secret: Redacted.make(secret),
    previousSecret: Redacted.make(previousSecret),
    port: 0,
    ...options
  }).pipe(Effect.provideService(Supervisor.Supervisor, supervisor));
});
const post = Effect.fn("ManagementTest.post")(function* (
  url: string,
  path: string,
  body: unknown,
  token = secret
) {
  const http = yield* HttpClient.HttpClient;
  return yield* http.execute(
    HttpClientRequest.post(`${url}/${path}`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
      HttpClientRequest.bodyJsonUnsafe(body)
    )
  );
});
const decodeBind = Schema.decodeUnknownEffect(Protocol.BindReply, { onExcessProperty: "error" });
const decodeStats = Schema.decodeUnknownEffect(Protocol.StatsReply, { onExcessProperty: "error" });
const invocation = (
  binding: GuestProtocol.BundleBinding,
  processGeneration: number
): GuestProtocol.Invoke => ({
  wire: 1,
  binding,
  processGeneration,
  invocationId: "inv_management",
  attemptId: "attempt_management",
  deadline: Date.now() + 10_000,
  handler: "demo.read",
  args: {},
  viewer: {
    user: { id: "usr_test", name: "Reader", email: "reader@example.test" },
    company: { id: bundle.companyId, name: "Example", handle: "example" },
    admin: false
  },
  callback: { url: callbackUrl, capability: "invocation-capability-not-management-secret" }
});

it.live(
  "authenticates all verbs before reading an unfinished body",
  () =>
    Effect.gen(function* () {
      const { url } = yield* start();
      for (const path of ["bind", "invoke", "stop", "stats", "touch"]) {
        const status = yield* Effect.callback<number, Error>((resume) => {
          const request = httpRequest(
            `${url}/${path}`,
            {
              method: "POST",
              headers: {
                authorization: "Bearer invocation-capability-not-management-secret",
                "content-type": "application/json",
                "content-length": "1000000"
              }
            },
            (response) => {
              response.resume();
              resume(Effect.succeed(response.statusCode ?? 0));
            }
          );
          request.once("error", (error) => resume(Effect.fail(error)));
          request.flushHeaders();
          return Effect.sync(() => {
            request.destroy();
          });
        }).pipe(Effect.timeout("3 seconds"));
        expect(status).toBe(401);
      }
      const bound = yield* post(
        url,
        "bind",
        { companyId: bundle.companyId, bindingEpoch: 1 },
        previousSecret
      );
      expect(bound.status).toBe(200);
      expect((yield* post(url, "stats", { bindingEpoch: 1 })).status).toBe(200);
      expect(
        (yield* post(url, "stats", { bindingEpoch: 1 }, "older-deployment-secret")).status
      ).toBe(401);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  15_000
);

it.live("returns the enforced residency bound when no process can be evicted", () =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.make({
      callbackUrls: [callbackUrl],
      operatingLimits: { "execution.residency.bytes": 1 },
      configRevision: { deploymentRevision: "capacity-test", overrideRevision: "7" }
    });
    const { url } = yield* Management.serve({
      secret: Redacted.make(secret),
      port: 0
    }).pipe(Effect.provideService(Supervisor.Supervisor, supervisor));
    const response = yield* post(url, "bind", {
      companyId: bundle.companyId,
      bindingEpoch: 1,
      bundle
    });
    expect(response.status).toBe(503);
    expect(yield* response.json).toEqual({
      ok: false,
      code: "busy",
      scope: "company",
      limitId: "execution.residency.bytes",
      value: 1,
      limits: [
        {
          limitId: "execution.residency.bytes",
          value: 1,
          peak: expect.any(Number),
          configRevision: { deploymentRevision: "capacity-test", overrideRevision: "7" }
        }
      ]
    });
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))
);

it.live(
  "refuses a request naming another task before it has any effect",
  () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.make({ callbackUrls: [callbackUrl], taskId: "task-a" });
      const { url } = yield* Management.serve({ secret: Redacted.make(secret), port: 0 }).pipe(
        Effect.provideService(Supervisor.Supervisor, supervisor)
      );
      const misdirected = Effect.fn("ManagementTest.misdirected")(function* (
        path: string,
        body: object
      ) {
        const response = yield* post(url, path, { ...body, taskId: "task-b" });
        expect(response.status).toBe(421);
        expect(yield* response.json).toEqual({ ok: false, code: "wrong_task" });
      });
      // Without `taskId`, as an older host sends it.
      const stats = Effect.fn("ManagementTest.stats")(function* (bindingEpoch: number) {
        return yield* decodeStats(yield* (yield* post(url, "stats", { bindingEpoch })).json);
      });
      yield* misdirected("bind", { companyId: bundle.companyId, bindingEpoch: 1, bundle });
      expect(yield* stats(0)).toMatchObject({ companyId: null, bindingEpoch: 0, processes: [] });
      const loaded = yield* decodeBind(
        yield* (yield* post(url, "bind", {
          companyId: bundle.companyId,
          bindingEpoch: 1,
          bundle,
          taskId: "task-a"
        })).json
      );
      if (loaded.binding === undefined || loaded.processGeneration === undefined)
        return yield* Effect.die("Supervisor did not return its loaded generation.");
      yield* misdirected("invoke", {
        bindingEpoch: 1,
        request: invocation(loaded.binding, loaded.processGeneration)
      });
      yield* misdirected("stop", { bindingEpoch: 1 });
      yield* misdirected("stats", { bindingEpoch: 1 });
      yield* misdirected("touch", { bindingEpoch: 1, binding: loaded.binding });
      expect(yield* stats(1)).toMatchObject({ stopped: false, processes: [{ callsServed: 0 }] });
      // A supervisor without an identity is no task a host can name.
      const anonymous = yield* start();
      expect(
        (yield* post(anonymous.url, "stats", { bindingEpoch: 0, taskId: "task-a" })).status
      ).toBe(421);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  15_000
);

it.live(
  "binds a held version by hash and refuses one it doesn't hold before any effect",
  () =>
    Effect.gen(function* () {
      const { url } = yield* start();
      const binding: GuestProtocol.BundleBinding = {
        companyId: bundle.companyId,
        patchId: bundle.patchId,
        versionId: bundle.versionId,
        sha256: bundle.sha256
      };
      const stats = Effect.fn("ManagementTest.stats")(function* (bindingEpoch: number) {
        return yield* decodeStats(yield* (yield* post(url, "stats", { bindingEpoch })).json);
      });
      const needed = yield* post(url, "bind", {
        companyId: bundle.companyId,
        bindingEpoch: 1,
        binding
      });
      expect(needed.status).toBe(409);
      expect(yield* needed.json).toEqual({ ok: false, code: "bundle_required" });
      // Still a spare: the refusal reserved no company and adopted no epoch.
      expect(yield* stats(0)).toMatchObject({ companyId: null, bindingEpoch: 0, processes: [] });
      const loaded = yield* decodeBind(
        yield* (yield* post(url, "bind", { companyId: bundle.companyId, bindingEpoch: 1, bundle }))
          .json
      );
      const held = yield* post(url, "bind", {
        companyId: bundle.companyId,
        bindingEpoch: 1,
        binding
      });
      expect(held.status).toBe(200);
      expect(yield* decodeBind(yield* held.json)).toEqual(loaded);
      const conflicting = yield* post(url, "bind", {
        companyId: bundle.companyId,
        bindingEpoch: 1,
        binding: { ...binding, sha256: "f".repeat(64) }
      });
      expect(conflicting.status).toBe(409);
      expect(yield* conflicting.json).toEqual({ ok: false, code: "binding_conflict" });
      const both = yield* post(url, "bind", {
        companyId: bundle.companyId,
        bindingEpoch: 1,
        bundle,
        binding
      });
      expect(both.status).toBe(400);
      expect(yield* both.json).toEqual({ ok: false, code: "invalid_request" });
      expect((yield* stats(1)).processes).toMatchObject([
        { processGeneration: loaded.processGeneration }
      ]);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  15_000
);

it.live(
  "fences every management verb and transports acknowledged process reports",
  () =>
    Effect.gen(function* () {
      const { url } = yield* start();
      const first = yield* post(url, "bind", {
        companyId: bundle.companyId,
        bindingEpoch: 1,
        bundle
      });
      expect(first.status).toBe(200);
      const loaded = yield* decodeBind(yield* first.json);
      expect(loaded.binding).toEqual({
        companyId: bundle.companyId,
        patchId: bundle.patchId,
        versionId: bundle.versionId,
        sha256: bundle.sha256
      });
      if (loaded.binding === undefined || loaded.processGeneration === undefined)
        return yield* Effect.die("Supervisor did not return its loaded generation.");
      const invoke = invocation(loaded.binding, loaded.processGeneration);
      const served = yield* post(url, "invoke", { bindingEpoch: 1, request: invoke });
      expect(served.status).toBe(200);
      expect(yield* served.json).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: 1 }
      });
      const adopted = yield* post(url, "bind", { companyId: bundle.companyId, bindingEpoch: 2 });
      expect(adopted.status).toBe(200);
      for (const [path, body] of [
        ["bind", { companyId: bundle.companyId, bindingEpoch: 1 }],
        ["invoke", { bindingEpoch: 1, request: invoke }],
        ["stop", { bindingEpoch: 1 }],
        ["stats", { bindingEpoch: 1 }]
      ] as const) {
        const stale = yield* post(url, path, body);
        expect(stale.status).toBe(409);
        expect(yield* stale.json).toEqual({ ok: false, code: "stale_epoch" });
      }
      const stopped = yield* post(url, "stop", {
        bindingEpoch: 2,
        processGeneration: loaded.processGeneration
      });
      expect(stopped.status).toBe(204);
      const stats = yield* decodeStats(
        yield* (yield* post(url, "stats", { bindingEpoch: 2 })).json
      );
      expect(stats.processes).toEqual([]);
      expect(stats.reports).toHaveLength(1);
      const report = stats.reports[0]!;
      expect(report).toMatchObject({
        binding: loaded.binding,
        processGeneration: loaded.processGeneration,
        cause: "stopped",
        callsServed: 1,
        invocations: [],
        event: { type: "process", callsServed: 1, cause: "stopped", companyId: bundle.companyId }
      });
      expect(report.peakRssBytes).toBeGreaterThan(0);
      expect(report.endedAt).toBeGreaterThanOrEqual(report.startedAt);
      const repeated = yield* decodeStats(
        yield* (yield* post(url, "stats", { bindingEpoch: 2 })).json
      );
      expect(repeated.reports).toEqual(stats.reports);
      const staleAck = yield* post(url, "stats", {
        bindingEpoch: 1,
        acknowledgeReports: [report.reportId]
      });
      expect(staleAck.status).toBe(409);
      expect(
        (yield* decodeStats(yield* (yield* post(url, "stats", { bindingEpoch: 2 })).json)).reports
      ).toEqual(stats.reports);
      const acknowledged = yield* decodeStats(
        yield* (yield* post(url, "stats", {
          bindingEpoch: 2,
          acknowledgeReports: [report.reportId]
        })).json
      );
      expect(acknowledged.reports).toEqual([]);
      expect((yield* post(url, "stop", { bindingEpoch: 2 })).status).toBe(204);
      const otherCompany = yield* post(url, "bind", { companyId: "com_other", bindingEpoch: 3 });
      expect(otherCompany.status).toBe(409);
      expect(
        yield* decodeStats(yield* (yield* post(url, "stats", { bindingEpoch: 2 })).json)
      ).toMatchObject({ companyId: bundle.companyId, stopped: true, processes: [] });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);

it.live(
  "rejects malformed epochs, excess fields and oversized management bodies",
  () =>
    Effect.gen(function* () {
      const { url } = yield* start({ maxRequestBytes: 1024 });
      for (const bindingEpoch of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
        const response = yield* post(url, "bind", { companyId: bundle.companyId, bindingEpoch });
        expect(response.status).toBe(400);
        expect(yield* response.json).toEqual({ ok: false, code: "invalid_request" });
      }
      const excess = yield* post(url, "bind", {
        companyId: bundle.companyId,
        bindingEpoch: 1,
        capability: "not-a-secret"
      });
      expect(excess.status).toBe(400);
      const oversized = yield* post(url, "bind", { companyId: "x".repeat(2048), bindingEpoch: 1 });
      expect(oversized.status).toBe(413);
      expect(yield* oversized.json).toEqual({
        ok: false,
        code: "too_large",
        scope: "host",
        limitId: "execution.management.bodyBytes",
        value: 1024
      });
      const streamed = yield* Effect.callback<number, Error>((resume) => {
        const request = httpRequest(
          `${url}/bind`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
              "transfer-encoding": "chunked"
            }
          },
          (response) => {
            response.resume();
            resume(Effect.succeed(response.statusCode ?? 0));
          }
        );
        request.once("error", (error) => resume(Effect.fail(error)));
        request.write(`{"companyId":"com_overflow","bindingEpoch":9}`);
        request.end(" ".repeat(2048));
        return Effect.sync(() => {
          request.destroy();
        });
      });
      expect(streamed).toBe(413);
      const first = yield* post(url, "bind", { companyId: bundle.companyId, bindingEpoch: 0 });
      expect(first.status).toBe(200);
      const status = yield* decodeStats(
        yield* (yield* post(url, "stats", { bindingEpoch: 0 })).json
      );
      expect(status).toMatchObject({
        companyId: bundle.companyId,
        bindingEpoch: 0,
        stopped: false,
        processes: [],
        reports: []
      });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  15_000
);

it.live(
  "refuses wildcard, public and implicit private-interface listener configurations",
  () =>
    Effect.gen(function* () {
      for (const options of [
        { host: "0.0.0.0", privateInterface: true },
        { host: "::", privateInterface: true },
        { host: "8.8.8.8", privateInterface: true },
        { host: "10.0.0.1" },
        { host: "localhost", privateInterface: true }
      ]) {
        expect(yield* start(options).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "public_interface" }
        });
      }
      expect(yield* start({ secret: Redacted.make("") }).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid_secret" }
      });
      expect(yield* start({ maxRequestBytes: 0 }).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid_body_limit" }
      });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  15_000
);

it.live(
  "reports the private listener address when its port is occupied",
  () =>
    Effect.gen(function* () {
      const { url } = yield* start();
      const port = Number(new URL(url).port);
      expect(yield* start({ port }).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ListenerUnavailable", host: "127.0.0.1", port }
      });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  15_000
);
