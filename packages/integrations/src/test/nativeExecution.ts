import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Pg from "pg";
import { inject } from "vitest";
import * as ConnectionStore from "../ConnectionStore.js";
import * as Execution from "../postgres/Execution.js";
import * as SourceClient from "../postgres/SourceClient.js";

/**
 * Native execution over the current test database on vitest's cluster. Only transport
 * acquisition is replaced; read-only transactions, resets and limits are production code.
 */
export const nativeExecution = Effect.fn("test.nativeExecution")(function* (
  store: ConnectionStore.ConnectionStore["Service"],
  limits: Execution.Limits = Execution.specLimits
) {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ database: string }>`SELECT current_database() AS database`;
  const url = new URL(inject("postgres").adminUrl);
  url.pathname = `/${databases[0]!.database}`;
  return yield* Execution.makeWithClient(
    Effect.fn("test.openNative")(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const client = new Pg.Client({ connectionString: url.toString() });
          client.on("error", () => Execution.destroy(client));
          return client;
        }),
        (client) => Effect.sync(() => Execution.destroy(client))
      );
      yield* Effect.tryPromise({
        try: () => client.connect(),
        catch: (cause) =>
          new SourceClient.SourceUnavailable({ stage: "connect", cause: Redacted.make(cause) })
      });
      return client;
    }),
    (_settings, client) => Effect.sync(() => Execution.destroy(client)),
    limits
  ).pipe(
    Effect.provideService(ConnectionStore.ConnectionStore, {
      ...store,
      poolCredentials: () =>
        Effect.succeed(Redacted.make("postgres://reader:secret@fixture.example/fixture"))
    })
  );
});
