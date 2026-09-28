// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off -- real workerd hangs must be killed and reaped under wall-clock deadlines.
import { existsSync } from "node:fs";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Inspection from "./inspection.js";
import { startWorkerd } from "./process.js";

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
  "reports load throws and malformed descriptions",
  () =>
    Effect.gen(function* () {
      expect(
        yield* Inspection.inspect('throw new Error("top-level failure"); export default {};').pipe(
          Effect.result
        )
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "InspectionError", reason: "load" } });
      expect(
        yield* Inspection.inspect(
          'export default {fetch(){return Response.json({ok:true,handlers:{"invalid/name":{kind:"query",args:{},result:{kind:"text"}}}})}}'
        ).pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "InspectionError", reason: "load" } });
    }),
  30_000
);

it.live(
  "refuses re-exports and dormant computed imports in a server artifact",
  () =>
    Effect.gen(function* () {
      for (const edge of [
        'export { default as process } from "node:process";',
        'export * from "node:process";',
        "export function later(name) { return import(name); }"
      ]) {
        expect(yield* Inspection.inspect(`${edge}\n${source}`).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "InspectionError", reason: "load" }
        });
      }
    }),
  30_000
);

it.live.each([
  "while (true) {} export default {};",
  "await new Promise(() => {}); export default {};"
])(
  "bounds an initializer that cannot finish: %s",
  (bundle) =>
    Effect.gen(function* () {
      const result = yield* Inspection.inspect(bundle, { loadTimeoutMs: 150 }).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "InspectionError" } });
      // Some workerd releases detect unresolved top-level await themselves; either failure is typed.
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
            try {
              await fetch(`${child.url}/inspect`, {
                method: "POST",
                body: JSON.stringify({ wire: 1, bundle: "while (true) {} export default {};" }),
                signal: AbortSignal.timeout(150)
              });
            } catch (error) {
              expect(error).toMatchObject({ name: "TimeoutError" });
            }
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
