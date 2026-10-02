/**
 * The entrypoint: the server layer on Postgres from `DATABASE_URL` and a Node
 * HTTP server on `PORT`, launched under `NodeRuntime.runMain`, which turns
 * SIGINT and SIGTERM into interruption. Interruption closes the scope, and
 * the scope closes everything in it: the listener, the sweep, the analytics
 * flush (bounded, so a slow backend never holds the exit), the database pool.
 * A missing `DATABASE_URL`, an incomplete S3 configuration or a migration
 * that fails all fail here, before the server listens.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the Node server is Node's to create.
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/http/HttpServer";
import { DevPersonas, Session } from "@patchy/auth";
import { PgCompanyDatabases } from "@patchy/company-database";
import { CredentialKeys } from "@patchy/integrations";
import * as Sql from "@patchy/sql";
import { Runtime, RuntimeStream } from "@patchy/runtime";
import * as Server from "./Server.js";

/** The line the packed-CLI e2e and the dev runner wait for, exactly as written. */
const announce = HttpServer.addressFormattedWith((address) =>
  Console.log(`Patchy Cloud server listening on ${address}`)
);

/** Dev personas sign anyone in, so their environments listen on loopback only. */
const httpServer = Layer.unwrap(
  Effect.map(Effect.all([Server.port, DevPersonas.enabled]), ([port, personas]) =>
    NodeHttpServer.layer(createServer, { port, host: personas ? "127.0.0.1" : "0.0.0.0" })
  )
);

const server = Layer.effectDiscard(
  Effect.gen(function* () {
    const streams = yield* RuntimeStream.RuntimeStream;
    const runtime = yield* Runtime.Runtime;
    const context = yield* Effect.context<never>();
    // NodeRuntime also handles these signals. Fence streams before its interruption
    // closes the HTTP listener; EOF remains an ordinary reconnect for the browser.
    const onSignal = () => {
      Effect.runSyncWith(context)(Effect.andThen(runtime.drain, streams.drain));
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.prependListener("SIGTERM", onSignal);
        process.prependListener("SIGINT", onSignal);
      }),
      () =>
        Effect.sync(() => {
          process.removeListener("SIGTERM", onSignal);
          process.removeListener("SIGINT", onSignal);
        })
    );
    yield* announce;
  })
).pipe(Layer.provideMerge(Server.layer), Layer.provide(Sql.layer), Layer.provide(httpServer));

// Check required settings before acquiring Postgres, so an unreachable database
// cannot hide a missing Clerk key (or personas secret) or public origin behind a connection error.
NodeRuntime.runMain(
  Effect.gen(function* () {
    yield* Config.all([
      Config.Redacted("DATABASE_URL"),
      PgCompanyDatabases.config,
      CredentialKeys.config
    ]);
    if (yield* DevPersonas.enabled) yield* DevPersonas.config;
    else yield* Session.config;
    return yield* Layer.launch(server);
  })
);
