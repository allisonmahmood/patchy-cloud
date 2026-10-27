import {
  CURRENT_RELEASE,
  RuntimeGroup,
  WIRE_VERSION,
  type GuestProtocol,
  type Manifest,
  type PidgeonSnapshot
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { DEV_SEED } from "@patchy/auth/seed";
import { PUBLIC_BASE_URL, signedInCookies } from "@patchy/auth/testing";
import { newInternalId, sha256 } from "@patchy/core";
import {
  CallbackGateway,
  CallbackGatewayApi,
  Executor,
  Invocation,
  LoadedVersions,
  RuntimeApi,
  RuntimeProduction,
  StreamAdmission,
  type Binding,
  type Runtime,
  ServerBundles
} from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import { build } from "esbuild";
import * as Local from "../../../execution/src/local.js";
import type { PidgeonReader, PidgeonSender } from "../../../patchy/src/pidgeon.js";
import { generate } from "../pidgeon/Generate.js";

/**
 * Patches as the runtime runs them, for an integration's journeys: a tier 1 page's calls over the
 * runtime wire as the seeded signed-in viewer, and a tier 2 bundle in real workerd calling back
 * through the gateway. Both bundle the packed `patchy` package, never its source.
 */

const patchy = new URL("../../../patchy", import.meta.url).pathname;
/** How a page's client reaches the runtime. */
export type Call = (op: string, args: unknown) => Promise<unknown>;

/** One module from the packed package's exports, bundled for the browser or a guest. */
export const bundle = (contents: string, sourcefile: string) =>
  Effect.promise(() =>
    build({
      stdin: { contents, resolveDir: patchy, sourcefile, loader: "ts" },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022"
    })
  ).pipe(Effect.map((result) => result.outputFiles[0]!.text));

/** The loaded versions: one tier 1 patch's version, declaring `uses` as they stand when it loads. */
export const versions = (
  patchId: string,
  versionId: string,
  uses: () => (typeof Manifest.Type)["uses"]
) =>
  Layer.succeed(LoadedVersions.LoadedVersions, {
    find: (patch, version) =>
      Effect.succeed(
        patch === patchId && (version === undefined || version === versionId)
          ? Option.some({
              patchId,
              versionId,
              patchTier: 1,
              companyId: DEV_SEED.companyId,
              scope: "company" as const,
              wireVersion: WIRE_VERSION,
              manifest: {
                manifestVersion: 1,
                release: CURRENT_RELEASE,
                tier: 1 as const,
                tables: {},
                files: {},
                uses: uses()
              }
            })
          : Option.none()
      )
  });

const TestApi = HttpApi.make("patchy").add(
  RuntimeGroup.add(
    HttpApiEndpoint.post("call", "/api/runtime/call", {
      headers: Schema.Record(Schema.String, Schema.String),
      payload: Schema.Unknown,
      success: Schema.Unknown
    })
  )
);

/**
 * The shell's transport in miniature: one runtime call per client call, as the seeded viewer,
 * answering a success's value or the refusal itself.
 */
export const page = Effect.fn("RuntimeTest.page")(function* (
  handlers: Readonly<Record<string, Runtime.Handler>>,
  patchId: string,
  versionId: string
) {
  const api = yield* HttpApiTest.groups(TestApi, ["runtime"], { baseUrl: PUBLIC_BASE_URL }).pipe(
    Effect.provide(
      Layer.mergeAll(RuntimeApi.layer, HttpServer.layerServices).pipe(
        Layer.provide(RuntimeProduction.layer(handlers)),
        Layer.provide(StreamAdmission.layer)
      )
    )
  );
  const run = yield* FiberSet.makeRuntimePromise();
  const call: Call = (op, args) =>
    run(
      api
        .call({
          payload: {
            patchId,
            versionId,
            principal: { userId: DEV_SEED.userId },
            wire: WIRE_VERSION,
            op,
            args
          },
          headers: {
            "x-patchy-wire": String(WIRE_VERSION),
            "x-patchy-principal": `{"userId":"${DEV_SEED.userId}"}`,
            origin: PUBLIC_BASE_URL,
            cookie: signedInCookies()
          },
          responseMode: "response-only"
        })
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) =>
            typeof body === "object" &&
            body !== null &&
            "ok" in body &&
            body.ok === true &&
            "value" in body
              ? body.value
              : body
          )
        )
    );
  return call;
});

/** A Pidgeon declaration's generated client, bundled and loaded as a page loads it. */
export function pidgeonClient(
  alias: string,
  declaration: { readonly id: string; readonly handle: string },
  snapshot: PidgeonSnapshot & { readonly access: "send" },
  call: Call
): Effect.Effect<PidgeonSender>;
export function pidgeonClient(
  alias: string,
  declaration: { readonly id: string; readonly handle: string },
  snapshot: PidgeonSnapshot & { readonly access: "read" },
  call: Call
): Effect.Effect<PidgeonReader>;
export function pidgeonClient(
  alias: string,
  declaration: { readonly id: string; readonly handle: string },
  snapshot: PidgeonSnapshot,
  call: Call
): Effect.Effect<PidgeonReader> {
  const source = generate(
    { kind: "pidgeon", ...declaration, revision: 1, description: "Journey mail" },
    snapshot
  ).client;
  return bundle(source, `${alias}.ts`).pipe(
    Effect.flatMap((code) =>
      Effect.promise(
        () =>
          import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Promise<{
            createClient: (alias: string, call: Call) => PidgeonReader;
          }>
      )
    ),
    Effect.map((module) => module.createClient(alias, call))
  );
}

/**
 * A tier 2 `source` (its default export a `createGuest`) running in workerd, calling back through
 * the gateway to `handlers`; `invoke` runs one of its handlers as `binding`'s viewer.
 */
export const invoker = Effect.fn("RuntimeTest.invoker")(function* (
  handlers: Readonly<Record<string, Runtime.Handler>>,
  binding: Binding.Binding["Service"],
  source: string
) {
  const gateway = yield* CallbackGateway.make(handlers);
  const listener = yield* CallbackGatewayApi.listen().pipe(
    Effect.provideService(CallbackGateway.CallbackGateway, gateway)
  );
  const text = yield* bundle(source, "guest.ts");
  const guest: GuestProtocol.Bundle = {
    companyId: binding.companyId,
    patchId: binding.patchId,
    versionId: binding.versionId,
    bundle: text,
    sha256: sha256(text)
  };
  const executor = yield* Local.make({
    companyId: binding.companyId,
    callbackUrls: [listener.url],
    environment: "test"
  }).pipe(Effect.provide(WideEvents.layerNoop));
  const invocations = yield* Invocation.make({ callbackUrl: listener.url }).pipe(
    Effect.provideService(Executor.Executor, executor),
    Effect.provideService(ServerBundles.ServerBundles, { load: () => Effect.succeed(guest) })
  );
  return (handler: string, args: Readonly<Record<string, string>> = {}) =>
    invocations.call(
      { handler, args },
      { ...binding, correlationId: newInternalId("call") },
      Effect.succeed(binding.identity!)
    );
});
