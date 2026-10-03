// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off -- real workerd hangs require wall-clock deadlines; JSON only serializes test fixtures.
import { existsSync } from "node:fs";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Inspection from "./inspection.js";
import { startWorkerd } from "./process.js";
import { networkListener, networkProbeBundle } from "./test/network.js";

const descriptors = { "demo.read": { kind: "query", args: {}, result: { kind: "text" } } };
const source = `export default { fetch(request, env, ctx) {
  if (Object.keys(env).length !== 0 || Object.keys(ctx.props).length !== 0) throw new Error("Inspection received authority.");
  return Response.json({ok: true, handlers: ${JSON.stringify(descriptors)}});
}};`;

it.live(
  "discovers descriptors without company or callback bindings",
  () =>
    Effect.gen(function* () {
      expect(yield* Inspection.inspect(source)).toEqual(descriptors);
    }),
  30_000
);

it.live(
  "inspects each replacement bundle independently and recovers after a refused load",
  () =>
    Effect.gen(function* () {
      const inspection = yield* Inspection.make();
      expect(yield* inspection.inspect(source)).toEqual(descriptors);
      const replacement = {
        "leads.list": { kind: "query", args: {}, result: { kind: "number" } }
      };
      expect(
        yield* inspection.inspect(
          `export default { fetch() { return Response.json({ ok: true, handlers: ${JSON.stringify(replacement)} }); } };`
        )
      ).toEqual(replacement);
      expect(
        yield* inspection
          .inspect('throw new Error("bad replacement"); export default {};')
          .pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { reason: "load" } });
      expect(yield* inspection.inspect(source)).toEqual(descriptors);
    }).pipe(Effect.scoped),
  30_000
);

it.live(
  "discards inspection globals and background work after each successful description",
  () =>
    Effect.gen(function* () {
      const inspection = yield* Inspection.make({ loadTimeoutMs: 300 });
      const background = `let calls = 0;
        export default { fetch(request, env, ctx) {
          if (++calls !== 1) throw new Error("Reused inspection state.");
          ctx.waitUntil(scheduler.wait(75).then(() => { while (true) {} }));
          return Response.json({ ok: true, handlers: ${JSON.stringify(descriptors)} });
        } };`;
      for (let i = 0; i < 3; i++) {
        expect(yield* inspection.inspect(background)).toEqual(descriptors);
        // The child owns a real platform clock; TestClock cannot advance its scheduled work.
        yield* Effect.sleep("150 millis");
      }
      expect(yield* inspection.inspect(source)).toEqual(descriptors);
    }).pipe(Effect.scoped),
  30_000
);

it.live(
  "restarts reusable inspection after a replacement spins during initialization",
  () =>
    Effect.gen(function* () {
      const inspection = yield* Inspection.make({ loadTimeoutMs: 150 });
      expect(yield* inspection.inspect(source)).toEqual(descriptors);
      expect(
        yield* inspection.inspect("while (true) {} export default {};").pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { reason: "timeout" } });
      expect(yield* inspection.inspect(source)).toEqual(descriptors);
    }).pipe(Effect.scoped),
  30_000
);

it.live(
  "reports a malformed description as a load failure",
  () =>
    Effect.gen(function* () {
      expect(
        yield* Inspection.inspect(
          'export default {fetch(){return Response.json({ok:true,handlers:{"invalid/name":{kind:"query",args:{},result:{kind:"text"}}}})}}'
        ).pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "InspectionError", reason: "load" } });
    }),
  30_000
);

it.live(
  "refuses static imports, re-exports and dormant computed imports in a server artifact",
  () =>
    Effect.gen(function* () {
      for (const edge of [
        'import "cloudflare:workers";',
        'export { env } from "cloudflare:workers";',
        'export * from "cloudflare:workers";',
        'export * as workers from "cloudflare:workers";',
        "export function later(name) { return import(name); }",
        'export function later() { return import /* comment */ ("cloudflare:" + "workers"); }',
        "export function later(name) { return `prefix${import(name)}suffix`; }",
        "export function later(name) { return import(import(name)); }",
        "export function later(name) { return { [import(name)]: 1 }; }",
        "export function later(name) { return (function() {}) / import(name); }",
        'export function later(name) { if (false) /a/.test("a"); return import(name); }'
      ]) {
        expect(yield* Inspection.inspect(`${edge}\n${source}`).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "InspectionError", reason: "load" }
        });
      }
    }),
  30_000
);

it.live(
  "accepts import-like text and metadata but leaves syntax validation to workerd",
  () =>
    Effect.gen(function* () {
      const inspection = yield* Inspection.make();
      expect(
        yield* inspection.inspect(`
          // import("cloudflare:workers")
          const text = 'export * from "cloudflare:workers"';
          const pattern = /import\\("cloudflare:workers"\\)/;
          const template = \`import("cloudflare:workers")\`;
          const object = { import() { return import.meta.url; } };
          object.import();
          ${source}
        `)
      ).toEqual(descriptors);
      expect(
        yield* inspection.inspect(`export const = 1; ${source}`).pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { reason: "load" } });
    }).pipe(Effect.scoped),
  30_000
);

it.live(
  "denies TCP, fetch and WebSocket network after the exact Opus import bypass during inspection",
  () =>
    Effect.gen(function* () {
      const target = yield* networkListener;
      expect(yield* target.control).toBe("reachable");
      expect(target.connections()).toBe(1);
      const descriptor = { kind: "query", args: {}, result: { kind: "json" } };
      expect(yield* Inspection.inspect(networkProbeBundle(target.port))).toEqual({
        "probe.loaded_function": descriptor,
        "probe.tcp_refused": descriptor,
        "probe.fetch_refused": descriptor,
        "probe.webSocket_refused": descriptor
      });
      // The control reached a real TCP listener; no guest transport may reach it.
      expect(target.connections()).toBe(1);
    }).pipe(Effect.scoped),
  30_000
);

it.live(
  "bounds unresolved top-level await even when workerd rejects it natively",
  () =>
    Effect.gen(function* () {
      const result = yield* Inspection.inspect("await new Promise(() => {}); export default {};", {
        loadTimeoutMs: 150
      }).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "InspectionError" } });
      if (result._tag === "Failure") expect(["timeout", "load"]).toContain(result.failure.reason);
    }),
  30_000
);

it.live(
  "kills and reaps a spinning child before removing its scoped files",
  () =>
    Effect.gen(function* () {
      const process = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* startWorkerd();
          yield* Effect.promise(async () => {
            await expect(
              fetch(`${child.url}/inspect`, {
                method: "POST",
                body: JSON.stringify({ wire: 1, bundle: "while (true) {} export default {};" }),
                signal: AbortSignal.timeout(150)
              })
            ).rejects.toMatchObject({ name: "TimeoutError" });
          });
          return child;
        })
      );
      expect(process.child.signalCode).toBe("SIGKILL");
      expect(existsSync(process.directory)).toBe(false);
      expect(() => globalThis.process.kill(process.child.pid!, 0)).toThrow();
    }),
  30_000
);
