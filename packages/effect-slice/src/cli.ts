/**
 * `patchy whoami` on effect/unstable/cli, through the client derived from the
 * HttpApi. Credentials come from the environment only (the credential file is
 * not this slice's question).
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Layer, Option, Redacted } from "effect";
import { CliConfig, CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/unstable/cli";
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

/** A missing setting is the agent's to fix: say which one, no stack. */
const required = <A>(config: Config.Config<A>, userMessage: string) =>
  config.pipe(
    Effect.catchTags({ ConfigError: (cause) => new CliError.UserError({ cause, userMessage }) })
  );

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
      : yield* required(Config.string("PATCHY_API_URL"), "Set PATCHY_API_URL or pass --api-url.");
    const token = yield* required(
      Config.redacted("PATCHY_API_TOKEN"),
      "Set PATCHY_API_TOKEN to the publishing token for this instance."
    );
    const client = yield* makeClient(resolvedUrl, token);
    // Every failure an agent can act on becomes a one-line stderr message and exit 1.
    const identity = yield* client.me().pipe(
      Effect.catch(
        (error) =>
          new CliError.UserError({
            cause: error,
            userMessage:
              "ok" in error ? error.error : `Could not reach ${resolvedUrl}: ${error.message}`
          })
      )
    );
    yield* Console.log(`Account: ${identity.accountName} (${identity.accountId})`);
    yield* Console.log(`API token: ${identity.apiTokenName} (${identity.apiTokenId})`);
    yield* Console.log(`Scopes: ${identity.scopes.join(", ")}`);
  })
).pipe(Command.withDescription("Check the configured Patchy Cloud credentials."));

/** Agent-facing surface: `--help`/`--version` only (no wizard, completions, log-level); bare version string. */
const CliSurface = Layer.mergeAll(
  CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
  CliOutput.layer({
    ...CliOutput.defaultFormatter(),
    formatVersion: (_name, version) => version,
    formatError: (error) => error.message
  })
);

Command.make("patchy").pipe(
  Command.withSubcommands([whoami]),
  Command.run({ version: __PATCHY_VERSION__ }),
  Effect.provide([NodeServices.layer, CliSurface]),
  NodeRuntime.runMain
);
