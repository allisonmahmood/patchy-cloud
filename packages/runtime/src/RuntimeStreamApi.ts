import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { PatchyApi } from "@patchy/api";
import { Session } from "@patchy/auth";
import { newInternalId } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import * as RuntimeApi from "./RuntimeApi.js";
import * as RuntimeStream from "./RuntimeStream.js";
import * as Runtime from "./Runtime.js";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isTooLarge = Schema.is(Runtime.TooLarge);

const layerFor = (secure: boolean) =>
  HttpApiBuilder.group(PatchyApi, "runtimeStream", (handlers) =>
    Effect.gen(function* () {
      const streams = yield* RuntimeStream.RuntimeStream;
      const affinity = newInternalId("replica");
      return handlers
        .handleRaw("stream", ({ query }) =>
          streams.open(query).pipe(
            Effect.map((body) =>
              HttpServerResponse.stream(body, {
                contentType: "text/event-stream",
                headers: {
                  "cache-control": "private, no-store, no-transform",
                  "x-accel-buffering": "no",
                  "x-content-type-options": "nosniff"
                }
              }).pipe(
                HttpServerResponse.setCookieUnsafe("patchy_stream_affinity", affinity, {
                  path: "/api/runtime",
                  httpOnly: true,
                  sameSite: "strict",
                  secure
                })
              )
            ),
            Effect.catch((error) => Effect.succeed(RuntimeApi.failure(error)))
          )
        )
        .handleRaw("subscriptions", () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const callBytes = yield* ContractLimits.get("runtime.call.bytes");
            const serverArgsBytes = yield* ContractLimits.get("tier2.args.bytes");
            const documents = yield* ContractLimits.get("subscriptions.document");
            const maxBytes = (callBytes + serverArgsBytes) * documents + callBytes;
            let size = 0;
            let text = "";
            const decoder = new TextDecoder();
            yield* Stream.runForEach(request.stream, (chunk) =>
              Effect.gen(function* () {
                size += chunk.byteLength;
                if (size > maxBytes)
                  return yield* new Runtime.TooLarge({
                    maxBytes,
                    limitId: "runtime.call.bytes"
                  });
                text += decoder.decode(chunk, { stream: true });
              })
            ).pipe(
              Effect.mapError((cause) =>
                isTooLarge(cause) ? cause : new Runtime.InvalidRequest({ cause })
              )
            );
            text += decoder.decode();
            const input = yield* decodeJson(text).pipe(
              Effect.mapError((cause) => new Runtime.InvalidRequest({ cause }))
            );
            yield* streams.update(input);
            return HttpServerResponse.jsonUnsafe(
              { ok: true },
              {
                headers: { "cache-control": "no-store" }
              }
            );
          }).pipe(Effect.catch((error) => Effect.succeed(RuntimeApi.failure(error))))
        );
    })
  );

export const layer = Layer.unwrap(
  Effect.map(Session.Session, (session) =>
    layerFor(new URL(session.publicBaseUrl).protocol === "https:")
  )
);

/** Local admission has fixed viewer identities, not a Clerk session service. */
export const layerLocal = layerFor(false);
