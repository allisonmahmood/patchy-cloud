import * as WideEvents from "@patchy/analytics/wide-events";
import * as Executor from "@patchy/runtime/executor";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Supervisor from "./supervisor.js";
import * as TaskProvider from "./TaskProvider.js";

export interface Options extends Omit<Supervisor.Options, "residencyAccounting"> {
  readonly companyId: string;
  readonly environment?: "development" | "test" | "production";
}

const isExecutionReason = Schema.is(Executor.ExecutionError.fields.reason);
const executionError = (cause: Supervisor.SupervisorError) =>
  new Executor.ExecutionError({
    operation: cause.operation === "invoke" ? "invoke" : "bind",
    reason: isExecutionReason(cause.reason) ? cause.reason : "transport",
    ...(cause.limit === undefined ? {} : { limit: cause.limit }),
    ...(cause.limits === undefined ? {} : { limits: cause.limits }),
    cause
  });

/**
 * No pool and no replay. Hosts rebind after a killed or evicted generation. With no fleet to
 * collect them, it emits each ended process's wide event itself, within a second.
 */
export const make = Effect.fn("LocalExecutor.make")(
  function* (options: Options) {
    const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment === "production" || options.environment === "production")
      return yield* new Executor.ExecutionError({
        operation: "bind",
        reason: "production_refused"
      });
    const events = yield* WideEvents.WideEvents;
    const supervisor = yield* Supervisor.make({ ...options, residencyAccounting: "workerd-only" });
    const bindingEpoch = 1;
    yield* supervisor.bind({ companyId: options.companyId, bindingEpoch });
    // As the fleet's collection does: emit, then acknowledge so the supervisor lets them go.
    // Uninterruptible, so closing never cuts between the two and sends a report twice.
    const emitReports = Effect.gen(function* () {
      const { reports } = yield* supervisor.stats({ bindingEpoch });
      if (reports.length === 0) return;
      for (const report of reports) yield* events.emit(report.event);
      yield* supervisor.stats({
        bindingEpoch,
        acknowledgeReports: reports.map((report) => report.reportId)
      });
    }).pipe(
      Effect.uninterruptible,
      Effect.catchTags({
        SupervisorError: (error) =>
          Effect.logWarning("Local process reports are unavailable", { reason: error.reason })
      })
    );
    // Finalizers run in reverse, so this runs after the loop below stops and before the
    // supervisor's own: stopping it first reports the processes still running.
    yield* Effect.addFinalizer(() =>
      supervisor.stop({ bindingEpoch }).pipe(
        Effect.catchTags({
          SupervisorError: (error) =>
            Effect.logWarning("Local processes did not stop", { reason: error.reason })
        }),
        Effect.andThen(emitReports)
      )
    );
    yield* emitReports.pipe(
      Effect.andThen(Effect.sleep("1 second")),
      Effect.forever,
      Effect.forkScoped
    );
    return Executor.Executor.of({
      bind: Effect.fn("LocalExecutor.bind")(function* (bundle) {
        // In process no bytes move, but binding by hash first runs the fleet's path locally.
        const reply = yield* TaskProvider.bindByHash(
          { companyId: options.companyId, bindingEpoch, bundle },
          supervisor.bind
        ).pipe(Effect.mapError(executionError));
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
