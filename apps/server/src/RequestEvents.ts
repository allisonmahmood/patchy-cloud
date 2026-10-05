/**
 * One request wide event for every server request outside the runtime path.
 *
 * Effect's router matches the route inside global middleware, so the event
 * opens in route middleware (`layer`), where the matched template is known.
 * Runtime routes open their own events and health probes open none. The API
 * guard answers some requests before the router; it records those through
 * `make`, under the API fallback's pattern. `edge`, outside every other
 * middleware, keeps the method the client sent and records a target the
 * router cannot look up at all.
 *
 * The outcome is what the client received, not the exit: handlers answer
 * typed refusals as responses, and the server answers a failed exit, such as
 * a request that does not decode, with a response of its own. A 2xx or 3xx is
 * `success`, a 4xx is `refused` with its body's `code`, a 5xx is `failure`,
 * and an interruption stays `interrupted`. Events name the template, never
 * the URL, and read no request body.
 *
 * A `patchy` CLI request names its release, command and coding agent in its
 * `Patchy-Cli` header. The fields that parse ride on the event, and the
 * release and agent reach the request's business events through
 * `Analytics.CurrentCli`.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Analytics } from "@patchy/analytics";
import * as WideEvents from "@patchy/analytics/wide-events";
import { PATCHY_CLI_HEADER, PatchId, parsePatchyCli } from "@patchy/api";

/** Probes poll these from several places; their traffic would swamp the stream and say nothing. */
const healthProbes = new Set(["/healthz", "/healthz/deep"]);

/** A refusal body's code: snake_case, so nothing a client sent can ride along. */
const decodeCode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/)) })
  )
);
const isPatchId = Schema.is(PatchId);
const text = new TextDecoder();

/** The method the client sent, set by `edge`: Serving answers HEAD as GET before routing. */
const sentMethod = Context.Reference<string | undefined>(
  "@patchy/server/RequestEvents/sentMethod",
  { defaultValue: () => undefined }
);

/** The status, body size and outcome of the response the client received. */
const answered = (
  response: HttpServerResponse.HttpServerResponse,
  method: string
): WideEvents.EventFields => {
  const { body, status } = response;
  // A HEAD response carries the GET response's headers and no body.
  const responseBytes = method === "HEAD" || body._tag === "Empty" ? 0 : body.contentLength;
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

/** The response the server sends for an exit: the route's own, or the one it derives from a cause. */
const received = (
  exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>,
  method: string
) =>
  Exit.isSuccess(exit)
    ? WideEvents.enrich(answered(exit.value, method))
    : Effect.flatMap(HttpServerError.causeResponse(exit.cause), ([response]) =>
        WideEvents.enrich(
          Cause.hasInterrupts(exit.cause)
            ? { status: response.status, outcome: "interrupted" }
            : answered(response, method)
        )
      );

/**
 * Wraps a response in its request event, under `route`. Built once with the
 * middleware. The event closes over the exit, so its outcome follows the
 * response; a failure is raised again outside it, for the server to answer
 * and report as before.
 */
export const make = Effect.map(
  WideEvents.WideEvents,
  (events) =>
    <E, R>(route: string, app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const method = (yield* sentMethod) ?? request.method;
        const declared = request.headers["content-length"];
        const { cliCommand, ...cli } = parsePatchyCli(request.headers[PATCHY_CLI_HEADER]);
        const exit = yield* events.withEvent(
          {
            type: "request",
            route,
            method,
            ...(declared !== undefined && /^\d+$/.test(declared)
              ? { requestBytes: Number(declared) }
              : {}),
            cliCommand,
            ...cli
          },
          // Interrupting the handler must not also skip recording what it answered.
          Effect.uninterruptibleMask((restore) =>
            Effect.exit(restore(app)).pipe(Effect.tap((exit) => received(exit, method)))
          ).pipe(Effect.provideService(Analytics.CurrentCli, cli))
        );
        return yield* exit;
      })
);

const isRouteNotFound = (error: unknown): error is HttpServerError.HttpServerError =>
  HttpServerError.isHttpServerError(error) && error.reason._tag === "RouteNotFound";

/**
 * The server's outermost middleware. It keeps the method the client sent, and
 * records a target the router cannot look up at all, such as one that does not
 * decode, under the page fallback it never reached.
 */
export const edge = Effect.map(make, (record) =>
  HttpMiddleware.make((app) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      app.pipe(
        Effect.catchIf(isRouteNotFound, (error) => record("/*", Effect.fail(error))),
        Effect.provideService(sentMethod, request.method)
      )
    )
  )
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
