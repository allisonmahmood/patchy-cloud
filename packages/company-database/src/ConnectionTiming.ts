import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import type * as SqlError from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";
import * as DatabaseMeter from "@patchy/analytics/database-meter";
import * as WideEvents from "@patchy/analytics/wide-events";

export interface Reservation {
  readonly connection: SqlConnection.Connection;
  /** Stop immediately when the native session is destroyed, before its scope closes. */
  readonly release: () => void;
}

export interface Client {
  readonly sql: SqlClient.SqlClient;
  readonly reserve: Effect.Effect<Reservation, SqlError.SqlError, Scope.Scope>;
}

const hasCommand = Schema.is(Schema.Struct({ command: Schema.String }));

const transactionOutcomes = (connection: SqlConnection.Connection): SqlConnection.Connection => {
  let transaction: "none" | "read-write" | "read-only" | "unknown" = "none";
  const observe = <A, E, R>(sql: string, effect: Effect.Effect<A, E, R>) => {
    if (sql === "BEGIN") {
      return Effect.tap(effect, () =>
        Effect.sync(() => {
          transaction = "read-write";
        })
      );
    }
    if (sql.startsWith("SET TRANSACTION ") && sql.endsWith("READ ONLY")) {
      return Effect.tap(effect, () =>
        Effect.sync(() => {
          transaction = "read-only";
        })
      );
    }
    return effect;
  };
  const terminal = (sql: string, params: ReadonlyArray<unknown>) =>
    connection.executeRaw(sql, params).pipe(
      Effect.tap((result) =>
        Effect.gen(function* () {
          if (transaction === "read-write") {
            // PostgreSQL acknowledges COMMIT on an aborted transaction as ROLLBACK.
            // PGlite omits the command tag, so its COMMIT outcome remains unknown.
            const command = hasCommand(result) ? result.command : undefined;
            yield* WideEvents.enrich({
              commitOutcome:
                command === "COMMIT"
                  ? "committed"
                  : command === "ROLLBACK" || sql === "ROLLBACK"
                    ? "rolled_back"
                    : "unknown_outcome"
            });
          }
          transaction = "none";
        })
      ),
      Effect.onError(() =>
        Effect.gen(function* () {
          if (transaction !== "read-write") return;
          transaction = "unknown";
          yield* WideEvents.enrich({ commitOutcome: "unknown_outcome" });
        })
      )
    );
  return Object.assign(Object.create(connection) as SqlConnection.Connection, {
    execute: (...args: Parameters<SqlConnection.Connection["execute"]>) =>
      args[0] === "COMMIT" || args[0] === "ROLLBACK"
        ? terminal(args[0], args[1]).pipe(Effect.as(args[2] ? args[2]([]) : []))
        : observe(args[0], connection.execute(...args)),
    executeUnprepared: (...args: Parameters<SqlConnection.Connection["executeUnprepared"]>) =>
      args[0] === "COMMIT" || args[0] === "ROLLBACK"
        ? terminal(args[0], args[1]).pipe(Effect.as(args[2] ? args[2]([]) : []))
        : observe(args[0], connection.executeUnprepared(...args)),
    executeRaw: (...args: Parameters<SqlConnection.Connection["executeRaw"]>) =>
      args[0] === "COMMIT" || args[0] === "ROLLBACK"
        ? terminal(...args)
        : observe(args[0], connection.executeRaw(...args))
  });
};

/** Meter the driver's reservation, not the company's admission slot or pool lookup. */
export const make = Effect.fnUntraced(function* (compiler: Statement.Compiler) {
  const source = yield* SqlClient.SqlClient;
  const reserve = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const meter = yield* DatabaseMeter.current;
      let startedAt: bigint | undefined;
      let stoppedAt: bigint | undefined;
      let releaseMeter: (() => void) | undefined;
      const release = () => {
        if (startedAt === undefined || stoppedAt !== undefined) return;
        stoppedAt = clock.monotonicTimeNanosUnsafe();
        releaseMeter?.();
      };
      // Registered first so the driver's release runs before this accounting finalizer.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          release();
          if (startedAt !== undefined && stoppedAt !== undefined) {
            yield* WideEvents.add({ dbMs: Number(stoppedAt - startedAt) / 1_000_000 });
          }
        })
      );
      const waitingAt = clock.monotonicTimeNanosUnsafe();
      const connection = yield* restore(source.reserve).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            startedAt = clock.monotonicTimeNanosUnsafe();
            releaseMeter = meter?.start();
          })
        ),
        Effect.ensuring(
          Effect.suspend(() =>
            WideEvents.add({
              connectionWaitMs:
                Number((startedAt ?? clock.monotonicTimeNanosUnsafe()) - waitingAt) / 1_000_000
            })
          )
        )
      );
      return { connection: transactionOutcomes(connection), release } satisfies Reservation;
    })
  );
  const sql = yield* SqlClient.make({
    acquirer: Effect.map(reserve, (reservation) => reservation.connection),
    compiler,
    spanAttributes: []
  });
  return { sql, reserve } satisfies Client;
});
