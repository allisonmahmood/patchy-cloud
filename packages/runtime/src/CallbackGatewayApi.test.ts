import { assert, it } from "@effect/vitest";
import { ContractLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as CallbackGateway from "./CallbackGateway.js";
import * as CallbackGatewayApi from "./CallbackGatewayApi.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as Fixtures from "./test/callbacks.js";

const headers = (capability: InvocationCapabilities.Capability) => ({
  authorization: `Bearer ${capability.token}`,
  "x-patchy-invocation-id": capability.attempt.invocationId,
  "x-patchy-attempt-id": capability.attempt.attemptId,
  "x-patchy-process-generation": String(capability.attempt.processGeneration)
});
const fetchJson = Effect.fnUntraced(function* (url: string, init: RequestInit) {
  const response = yield* Effect.tryPromise(() => fetch(url, init));
  return yield* Effect.tryPromise(() => response.json());
});

it.layer(RuntimeLog.layer.pipe(Layer.provide(Testing.layer())))("CallbackGatewayApi", (it) => {
  it.effect(
    "the private listener accepts loader JSON and raw-file framing but not management authority or replays",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        let stored: Uint8Array = new Uint8Array();
        const gateway = yield* CallbackGateway.make({
          "tables.get": {
            kind: "read",
            run: () => Effect.succeed({ id: "row_one", title: "Saved" })
          },
          "files.put": {
            kind: "mutation",
            transport: "bytes-put",
            run: (_args, bytes) =>
              Effect.sync(() => {
                stored = bytes;
                return null;
              })
          },
          "files.get": {
            kind: "read",
            transport: "bytes-get",
            run: () => Effect.succeed({ bytes: stored, contentType: "application/octet-stream" })
          }
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        const listener = yield* CallbackGatewayApi.listen().pipe(
          Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
          Effect.provideService(CallbackGateway.CallbackGateway, gateway)
        );
        const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
        const request = {
          method: "POST",
          headers: { ...headers(capability), "content-type": "application/json" },
          body: JSON.stringify({ op: "tables.get", args: { table: "notes", id: "row_one" } })
        };
        assert.deepStrictEqual(yield* fetchJson(listener.url, request), {
          ok: true,
          value: { id: "row_one", title: "Saved" }
        });
        assert.include(
          yield* fetchJson(listener.url, {
            ...request,
            headers: { ...request.headers, authorization: "Bearer deployment-management-secret" }
          }),
          { ok: false, code: "access_denied" }
        );
        assert.include(
          yield* fetchJson(listener.url, {
            ...request,
            headers: { ...request.headers, "x-patchy-process-generation": "2" }
          }),
          { ok: false, code: "access_denied" }
        );
        assert.include(yield* fetchJson(listener.url, { ...request, body: "{" }), {
          ok: false,
          code: "invalid_request"
        });
        const bytes = new Uint8Array([0, 255, 1, 2]);
        assert.deepStrictEqual(
          yield* fetchJson(listener.url, {
            method: "POST",
            headers: {
              ...headers(capability),
              "content-type": "application/octet-stream",
              "x-patchy-callback": encodeURIComponent(
                JSON.stringify({ op: "files.put", args: { store: "assets", name: "data" } })
              )
            },
            body: bytes
          }),
          { ok: true, value: null }
        );
        const response = yield* Effect.tryPromise(() =>
          fetch(listener.url, {
            ...request,
            body: JSON.stringify({ op: "files.get", args: { store: "assets", name: "data" } })
          })
        );
        assert.strictEqual(response.headers.get("x-patchy-file-body"), "1");
        assert.deepStrictEqual(
          new Uint8Array(yield* Effect.tryPromise(() => response.arrayBuffer())),
          bytes
        );
        yield* capabilities.end(capability.token, "returned");
        const replay = yield* fetchJson(listener.url, request);
        assert.include(replay, { ok: false, code: "access_denied" });
        assert.include(
          Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(replay).error,
          "returned"
        );
      }).pipe(Effect.scoped)
  );

  it.effect("chunked callback bodies stop at the byte bound without executing the callback", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.make;
      let writes = 0;
      const gateway = yield* CallbackGateway.make({
        "files.put": {
          kind: "mutation",
          transport: "bytes-put",
          run: () =>
            Effect.sync(() => {
              writes++;
              return null;
            })
        }
      }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
      const listener = yield* CallbackGatewayApi.listen().pipe(
        Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
        Effect.provideService(CallbackGateway.CallbackGateway, gateway)
      );
      const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(6));
          controller.close();
        }
      });
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        duplex: "half",
        body,
        headers: {
          ...headers(capability),
          "x-patchy-callback": encodeURIComponent(JSON.stringify({ op: "files.put", args: {} }))
        }
      };
      assert.include(yield* fetchJson(listener.url, init), {
        ok: false,
        code: "too_large",
        limitId: "tier2.callbacks.fileBytes",
        value: 10
      });
      assert.strictEqual(writes, 0);
    }).pipe(
      Effect.scoped,
      Effect.provideService(ContractLimits.overrides, { "tier2.callbacks.fileBytes": 10 })
    )
  );

  it.effect("malformed and oversized authenticated requests consume the callback allowance", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.make;
      const gateway = yield* CallbackGateway.make({}).pipe(
        Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities)
      );
      const listener = yield* CallbackGatewayApi.listen().pipe(
        Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
        Effect.provideService(CallbackGateway.CallbackGateway, gateway)
      );
      const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
      const request = { method: "POST", headers: headers(capability) };
      assert.include(yield* fetchJson(listener.url, { ...request, body: "{" }), {
        ok: false,
        code: "invalid_request"
      });
      assert.include(
        yield* fetchJson(listener.url, {
          ...request,
          headers: {
            ...request.headers,
            "x-patchy-callback": encodeURIComponent(
              JSON.stringify({
                op: "files.put",
                args: { store: "assets", name: "data" }
              })
            )
          },
          body: new Uint8Array(4)
        }),
        { ok: false, code: "too_large", limitId: "tier2.callbacks.fileBytes" }
      );
      assert.include(
        yield* fetchJson(listener.url, {
          ...request,
          body: JSON.stringify({ op: "log", args: { message: "not admitted" } })
        }),
        { ok: false, code: "limit_exceeded", limitId: "tier2.callbacks.count", value: 2 }
      );
      assert.deepStrictEqual(capability.logs, []);
    }).pipe(
      Effect.scoped,
      Effect.provideService(ContractLimits.overrides, {
        "tier2.callbacks.count": 2,
        "tier2.callbacks.fileBytes": 3
      })
    )
  );

  it.effect(
    "public or wildcard callback binds stay refused even with private-interface opt-in",
    () =>
      Effect.gen(function* () {
        for (const host of ["0.0.0.0", "::", "8.8.8.8", "example.com", "::ffff:127.0.0.1"]) {
          const result = yield* CallbackGatewayApi.listen({ host, privateInterface: true }).pipe(
            Effect.flip
          );
          assert.strictEqual(result._tag, "CallbackListenerRefused");
        }
      }).pipe(
        Effect.scoped,
        Effect.provideService(CallbackGateway.CallbackGateway, {
          callback: () => Effect.succeed({ ok: true, value: null })
        }),
        Effect.provide(InvocationCapabilities.layer)
      )
  );
});
