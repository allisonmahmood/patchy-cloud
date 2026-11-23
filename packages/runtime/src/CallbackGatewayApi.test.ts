import { assert, it } from "@effect/vitest";
import { FilePutUpload, RuntimeCode, RuntimeFailure } from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as CallbackGateway from "./CallbackGateway.js";
import * as CallbackGatewayApi from "./CallbackGatewayApi.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as Fixtures from "./test/callbacks.js";
import { NodeCryptography } from "@patchy/core";
import { stalledUpload, twoRequests } from "../../../test/socket.js";

const headers = (capability: InvocationCapabilities.Capability) => ({
  authorization: `Bearer ${capability.token}`,
  "x-patchy-invocation-id": capability.attempt.invocationId,
  "x-patchy-attempt-id": capability.attempt.attemptId,
  "x-patchy-process-generation": String(capability.attempt.processGeneration)
});
/**
 * A reply as a loader from before model calls decodes it: strictly, and without the two codes
 * model calls brought. A reply it can't decode reaches its guest as a lost one.
 */
const olderLoaderReply = Schema.decodeUnknownSync(
  Schema.Struct({
    ...RuntimeFailure.fields,
    code: Schema.Literals(
      RuntimeCode.literals.filter((code) => code !== "output_truncated" && code !== "model_refused")
    )
  }),
  { onExcessProperty: "error" }
);
const fetchJson = Effect.fnUntraced(function* (url: string, init: RequestInit) {
  const response = yield* Effect.tryPromise(() => fetch(url, init));
  return yield* Effect.tryPromise(() => response.json());
});

it.layer(
  RuntimeLog.layer.pipe(Layer.provide(Testing.layer()), Layer.provideMerge(NodeCryptography.layer))
)("CallbackGatewayApi", (it) => {
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
                assert.isDefined(bytes);
                stored = bytes!;
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

  it.effect("the private listener adopts an upload over JSON without a byte body", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.make;
      const upload = { token: "opaque-stage-token", size: 4, contentType: "image/png" };
      let adopted = false;
      const decode = Schema.decodeUnknownEffect(FilePutUpload, { onExcessProperty: "error" });
      const gateway = yield* CallbackGateway.make({
        "files.put": {
          kind: "mutation",
          transport: "bytes-put",
          run: (input, bytes) =>
            Effect.gen(function* () {
              const args = yield* decode(input).pipe(
                Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
              );
              assert.isUndefined(bytes);
              assert.deepStrictEqual(args.upload, upload);
              adopted = true;
              return null;
            })
        }
      }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
      const listener = yield* CallbackGatewayApi.listen().pipe(
        Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
        Effect.provideService(CallbackGateway.CallbackGateway, gateway)
      );
      const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
      const request = {
        method: "POST",
        headers: { ...headers(capability), "content-type": "application/json" }
      };
      assert.include(
        yield* fetchJson(listener.url, {
          ...request,
          body: JSON.stringify({
            op: "files.put",
            args: { store: "docs", name: "photo.png", contentType: "image/png" }
          })
        }),
        { ok: false, code: "invalid_request" }
      );
      assert.isFalse(adopted);
      assert.deepStrictEqual(
        yield* fetchJson(listener.url, {
          ...request,
          body: JSON.stringify({
            op: "files.put",
            args: { store: "docs", name: "photo.png", upload }
          })
        }),
        { ok: true, value: null }
      );
      assert.isTrue(adopted);
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
      assert.strictEqual(capability.counters.peakFileBytes, 12);
    }).pipe(
      Effect.scoped,
      Effect.provideService(ContractLimits.overrides, { "tier2.callbacks.fileBytes": 10 })
    )
  );

  it.effect("a callback body past its bound is refused, then its connection closes", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.make;
      const gateway = yield* CallbackGateway.make({
        "files.put": {
          kind: "mutation",
          transport: "bytes-put",
          run: () => Effect.die("An oversized callback must not reach its handler.")
        }
      }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
      const listener = yield* CallbackGatewayApi.listen().pipe(
        Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
        Effect.provideService(CallbackGateway.CallbackGateway, gateway)
      );
      const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
      const head = [
        "POST /callback HTTP/1.1",
        "host: 127.0.0.1",
        ...Object.entries({
          ...headers(capability),
          "x-patchy-callback": encodeURIComponent(JSON.stringify({ op: "files.put", args: {} }))
        }).map(([name, value]) => `${name}: ${value}`)
      ].join("\n");
      // The gateway answers its refusal as a 200 body; the rest of the upload never arrives.
      const answer = yield* Effect.promise(() =>
        stalledUpload(Number(new URL(listener.url).port), head, { chunked: 64 })
      );
      assert.strictEqual(answer.status, 200);
      assert.isDefined(answer.closedAfterMs);
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
    "a model call from an execution task of an older release is refused in words its loader reads, nothing sent",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        let ran = 0;
        const gateway = yield* CallbackGateway.make({
          "tables.get": { kind: "read", run: () => Effect.succeed(null) },
          "models.generate": {
            kind: "integration",
            fence: "action",
            connectionId: () => "role",
            run: () =>
              Effect.sync(() => {
                ran++;
                return { text: "ok", usage: { inputTokens: null, outputTokens: null } };
              })
          }
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        const listener = yield* CallbackGatewayApi.listen().pipe(
          Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
          Effect.provideService(CallbackGateway.CallbackGateway, gateway)
        );
        const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
        const send = (op: string, marked?: string) =>
          fetchJson(listener.url, {
            method: "POST",
            headers: {
              ...headers(capability),
              "content-type": "application/json",
              ...(marked === undefined ? {} : { "x-patchy-model-call": marked })
            },
            body: JSON.stringify({ op, args: { connection: "writer", table: "notes" } })
          });
        // Unmarked: its task's proxy held no model permit, and its loader decodes replies strictly
        // with the codes it knew, which this refusal keeps to.
        const older = yield* send("models.generate");
        assert.deepStrictEqual(olderLoaderReply(older), {
          ok: false,
          source: "patchy",
          code: "source_unavailable",
          error:
            "This patch runs on an execution task from an older release, which can't call models, so nothing was sent. Try again shortly.",
          details: { sent: false, reason: "execution" }
        });
        assert.strictEqual(ran, 0);
        // Marked, it runs; a mark that doesn't name the call's own operation is a fault.
        assert.deepStrictEqual(yield* send("models.generate", "models.generate"), {
          ok: true,
          value: { text: "ok", usage: { inputTokens: null, outputTokens: null } }
        });
        assert.strictEqual(ran, 1);
        assert.include(yield* send("models.generate", "models.decide"), {
          ok: false,
          code: "invalid_request"
        });
        assert.include(yield* send("tables.get", "models.generate"), {
          ok: false,
          code: "invalid_request"
        });
        assert.deepStrictEqual(yield* send("tables.get"), { ok: true, value: null });
        assert.strictEqual(ran, 1);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a marked model call refused by the shared count or byte budget says nothing was sent, once",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        const gateway = yield* CallbackGateway.make({
          "tables.get": { kind: "read", run: () => Effect.succeed(null) },
          "models.generate": {
            kind: "integration",
            fence: "action",
            connectionId: () => "role",
            run: () =>
              Effect.succeed({ text: "ok", usage: { inputTokens: null, outputTokens: null } })
          }
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        const listener = yield* CallbackGatewayApi.listen().pipe(
          Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
          Effect.provideService(CallbackGateway.CallbackGateway, gateway)
        );
        const send = (capability: InvocationCapabilities.Capability, input: string) =>
          fetchJson(listener.url, {
            method: "POST",
            headers: {
              ...headers(capability),
              "content-type": "application/json",
              "x-patchy-model-call": "models.generate"
            },
            body: JSON.stringify({ op: "models.generate", args: { connection: "writer", input } })
          });
        // Past the call tree's bytes: refused as it is read, nothing sent.
        const budgeted = yield* Fixtures.issue(capabilities, { kind: "action" });
        const overBudget = yield* send(budgeted, "x".repeat(200));
        assert.deepInclude(overBudget, {
          code: "limit_exceeded",
          limitId: "tier2.callbacks.bytes",
          details: { sent: false }
        });
        // Past the invocation's callbacks: refused before it is read, nothing sent.
        const counted = yield* Fixtures.issue(capabilities, { kind: "action" });
        yield* send(counted, "first");
        const overCount = yield* send(counted, "second");
        assert.deepInclude(overCount, {
          code: "limit_exceeded",
          limitId: "tier2.callbacks.count",
          details: { sent: false }
        });
        // Each kept once, as the guest got it, with the operation it relays under.
        for (const [capability, refusal, status] of [
          [budgeted, overBudget, 429],
          [counted, overCount, 429]
        ] as const)
          assert.deepStrictEqual(
            capability.refusals.map(({ failure, status, operation }) => ({
              failure,
              status,
              operation
            })),
            [{ failure: refusal, status, operation: "models.generate" }]
          );
      }).pipe(
        Effect.scoped,
        Effect.provideService(ContractLimits.overrides, {
          "tier2.callbacks.count": 1,
          "tier2.callbacks.bytes": 150
        })
      )
  );

  it.effect(
    "a fifth marked model call is refused its place before its body is read, and a place comes back",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        const release = yield* Deferred.make<void>();
        const allRunning = yield* Deferred.make<void>();
        let running = 0;
        const gateway = yield* CallbackGateway.make({
          "models.generate": {
            kind: "integration",
            fence: "action",
            connectionId: () => "role",
            run: () =>
              Effect.gen(function* () {
                if (++running === 4) yield* Deferred.succeed(allRunning, undefined);
                yield* Deferred.await(release);
                return { text: "ok", usage: { inputTokens: null, outputTokens: null } };
              })
          }
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        const listener = yield* CallbackGatewayApi.listen().pipe(
          Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
          Effect.provideService(CallbackGateway.CallbackGateway, gateway)
        );
        const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
        const marked = {
          ...headers(capability),
          "content-type": "application/json",
          "x-patchy-model-call": "models.generate"
        };
        const call = (body: string) =>
          fetchJson(listener.url, { method: "POST", headers: marked, body });
        const generate = JSON.stringify({
          op: "models.generate",
          args: { connection: "writer", input: "x" }
        });
        const four = yield* Effect.forEach([1, 2, 3, 4], () => call(generate), {
          concurrency: "unbounded"
        }).pipe(Effect.forkChild);
        yield* Deferred.await(allRunning);
        // Its body declared and never sent: only a refusal given before reading can answer it.
        const head = [
          "POST /callback HTTP/1.1",
          "host: 127.0.0.1",
          ...Object.entries(marked).map(([name, value]) => `${name}: ${value}`)
        ].join("\n");
        const fifth = yield* Effect.promise(() =>
          stalledUpload(Number(new URL(listener.url).port), head, { declared: 100 })
        );
        assert.strictEqual(fifth.status, 200);
        assert.deepInclude(JSON.parse(fifth.body), {
          code: "busy",
          limitId: "models.calls.inFlight",
          details: { sent: false }
        });
        // Its unread body is never waited for: the connection closes after the answer.
        assert.isDefined(fifth.closedAfterMs);
        yield* Deferred.succeed(release, undefined);
        assert.isTrue((yield* Fiber.join(four)).every((reply) => reply.ok === true));
        // A call refused after taking its place, before its handler, gives the place back.
        assert.deepInclude(yield* call("{"), { code: "invalid_request", details: { sent: false } });
        assert.strictEqual(capability.counters.modelsInFlight, 0);
      }).pipe(Effect.scoped, Effect.provideService(ContractLimits.overrides, {}))
  );

  it.effect("an ordinary callback refused before its body is read keeps its connection", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.make;
      const gateway = yield* CallbackGateway.make({
        "tables.get": { kind: "read", run: () => Effect.succeed(null) }
      }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
      const listener = yield* CallbackGatewayApi.listen().pipe(
        Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
        Effect.provideService(CallbackGateway.CallbackGateway, gateway)
      );
      const capability = yield* Fixtures.issue(capabilities, { kind: "query" });
      const request = (bearer: string, body: string) => ({
        head: [
          "POST /callback HTTP/1.1",
          "host: 127.0.0.1",
          "content-type: application/json",
          ...Object.entries({ ...headers(capability), authorization: `Bearer ${bearer}` }).map(
            ([name, value]) => `${name}: ${value}`
          )
        ].join("\n"),
        body
      });
      // A stale capability, no body: refused before reading, and the connection stays for the
      // loader's next callback, as it always has.
      const answers = yield* Effect.promise(() =>
        twoRequests(
          Number(new URL(listener.url).port),
          request("stale-capability", ""),
          request(capability.token, JSON.stringify({ op: "tables.get", args: { table: "rows" } }))
        )
      );
      assert.strictEqual(answers.first.status, 200);
      assert.notStrictEqual(answers.first.connection, "close");
      assert.strictEqual(answers.second?.status, 200);
    }).pipe(Effect.scoped, Effect.provideService(ContractLimits.overrides, {}))
  );

  it.effect(
    "a model call refused busy at the listener is still an attempt: the 201st is refused either way",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.make;
        const limit = yield* ContractLimits.get("models.calls.perAction");
        const release = yield* Deferred.make<void>();
        const allRunning = yield* Deferred.make<void>();
        let holding = true;
        let running = 0;
        const gateway = yield* CallbackGateway.make({
          "models.generate": {
            kind: "integration",
            fence: "action",
            connectionId: () => "role",
            run: () =>
              Effect.gen(function* () {
                if (holding) {
                  if (++running === 4) yield* Deferred.succeed(allRunning, undefined);
                  yield* Deferred.await(release);
                }
                return { text: "ok", usage: { inputTokens: null, outputTokens: null } };
              })
          }
        }).pipe(Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities));
        const listener = yield* CallbackGatewayApi.listen().pipe(
          Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
          Effect.provideService(CallbackGateway.CallbackGateway, gateway)
        );
        const body = JSON.stringify({
          op: "models.generate",
          args: { connection: "writer", input: "x" }
        });
        const caller = (capability: InvocationCapabilities.Capability) => () =>
          fetchJson(listener.url, {
            method: "POST",
            headers: {
              ...headers(capability),
              "content-type": "application/json",
              "x-patchy-model-call": "models.generate"
            },
            body
          });
        const spent = {
          code: "limit_exceeded",
          limitId: "models.calls.perAction",
          details: { sent: false }
        };
        // Four running hold every place, so the rest are refused busy before they are read.
        const crowded = caller(yield* Fixtures.issue(capabilities, { kind: "action" }));
        const four = yield* Effect.forEach([1, 2, 3, 4], crowded, {
          concurrency: "unbounded"
        }).pipe(Effect.forkChild);
        yield* Deferred.await(allRunning);
        for (let attempt = 5; attempt <= limit; attempt++)
          assert.deepInclude(yield* crowded(), { code: "busy", limitId: "models.calls.inFlight" });
        assert.deepInclude(yield* crowded(), spent);
        holding = false;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(four);
        // Answered one at a time, each attempt counts once: the 200th runs, the 201st is refused.
        const action = yield* Fixtures.issue(capabilities, { kind: "action" });
        const answered = caller(action);
        for (let attempt = 1; attempt <= limit; attempt++)
          assert.strictEqual((yield* answered()).ok, true);
        assert.deepInclude(yield* answered(), spent);
        // Each further attempt is its own refusal, kept with its operation: the same words given
        // decide and then generate are both recorded, so a relayed one names neither.
        const marked = (op: string) =>
          fetchJson(listener.url, {
            method: "POST",
            headers: {
              ...headers(action),
              "content-type": "application/json",
              "x-patchy-model-call": op
            },
            body: JSON.stringify({ op, args: { connection: "writer", input: "x" } })
          });
        assert.deepInclude(yield* marked("models.decide"), spent);
        assert.deepInclude(yield* marked("models.generate"), spent);
        const spentOps = action.refusals
          .filter((entry) => entry.failure.limitId === "models.calls.perAction")
          .map((entry) => entry.operation);
        assert.includeMembers(spentOps, ["models.decide", "models.generate"]);
      }).pipe(Effect.scoped, Effect.provideService(ContractLimits.overrides, {})),
    30_000
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
          callback: () => Effect.succeed({ ok: true, value: null }),
          admitModelCall: () => Effect.die("no model call reaches this listener"),
          refuseModelCall: () => Effect.die("no model call reaches this listener")
        }),
        Effect.provide(InvocationCapabilities.layer)
      )
  );
});
