import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { PatchyApi } from "@patchy/api";
import * as RuntimeApi from "./RuntimeApi.js";
import * as RuntimeStream from "./RuntimeStream.js";

export const layer = HttpApiBuilder.group(PatchyApi, "runtimeStream", (handlers) =>
  Effect.gen(function* () {
    const streams = yield* RuntimeStream.RuntimeStream;
    return handlers.handleRaw("stream", ({ query }) =>
      streams.open(query).pipe(
        Effect.map((body) =>
          HttpServerResponse.stream(body, {
            contentType: "text/event-stream",
            headers: {
              "cache-control": "private, no-store, no-transform",
              "x-accel-buffering": "no",
              "x-content-type-options": "nosniff"
            }
          })
        ),
        Effect.catch((error) => Effect.succeed(RuntimeApi.failure(error)))
      )
    );
  })
);
