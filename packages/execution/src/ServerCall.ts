// PROTOTYPE for #314: the `server.call` runtime operation.
//
// Admission is the runtime's (session, version, wire, principal); this handler adds the tier 2
// rules: the loaded version must be tier 2, the handler must be in the version's descriptors,
// the arguments must fit the descriptor before invocation and the result after it. Everything
// an invocation needs is read from the `Binding` at admission and closed over for its whole
// life; a rebuild in dev binds a new version, it never mutates this one. Callbacks resolve to
// the sibling runtime handlers under that same binding, gated per kind (a query's writes and
// every kind's off-limits capability are refused by the host, never only by the types).
//
// Round 3: one invocation deadline spans admission, every attempt and settlement; each attempt
// opens one company transaction (Transaction.ts) whose scope is ready before the guest runs;
// a serialization failure anywhere marks the attempt abort-only and re-invokes the handler,
// mutations only, up to three attempts with a fresh capability each; the outcome is what the
// commit phase says. Refusal codes the guest reports are checked against the refusal the host
// issued to that same invocation; declared `errors` are enforced host-side.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  checkValue,
  handlersOf,
  RuntimeCode,
  runtimeOperations,
  type ServerCallReply
} from "@patchy/api";
import type { CompanyDatabases } from "@patchy/company-database";
import { Binding, Runtime } from "@patchy/runtime/core";
import * as Engine from "./Engine.js";
import * as Transaction from "./Transaction.js";

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
export class Busy extends Schema.TaggedError<Busy>()("ServerCallBusy", {
  correlationId: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  readonly code = "busy" as const;
  readonly status = 503;
  override get message() {
    return "The company's execution capacity is in use. Try again shortly.";
  }
}

/** Wall-clock deadline per invocation; below the runtime's mutation deadline so this fires first. */
export const deadlineMs = Config.Int("PATCHY_HANDLER_DEADLINE_MS").pipe(Config.withDefault(10_000));
/** Concurrent invocations per company: the pool's four connections, one per invocation. */
export const invocationsPerCompany = Config.Int("PATCHY_INVOCATIONS_PER_COMPANY").pipe(
  Config.withDefault(4)
);
const MAX_ATTEMPTS = 3;
const isRuntimeCode = Schema.is(RuntimeCode);

/** Which callback operations each kind may reach; everything else is refused by the host. */
const permitted = (kind: "query" | "mutation" | "action", op: string, target: Runtime.Handler) => {
  if (op.startsWith("shared.")) return kind !== "mutation";
  if (op.startsWith("postgres.")) return kind === "action";
  if (op.startsWith("tables.")) return kind !== "query" || target.kind === "read";
  return false;
};

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

/**
 * `handlers` are the callback targets and should be built over `Transaction.joiningDatabases`
 * so their table operations run on the invocation's held connection.
 */
export const make = (handlers: Readonly<Record<string, Runtime.Handler>>, options: Options) =>
  Effect.gen(function* () {
    const engine = yield* Engine.Engine;
    const deadline = yield* deadlineMs;
    const perCompany = yield* invocationsPerCompany;
    const databases = yield* Effect.context<CompanyDatabases.CompanyDatabases>();
    const slots = new Map<string, Semaphore.Semaphore>();
    const slotOf = (companyId: string) => {
      let semaphore = slots.get(companyId);
      if (semaphore === undefined) {
        semaphore = Semaphore.makeUnsafe(perCompany);
        slots.set(companyId, semaphore);
      }
      return semaphore;
    };
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
          const problem = checkValue(descriptor.args, args.args, "$", binding.manifest.tables);
          if (problem !== undefined)
            return yield* new Runtime.InvalidRequest({
              cause: new Error(`arguments: ${problem}`)
            });
          const log = (line: string, details?: unknown) =>
            options.log(binding, `${args.handler} ${binding.correlationId}: ${line}`, details);
          const startedAt = yield* Clock.currentTimeMillis;
          const remaining = Effect.map(
            Clock.currentTimeMillis,
            (now) => deadline - (now - startedAt)
          );
          const timedOut = () =>
            new HandlerTimeout({ correlationId: binding.correlationId, deadlineMs: deadline });

          type Attempt = {
            readonly reply?: ServerCallReply;
            readonly failure?: Runtime.RuntimeError;
            readonly outcome: Transaction.Outcome;
          };
          const attempt = Effect.fn("ServerCall.attempt")(function* (number: number) {
            const left = yield* remaining;
            if (left <= 0)
              return {
                failure: timedOut(),
                outcome: { _tag: "rolled_back", reason: "deadline" }
              } as Attempt;
            const scope = yield* Transaction.open(binding.companyId, descriptor.kind, {
              statementTimeoutMs: left
            }).pipe(Effect.provideContext(databases));
            // Every refusal this host issued to the guest, in order; the guest's report is a hint.
            const issued: Runtime.OperationError[] = [];
            const callback: Engine.Invocation["callback"] = (op, callbackArgs) =>
              scope.submit(
                Effect.gen(function* () {
                  const target = Object.hasOwn(handlers, op) ? handlers[op] : undefined;
                  const refuse = (error: Runtime.OperationError) =>
                    Effect.gen(function* () {
                      issued.push(error);
                      yield* log(`refused ${op}: ${error.message}`);
                      return yield* Effect.fail({
                        code: error.code,
                        message: error.message,
                        ...(error.details === undefined ? {} : { details: error.details })
                      });
                    });
                  if (
                    target === undefined ||
                    target.transport !== undefined ||
                    op === "server.call"
                  )
                    return yield* refuse({
                      code: "invalid_request",
                      status: 400,
                      message: `Unknown callback operation ${op}.`
                    });
                  if (!permitted(descriptor.kind, op, target))
                    return yield* refuse({
                      code: "access_denied",
                      status: 403,
                      message: `A ${descriptor.kind} may not call ${op}.`
                    });
                  return yield* target.run(callbackArgs).pipe(
                    Effect.provideService(Binding.Binding, binding),
                    Effect.catch((error) =>
                      Effect.gen(function* () {
                        if (Transaction.isSerializationFailure(error))
                          scope.abort("serialization_failure");
                        return yield* refuse({
                          code: error.code,
                          status: error.status,
                          message: error.message,
                          ...("details" in error && error.details !== undefined
                            ? { details: error.details }
                            : {})
                        });
                      })
                    )
                  );
                })
              );
            const invoked = yield* engine
              .invoke({
                name: `${binding.patchId}@${binding.versionId}#${binding.server!.digest}`,
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
                deadlineMs: Math.max(1, yield* remaining),
                callback
              })
              .pipe(Effect.result);
            let reply: ServerCallReply | undefined;
            let failure: Runtime.RuntimeError | undefined;
            if (invoked._tag === "Failure") {
              const error = invoked.failure;
              if (error._tag === "InvocationTimeout") {
                yield* log(`handler_timeout after ${deadline} ms`);
                scope.abort("deadline");
                failure = timedOut();
              } else if (error._tag === "ProcessKilled") {
                yield* log(`killed with the execution process (generation ${error.generation})`);
                scope.abort("failed");
                failure = timedOut();
              } else {
                scope.abort("failed");
                failure = new Runtime.SourceUnavailable({ cause: error });
              }
            } else {
              const guest = invoked.success;
              for (const line of guest.log ?? []) yield* log(line.message, line.details);
              if (guest.ok) {
                const violation = checkValue(
                  descriptor.result,
                  guest.result ?? null,
                  "$",
                  binding.manifest.tables
                );
                if (violation === undefined) reply = { ok: true, value: guest.result ?? null };
                else {
                  yield* log(
                    `handler_failed: result does not match its declaration (${violation})`
                  );
                  failure = new HandlerFailed({ correlationId: binding.correlationId });
                }
              } else if (guest.error === "handler") {
                if (descriptor.errors?.includes(guest.code) === true)
                  reply = {
                    ok: false,
                    source: "handler",
                    code: guest.code,
                    ...(guest.details === undefined ? {} : { details: guest.details })
                  };
                else {
                  yield* log(`handler_failed: undeclared handler error code ${guest.code}`);
                  failure = new HandlerFailed({ correlationId: binding.correlationId });
                }
              } else if (
                guest.error === "refused" &&
                isRuntimeCode(guest.code) &&
                issued.some((error) => error.code === guest.code)
              ) {
                // Answer with the refusal this host issued to this invocation, never the guest's version.
                const own = issued.find((error) => error.code === guest.code)!;
                failure = { ...own, correlationId: binding.correlationId };
              } else {
                yield* log(
                  `handler_failed: ${guest.error}${"message" in guest && guest.message !== undefined ? ` ${guest.message}` : ""}`,
                  "stack" in guest ? guest.stack : undefined
                );
                failure = new HandlerFailed({ correlationId: binding.correlationId });
              }
            }
            // The guest's return decides nothing once the attempt is abort-only; finish sees that.
            const outcome = yield* scope.finish(
              reply !== undefined && reply.ok ? "commit" : "rollback"
            );
            return { reply, failure, outcome } as Attempt;
          });

          const run = Effect.gen(function* () {
            for (let number = 1; ; number++) {
              const result = yield* Effect.scoped(attempt(number)).pipe(
                Effect.catchTag("TransactionOpenFailed", (error) =>
                  Effect.fail(
                    error.code === "busy"
                      ? new Busy({ correlationId: binding.correlationId, cause: error.cause })
                      : new Runtime.SourceUnavailable({
                          cause: error.cause,
                          correlationId: binding.correlationId
                        })
                  )
                )
              );
              switch (result.outcome._tag) {
                case "serialization_failure":
                  yield* log(`serialization failure on attempt ${number}`);
                  if (descriptor.kind === "mutation" && number < MAX_ATTEMPTS) continue;
                  return yield* new Runtime.SourceUnavailable({
                    cause: new Error(`serialization failure after ${number} attempts`),
                    correlationId: binding.correlationId
                  });
                case "unknown":
                  yield* log(
                    "commit outcome unknown",
                    Transaction.describeChain(result.outcome.cause)
                  );
                  return yield* new Runtime.UnknownOutcome({
                    cause: result.outcome.cause,
                    correlationId: binding.correlationId
                  });
                case "committed":
                  if (result.failure !== undefined) return yield* Effect.fail(result.failure);
                  return result.reply!;
                case "rolled_back":
                  if (result.failure !== undefined) return yield* Effect.fail(result.failure);
                  if (result.reply !== undefined && !result.reply.ok) return result.reply;
                  // A valid result whose transaction did not commit is never reported as success.
                  yield* log(`rolled back before commit (${result.outcome.reason})`);
                  return yield* result.outcome.reason === "deadline"
                    ? timedOut()
                    : new Runtime.SourceUnavailable({
                        cause: new Error(`rolled back: ${result.outcome.reason}`),
                        correlationId: binding.correlationId
                      });
              }
            }
          });
          const admitted = yield* slotOf(binding.companyId).withPermitsIfAvailable(1)(run);
          if (Option.isNone(admitted)) {
            yield* log(`busy: ${perCompany} invocations already running for the company`);
            return yield* new Busy({ correlationId: binding.correlationId });
          }
          return admitted.value;
        })
    );
  });
