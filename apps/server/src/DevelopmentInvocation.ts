import type { CompanyDatabases, Inventory } from "@patchy/company-database";
import * as Local from "@patchy/execution/local";
import type { OperatingLimits } from "@patchy/limits";
import type { InvalidLimit } from "@patchy/limits/deployment-config";
import { MutationTransaction, QuerySnapshot } from "@patchy/primitives";
import {
  CallbackGateway,
  CallbackGatewayApi,
  Executor,
  Invocation,
  InvocationCapabilities,
  InvocationLog,
  Runtime,
  type MutationTransaction as RuntimeMutationTransaction,
  type QuerySnapshot as RuntimeQuerySnapshot,
  type RuntimeLog,
  ServerBundles,
  type Wakes
} from "@patchy/runtime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as SqlClient from "effect/sql/SqlClient";

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
  | ServerBundles.ServerBundles
  | InvocationCapabilities.InvocationCapabilities
  | InvocationLog.InvocationLog
  | SqlClient.SqlClient
  | RuntimeQuerySnapshot.QuerySnapshot
  | RuntimeMutationTransaction.MutationTransaction
  | OperatingLimits.OperatingLimits;

/** Every dev and test host uses the supervised local executor. */
export const enabled = Config.map(
  Config.String("NODE_ENV").pipe(Config.withDefault("development")),
  (environment) => environment !== "production"
);

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
    Effect.provideService(Executor.Executor, executor)
  );
});

export const layer = (
  handlers: Readonly<Record<string, Runtime.Handler>>
): Layer.Layer<
  Invocation.Invocation,
  StartupError,
  | CompanyDatabases.CompanyDatabases
  | Inventory.Inventory
  | Wakes.Wakes
  | OperatingLimits.OperatingLimits
  | RuntimeLog.RuntimeLog
  | ServerBundles.ServerBundles
  | SqlClient.SqlClient
> =>
  Layer.effect(Invocation.Invocation, make(handlers)).pipe(
    Layer.provide([InvocationLog.layer, QuerySnapshot.layer, MutationTransaction.layer]),
    Layer.provide(InvocationCapabilities.layer),
    Layer.provide(FetchHttpClient.layer)
  );
