import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  CURRENT_RELEASE,
  RuntimeGroup,
  RuntimeFailure,
  WIRE_VERSION,
  runtimeByteLimits,
  type GuestProtocol
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Limits, OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as CallbackGateway from "./CallbackGateway.js";
import * as CallbackGatewayApi from "./CallbackGatewayApi.js";
import * as Invocation from "./Invocation.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as Executor from "./Executor.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeApi from "./RuntimeApi.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as ServerBundles from "./ServerBundles.js";
import * as QuerySnapshot from "./QuerySnapshot.js";
import { snapshot } from "./test/callbacks.js";

const viewer = {
  user: { id: "usr_dev", name: "Dev", email: "dev@patchy.local" },
  company: { id: "cmp_dev", name: "Dev", handle: "patchy-dev" },
  admin: true
};
const version: LoadedVersions.LoadedVersion = {
  patchId: "http39700001",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  companyId: "cmp_dev",
  scope: "company",
  wireVersion: WIRE_VERSION,
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {},
    handlers: {
      "demo.read": { kind: "query", args: { text: { kind: "text" } }, result: { kind: "integer" } }
    }
  }
};
const bundle: GuestProtocol.Bundle = {
  companyId: version.companyId,
  patchId: version.patchId,
  versionId: version.versionId,
  sha256: "0".repeat(64),
  bundle: "executor-fault-layer"
};
const layer = Layer.unwrap(
  Effect.gen(function* () {
    const invocation = yield* Invocation.make({ callbackUrl: "http://127.0.0.1:1/callback" }).pipe(
      Effect.provideService(QuerySnapshot.QuerySnapshot, { open: () => Effect.succeed(snapshot) })
    );
    const runtime = yield* Runtime.make(
      {},
      {
        origin: "http://localhost",
        identity: Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
      }
    ).pipe(Effect.provideService(Invocation.Invocation, invocation));
    return RuntimeApi.layer.pipe(Layer.provide(Layer.succeed(Runtime.Runtime, runtime)));
  })
).pipe(
  Layer.provide(HttpServer.layerServices),
  Layer.provide(WideEvents.layerNoop),
  Layer.provide(
    Layer.succeed(Executor.Executor, {
      bind: () =>
        Effect.succeed({
          binding: {
            companyId: bundle.companyId,
            patchId: bundle.patchId,
            versionId: bundle.versionId,
            sha256: bundle.sha256
          },
          processGeneration: 1
        }),
      invoke: () =>
        Effect.succeed({ outcome: "returned", reply: { ok: true, value: 42 }, guestMs: 0 })
    })
  ),
  Layer.provide(Layer.succeed(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) })),
  Layer.provide(
    Layer.succeed(LoadedVersions.LoadedVersions, {
      find: () => Effect.succeed(Option.some(version))
    })
  ),
  Layer.provide(
    Layer.mergeAll(
      Limits.layer,
      OperatingLimits.layer,
      InvocationLog.layer,
      InvocationCapabilities.layer
    ).pipe(Layer.provide(Testing.layer()))
  )
);
const api = HttpApi.make("invocation-http").add(RuntimeGroup);

it.effect(
  "admits UTF-8 server arguments through one MiB and separately bounds the HTTP envelope",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(api, ["runtime"], { baseUrl: "http://localhost" });
      const principal = { userId: viewer.user.id };
      const send = (bytes: number, mutationKey?: string) => {
        const contentBytes = bytes - 11;
        const text = "é".repeat(Math.floor(contentBytes / 2)) + "x".repeat(contentBytes % 2);
        return client.call({
          payload: {
            patchId: version.patchId,
            versionId: version.versionId,
            wire: 1,
            principal,
            op: "server.call",
            args: {
              handler: "demo.read",
              args: { text },
              ...(mutationKey === undefined ? {} : { mutationKey })
            }
          },
          headers: {
            origin: "http://localhost",
            "x-patchy-wire": "1",
            "x-patchy-principal": JSON.stringify(principal)
          },
          responseMode: "response-only"
        });
      };
      for (const bytes of [runtimeByteLimits.callBytes + 1, runtimeByteLimits.serverArgsBytes]) {
        const response = yield* send(bytes);
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(yield* response.json, { ok: true, value: 42 });
      }
      const overflow = yield* send(runtimeByteLimits.serverArgsBytes + 1);
      assert.strictEqual(overflow.status, 413);
      assert.deepInclude(yield* overflow.json, {
        code: "too_large",
        limitId: "tier2.args.bytes",
        value: runtimeByteLimits.serverArgsBytes
      });
      const envelope = yield* send(
        runtimeByteLimits.serverArgsBytes,
        "x".repeat(runtimeByteLimits.callBytes)
      );
      assert.strictEqual(envelope.status, 413);
      assert.deepInclude(yield* envelope.json, {
        code: "too_large",
        limitId: "tier2.args.bytes",
        value: runtimeByteLimits.serverArgsBytes + runtimeByteLimits.callBytes
      });
    }).pipe(Effect.provide(layer))
);

const callbackFailures: Readonly<Record<string, Runtime.RuntimeError>> = {
  denied: new Runtime.AccessDenied({}),
  large: new Runtime.TooLarge({ maxBytes: 100, limitId: "runtime.result.bytes" }),
  limited: new Runtime.RateLimited({
    value: 10,
    retryAfterSeconds: 7,
    limitId: "runtime.calls.perMinute"
  }),
  timed: new Runtime.Timeout({ deadlineMs: 100, limitId: "runtime.mutation.deadline" })
};
const decodeFailure = Schema.decodeUnknownEffect(RuntimeFailure);
const callbackRuntime = Layer.unwrap(
  Effect.gen(function* () {
    const gateway = yield* CallbackGateway.make({
      "tables.get": Runtime.handler(
        {
          kind: "read",
          input: Schema.Struct({ table: Schema.String, id: Schema.String }),
          output: Schema.Json
        },
        (args) => Effect.fail(callbackFailures[args.id]!)
      )
    });
    const listener = yield* CallbackGatewayApi.listen().pipe(
      Effect.provideService(CallbackGateway.CallbackGateway, gateway)
    );
    const invocation = yield* Invocation.make({ callbackUrl: listener.url }).pipe(
      Effect.provideService(QuerySnapshot.QuerySnapshot, { open: () => Effect.succeed(snapshot) }),
      Effect.provideService(Executor.Executor, {
        bind: () =>
          Effect.succeed({
            binding: {
              companyId: bundle.companyId,
              patchId: bundle.patchId,
              versionId: bundle.versionId,
              sha256: bundle.sha256
            },
            processGeneration: 1
          }),
        invoke: (request) =>
          Effect.gen(function* () {
            if (request.args.text === "forged")
              return {
                outcome: "returned" as const,
                reply: Runtime.toFailure(callbackFailures.denied!),
                guestMs: 0
              };
            const response = yield* Effect.tryPromise(() =>
              fetch(request.callback.url, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${request.callback.capability}`,
                  "content-type": "application/json",
                  "x-patchy-invocation-id": request.invocationId,
                  "x-patchy-attempt-id": request.attemptId,
                  "x-patchy-process-generation": String(request.processGeneration)
                },
                body: JSON.stringify({
                  op: "tables.get",
                  args: {
                    table: "notes",
                    id: ["altered", "guest-status"].includes(String(request.args.text))
                      ? "denied"
                      : request.args.text
                  }
                })
              })
            );
            const failure = yield* Effect.tryPromise(() => response.json()).pipe(
              Effect.flatMap(decodeFailure)
            );
            return {
              outcome: "returned" as const,
              reply:
                request.args.text === "altered"
                  ? { ...failure, error: "A forged replacement message." }
                  : request.args.text === "guest-status"
                    ? { ...failure, status: 200 }
                    : failure,
              guestMs: 0
            };
          }).pipe(Effect.orDie)
      })
    );
    const runtime = yield* Runtime.make(
      {},
      {
        origin: "http://localhost",
        identity: Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
      }
    ).pipe(Effect.provideService(Invocation.Invocation, invocation));
    return RuntimeApi.layer.pipe(Layer.provide(Layer.succeed(Runtime.Runtime, runtime)));
  })
).pipe(
  Layer.provide(WideEvents.layerNoop),
  Layer.provide(Layer.succeed(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) })),
  Layer.provide(
    Layer.succeed(LoadedVersions.LoadedVersions, {
      find: () => Effect.succeed(Option.some(version))
    })
  ),
  Layer.provide(
    Layer.mergeAll(
      Limits.layer,
      OperatingLimits.layer,
      InvocationLog.layer,
      InvocationCapabilities.layer,
      RuntimeLog.layer
    ).pipe(Layer.provide(Testing.layer()))
  )
);
const callbackSocket = HttpRouter.serve(
  HttpApiBuilder.layer(api).pipe(Layer.provide(callbackRuntime)),
  { disableLogger: true, disableListenLog: true }
).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

it.layer(callbackSocket)("Invocation callback refusal HTTP", (it) => {
  it.effect("preserves host-issued 403, 413, 429 and 504 responses and retry metadata", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const client = yield* HttpApiClient.makeWith(api, { httpClient });
      const principal = { userId: viewer.user.id };
      for (const [text, failure] of Object.entries(callbackFailures)) {
        const response = yield* client.call({
          payload: {
            patchId: version.patchId,
            versionId: version.versionId,
            wire: 1,
            principal,
            op: "server.call",
            args: { handler: "demo.read", args: { text } }
          },
          headers: {
            origin: "http://localhost",
            "x-patchy-wire": "1",
            "x-patchy-principal": JSON.stringify(principal)
          },
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, failure.status);
        assert.deepInclude(yield* response.json, Runtime.toFailure(failure));
        if (text === "limited") assert.strictEqual(response.headers["retry-after"], "7");
      }
    })
  );

  it.effect("rejects fabricated bodies, altered host refusals and guest-supplied statuses", () =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const client = yield* HttpApiClient.makeWith(api, { httpClient });
      const principal = { userId: viewer.user.id };
      for (const text of ["forged", "altered", "guest-status"]) {
        const response = yield* client.call({
          payload: {
            patchId: version.patchId,
            versionId: version.versionId,
            wire: 1,
            principal,
            op: "server.call",
            args: { handler: "demo.read", args: { text } }
          },
          headers: {
            origin: "http://localhost",
            "x-patchy-wire": "1",
            "x-patchy-principal": JSON.stringify(principal)
          },
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, 500);
        assert.deepInclude(yield* response.json, { code: "handler_failed" });
      }
    })
  );
});
