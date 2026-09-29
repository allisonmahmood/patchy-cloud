import type { GuestProtocol, Manifest } from "@patchy/api";
import { sha256 } from "@patchy/core";
import * as Local from "@patchy/execution/local";
import { MutationTransaction, QuerySnapshot } from "@patchy/primitives";
import {
  CallbackGateway,
  CallbackGatewayApi,
  Executor,
  Invocation,
  InvocationCapabilities,
  InvocationLog,
  LoadedVersions,
  Runtime,
  RuntimeLog,
  ServerBundles,
  StreamLimits,
  Subscriptions
} from "@patchy/runtime/dev";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ServerBinding {
  readonly bytes: Uint8Array;
  readonly handlers: NonNullable<typeof Manifest.Type.handlers>;
}
export interface Options {
  readonly server?: ServerBinding;
  readonly observe?: (settlement: Invocation.DevSettlement) => Effect.Effect<void>;
}

// Dev settlement goes to dev.log, never to the platform attribution tables.
const journals = Layer.mergeAll(
  Layer.succeed(InvocationLog.InvocationLog, {
    begin: (input) => Effect.succeed(input.id),
    finish: () => Effect.void,
    reconcileMutation: () => Effect.void,
    find: () => Effect.succeed(null)
  }),
  Layer.succeed(RuntimeLog.RuntimeLog, {
    begin: (input) => Effect.succeed(input.correlationId),
    finish: () => Effect.void,
    find: () => Effect.succeed(null),
    recent: () => Effect.succeed([])
  })
);

/** One callback listener, executor and subscription registry serve both dev identities. */
export const make = Effect.fn("DevExecution.make")(function* (
  version: LoadedVersions.LoadedVersion,
  handlers: Readonly<Record<string, Runtime.Handler>>,
  options: Options,
  install: (version: LoadedVersions.LoadedVersion) => void
) {
  const base = yield* Layer.build(
    Layer.mergeAll(QuerySnapshot.layer, MutationTransaction.layer).pipe(
      Layer.provideMerge(InvocationCapabilities.layer),
      Layer.provideMerge(journals)
    )
  );
  const gateway = yield* CallbackGateway.make(handlers).pipe(Effect.provideContext(base));
  const listener = yield* CallbackGatewayApi.listen().pipe(
    Effect.provideContext(base),
    Effect.provideService(CallbackGateway.CallbackGateway, gateway)
  );
  const executor = yield* Local.make({
    companyId: version.companyId,
    callbackUrls: [listener.url],
    environment: "development"
  });
  const bundles = new WeakMap<typeof Manifest.Type, GuestProtocol.Bundle>();
  const invocation = yield* Invocation.makeDev({
    callbackUrl: listener.url,
    observe: options.observe ?? (() => Effect.void)
  }).pipe(
    Effect.provideContext(base),
    Effect.provideService(Executor.Executor, executor),
    Effect.provideService(ServerBundles.ServerBundles, {
      load: (loaded) => {
        const bundle = bundles.get(loaded.manifest);
        return bundle === undefined
          ? Effect.fail(new Runtime.InvocationUnavailable())
          : Effect.succeed(bundle);
      }
    })
  );
  const subscriptions = yield* Subscriptions.make.pipe(
    Effect.provideService(Invocation.Invocation, invocation),
    Effect.provide(StreamLimits.layerLocal)
  );
  // The watcher stages and installs serially. Only inspection overlaps this preload.
  const stage = Effect.fn("DevExecution.stage")(function* (bytes: Uint8Array) {
    const source = new TextDecoder().decode(bytes);
    const digest = sha256(source);
    const bundle: GuestProtocol.Bundle = {
      companyId: version.companyId,
      patchId: version.patchId,
      versionId: `ver_${digest.slice(0, 24)}`,
      sha256: digest,
      bundle: source
    };
    yield* executor.bind(bundle);
    return Effect.fn("DevExecution.install")(function* (descriptors: ServerBinding["handlers"]) {
      const next: LoadedVersions.LoadedVersion = {
        ...version,
        executionVersionId: bundle.versionId,
        manifest: Object.freeze({ ...version.manifest, handlers: descriptors })
      };
      // A staged process has no admitted calls until both loading and inspection succeeded.
      bundles.set(next.manifest, bundle);
      install(next);
      yield* subscriptions.rebind(
        version.patchId,
        Object.fromEntries(
          Object.entries(descriptors).map(([name, descriptor]) => [name, descriptor.kind])
        )
      );
    });
  });
  if (options.server === undefined) return yield* new Runtime.InvocationUnavailable();
  const installInitial = yield* stage(options.server.bytes);
  yield* installInitial(options.server.handlers);
  return {
    context: Context.make(Invocation.Invocation, invocation).pipe(
      Context.add(Subscriptions.Subscriptions, subscriptions)
    ),
    stage
  };
});
