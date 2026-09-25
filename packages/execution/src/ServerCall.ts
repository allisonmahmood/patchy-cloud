// PROTOTYPE for #314: the `server.call` runtime operation.
//
// Admission is the runtime's (session, version, wire, principal); this handler adds the tier 2
// rules: the loaded version must be tier 2, the handler must be in the version's descriptors,
// the arguments must fit the descriptor before invocation and the result after it. Everything
// an invocation needs is read from the `Binding` at admission and closed over for its whole
// life; a rebuild in dev binds a new version, it never mutates this one. Callbacks resolve to
// the sibling runtime handlers (`tables.*`) under that same binding, and a query's callbacks
// are refused by the host when they would write.
//
// Round 2: every attempt opens one company transaction at admission (Transaction.ts) that
// the callbacks join; it commits only after the result validated and rolls back otherwise.
// A serialization failure re-invokes the whole handler, mutations only, up to three
// attempts, each with a fresh capability so a late callback from an earlier attempt is
// refused. Refusal codes the guest reports are never trusted: the host answers with the
// refusal it issued itself, or `handler_failed`.
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
const MAX_ATTEMPTS = 3;
/**
 * Concurrent invocations per company. The company pool has four connections; an invocation's
 * transaction holds one for its whole life and each of its callbacks borrows a second through
 * the table handlers' own `withCompany`, so two invocations is what four slots carry. Past it:
 * `busy`, fail-fast, never a wait. A build would fold the callback's borrow into the held one.
 */
const INVOCATIONS_PER_COMPANY = 2;
const isRuntimeCode = Schema.is(RuntimeCode);

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
    // Captured once: callbacks run on the transaction fiber, which needs the company databases.
    const databases = yield* Effect.context<CompanyDatabases.CompanyDatabases>();
    const slots = new Map<string, Semaphore.Semaphore>();
    const slotOf = (companyId: string) => {
      let semaphore = slots.get(companyId);
      if (semaphore === undefined) {
        semaphore = Semaphore.makeUnsafe(INVOCATIONS_PER_COMPANY);
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

          const attempt = Effect.fn("ServerCall.attempt")(function* (number: number) {
            const scope = yield* Transaction.open(binding.companyId, descriptor.kind).pipe(
              Effect.provideContext(databases)
            );
            // The last refusal this host issued to the guest; the guest's own report is only a hint.
            let issued: Runtime.OperationError | undefined;
            // A 40001 at a statement inside a callback surfaces as the table handler's refusal;
            // it is the transaction's serialization failure and the attempt is retried.
            let serialized = false;
            const callback: Engine.Invocation["callback"] = (op, callbackArgs) =>
              scope.submit(
                Effect.gen(function* () {
                  const target = Object.hasOwn(handlers, op) ? handlers[op] : undefined;
                  const refuse = (error: Runtime.OperationError) =>
                    Effect.gen(function* () {
                      issued = error;
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
                  if (descriptor.kind === "query" && target.kind !== "read")
                    return yield* refuse({
                      code: "access_denied",
                      status: 403,
                      message: `A query may not call ${op}; declare a mutation for writes.`
                    });
                  return yield* target.run(callbackArgs).pipe(
                    Effect.provideService(Binding.Binding, binding),
                    Effect.catch((error) =>
                      refuse({
                        ...(Transaction.isSerializationFailure(error)
                          ? ((serialized = true), {})
                          : {}),
                        code: error.code,
                        status: error.status,
                        message: error.message,
                        ...("details" in error && error.details !== undefined
                          ? { details: error.details }
                          : {})
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
                deadlineMs: deadline,
                callback
              })
              .pipe(Effect.result);
            // Decide before touching the transaction: commit only on a validated result.
            let reply: ServerCallReply | undefined;
            let failure: Runtime.RuntimeError | undefined;
            if (invoked._tag === "Failure") {
              const error = invoked.failure;
              if (error._tag === "InvocationTimeout") {
                yield* log(`handler_timeout after ${error.deadlineMs} ms`);
                failure = new HandlerTimeout({
                  correlationId: binding.correlationId,
                  deadlineMs: error.deadlineMs
                });
              } else if (error._tag === "ProcessKilled") {
                // Collateral of the watchdog: its transaction rolls back below, so the outcome is
                // a confirmed non-commit and reported as handler_timeout, never unknown_outcome.
                yield* log(`killed with the execution process (generation ${error.generation})`);
                failure = new HandlerTimeout({
                  correlationId: binding.correlationId,
                  deadlineMs: deadline
                });
              } else failure = new Runtime.SourceUnavailable({ cause: error });
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
                reply = {
                  ok: false,
                  source: "handler",
                  code: guest.code,
                  ...(guest.details === undefined ? {} : { details: guest.details })
                };
              } else if (
                guest.error === "refused" &&
                issued !== undefined &&
                isRuntimeCode(guest.code)
              ) {
                // Answer with the refusal this host issued, never the guest's version of it.
                failure = { ...issued, correlationId: binding.correlationId };
              } else {
                yield* log(
                  `handler_failed: ${guest.error}${"message" in guest && guest.message !== undefined ? ` ${guest.message}` : ""}`,
                  "stack" in guest ? guest.stack : undefined
                );
                failure = new HandlerFailed({ correlationId: binding.correlationId });
              }
            }
            // A handler error aborts the transaction like any throw (#296 point 6).
            const decision = reply !== undefined && reply.ok ? "commit" : "rollback";
            const finished = yield* scope.finish(decision);
            const outcome =
              serialized && finished._tag === "rolled_back"
                ? ({ _tag: "serialization_failure" } as const)
                : finished;
            return { reply, failure, outcome, number };
          });

          const admitted = yield* slotOf(binding.companyId).withPermitsIfAvailable(1)(
            Effect.gen(function* () {
              for (let number = 1; ; number++) {
                const result = yield* Effect.scoped(attempt(number));
                switch (result.outcome._tag) {
                  case "serialization_failure":
                    yield* log(`serialization failure on attempt ${number}`);
                    if (descriptor.kind === "mutation" && number < MAX_ATTEMPTS) continue;
                    return yield* new Runtime.SourceUnavailable({
                      cause: new Error(`serialization failure after ${number} attempts`),
                      correlationId: binding.correlationId
                    });
                  case "unavailable":
                    return yield* result.outcome.code === "busy"
                      ? new Busy({ correlationId: binding.correlationId })
                      : new Runtime.SourceUnavailable({
                          cause: result.outcome.cause,
                          correlationId: binding.correlationId
                        });
                  case "unknown":
                    yield* log("commit outcome unknown");
                    return yield* new Runtime.UnknownOutcome({
                      cause: result.outcome.cause,
                      correlationId: binding.correlationId
                    });
                  case "committed":
                  case "rolled_back":
                    if (result.failure !== undefined) return yield* Effect.fail(result.failure);
                    return result.reply!;
                }
              }
            })
          );
          if (Option.isNone(admitted)) {
            yield* log(
              `busy: ${INVOCATIONS_PER_COMPANY} invocations already running for the company`
            );
            return yield* new Busy({ correlationId: binding.correlationId });
          }
          return admitted.value;
        })
    );
  });
