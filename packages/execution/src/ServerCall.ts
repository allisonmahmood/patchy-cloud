// PROTOTYPE for #314: the `server.call` runtime operation.
//
// Admission is the runtime's (session, version, wire, principal); this handler adds the tier 2
// rules: the loaded version must be tier 2, the handler must be in the version's descriptors,
// the arguments must fit the descriptor before invocation and the result after it. Everything
// an invocation needs is read from the `Binding` at admission and closed over for its whole
// life; a rebuild in dev binds a new version, it never mutates this one. Callbacks resolve to
// the sibling runtime handlers (`tables.*`) under that same binding, and a query's callbacks
// are refused by the host when they would write.
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import { checkValue, handlersOf, runtimeOperations, type ServerCallReply } from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Engine from "./Engine.js";

export class HandlerFailed extends Schema.TaggedError<HandlerFailed>()("HandlerFailed", {
  correlationId: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  readonly code = "handler_failed" as const;
  readonly status = 500;
  override get message() {
    return "The handler failed; the details are in the runtime log.";
  }
}
export class HandlerTimeout extends Schema.TaggedError<HandlerTimeout>()("HandlerTimeout", {
  correlationId: Schema.String,
  deadlineMs: Schema.Int
}) {
  readonly code = "handler_timeout" as const;
  readonly status = 504;
  override get message() {
    return `The handler did not return within ${this.deadlineMs} ms.`;
  }
}

/** Wall-clock deadline per invocation; below the runtime's mutation deadline so this fires first. */
export const deadlineMs = Config.Int("PATCHY_HANDLER_DEADLINE_MS").pipe(Config.withDefault(10_000));

export interface Options {
  /** The exact bytes the binding's version recorded; asked for on the engine's first load. */
  readonly bundle: (
    binding: Binding.Binding["Service"]
  ) => Effect.Effect<string, Runtime.RuntimeError>;
  /** Where `ctx.log` lines and refusals go; the dev runtime prints them, the server logs them. */
  readonly log: (
    binding: Binding.Binding["Service"],
    line: string,
    details?: unknown
  ) => Effect.Effect<void>;
}

const operation = runtimeOperations["server.call"];

export const make = (handlers: Readonly<Record<string, Runtime.Handler>>, options: Options) =>
  Effect.gen(function* () {
    const engine = yield* Engine.Engine;
    const deadline = yield* deadlineMs;
    return Runtime.handler(
      {
        kind: operation.kind,
        input: operation.request.fields.args,
        output: operation.response,
        resource: (args) =>
          args !== null && typeof args === "object" && "handler" in args
            ? String(args.handler)
            : null
      },
      (args) =>
        Effect.gen(function* () {
          const binding = yield* Binding.Binding;
          if (binding.manifest.tier !== 2) return yield* new Runtime.InvalidRequest({});
          const descriptor = handlersOf(binding.manifest.handlers)[args.handler];
          if (descriptor === undefined || binding.server === undefined)
            return yield* new Runtime.InvalidRequest({});
          const problem = checkValue(descriptor.args, args.args);
          if (problem !== undefined)
            return yield* new Runtime.InvalidRequest({
              cause: new Error(`arguments: ${problem}`)
            });
          const log = (line: string, details?: unknown) =>
            options.log(binding, `${args.handler} ${binding.correlationId}: ${line}`, details);
          const callback: Engine.Invocation["callback"] = (op, callbackArgs) =>
            Effect.gen(function* () {
              const target = Object.hasOwn(handlers, op) ? handlers[op] : undefined;
              if (target === undefined || target.transport !== undefined || op === "server.call")
                return yield* Effect.fail({
                  code: "invalid_request",
                  message: `Unknown callback operation ${op}.`
                });
              if (descriptor.kind === "query" && target.kind !== "read") {
                yield* log(`refused ${op}: a query may not write`);
                return yield* Effect.fail({
                  code: "access_denied",
                  message: `A query may not call ${op}; declare a mutation for writes.`
                });
              }
              return yield* target.run(callbackArgs).pipe(
                Effect.provideService(Binding.Binding, binding),
                Effect.mapError((error) => ({
                  code: error.code,
                  message: error.message,
                  ...("details" in error && error.details !== undefined
                    ? { details: error.details }
                    : {})
                }))
              );
            });
          const reply = yield* engine
            .invoke({
              name: `${binding.patchId}@${binding.versionId}#${binding.server.digest}`,
              bundle: options
                .bundle(binding)
                .pipe(
                  Effect.mapError(
                    (cause) => new Engine.EngineUnavailable({ stage: "bundle", cause })
                  )
                ),
              handler: args.handler,
              args: args.args,
              viewer: binding.identity,
              deadlineMs: deadline,
              callback
            })
            .pipe(
              Effect.catchTags({
                EngineUnavailable: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
                InvocationTimeout: (timeout) =>
                  log(`handler_timeout after ${timeout.deadlineMs} ms`).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new HandlerTimeout({
                          correlationId: binding.correlationId,
                          deadlineMs: timeout.deadlineMs
                        })
                      )
                    )
                  )
              })
            );
          for (const line of reply.log ?? []) yield* log(line.message, line.details);
          if (reply.ok) {
            const violation = checkValue(descriptor.result, reply.result ?? null);
            if (violation !== undefined) {
              yield* log(`handler_failed: result does not match its declaration (${violation})`);
              return yield* new HandlerFailed({ correlationId: binding.correlationId });
            }
            return { ok: true, value: reply.result ?? null } satisfies ServerCallReply;
          }
          if (reply.error === "handler")
            return {
              ok: false,
              source: "handler",
              code: reply.code,
              ...(reply.details === undefined ? {} : { details: reply.details })
            } satisfies ServerCallReply;
          if (reply.error === "refused") {
            yield* log(
              `refused ${reply.code}${reply.message === undefined ? "" : `: ${reply.message}`}`
            );
            const refusal: Runtime.OperationError = {
              code: reply.code as Runtime.OperationError["code"],
              status: 400,
              message: reply.message ?? `Runtime request refused: ${reply.code}.`,
              correlationId: binding.correlationId
            };
            return yield* Effect.fail(refusal);
          }
          yield* log(
            `handler_failed: ${reply.error}${reply.message === undefined ? "" : ` ${reply.message}`}`,
            reply.stack
          );
          return yield* new HandlerFailed({ correlationId: binding.correlationId });
        })
    );
  });
