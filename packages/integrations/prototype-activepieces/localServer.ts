/** Local-only application boundary. The production entrypoint never imports this module. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/http/HttpServer";
import { DevPersonas } from "@patchy/auth";
import * as Sql from "@patchy/sql";
import * as Server from "../../../apps/server/src/Server.js";
import * as LocalSource from "./localSource.js";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const origin = new URL(yield* Config.String("PATCHY_PUBLIC_BASE_URL"));
    const mode = yield* Config.String("NODE_ENV");
    if (
      mode !== "development" ||
      origin.hostname !== "127.0.0.1" ||
      !(yield* DevPersonas.enabled)
    ) {
      return yield* Effect.die(
        new Error("The Activepieces prototype requires a loopback dev-personas instance.")
      );
    }
    const http = NodeHttpServer.layer(createServer, {
      host: "127.0.0.1",
      port: yield* Server.port
    });
    return yield* Layer.launch(
      Layer.effectDiscard(
        HttpServer.addressFormattedWith((address) =>
          Console.log(
            `Patchy Cloud server listening on ${address} (Activepieces; SIMULATED provider)`
          )
        )
      ).pipe(
        Layer.provide(Server.withPostHogSource(LocalSource.layer)),
        Layer.provide(Sql.layer),
        Layer.provide(http)
      )
    );
  })
);
