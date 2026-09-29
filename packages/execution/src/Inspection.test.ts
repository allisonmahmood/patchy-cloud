// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off -- real workerd hangs require wall-clock deadlines; JSON only serializes test fixtures.
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

it.live.each([
  "file:///private/credential",
  "http://user:secret@127.0.0.1/callback",
  "http://127.0.0.1/callback#secret"
])("rejects unsupported callback authority without fabricating a cause: %s", (callbackUrl) =>
  Effect.gen(function* () {
    const result = yield* startWorkerd({ callbackUrls: [callbackUrl] }).pipe(
      Effect.scoped,
      Effect.result
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "WorkerdError", stage: "config", reason: "invalid_callback_url" }
    });
    if (result._tag === "Failure") {
      expect(result.failure.cause).toBeUndefined();
      expect(result.failure.message).not.toContain(callbackUrl);
      expect(result.failure.message).not.toContain("secret");
    }
  })
);

it.live("preserves the native cause of a malformed callback URL", () =>
  Effect.gen(function* () {
    const result = yield* startWorkerd({ callbackUrls: ["not a URL"] }).pipe(
      Effect.scoped,
      Effect.result
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "WorkerdError", stage: "config", reason: "invalid_callback_url" }
    });
    if (result._tag === "Failure") expect(result.failure.cause).toBeInstanceOf(TypeError);
  })
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

it.live(
  "times out synchronous initialization that spins forever",
  () =>
    Effect.gen(function* () {
      const result = yield* Inspection.inspect("while (true) {} export default {};", {
        loadTimeoutMs: 150
      }).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "InspectionError", reason: "timeout" }
      });
    }),
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
