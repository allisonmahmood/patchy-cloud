import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CurrentIdentity, PatchyApi } from "@patchy/api";
import { Bearer } from "@patchy/auth";
import * as AgentRuntime from "./AgentRuntime.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeApi from "./RuntimeApi.js";

export const layer = HttpApiBuilder.group(PatchyApi, "agent", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* AgentRuntime.AgentRuntime;
    return handlers
      .handle("describe", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          return yield* agent.describe(params.patchId, identity).pipe(
            Effect.map((value) =>
              HttpServerResponse.jsonUnsafe(value, { headers: { "cache-control": "no-store" } })
            ),
            Effect.catch((error) => Effect.succeed(RuntimeApi.failure(error)))
          );
        })
      )
      .handle("call", ({ params, payload }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const credential = Bearer.parse(request.headers.authorization);
          if (credential.kind !== "bearer") return RuntimeApi.failure(new Runtime.AccessDenied({}));
          return yield* agent.call(params.patchId, payload, identity, credential.token).pipe(
            Effect.map((reply) =>
              HttpServerResponse.jsonUnsafe(reply, { headers: { "cache-control": "no-store" } })
            ),
            Effect.catch((error) => Effect.succeed(RuntimeApi.failure(error)))
          );
        })
      );
  })
);
