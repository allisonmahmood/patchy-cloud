/**
 * The seam between the Fastify app and the ported capability packages. The
 * server builds one `ManagedRuntime` over the layer stack in `start.ts`;
 * the adapters below are the only places the app runs an Effect. Deleted by
 * the PR that moves the app itself onto HttpApi.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { Analytics } from "@patchy/analytics";
import { AuthApi, Tokens } from "@patchy/auth";
import { Limits } from "@patchy/limits";
import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The `auth` API group as one request handler, built once with the runtime
 * so its handlers share the same tokens, limiter and analytics as the app.
 */
export class AuthApiHandler extends Context.Service<
  AuthApiHandler,
  Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    Scope.Scope | HttpServerRequest.HttpServerRequest
  >
>()("@patchy/server/runtime/AuthApiHandler") {}

/** The auth group's routes as one handler; a routing failure is a defect here, not a response. */
const make = Effect.map(HttpRouter.toHttpEffect(AuthApi.routes), Effect.orDie);

export interface LayerOptions {
  /** Tokens over the store the caller opened. */
  readonly tokens: Layer.Layer<Tokens.Tokens, ConfigError | SqlError>;
  /** Defaults to reporting when a PostHog key is configured; a test brings its own. */
  readonly analytics?: Layer.Layer<Analytics.Analytics, ConfigError>;
}

/**
 * What the app runs on: analytics, the in-memory limiter, tokens, and the
 * auth group's handler over all three.
 */
export const layer = ({ analytics = Analytics.layer, tokens }: LayerOptions) => {
  const services = Layer.mergeAll(analytics, Limits.layer, tokens);
  return Layer.merge(services, Layer.effect(AuthApiHandler, make).pipe(Layer.provide(services)));
};

export type ServerRuntime = ManagedRuntime.ManagedRuntime<
  Analytics.Analytics | Limits.Limits | Tokens.Tokens | AuthApiHandler,
  never
>;

/** Spends one attempt of a rate limit; see `Limits.consume`. */
export function consume(
  runtime: ServerRuntime,
  options: Limits.ConsumeOptions
): Promise<Limits.ConsumeResult> {
  return runtime.runPromise(Effect.flatMap(Limits.Limits, (limits) => limits.consume(options)));
}

/** The identity a plaintext token resolves to, or `null`; see `Tokens.authenticate`. */
export function authenticate(runtime: ServerRuntime, token: string) {
  return runtime.runPromise(
    Effect.flatMap(Tokens.Tokens, (tokens) => tokens.authenticate(token)).pipe(
      Effect.map(Option.getOrNull)
    )
  );
}

/**
 * Reports one event. Fire-and-forget: it never throws, never returns a
 * promise, and must never be awaited. Callers hand it what happened and
 * carry on answering the request.
 */
export function track(runtime: ServerRuntime, event: Analytics.AnalyticsEvent): void {
  runtime.runFork(Effect.flatMap(Analytics.Analytics, (analytics) => analytics.track(event)));
}

/**
 * Answers a request from the `auth` group's handlers. Fastify has already
 * parsed the body, so it is put back on the wire as JSON; the source address
 * it attributed (proxy trust applied) rides as the request's remote address.
 */
export async function serveAuthApi(
  runtime: ServerRuntime,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  const serverRequest = HttpServerRequest.fromWeb(
    new Request(new URL(request.url, "http://localhost"), {
      method: request.method,
      headers,
      body
    })
  ).modify({ remoteAddress: Option.some(request.ip) });

  const response = await runtime.runPromise(
    Effect.flatMap(AuthApiHandler, (handle) => handle).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
      Effect.scoped
    )
  );

  const web = HttpServerResponse.toWeb(response);
  reply.status(web.status);
  web.headers.forEach((value, name) => reply.header(name, value));
  return reply.send(await web.text());
}
