import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import type * as PidgeonSource from "../pidgeon/Source.js";
import * as SqlConnectionStore from "../SqlConnectionStore.js";

/** What the next outermost COMMIT does once armed. */
export type CommitFault =
  /** It goes through and answers with an error, as a connection lost right after COMMIT does. */
  | { readonly kind: "lose" }
  /** It fails and the transaction rolls back; `meanwhile` runs before the error answers. */
  | { readonly kind: "fail"; readonly meanwhile: Effect.Effect<unknown, unknown> };

const commitError = (cause: string) =>
  new SqlError({ reason: new ConnectionError({ cause: new Error(cause) }) });

/**
 * The production store over a database whose next outermost COMMIT can be made to misbehave, and
 * over `pidgeon`: a Patchy-side fault through an alternate client, never a change to the store.
 */
export const losingCommits = (pidgeon: Layer.Layer<PidgeonSource.Source>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const armed: { next: CommitFault | undefined } = { next: undefined };
    const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
      Effect.gen(function* () {
        const fault = Option.isNone(yield* Effect.serviceOption(sql.transactionService))
          ? armed.next
          : undefined;
        if (fault === undefined) return yield* sql.withTransaction(effect);
        armed.next = undefined;
        if (fault.kind === "lose") {
          yield* sql.withTransaction(effect);
          return yield* commitError("the COMMIT's answer was lost");
        }
        const failed = yield* sql
          .withTransaction(
            Effect.flatMap(effect, () => Effect.fail(commitError("the COMMIT failed")))
          )
          .pipe(Effect.flip);
        yield* Effect.ignore(fault.meanwhile);
        return yield* Effect.fail(failed);
      });
    const lossy = new Proxy(sql, {
      get: (target, key, receiver) =>
        key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver)
    });
    const store = yield* SqlConnectionStore.make.pipe(
      Effect.provide(pidgeon),
      Effect.provideService(SqlClient.SqlClient, lossy)
    );
    return { store, armed };
  });
