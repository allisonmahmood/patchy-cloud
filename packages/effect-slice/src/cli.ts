/**
 * `patchy whoami` on effect/unstable/cli, through the client derived from the
 * HttpApi. Credentials come from the environment only (the credential file is
 * not this slice's question).
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Option, Redacted } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi";
import { Authorization, PatchyApi } from "./api.js";

declare const __PATCHY_VERSION__: string;

const authorizationClient = (token: Redacted.Redacted) =>
  HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token))
  );

const makeClient = (apiUrl: string, token: Redacted.Redacted) =>
  HttpApiClient.make(PatchyApi, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.prependUrl(apiUrl))
  }).pipe(Effect.provide([authorizationClient(token), FetchHttpClient.layer]));

const whoami = Command.make(
  "whoami",
  {
    apiUrl: Flag.string("api-url").pipe(
      Flag.withDescription("Override the configured Patchy Cloud API base URL"),
      Flag.optional
    )
  },
  Effect.fn(function* ({ apiUrl }) {
    const resolvedUrl = Option.isSome(apiUrl)
      ? apiUrl.value
      : yield* Config.string("PATCHY_API_URL");
    const token = yield* Config.redacted("PATCHY_API_TOKEN");
    const client = yield* makeClient(resolvedUrl, token);
    const identity = yield* client
      .me()
      .pipe(Effect.catchTag("Unauthorized", (error) => Effect.die(new Error(error.error))));
    yield* Console.log(`Account: ${identity.accountName} (${identity.accountId})`);
    yield* Console.log(`API token: ${identity.apiTokenName} (${identity.apiTokenId})`);
    yield* Console.log(`Scopes: ${identity.scopes.join(", ")}`);
  })
).pipe(Command.withDescription("Check the configured Patchy Cloud credentials."));

Command.make("patchy").pipe(
  Command.withSubcommands([whoami]),
  Command.run({ version: __PATCHY_VERSION__ }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
