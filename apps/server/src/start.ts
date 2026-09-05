/**
 * The entrypoint: the server layer on Postgres from `DATABASE_URL` and a Node
 * HTTP server on `PORT`, launched under `NodeRuntime.runMain`, which turns
 * SIGINT and SIGTERM into interruption. Interruption closes the scope, and
 * the scope closes everything in it: the listener, the sweep, the analytics
 * flush (bounded, so a slow backend never holds the exit), the database pool.
 * A missing `DATABASE_URL`, an incomplete Azure configuration or a migration
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
import * as HttpServer from "effect/unstable/http/HttpServer";
import { Session } from "@patchy/auth";
import * as Sql from "@patchy/sql";
import * as Server from "./Server.js";

/** The line the packed-CLI e2e and the dev runner wait for, exactly as written. */
const announce = HttpServer.addressFormattedWith((address) =>
  Console.log(`Patchy Cloud server listening on ${address}`)
);

const httpServer = Layer.unwrap(
  Effect.map(Server.port, (port) => NodeHttpServer.layer(createServer, { port, host: "0.0.0.0" }))
);

const server = Layer.effectDiscard(announce).pipe(
  Layer.provideMerge(Server.layer),
  Layer.provide(Sql.layer),
  Layer.provide(httpServer)
);

// Check required settings before acquiring Postgres, so an unreachable database
// cannot hide a missing Clerk key or public origin behind a connection error.
NodeRuntime.runMain(
  Effect.gen(function* () {
    yield* Config.all([Config.redacted("DATABASE_URL"), Session.config]);
    return yield* Layer.launch(server);
  })
);
