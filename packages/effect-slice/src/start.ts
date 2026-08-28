/** Server entrypoint: migrate, then serve. `PORT` and `DATABASE_URL` from the environment. */
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { createServer } from "node:http";
import { Patches } from "./patches/index.js";
import { MigratorLive, PgLive } from "./sql.js";
import { AppRoutes } from "./server.js";

const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.port("PORT").pipe(Config.withDefault(3000));
    return NodeHttpServer.layer(createServer, { port });
  })
);

const Main = HttpRouter.serve(AppRoutes).pipe(
  Layer.provide([ServerLive, Patches.layer]),
  Layer.provide(MigratorLive),
  Layer.provide(PgLive)
);

NodeRuntime.runMain(Layer.launch(Main));
