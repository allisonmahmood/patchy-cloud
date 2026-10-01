import type * as WideEvents from "@patchy/analytics/wide-events";
import type { CompanyDatabases, Inventory } from "@patchy/company-database";
import { newInternalId } from "@patchy/core";
import * as Fleet from "@patchy/execution/fleet";
import * as Ecs from "@patchy/execution/ecs";
import * as EcsTaskProvider from "@patchy/execution/ecs-task-provider";
import * as LocalTaskProvider from "@patchy/execution/local-task-provider";
import * as TaskProvider from "@patchy/execution/task-provider";
import type { OperatingLimits } from "@patchy/limits";
import type { InvalidLimit } from "@patchy/limits/deployment-config";
import { MutationTransaction, QuerySnapshot } from "@patchy/primitives";
import {
  CallbackGateway,
  CallbackGatewayApi,
  ExecutionLifecycle,
  Executor,
  Invocation,
  InvocationCapabilities,
  InvocationLog,
  Runtime,
  type MutationTransaction as RuntimeMutationTransaction,
  type QuerySnapshot as RuntimeQuerySnapshot,
  type RuntimeLog,
  type ServerBundles,
  type Wakes
} from "@patchy/runtime";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";
import * as PrivateInterface from "./PrivateInterface.js";

export type StartupError =
  | Config.ConfigError
  | InvalidLimit
  | Executor.ExecutionError
  | TaskProvider.TaskProviderError
  | PrivateInterface.PrivateInterfaceError
  | SqlError.SqlError
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
  | OperatingLimits.OperatingLimits
  | WideEvents.WideEvents;

export const enabled = Config.map(
  Config.String("EXECUTION_PROVIDER").pipe(Config.withDefault("local")),
  (provider) => provider === "local-fleet" || provider === "ecs"
);

/** The same controller runs on ECS in production and isolated local tasks in development. */
export const make: (
  handlers: Readonly<Record<string, Runtime.Handler>>
) => Effect.Effect<
  Context.Context<Invocation.Invocation | ExecutionLifecycle.ExecutionLifecycle>,
  StartupError,
  Dependencies
> = Effect.fn("FleetInvocation.make")(function* (
  handlers: Readonly<Record<string, Runtime.Handler>>
) {
  const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
  const providerKind = yield* Config.String("EXECUTION_PROVIDER");
  if (environment === "production" && providerKind !== "ecs")
    return yield* new Executor.ExecutionError({ operation: "bind", reason: "production_refused" });
  const replicaId = yield* Config.String("PATCHY_REPLICA").pipe(
    Config.withDefault(newInternalId("host"))
  );
  const deploymentRevision = yield* Config.String("PATCHY_DEPLOYMENT_REVISION").pipe(
    Config.withDefault("development")
  );
  const callbackUrls = yield* Config.schema(
    Schema.fromJsonString(Schema.Array(Schema.String)),
    "EXECUTION_CALLBACK_URLS"
  );
  const callbackPort = yield* Config.Int("EXECUTION_CALLBACK_PORT");
  const callbackHost = yield* PrivateInterface.resolve(
    yield* Config.String("EXECUTION_CALLBACK_HOST").pipe(Config.withDefault("127.0.0.1"))
  );
  const privateInterface = yield* Config.Boolean("EXECUTION_CALLBACK_PRIVATE_INTERFACE").pipe(
    Config.withDefault(false)
  );
  const gateway = yield* CallbackGateway.make(handlers);
  const listener = yield* CallbackGatewayApi.listen({
    port: callbackPort,
    host: callbackHost,
    privateInterface
  }).pipe(Effect.provideService(CallbackGateway.CallbackGateway, gateway));
  const provider =
    providerKind === "ecs"
      ? yield* Effect.gen(function* () {
          const options = yield* EcsTaskProvider.config;
          const ecs = yield* Ecs.make(options.region);
          return yield* EcsTaskProvider.make({
            ...options,
            callbackUrls: [...new Set([...callbackUrls, listener.url])]
          }).pipe(Effect.provideService(Ecs.Ecs, ecs));
        })
      : yield* Effect.gen(function* () {
          if (!callbackUrls.includes(listener.url))
            return yield* new Executor.ExecutionError({ operation: "bind", reason: "protocol" });
          const directory = yield* Config.String("EXECUTION_LOCAL_DIRECTORY");
          return yield* LocalTaskProvider.make({ directory, callbackUrls });
        });
  const fleet = yield* Fleet.make({
    replicaId,
    deploymentRevision,
    dev: environment === "development"
  }).pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
  const invocation = yield* Invocation.make({ callbackUrl: listener.url }).pipe(
    Effect.provideService(Executor.Executor, fleet.executor),
    Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, fleet.lifecycle)
  );
  return Context.make(Invocation.Invocation, invocation).pipe(
    Context.add(ExecutionLifecycle.ExecutionLifecycle, fleet.lifecycle)
  );
});

export const layer = (
  handlers: Readonly<Record<string, Runtime.Handler>>
): Layer.Layer<
  Invocation.Invocation | ExecutionLifecycle.ExecutionLifecycle,
  StartupError,
  | CompanyDatabases.CompanyDatabases
  | Inventory.Inventory
  | Wakes.Wakes
  | OperatingLimits.OperatingLimits
  | RuntimeLog.RuntimeLog
  | ServerBundles.ServerBundles
  | SqlClient.SqlClient
  | WideEvents.WideEvents
> =>
  Layer.effectContext(make(handlers)).pipe(
    Layer.provide([InvocationLog.layer, QuerySnapshot.layer, MutationTransaction.layer]),
    Layer.provide(InvocationCapabilities.layer),
    Layer.provide(FetchHttpClient.layer)
  );
