// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- Real workerd watchdogs use wall-clock deadlines and content hashes.
import { createHash } from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as GuestProtocol from "@patchy/api/guest";
import * as Executor from "@patchy/runtime/executor";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Local from "./local.js";
import * as Supervisor from "./supervisor.js";

const callbackUrl = "http://127.0.0.1:32124/callback";
const source = `let calls = 0;
export default { async fetch(request) {
  const input = await request.json();
  if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
  if (input.handler === "demo.spin") { for (;;) {} }
  return Response.json({ ok: true, value: ++calls });
}};`;
const bundle: GuestProtocol.Bundle = {
  companyId: "com_local",
  patchId: "pat_local",
  versionId: "ver_local",
  sha256: createHash("sha256").update(source).digest("hex"),
  bundle: source
};
const options = {
  companyId: bundle.companyId,
  callbackUrls: [callbackUrl],
  environment: "test" as const
};
const invocation = (
  loaded: Executor.BoundVersion,
  handler: string,
  attemptId: string,
  deadlineMs = 30_000
): GuestProtocol.Invoke => {
  if (loaded.processGeneration === undefined)
    throw new Error("Local binding omitted its process generation.");
  return {
    wire: 1,
    binding: loaded.binding,
    processGeneration: loaded.processGeneration,
    invocationId: `inv_${attemptId}`,
    attemptId,
    deadline: Date.now() + deadlineMs,
    handler,
    args: {},
    viewer: {
      user: { id: "usr_test", name: "Reader", email: "reader@example.test" },
      company: { id: bundle.companyId, name: "Example", handle: "example" },
      admin: false
    },
    callback: { url: callbackUrl, capability: "local-host-capability" }
  };
};

it.live(
  "binds, calls and rebinds above the host RSS ceiling while fleet accounting still refuses",
  () =>
    Effect.gen(function* () {
      const ceiling = 256 * 1024 ** 2;
      yield* Effect.acquireRelease(
        Effect.sync(() => [
          Buffer.alloc(Math.max(0, ceiling - process.memoryUsage.rss()) + 16 * 1024 ** 2, 165)
        ]),
        (pressure) =>
          Effect.sync(() => {
            pressure.length = 0;
          })
      );
      expect(process.memoryUsage.rss()).toBeGreaterThanOrEqual(ceiling);
      const operatingLimits = {
        "execution.residency.bytes": ceiling,
        "execution.residency.processes": 1
      } as const;
      const fleet = yield* Supervisor.make({ callbackUrls: [callbackUrl], operatingLimits });
      expect(
        yield* fleet
          .bind({ companyId: bundle.companyId, bindingEpoch: 1, bundle })
          .pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "busy",
          limit: { scope: "company", limitId: "execution.residency.bytes", value: ceiling }
        }
      });
      expect((yield* fleet.stats({ bindingEpoch: 1 })).aggregateRssBytes).toBeGreaterThanOrEqual(
        ceiling
      );
      const local = yield* Local.make({ ...options, operatingLimits });
      const first = yield* local.bind(bundle);
      expect(yield* local.invoke(invocation(first, "demo.read", "host_pressure"))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: 1 }
      });
      const replacement = yield* local.bind({ ...bundle, versionId: "ver_replacement" });
      expect(
        yield* local.invoke(invocation(replacement, "demo.read", "replacement"))
      ).toMatchObject({ outcome: "returned", reply: { ok: true, value: 1 } });
      const rebound = yield* local.bind(bundle);
      expect(rebound.processGeneration).toBeGreaterThan(first.processGeneration!);
      expect(yield* local.invoke(invocation(rebound, "demo.read", "rebound"))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: 1 }
      });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  20_000
);

it.live(
  "recovers a watchdog-killed local generation only on a fresh host bind, without replay",
  () =>
    Effect.gen(function* () {
      const local = yield* Local.make(options);
      const first = yield* local.bind(bundle);
      expect(yield* local.invoke(invocation(first, "demo.read", "first"))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: 1 }
      });
      expect(yield* local.bind(bundle)).toEqual(first);
      // A short deadline takes the deadline kill; Supervisor.test.ts owns the six-second stall.
      const killed = yield* local
        .invoke(invocation(first, "demo.spin", "spin", 250))
        .pipe(Effect.result);
      expect(killed).toMatchObject({ _tag: "Failure", failure: { reason: "process_killed" } });
      expect(
        yield* local.invoke(invocation(first, "demo.read", "missing")).pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "bundle_required" }
      });
      const recovered = yield* local.bind(bundle);
      expect(recovered.binding).toEqual(first.binding);
      expect(recovered.processGeneration).toBeGreaterThan(first.processGeneration!);
      expect(
        yield* local.invoke(invocation(first, "demo.read", "stale")).pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale_generation" }
      });
      expect(yield* local.invoke(invocation(recovered, "demo.read", "recovered"))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: 1 }
      });
      expect(
        yield* local.bind({ ...bundle, companyId: "com_other" }).pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "binding_conflict" }
      });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);

it.live(
  "refuses production construction even when callers request a test environment",
  () =>
    Effect.gen(function* () {
      const production = ConfigProvider.layer(
        ConfigProvider.fromUnknown({ NODE_ENV: "production" })
      );
      expect(
        yield* Local.make(options).pipe(Effect.provide(production), Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "production_refused" }
      });
      const development = ConfigProvider.layer(
        ConfigProvider.fromUnknown({ NODE_ENV: "development" })
      );
      expect(
        yield* Local.make({ ...options, environment: "production" }).pipe(
          Effect.provide(development),
          Effect.result
        )
      ).toMatchObject({ _tag: "Failure", failure: { reason: "production_refused" } });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  10_000
);
