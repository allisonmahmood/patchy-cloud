/**
 * The seam between the Fastify app and the ported capability packages. The
 * server builds one `ManagedRuntime` over the layer stack in `start.ts`;
 * the adapters below are the only places the app runs an Effect. Deleted by
 * the PR that moves the app itself onto HttpApi.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { Analytics } from "@patchy/analytics";
import { PatchyApi } from "@patchy/api";
import { AuthApi, Authorization, Tokens } from "@patchy/auth";
import { ContentStore } from "@patchy/content-store";
import { Limits } from "@patchy/limits";
import { Content, ExpirySweep, Patches, PatchesApi } from "@patchy/patches";
import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * The whole `/api/*` contract as one request handler, built once with the
 * runtime so its handlers share the same services as the app.
 */
export class ApiHandler extends Context.Service<
  ApiHandler,
  Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    Scope.Scope | HttpServerRequest.HttpServerRequest
  >
>()("@patchy/server/runtime/ApiHandler") {}

/** Both groups' routes, bearer middleware bound, as one router layer. */
const routes = HttpApiBuilder.layer(PatchyApi).pipe(
  Layer.provide([AuthApi.layer, PatchesApi.layer]),
  Layer.provide(Authorization.layer),
  Layer.provide(HttpServer.layerServices)
);

/** The API's routes as one handler; a routing failure is a defect here, not a response. */
const make = Effect.map(HttpRouter.toHttpEffect(routes), Effect.orDie);

export interface LayerOptions {
  /** The Postgres client every capability's rows live in. */
  readonly sql: Layer.Layer<SqlClient.SqlClient, ConfigError | SqlError>;
  /** Where a patch's bytes go: the filesystem layer, or Azure when its config is present. */
  readonly contentStore: Layer.Layer<ContentStore.ContentStore, ConfigError>;
  /** Defaults to reporting when a PostHog key is configured; a test brings its own. */
  readonly analytics?: Layer.Layer<Analytics.Analytics, ConfigError>;
}

/**
 * What the app runs on: analytics, the in-memory limiter, tokens, patches
 * and the content store, and the API handler over all of them.
 */
export const layer = ({ analytics = Analytics.layer, contentStore, sql }: LayerOptions) => {
  const services = Layer.mergeAll(Content.layer, ExpirySweep.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(analytics, Limits.layer, contentStore, Tokens.layer, Patches.layer)
    ),
    Layer.provide(sql)
  );
  return Layer.merge(services, Layer.effect(ApiHandler, make).pipe(Layer.provide(services)));
};

/** Every service the runtime holds. */
export type ServerServices =
  | Analytics.Analytics
  | Limits.Limits
  | Tokens.Tokens
  | ContentStore.ContentStore
  | Patches.Patches
  | Content.Content
  | ExpirySweep.ExpirySweep
  | ApiHandler;

export type ServerRuntime = ManagedRuntime.ManagedRuntime<ServerServices, never>;

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

/** A patch in service with its current or numbered version and HTML, or `null`; see `Content.read`. */
export function readPatch(
  runtime: ServerRuntime,
  patchId: string,
  versionNumber?: number
): Promise<Content.Served | null> {
  return runtime.runPromise(
    Effect.flatMap(Content.Content, (content) => content.read(patchId, versionNumber)).pipe(
      Effect.map(Option.getOrNull)
    )
  );
}

/** Tops a served patch's retention clock up, when a visit does; see `Patches.recordVisit`. */
export function recordVisit(runtime: ServerRuntime, patchId: string): Promise<void> {
  return runtime.runPromise(
    Effect.flatMap(Patches.Patches, (patches) => patches.recordVisit(patchId))
  );
}

/** One run of the expiry sweep; see `ExpirySweep.sweep`. */
export function sweepExpiredPatches(runtime: ServerRuntime): Promise<ExpirySweep.SweepResult> {
  return runtime.runPromise(Effect.flatMap(ExpirySweep.ExpirySweep, (sweep) => sweep.sweep));
}

/**
 * Answers a request from the API's handlers. Fastify has already parsed the
 * body, so it is put back on the wire as JSON — an absent one on a write as
 * `{}`, since every payload the contract takes has only optional fields and
 * the Fastify routes have already refused what does not decode; the source
 * address it attributed (proxy trust applied) rides as the request's remote
 * address.
 */
export async function serveApi(
  runtime: ServerRuntime,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === "content-length") continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const write = request.method === "POST" || request.method === "PUT" || request.method === "PATCH";
  const body = write ? JSON.stringify(request.body ?? {}) : undefined;
  if (write) headers.set("content-type", "application/json");
  const serverRequest = HttpServerRequest.fromWeb(
    new Request(new URL(request.url, "http://localhost"), {
      method: request.method,
      headers,
      body
    })
  ).modify({ remoteAddress: Option.some(request.ip) });

  const response = await runtime.runPromise(
    Effect.flatMap(ApiHandler, (handle) => handle).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
      Effect.scoped
    )
  );

  const web = HttpServerResponse.toWeb(response);
  reply.status(web.status);
  web.headers.forEach((value, name) => reply.header(name, value));
  return reply.send(await web.text());
}
