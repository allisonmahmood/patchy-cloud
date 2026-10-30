import {
  CURRENT_RELEASE,
  WIRE_VERSION,
  GuestProtocol,
  type Manifest,
  type PidgeonSnapshot
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { DEV_SEED } from "@patchy/auth/seed";
import { newInternalId, sha256 } from "../../../../test/crypto.js";
import {
  CallbackGateway,
  CallbackGatewayApi,
  Executor,
  Invocation,
  InvocationCapabilities,
  LoadedVersions,
  type Binding,
  type Runtime,
  ServerBundles
} from "@patchy/runtime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { build } from "esbuild";
import * as Local from "../../../execution/src/local.js";
import type { PidgeonReader, PidgeonSender } from "../../../patchy/src/pidgeon.js";
import { generate } from "../pidgeon/Generate.js";

/**
 * Patches as the runtime runs them, for an integration's journeys: a generated client calling
 * back through the gateway as a tier 2 action does, as the seeded viewer, and a tier 2 bundle in
 * real workerd doing the same. Both bundle the packed `patchy` package, never its source.
 */

const patchy = new URL("../../../patchy", import.meta.url).pathname;
const decodeCallback = Schema.decodeUnknownSync(GuestProtocol.Callback);

/** How a generated client reaches the runtime. */
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

/** The loaded versions: one tier 2 patch's version, declaring `uses` as they stand when it loads. */
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
              patchTier: 2,
              companyId: DEV_SEED.companyId,
              scope: "company" as const,
              wireVersion: WIRE_VERSION,
              manifest: {
                manifestVersion: 1,
                release: CURRENT_RELEASE,
                tier: 2 as const,
                tables: {},
                files: {},
                uses: uses(),
                handlers: {}
              }
            })
          : Option.none()
      )
  });

/**
 * One action's callbacks in miniature: each client call is one gateway callback for the loaded
 * version, as the seeded viewer, answering a success's value or the refusal itself.
 */
export const page = Effect.fn("RuntimeTest.page")(function* (
  handlers: Readonly<Record<string, Runtime.Handler>>,
  patchId: string,
  versionId: string
) {
  const loaded = yield* (yield* LoadedVersions.LoadedVersions).find(patchId, versionId);
  if (Option.isNone(loaded)) return yield* Effect.die("The journey's version is not loaded.");
  const viewer = {
    user: { id: DEV_SEED.userId, name: "Dev", email: "dev@patchy.local" },
    company: { id: DEV_SEED.companyId, name: "Patchy Dev", handle: "patchy-dev" },
    admin: false,
    guest: false
  };
  const capabilities = yield* InvocationCapabilities.make;
  const gateway = yield* CallbackGateway.make(handlers).pipe(
    Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities)
  );
  const capability = yield* capabilities.issue({
    binding: {
      ...loaded.value,
      principal: { userId: viewer.user.id },
      identity: viewer,
      correlationId: newInternalId("call")
    },
    kind: "action",
    readOnly: false,
    attempt: {
      invocationId: newInternalId("inv"),
      attemptId: "journey",
      processGeneration: 1,
      deadline: (yield* Clock.currentTimeMillis) + 600_000
    },
    reauthorize: Effect.succeed(viewer)
  });
  const run = yield* FiberSet.makeRuntimePromise();
  const call: Call = (op, args) =>
    run(
      gateway
        .callback(capability.token, capability.attempt, decodeCallback({ op, args }))
        .pipe(Effect.map((reply) => (reply.ok && "value" in reply ? reply.value : reply)))
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
