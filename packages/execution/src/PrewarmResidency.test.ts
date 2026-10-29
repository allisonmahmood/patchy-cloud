// @effect-diagnostics nodeBuiltinImport:off -- real workerd processes under a real supervisor are the boundary.
import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, type GuestProtocol, WIRE_VERSION } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import {
  ConnectedVersions,
  ExecutionLifecycle,
  Executor,
  LoadedVersions,
  Prewarm,
  ServerBundles,
  StreamLimits
} from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Supervisor from "./supervisor.js";
import { NodeCryptography } from "@patchy/core";

const companyId = "cmp_prewarm_residency";
const ready = `export default { async fetch() { return Response.json({ ok: true, handlers: {} }); } };`;
// Guest timers use workerd's clock: this version never finishes initializing.
const initializing = `export default { async fetch() {
  while (true) await new Promise((tick) => setTimeout(tick, 10));
}};`;
const version = (versionId: string): LoadedVersions.LoadedVersion & { patchTier: number } => ({
  companyId,
  patchId: `pat_${versionId}`,
  versionId,
  patchTier: 2,
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {},
    handlers: {}
  },
  scope: "company",
  wireVersion: WIRE_VERSION
});
const bundle = (loaded: LoadedVersions.LoadedVersion, code = ready): GuestProtocol.Bundle => ({
  companyId,
  patchId: loaded.patchId,
  versionId: loaded.versionId,
  sha256: createHash("sha256").update(code).digest("hex"),
  bundle: code
});

/**
 * A company task with room for one process, under the real ConnectedVersions and Prewarm. The
 * prewarm's candidate loads `code`; each bind ConnectedVersions sends lands in `attempts`.
 */
const harness = Effect.fnUntraced(function* (code = ready) {
  const supervisor = yield* Supervisor.make({
    callbackUrls: [],
    operatingLimits: {
      "execution.residency.processes": 1,
      "execution.residency.bytes": 8 * 1024 ** 3
    }
  });
  yield* supervisor.bind({ companyId, bindingEpoch: 1 });
  const attempts = yield* Queue.unbounded<{ readonly versionId: string; readonly ok: boolean }>();
  const lifecycle = ExecutionLifecycle.ExecutionLifecycle.of({
    prewarm: () => Effect.succeed({ found: "bound", followed: Effect.succeed(false) }),
    connect: () => Effect.void,
    acquire: () =>
      Effect.succeed({ binding: { taskId: "task", bindingEpoch: 1 }, release: Effect.void }),
    touch: (binding) => supervisor.touch({ binding, bindingEpoch: 1 }).pipe(Effect.orDie)
  });
  const local = yield* StreamLimits.StreamLimits.pipe(Effect.provide(StreamLimits.layerLocal));
  const connected = yield* ConnectedVersions.make.pipe(
    Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, lifecycle),
    Effect.provideService(StreamLimits.StreamLimits, local),
    Effect.provideService(ServerBundles.ServerBundles, {
      load: (loaded) => Effect.succeed(bundle(loaded, code))
    }),
    Effect.provideService(Executor.Executor, {
      bind: (sent, _binding, options) =>
        supervisor
          .bind({
            companyId,
            bindingEpoch: 1,
            bundle: sent,
            ...(options?.speculative === true ? { speculative: true } : {})
          })
          .pipe(
            Effect.onExit((exit) =>
              Queue.offer(attempts, { versionId: sent.versionId, ok: Exit.isSuccess(exit) })
            ),
            Effect.map((reply) => ({
              binding: reply.binding!,
              processGeneration: reply.processGeneration!
            })),
            Effect.mapError(
              (error) =>
                new Executor.ExecutionError({
                  operation: "bind",
                  reason: error.reason === "busy" ? "busy" : "load_failed"
                })
            )
          ),
      invoke: () => Effect.die("A prewarm never invokes.")
    })
  );
  const prewarm = yield* Prewarm.make.pipe(
    Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, lifecycle),
    Effect.provideService(ConnectedVersions.ConnectedVersions, connected),
    Effect.provideService(StreamLimits.StreamLimits, local),
    Effect.provideService(LoadedVersions.LoadedVersions, {
      find: (_patchId, versionId) => Effect.succeed(Option.some(version(versionId!)))
    })
  );
  return {
    supervisor,
    connected,
    next: Queue.take(attempts),
    prewarm: prewarm.prewarm({
      companyId,
      viewerId: "usr_prewarm",
      candidates: [{ patchId: "pat_speculative", versionId: "speculative" }]
    })
  };
});

it.live(
  "leaves a connected tool resident when a prewarm finds no free slot",
  () =>
    Effect.gen(function* () {
      const host = yield* harness();
      const document = version("document");
      yield* host.supervisor.bind({ companyId, bindingEpoch: 1, bundle: bundle(document) });
      yield* host.connected.connect(document, { warm: false });
      yield* host.prewarm;
      assert.deepStrictEqual(yield* host.next, { versionId: "speculative", ok: false });
      const stats = yield* host.supervisor.stats({ bindingEpoch: 1 });
      assert.deepStrictEqual(
        stats.processes.map((process) => process.binding.versionId),
        ["document"]
      );
      assert.deepStrictEqual(stats.reports, []);
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, NodeCryptography.layer]),
      Effect.provide(WideEvents.layerNoop)
    ),
  30_000
);

it.live(
  "loads a real open at once over a prewarm still initializing",
  () =>
    Effect.gen(function* () {
      const host = yield* harness(initializing);
      yield* host.prewarm;
      yield* host.supervisor.stats({ bindingEpoch: 1 }).pipe(
        Effect.tap(() => Effect.sleep(10)),
        Effect.repeat({
          until: (stats) =>
            stats.processes.some((process) => process.binding.versionId === "speculative")
        }),
        Effect.timeout("10 seconds")
      );
      const clicked = yield* host.supervisor.bind({
        companyId,
        bindingEpoch: 1,
        bundle: bundle(version("clicked"))
      });
      assert.strictEqual(clicked.binding?.versionId, "clicked");
      assert.deepStrictEqual(yield* host.next, { versionId: "speculative", ok: false });
      const stats = yield* host.supervisor.stats({ bindingEpoch: 1 });
      assert.deepStrictEqual(
        stats.processes.map((process) => process.binding.versionId),
        ["clicked"]
      );
      assert.deepInclude(stats.reports[0], { cause: "evicted" });
      assert.strictEqual(stats.reports[0]?.binding.versionId, "speculative");
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, NodeCryptography.layer]),
      Effect.provide(WideEvents.layerNoop)
    ),
  30_000
);
