import type { CompanyDatabases, Inventory } from "@patchy/company-database";
import * as Local from "@patchy/execution/local";
import type { OperatingLimits } from "@patchy/limits";
import type { InvalidLimit } from "@patchy/limits/deployment-config";
import { QuerySnapshot } from "@patchy/primitives";
import {
  CallbackGateway,
  CallbackGatewayApi,
  Executor,
  Invocation,
  InvocationCapabilities,
  InvocationLog,
  Runtime,
  type QuerySnapshot as RuntimeQuerySnapshot,
  type RuntimeLog,
  ServerBundles
} from "@patchy/runtime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export class MissingServerBundle extends Schema.TaggedError<MissingServerBundle>()(
  "MissingServerBundle",
  { companyId: Schema.String, patchId: Schema.String, versionId: Schema.String }
) {
  override get message() {
    return `No retained server bundle is available for ${this.patchId}/${this.versionId}.`;
  }
}

export type StartupError =
  | Config.ConfigError
  | InvalidLimit
  | Executor.ExecutionError
  | CallbackGatewayApi.ListenerRefused
  | CallbackGatewayApi.ListenerUnavailable;

type Dependencies =
  | Scope.Scope
  | HttpClient.HttpClient
  | RuntimeLog.RuntimeLog
  | InvocationCapabilities.InvocationCapabilities
  | InvocationLog.InvocationLog
  | RuntimeQuerySnapshot.QuerySnapshot
  | OperatingLimits.OperatingLimits;

/** Only the existing repository dev supervisor opts the cloud server into this layer. */
export const enabled = Config.Boolean("PATCHY_DEV_EXECUTION").pipe(Config.withDefault(false));

export const make: (
  handlers: Readonly<Record<string, Runtime.Handler>>
) => Effect.Effect<Invocation.Invocation["Service"], StartupError, Dependencies> = Effect.fn(
  "DevelopmentInvocation.make"
)(function* (handlers: Readonly<Record<string, Runtime.Handler>>) {
  const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
  if (environment === "production")
    return yield* new Executor.ExecutionError({ operation: "bind", reason: "production_refused" });

  const scope = yield* Effect.scope;
  const context = yield* Effect.context<HttpClient.HttpClient>();
  const bundles = yield* Effect.serviceOption(ServerBundles.ServerBundles);
  const gateway = yield* CallbackGateway.make(handlers);
  const listener = yield* CallbackGatewayApi.listen().pipe(
    Effect.provideService(CallbackGateway.CallbackGateway, gateway)
  );
  const companies = new Map<
    string,
    Effect.Effect<Executor.Executor["Service"], Executor.ExecutionError>
  >();
  const companyExecutor = Effect.fn("DevelopmentInvocation.companyExecutor")(function* (
    companyId: string
  ) {
    let cached = companies.get(companyId);
    if (cached === undefined) {
      cached = yield* Local.make({ companyId, callbackUrls: [listener.url] }).pipe(
        Effect.provideContext(context),
        Scope.provide(scope),
        Effect.catchTags({
          ConfigError: (cause) =>
            Effect.fail(
              new Executor.ExecutionError({ operation: "bind", reason: "load_failed", cause })
            )
        }),
        Effect.cached
      );
      companies.set(companyId, cached);
    }
    return yield* cached;
  });
  const executor = Executor.Executor.of({
    bind: (bundle) =>
      companyExecutor(bundle.companyId).pipe(Effect.flatMap((local) => local.bind(bundle))),
    invoke: (request) =>
      companyExecutor(request.binding.companyId).pipe(
        Effect.flatMap((local) => local.invoke(request))
      )
  });
  return yield* Invocation.make({ callbackUrl: listener.url }).pipe(
    Effect.provideService(Executor.Executor, executor),
    // Tier 2 publication has not supplied retained server bytes yet. Do not treat
    // stored page HTML as executable code or invent a second storage format.
    Effect.provideService(
      ServerBundles.ServerBundles,
      Option.getOrElse(bundles, () =>
        ServerBundles.ServerBundles.of({
          load: (version) =>
            Effect.fail(
              new Runtime.SourceUnavailable({
                cause: new MissingServerBundle({
                  companyId: version.companyId,
                  patchId: version.patchId,
                  versionId: version.versionId
                })
              })
            )
        })
      )
    )
  );
});

export const layer = (
  handlers: Readonly<Record<string, Runtime.Handler>>
): Layer.Layer<
  Invocation.Invocation,
  StartupError,
  | CompanyDatabases.CompanyDatabases
  | Inventory.Inventory
  | OperatingLimits.OperatingLimits
  | RuntimeLog.RuntimeLog
  | SqlClient.SqlClient
> =>
  Layer.effect(Invocation.Invocation, make(handlers)).pipe(
    Layer.provide([InvocationLog.layer, QuerySnapshot.layer]),
    Layer.provide(InvocationCapabilities.layer),
    Layer.provide(FetchHttpClient.layer)
  );
