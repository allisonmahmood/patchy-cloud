// @effect-diagnostics nodeBuiltinImport:off -- the release harness hashes the exact guest bytes in Node.
import { createHash } from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Executor from "@patchy/runtime/executor";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Engine from "./engine.js";
import * as Inspection from "./inspection.js";
import { startWorkerd } from "./process.js";
import { runtimePromiseBundle } from "./test/fixtures/runtimePromise.js";

const viewer = {
  user: { id: "usr_runtime", name: "Runtime reader", email: "runtime@example.test" },
  company: { id: "com_runtime", name: "Runtime", handle: "runtime" },
  admin: false
};

const callbackUrl = "http://127.0.0.1:1/callback";

// One workerd and engine serve every handler case; the handlers are pure.
class RuntimePromise extends Context.Service<
  RuntimePromise,
  { readonly run: (handler: string) => Effect.Effect<unknown, Executor.ExecutionError> }
>()("@patchy/execution/RuntimePromise.test/RuntimePromise") {}

const bound = Layer.effect(
  RuntimePromise,
  Effect.gen(function* () {
    const process = yield* startWorkerd({ callbackUrls: [callbackUrl] });
    const engine = yield* Engine.make({ url: process.url });
    const { binding } = yield* engine.bind({
      companyId: viewer.company.id,
      patchId: "pat_runtime",
      versionId: "ver_runtime",
      sha256: createHash("sha256").update(runtimePromiseBundle).digest("hex"),
      bundle: runtimePromiseBundle
    });
    const run = Effect.fnUntraced(function* (handler: string) {
      const response = yield* engine.invoke({
        wire: 1,
        binding,
        invocationId: `runtime-promise-${handler}`,
        attemptId: "first",
        processGeneration: 0,
        deadline: Date.now() + 10_000,
        handler: `runtime.${handler}`,
        args: {},
        viewer,
        callback: { url: callbackUrl, capability: "host-only-test-capability" }
      });
      expect(response.outcome).toBe("returned");
      if (response.outcome !== "returned")
        throw new Error(`Guest did not return: ${response.outcome}`);
      expect(response.reply.ok).toBe(true);
      if (!response.reply.ok) throw new Error(`Runtime promise failed: ${response.reply.code}`);
      return response.reply.value;
    });
    return RuntimePromise.of({ run });
  })
).pipe(Layer.provide(FetchHttpClient.layer));

it.layer(bound, { excludeTestServices: true, timeout: 30_000 })("server runtime promise", (it) => {
  it.effect("formats decimal strings exactly and supports the named Intl formatters", () =>
    Effect.gen(function* () {
      const { run } = yield* RuntimePromise;
      expect(yield* run("intl")).toEqual({
        decimal: "$9,007,199,254,740,993.01",
        date: "29/02/2024",
        plural: "two",
        relative: "yesterday",
        list: "Ada, Grace, and Linus",
        collator: -1,
        display: "États-Unis",
        segments: ["hello", " ", "world", "!"]
      });
    })
  );

  it.effect("provides UUIDs, integer random bytes and real Web Crypto operations", () =>
    Effect.gen(function* () {
      const { run } = yield* RuntimePromise;
      expect(yield* run("crypto")).toEqual({
        uuid: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
        sameArray: true,
        floatRefused: true,
        hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        verified: true,
        forged: false
      });
    })
  );

  it.effect("preserves encodings, structured values, URLs and large integers", () =>
    Effect.gen(function* () {
      const { run } = yield* RuntimePromise;
      expect(yield* run("values")).toEqual({
        text: "Grüße 🌍",
        clone: {
          cycle: true,
          date: "2024-02-29T00:00:00.000Z",
          answer: 42,
          originalByte: 1,
          copyByte: 9
        },
        url: {
          href: "https://example.test/items?q=a+b&q=c#row",
          query: ["a b", "c"],
          params: "name=Ada+%26+Grace&tag=a&tag=b"
        },
        base64: "AP9QYXRjaHk=",
        decoded: [0, 255, 80, 97, 116, 99, 104, 121],
        bigint: "900719925474099301"
      });
    })
  );

  it.effect("refuses network and dynamic code without exposing Node globals", () =>
    Effect.gen(function* () {
      const { run } = yield* RuntimePromise;
      expect(yield* run("refusals")).toEqual({
        fetches: [true, true, true, true],
        evalRefused: true,
        functionRefused: true,
        process: "undefined",
        Buffer: "undefined"
      });
    })
  );
});

it.live(
  "refuses Node built-ins and socket imports at load",
  () =>
    Effect.gen(function* () {
      for (const module of [
        "node:fs",
        "node:net",
        "node:process",
        "node:buffer",
        "cloudflare:sockets"
      ]) {
        const result = yield* Inspection.inspect(
          `import ${JSON.stringify(module)}; export default { fetch() { return Response.json({ ok: true, handlers: {} }); } };`
        ).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "InspectionError", reason: "load" }
        });
      }
    }),
  30_000
);
