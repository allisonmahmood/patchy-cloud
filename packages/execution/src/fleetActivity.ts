import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import * as SqlError from "effect/unstable/sql/SqlError";

/** One replaceable session holds this replica's live activity, with one lock per distinct key. */
export const make = Effect.fn("FleetActivity.make")(function* (options: {
  readonly checkInterval: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Scope.Scope;
  const serial = yield* Semaphore.make(1);
  const holders = new Map<string, number>();
  let session: { readonly connection: Connection; readonly scope: Scope.Closeable } | undefined;

  const bounded = <A, R>(work: Effect.Effect<A, SqlError.SqlError, R>) =>
    work.pipe(
      Effect.interruptible,
      Effect.timeout(options.checkInterval),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(
            new SqlError.SqlError({
              reason: new SqlError.ConnectionError({ cause, operation: "fleet activity" })
            })
          )
      })
    );
  const query = (connection: Connection, statement: string, parameters: readonly unknown[]) =>
    bounded(connection.executeValues(statement, parameters)).pipe(Effect.asVoid);
  const close = Effect.gen(function* () {
    const previous = session;
    session = undefined;
    if (previous) yield* Scope.close(previous.scope, Exit.void);
  });
  const connect = Effect.gen(function* () {
    // Release the dead reservation first, including when the pool has only one slot.
    yield* close;
    const nextScope = yield* Scope.make();
    const connection = yield* Effect.gen(function* () {
      const next = yield* bounded(sql.reserve);
      yield* Effect.addFinalizer(() =>
        query(next, "SELECT pg_advisory_unlock_all()", []).pipe(
          // A dead session already lost its locks; its reservation still must be released.
          Effect.catchTags({ SqlError: () => Effect.void })
        )
      );
      if (holders.size > 0)
        yield* query(
          next,
          "SELECT pg_advisory_lock_shared(hashtextextended(key, 0)) FROM unnest($1::text[]) AS key",
          [[...holders.keys()]]
        );
      return next;
    }).pipe(
      Scope.provide(nextScope),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(nextScope, exit) : Effect.void))
    );
    session = { connection, scope: nextScope };
    return connection;
  }).pipe(Effect.uninterruptible);
  const execute = Effect.fn("FleetActivity.execute")(function* (
    statement: string,
    parameters: readonly unknown[]
  ) {
    const connection = session?.connection ?? (yield* connect);
    yield* query(connection, statement, parameters).pipe(
      Effect.catchTags({
        SqlError: () =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              "Restoring execution activity after a database session failure",
              {
                heldKeys: holders.size
              }
            );
            const replacement = yield* connect;
            yield* query(replacement, statement, parameters);
          })
      })
    );
  });
  yield* connect;
  yield* Effect.addFinalizer(() => serial.withPermit(close));
  const hold = Effect.fn("FleetActivity.hold")(
    function* (key: string) {
      const count = holders.get(key) ?? 0;
      yield* execute(
        count === 0 ? "SELECT pg_advisory_lock_shared(hashtextextended($1, 0))" : "SELECT 1",
        count === 0 ? [key] : []
      );
      holders.set(key, count + 1);
      let released = false;
      return Effect.gen(function* () {
        if (released) return;
        released = true;
        const remaining = holders.get(key)! - 1;
        if (remaining > 0) {
          holders.set(key, remaining);
          return;
        }
        holders.delete(key);
        yield* execute("SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))", [key]);
      }).pipe(serial.withPermit, Effect.uninterruptible);
    },
    serial.withPermit,
    Effect.uninterruptible
  );
  yield* Effect.sleep(options.checkInterval).pipe(
    Effect.andThen(serial.withPermit(execute("SELECT 1", []))),
    Effect.catchTags({
      SqlError: () =>
        Effect.logWarning("Execution activity session is unavailable; retrying recovery")
    }),
    Effect.forever,
    Effect.forkIn(scope)
  );
  return { hold };
});
