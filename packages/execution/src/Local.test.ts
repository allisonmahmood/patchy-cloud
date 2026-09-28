// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- Real workerd watchdogs use wall-clock deadlines and content hashes.
import { createHash } from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as GuestProtocol from "@patchy/api/guest";
import * as Executor from "@patchy/runtime/executor";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Local from "./local.js";

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
  attemptId: string
): GuestProtocol.Invoke => {
  if (loaded.processGeneration === undefined)
    throw new Error("Local binding omitted its process generation.");
  return {
    wire: 1,
    binding: loaded.binding,
    processGeneration: loaded.processGeneration,
    invocationId: `inv_${attemptId}`,
    attemptId,
    deadline: Date.now() + 30_000,
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
  "recovers a health-killed local generation only on a fresh host bind, without replay",
  () =>
    Effect.gen(function* () {
      const local = yield* Local.make(options);
      const first = yield* local.bind(bundle);
      expect(yield* local.invoke(invocation(first, "demo.read", "first"))).toMatchObject({
        outcome: "returned",
        reply: { ok: true, value: 1 }
      });
      expect(yield* local.bind(bundle)).toEqual(first);
      const started = Date.now();
      const killed = yield* local
        .invoke(invocation(first, "demo.spin", "spin"))
        .pipe(Effect.result);
      expect(killed).toMatchObject({ _tag: "Failure", failure: { reason: "process_killed" } });
      expect(Date.now() - started).toBeLessThan(15_000);
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
      const local = yield* Local.make(options).pipe(Effect.provide(development));
      expect(
        yield* Executor.requireProduction.pipe(
          Effect.provideService(Executor.Executor, local),
          Effect.result
        )
      ).toMatchObject({ _tag: "Failure", failure: { reason: "production_refused" } });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  10_000
);
