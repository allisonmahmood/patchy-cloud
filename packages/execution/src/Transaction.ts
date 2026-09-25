// PROTOTYPE for #314 round 2/3: one company transaction per invocation, host-side (#310).
//
// A mutation opens one SERIALIZABLE company transaction at admission on its own fiber; the
// scope is handed out only once BEGIN and the isolation statements succeeded. Every callback
// of the invocation is a job on that fiber, so callbacks serialise on the transaction and join
// it (the table handlers' own `withTransaction` becomes a savepoint on the same connection,
// and `joiningDatabases` makes their `withCompany` reuse the held connection instead of
// borrowing a second pool slot). Completion revokes admission, joins the running job, settles
// every queued job with a refusal, then verifies the transaction is not aborted and commits;
// the outcome is classified from the phase the failure happened in, never from the requested
// choice. A serialization failure anywhere marks the attempt abort-only. Settlement runs on
// every fiber exit, interruption included. A query gets one REPEATABLE READ READ ONLY snapshot
// the same way; an action gets the serialised fiber with no transaction.
// The guest never sees any of this.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CompanyDatabases } from "@patchy/company-database";
import type { CallbackRefusal } from "./Engine.js";

export type Kind = "query" | "mutation" | "action";
export type AbortReason = "serialization_failure" | "deadline" | "failed";

/** What the transaction did once the invocation finished, classified from the commit phase. */
export type Outcome =
  | { readonly _tag: "committed" }
  | { readonly _tag: "rolled_back"; readonly reason: AbortReason | "requested" | "lost" }
  /** Postgres 40001 at a statement or at commit: the handler may be re-invoked (mutations only). */
  | { readonly _tag: "serialization_failure" }
  /** COMMIT was sent and its reply was lost or failed for another reason. */
  | { readonly _tag: "unknown"; readonly cause: unknown };

/** The transaction could not be opened; admission fails before any guest work. */
export class OpenFailed extends Schema.TaggedError<OpenFailed>()("TransactionOpenFailed", {
  code: Schema.Literals(["busy", "source_unavailable"]),
  cause: Schema.Defect()
}) {
  override get message() {
    return `The company transaction could not be opened (${this.code}).`;
  }
}

class RolledBack extends Schema.TaggedError<RolledBack>()("RolledBack", {
  reason: Schema.Literals(["serialization_failure", "deadline", "failed", "requested"])
}) {}
const isRolledBack = Schema.is(RolledBack);

interface Job {
  readonly run: Effect.Effect<unknown, CallbackRefusal>;
  readonly reply: Deferred.Deferred<unknown, CallbackRefusal>;
}
const refused = (code: string, message: string): CallbackRefusal => ({ code, message });
const completed = refused("capability_refused", "callback refused: the invocation has completed");

export interface CallbackScope {
  /** Runs one callback on the transaction's fiber; refused once the invocation completed. */
  readonly submit: (
    run: Effect.Effect<unknown, CallbackRefusal>
  ) => Effect.Effect<unknown, CallbackRefusal>;
  /** Marks the attempt abort-only: no later callback runs, no return value commits. */
  readonly abort: (reason: AbortReason) => void;
  /** Revokes admission, joins the running callback, refuses the rest, verifies, commits or rolls back. */
  readonly finish: (choice: "commit" | "rollback") => Effect.Effect<Outcome>;
}

/** Postgres 40001 anywhere in an error's cause chain: at a statement inside a callback or at commit. */
export const isSerializationFailure = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === "40001") return true;
    // SqlError keeps the driver error under `reason.cause`; wrappers use `cause`.
    for (const key of ["cause", "reason", "error"]) if (key in record) pending.push(record[key]);
  }
  return false;
};

/** DEBUG round 3: the keys and codes along an error's cause chain. */
export const describeChain = (error: unknown): string => {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && parts.length < 12) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const own = Object.getOwnPropertyNames(record).slice(0, 12).join(",");
    parts.push(
      `${String(record._tag ?? (record as { name?: unknown }).name ?? "?")}{${own}} code=${String(record.code ?? (record as { sqlState?: unknown }).sqlState ?? "")} msg=${String((record as { message?: unknown }).message ?? "").slice(0, 80)}`
    );
    for (const key of ["cause", "reason", "error"]) if (key in record) pending.push(record[key]);
  }
  return parts.join(" <- ");
};

// Failures and defects alike: a COMMIT that fails inside withTransaction surfaces as a defect.
const failuresOf = (cause: Cause.Cause<unknown>): ReadonlyArray<unknown> =>
  cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" ? [reason.error] : reason._tag === "Die" ? [reason.defect] : []
  );
const tagOf = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "_tag" in error
    ? String((error as { _tag: unknown })._tag)
    : undefined;

/**
 * A `CompanyDatabases` whose `withCompany` runs on the connection already held in the fiber's
 * context when there is one (a callback on the transaction fiber), and defers to the real
 * service otherwise. The table handlers built over it join the invocation's transaction
 * without a second pool borrow, so four slots carry four invocations. Lives in the
 * execution seam; the primitives are unchanged.
 */
export const joiningDatabases = (
  real: CompanyDatabases.CompanyDatabases["Service"]
): CompanyDatabases.CompanyDatabases["Service"] => ({
  ...real,
  withCompany: (companyId) => (effect) =>
    Effect.flatMap(Effect.serviceOption(CompanyDatabases.CompanyConnection), (held) =>
      Option.isSome(held)
        ? effect.pipe(
            Effect.provideContext(
              Context.make(CompanyDatabases.CompanyConnection, held.value).pipe(
                Context.add(SqlClient.SqlClient, held.value)
              )
            )
          )
        : real.withCompany(companyId)(effect)
    )
});

/** Opened at admission; lives in the caller's scope, which must outlive `finish`. */
export const open = Effect.fn("Transaction.open")(function* (
  companyId: string,
  kind: Kind,
  options: { readonly statementTimeoutMs: number }
): Effect.fn.Return<CallbackScope, OpenFailed, CompanyDatabases.CompanyDatabases | Scope.Scope> {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const jobs = yield* Queue.unbounded<Job | { readonly done: true }>();
  const decision = yield* Deferred.make<"commit" | "rollback">();
  const ready = yield* Deferred.make<void, OpenFailed>();
  let closed = false;
  let abortReason: AbortReason | undefined;
  let phase: "opening" | "running" | "settling" | "verifying" | "committing" = "opening";
  const settle = Effect.gen(function* () {
    // Idempotent: the loop settles on its way out and the fiber's ensuring settles again; a
    // clear on the already shut-down queue would end this fiber as interrupted.
    if (closed) return;
    closed = true;
    for (const job of yield* Queue.clear(jobs)) {
      if (!("done" in job)) yield* Deferred.fail(job.reply, completed);
    }
    yield* Queue.shutdown(jobs);
  });
  const loop = Effect.gen(function* () {
    phase = "running";
    yield* Deferred.succeed(ready, undefined);
    while (true) {
      const job = yield* Queue.take(jobs);
      if ("done" in job) break;
      const exit = yield* Effect.exit(job.run);
      yield* Deferred.done(job.reply, exit);
    }
    phase = "settling";
    yield* settle;
    const choice = yield* Deferred.await(decision);
    if (abortReason !== undefined) return yield* new RolledBack({ reason: abortReason });
    if (choice === "rollback") return yield* new RolledBack({ reason: "requested" });
  });
  const transactional = Effect.gen(function* () {
    const sql = yield* CompanyDatabases.CompanyConnection;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          kind === "query"
            ? "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
            : "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"
        );
        // A statement that outlives the invocation's deadline fails inside its callback, so a
        // genuinely in-flight callback is bounded and the rollback after it is confirmed.
        yield* sql.unsafe(
          `SET LOCAL statement_timeout = ${Math.max(1, options.statementTimeoutMs)}`
        );
        yield* loop;
        // An aborted transaction answers COMMIT with ROLLBACK without an error, so the state is
        // inspected before COMMIT is sent: this fails with 25P02 when the transaction is aborted.
        phase = "verifying";
        yield* sql.unsafe("SELECT 1");
        phase = "committing";
      })
    );
  });
  const body = (kind === "action" ? loop : transactional).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        yield* settle;
        // Failed before admission finished: the opener learns why instead of waiting.
        yield* Deferred.fail(
          ready,
          new OpenFailed({
            code: "source_unavailable",
            cause: new Error("transaction fiber exited")
          })
        );
      })
    )
  );
  const fiber = yield* databases.withCompany(companyId)(body).pipe(Effect.forkScoped);
  const opened = yield* Effect.exit(Deferred.await(ready));
  if (Exit.isFailure(opened)) {
    const exit = yield* Fiber.await(fiber);
    const errors = Exit.isFailure(exit) ? failuresOf(exit.cause) : [];
    const busy = errors.some((error) => tagOf(error) === "Busy" || tagOf(error) === "TableBusy");
    return yield* new OpenFailed({
      code: busy ? "busy" : "source_unavailable",
      cause: errors[0] ?? new Error("transaction did not open")
    });
  }
  const submit: CallbackScope["submit"] = (run) =>
    Effect.gen(function* () {
      if (abortReason !== undefined)
        return yield* Effect.fail(
          refused(abortReason, `callback refused: the attempt is aborted (${abortReason})`)
        );
      if (closed) return yield* Effect.fail(completed);
      const reply = yield* Deferred.make<unknown, CallbackRefusal>();
      // False once the queue is shut down: the loop drained and refused everything before.
      if (!(yield* Queue.offer(jobs, { run, reply }))) return yield* Effect.fail(completed);
      return yield* Deferred.await(reply);
    });
  const abort: CallbackScope["abort"] = (reason) => {
    abortReason ??= reason;
  };
  const finish: CallbackScope["finish"] = (choice) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(decision, choice);
      yield* Queue.offer(jobs, { done: true });
      const exit = yield* Fiber.await(fiber);
      if (Exit.isSuccess(exit)) return { _tag: "committed" } as const;
      const errors = failuresOf(exit.cause);
      const rolledBack = errors.find(isRolledBack);
      if (rolledBack !== undefined)
        return rolledBack.reason === "serialization_failure"
          ? ({ _tag: "serialization_failure" } as const)
          : ({ _tag: "rolled_back", reason: rolledBack.reason } as const);
      if (errors.some(isSerializationFailure)) return { _tag: "serialization_failure" } as const;
      if (abortReason !== undefined) return { _tag: "rolled_back", reason: abortReason } as const;
      // The phase says what was in flight when the fiber failed; only a failed or lost COMMIT is unknown.
      if (phase === "committing")
        return { _tag: "unknown", cause: Cause.squash(exit.cause) } as const;
      return { _tag: "rolled_back", reason: "lost" } as const;
    });
  return { submit, abort, finish };
});

/** Convenience for callers that only have the service tag. */
export const joiningLayer = Effect.map(CompanyDatabases.CompanyDatabases, (real) =>
  Context.make(CompanyDatabases.CompanyDatabases, joiningDatabases(real))
);
