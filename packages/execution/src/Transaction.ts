// PROTOTYPE for #314 round 2: one company transaction per invocation, host-side (#310's design).
//
// A mutation opens one SERIALIZABLE company transaction at admission; every callback of that
// invocation is a job run on the transaction's own fiber, so callbacks serialise on it and
// join it (the table handlers' own `withTransaction` becomes a savepoint on the same
// connection). It commits only when the driver says so, after the handler returned and its
// result validated; anything else rolls back. Completion joins the callback running now,
// then refuses every callback still queued or arriving later, so a callback that had already
// been parsed can never run against a closed transaction. A query gets one REPEATABLE READ
// READ ONLY snapshot the same way; an action gets the serialised fiber with no transaction.
// The guest never sees any of this; the company pool's four slots are the bound (`busy`).
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { CompanyDatabases } from "@patchy/company-database";
import type { CallbackRefusal } from "./Engine.js";

export type Kind = "query" | "mutation" | "action";

/** What the transaction did once the invocation finished. */
export type Outcome =
  | { readonly _tag: "committed" }
  | { readonly _tag: "rolled_back" }
  /** Postgres 40001: the whole handler may be re-invoked (mutations only). */
  | { readonly _tag: "serialization_failure" }
  /** The commit was sent and its outcome is not known. */
  | { readonly _tag: "unknown"; readonly cause: unknown }
  /** The company database refused to open or lost the connection before commit. */
  | {
      readonly _tag: "unavailable";
      readonly code: "busy" | "source_unavailable";
      readonly cause: unknown;
    };

class RolledBack extends Schema.TaggedError<RolledBack>()("RolledBack", {}) {}
const isRolledBack = Schema.is(RolledBack);

interface Job {
  readonly run: Effect.Effect<unknown, CallbackRefusal>;
  readonly reply: Deferred.Deferred<unknown, CallbackRefusal>;
}
const refused = (message: string): CallbackRefusal => ({ code: "capability_refused", message });

export interface CallbackScope {
  /** Runs one callback on the transaction's fiber; refused once the invocation completed. */
  readonly submit: (
    run: Effect.Effect<unknown, CallbackRefusal>
  ) => Effect.Effect<unknown, CallbackRefusal>;
  /** Joins the running callback, refuses the rest, then commits or rolls back. */
  readonly finish: (decision: "commit" | "rollback") => Effect.Effect<Outcome>;
}

/** Postgres 40001 anywhere in an error's cause chain: at a statement inside a callback or at commit. */
export const isSerializationFailure = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown; reason?: unknown };
    if (record.code === "40001") return true;
    current = record.cause ?? (record.reason as { cause?: unknown } | undefined)?.cause;
  }
  return false;
};

/** Opened at admission; lives in the caller's scope, which must outlive `finish`. */
export const open = Effect.fn("Transaction.open")(function* (
  companyId: string,
  kind: Kind
): Effect.fn.Return<CallbackScope, never, CompanyDatabases.CompanyDatabases | Scope.Scope> {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const jobs = yield* Queue.unbounded<Job | { readonly done: true }>();
  const decision = yield* Deferred.make<"commit" | "rollback">();
  let closed = false;
  const loop = Effect.gen(function* () {
    while (true) {
      const job = yield* Queue.take(jobs);
      if ("done" in job) break;
      const exit = yield* Effect.exit(job.run);
      yield* Deferred.done(job.reply, exit);
    }
    closed = true;
    for (const job of yield* Queue.clear(jobs)) {
      if (!("done" in job))
        yield* Deferred.fail(job.reply, refused("callback refused: the invocation has completed"));
    }
    yield* Queue.shutdown(jobs);
    if ((yield* Deferred.await(decision)) === "rollback") return yield* new RolledBack();
  });
  const body =
    kind === "action"
      ? loop
      : Effect.gen(function* () {
          const sql = yield* CompanyDatabases.CompanyConnection;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                kind === "query"
                  ? "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
                  : "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"
              );
              return yield* loop;
            })
          );
        });
  const fiber = yield* databases.withCompany(companyId)(body).pipe(Effect.forkScoped);
  const submit: CallbackScope["submit"] = (run) =>
    Effect.gen(function* () {
      if (closed)
        return yield* Effect.fail(refused("callback refused: the invocation has completed"));
      const reply = yield* Deferred.make<unknown, CallbackRefusal>();
      // False once the queue is shut down: the loop drained and refused everything before.
      if (!(yield* Queue.offer(jobs, { run, reply })))
        return yield* Effect.fail(refused("callback refused: the invocation has completed"));
      return yield* Deferred.await(reply);
    });
  const finish: CallbackScope["finish"] = (choice) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(decision, choice);
      // The fiber may already have failed to open; offering after shutdown just answers false.
      yield* Queue.offer(jobs, { done: true });
      const exit = yield* Fiber.await(fiber);
      if (Exit.isSuccess(exit)) return { _tag: "committed" } as const;
      const failure = Exit.isFailure(exit) ? exit.cause : undefined;
      const errors = failure === undefined ? [] : [...failuresOf(failure)];
      if (errors.some(isRolledBack)) return { _tag: "rolled_back" } as const;
      if (errors.some(isSerializationFailure)) return { _tag: "serialization_failure" } as const;
      const tagged = errors.find(
        (error): error is { readonly _tag: string } =>
          error !== null && typeof error === "object" && "_tag" in error
      );
      if (tagged?._tag === "Busy")
        return { _tag: "unavailable", code: "busy", cause: tagged } as const;
      if (tagged?._tag === "CompanyDatabaseNotReady" || tagged?._tag === "CompanyDatabaseError")
        return { _tag: "unavailable", code: "source_unavailable", cause: tagged } as const;
      return choice === "commit"
        ? ({ _tag: "unknown", cause: failure } as const)
        : ({ _tag: "rolled_back" } as const);
    });
  return { submit, finish };
});

const failuresOf = (cause: import("effect/Cause").Cause<unknown>): Iterable<unknown> =>
  cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []));
