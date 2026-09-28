import * as Executor from "@patchy/runtime/executor";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Supervisor from "./supervisor.js";

export interface Options extends Supervisor.Options {
  readonly companyId: string;
  readonly environment?: "development" | "test" | "production";
}

const isExecutionReason = Schema.is(Executor.ExecutionError.fields.reason);
const executionError = (cause: Supervisor.SupervisorError) =>
  new Executor.ExecutionError({
    operation: cause.operation === "invoke" ? "invoke" : "bind",
    reason: isExecutionReason(cause.reason) ? cause.reason : "transport",
    ...(cause.limit === undefined ? {} : { limit: cause.limit }),
    cause
  });

/** No pool and no replay. Hosts rebind after a killed or evicted generation. */
export const make = Effect.fn("LocalExecutor.make")(
  function* (options: Options) {
    const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment === "production" || options.environment === "production")
      return yield* new Executor.ExecutionError({
        operation: "bind",
        reason: "production_refused"
      });
    const supervisor = yield* Supervisor.make(options);
    const bindingEpoch = 1;
    yield* supervisor.bind({ companyId: options.companyId, bindingEpoch });
    return Executor.Executor.of({
      bind: Effect.fn("LocalExecutor.bind")(function* (bundle) {
        const reply = yield* supervisor
          .bind({ companyId: options.companyId, bindingEpoch, bundle })
          .pipe(Effect.mapError(executionError));
        if (reply.binding === undefined || reply.processGeneration === undefined)
          return yield* new Executor.ExecutionError({ operation: "bind", reason: "protocol" });
        return { binding: reply.binding, processGeneration: reply.processGeneration };
      }),
      invoke: Effect.fn("LocalExecutor.invoke")(function* (request) {
        return yield* supervisor
          .invoke({ bindingEpoch, request })
          .pipe(Effect.mapError(executionError));
      })
    });
  },
  Effect.catchTags({ SupervisorError: (cause) => Effect.fail(executionError(cause)) })
);

export const layer = (options: Options) => Layer.effect(Executor.Executor, make(options));
