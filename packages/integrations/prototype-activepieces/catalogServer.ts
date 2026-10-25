/** Local-only entrypoint. Production does not import community modules or mount these routes. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { ClientDocumentNetwork, DevPersonas } from "@patchy/auth";
import { Companies, Users } from "@patchy/companies";
import * as Sql from "@patchy/sql";
import { RuntimeLog } from "@patchy/runtime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Server from "../../../apps/server/src/Server.js";
import * as ConnectionPages from "../src/ConnectionPages.js";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as PostHogSource from "../src/posthog/Source.js";
import * as CommunityConnections from "./CommunityConnections.js";
import * as CommunityPages from "./CommunityPages.js";
import * as Pieces from "./Pieces.js";
import * as CommunityRuntime from "./CommunityRuntime.js";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const origin = new URL(yield* Config.String("PATCHY_PUBLIC_BASE_URL"));
    if (
      (yield* Config.String("NODE_ENV")) !== "development" ||
      origin.hostname !== "127.0.0.1" ||
      !(yield* DevPersonas.enabled)
    )
      return yield* Effect.die(
        new Error("The connector catalog requires a loopback dev-personas instance.")
      );
    const http = NodeHttpServer.layer(createServer, {
      host: "127.0.0.1",
      port: yield* Server.port
    });
    // The local routes bring their own request services, over this worktree's database.
    const localServices = Layer.mergeAll(
      DevPersonas.layer,
      Companies.layer,
      Users.layer,
      CommunityConnections.layer
    ).pipe(
      Layer.provideMerge(RuntimeLog.layer),
      Layer.provideMerge(Pieces.layer),
      Layer.provide(CredentialKeys.layer)
    );
    const routes = CommunityPages.layer.pipe(HttpRouter.provideRequest(localServices));
    const support = CommunityRuntime.layer.pipe(
      Layer.provide([Pieces.layer, CredentialKeys.layer])
    );
    return yield* Layer.launch(
      Layer.effectDiscard(
        HttpServer.addressFormattedWith((address) =>
          Console.log(
            `Patchy listening on ${address} (community connector catalog; REAL provider requests)`
          )
        )
      ).pipe(
        Layer.provide(Server.withPostHogSource(PostHogSource.layer, routes)),
        Layer.provide(
          Layer.succeed(ConnectionPages.extraNavigation, {
            href: CommunityPages.path,
            label: "Explore connectors (local prototype)"
          })
        ),
        Layer.provide(support),
        Layer.provide([Sql.layer, ClientDocumentNetwork.layer]),
        Layer.provide(http)
      )
    );
  })
);
