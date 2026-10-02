/**
 * One request wide event for every server request outside the runtime path.
 *
 * Effect's router matches the route inside global middleware, so the event
 * opens in route middleware (`layer`), where the matched template is known.
 * Runtime routes open their own events and health probes open none. The API
 * guard answers some requests before the router; it records those through
 * `make`, under the API fallback's pattern.
 *
 * The outcome is what the client received, not the exit: handlers answer
 * typed refusals as responses. A 4xx is `refused` with its body's `code`, a
 * 5xx or a defect is `failure`, and an interruption stays `interrupted`.
 * Events name the template, never the URL, and read no request body.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WideEvents from "@patchy/analytics/wide-events";
import { PatchId } from "@patchy/api";

/** Probes poll these from several places; their traffic would swamp the stream and say nothing. */
const healthProbes = new Set(["/healthz"]);

/** A refusal body's code: snake_case, so nothing a client sent can ride along. */
const decodeCode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/)) })
  )
);
const isPatchId = Schema.is(PatchId);
const text = new TextDecoder();

/** The status, body size and outcome of the response the client received. */
const answered = (response: HttpServerResponse.HttpServerResponse): WideEvents.EventFields => {
  const { body, status } = response;
  const responseBytes = body._tag === "Empty" ? 0 : body.contentLength;
  const fields = { status, ...(responseBytes === undefined ? {} : { responseBytes }) };
  if (status < 400) return fields;
  const code =
    body._tag === "Uint8Array" && body.contentType.includes("json")
      ? Option.getOrUndefined(decodeCode(text.decode(body.body)))?.code
      : undefined;
  return {
    ...fields,
    outcome: status < 500 ? "refused" : "failure",
    ...(code === undefined ? {} : { code })
  };
};

/** Wraps a response in its request event, under `route`. Built once with the middleware. */
export const make = Effect.map(
  WideEvents.WideEvents,
  (events) =>
    <E, R>(route: string, app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
        const declared = request.headers["content-length"];
        return events.withEvent(
          {
            type: "request",
            route,
            method: request.method,
            ...(declared !== undefined && /^\d+$/.test(declared)
              ? { requestBytes: Number(declared) }
              : {})
          },
          app.pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? WideEvents.enrich(answered(exit.value))
                : // The server answers an unhandled cause with this response, a 500 for a defect.
                  Effect.flatMap(HttpServerError.causeResponse(exit.cause), ([response]) =>
                    WideEvents.enrich({ status: response.status })
                  )
            )
          )
        );
      })
);

/**
 * The route middleware, provided to every route layer. A route whose template
 * names `:patchId` records it; handlers that resolve a patch by name add it.
 */
export const layer = HttpRouter.middleware(
  Effect.map(
    make,
    (record) => (app) =>
      Effect.flatMap(HttpRouter.RouteContext, ({ route, params }) =>
        route.path.startsWith("/api/runtime/") || healthProbes.has(route.path)
          ? app
          : record(
              route.path,
              isPatchId(params.patchId)
                ? Effect.andThen(WideEvents.enrich({ patchId: params.patchId }), app)
                : app
            )
      )
  )
).layer;
