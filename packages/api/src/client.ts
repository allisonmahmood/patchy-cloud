/**
 * The client derived from `PatchyApi`. Every method encodes its request and
 * decodes its response through the same schemas the server uses, so a
 * consumer never re-types a wire shape.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { Authorization, PatchyApi } from "./api.js";

/** Puts the bearer token on every request that `Authorization` protects. */
export const authorizationClient = (token: Redacted.Redacted) =>
  HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token))
  );

/**
 * A client for one instance. Needs an `HttpClient` in the environment and,
 * for the protected routes, the layer from `authorizationClient`.
 */
export const makeClient = (apiUrl: string) =>
  HttpApiClient.make(PatchyApi, {
    transformClient: HttpClient.mapRequest(HttpClientRequest.prependUrl(apiUrl))
  });

export type PatchyClient = Effect.Success<ReturnType<typeof makeClient>>;
