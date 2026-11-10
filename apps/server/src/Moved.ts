/**
 * Pages that moved, and where they went: Your agents left `/machines` for `/agents`, and company
 * management left `/company` for `/settings`. Shipped skills, CLI releases, receipts in people's
 * mail and bookmarks carry the old URLs, so they keep working for good.
 *
 * Each move names one old route exactly, with the methods it answered. A GET answers 308 with the
 * new URL and the request's query; a browser keeps the URL's fragment across it on its own, so the
 * new pages keep the old fragments' ids. A POST, from a form left open across the move, is served
 * by the new route itself, so it passes every check that route makes. Any other URL under the old
 * prefixes stays a 404.
 *
 * Two pieces: `routes`, the GET redirects, recorded under their old templates like any route; and
 * `rewrite`, the global middleware that hands an old POST to the router under its new URL.
 */
import * as Effect from "effect/Effect";
import * as FindMyWay from "effect/http/FindMyWay";
import type * as Layer from "effect/Layer";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Pages } from "@patchy/serving";

/** One old route: its template, the new route's, and the methods the old one answered. */
export interface Move {
  readonly from: `/${string}`;
  readonly to: `/${string}`;
  readonly methods: ReadonlyArray<"GET" | "POST">;
}

const move = (from: Move["from"], to: Move["to"], ...methods: Move["methods"]): Move => ({
  from,
  to,
  methods
});

/** A connection's acts that post straight away, and those that confirm on their own page first. */
const connectionActs = ["test", "refresh", "reconnect", "block-guests", "allow-guests"] as const;
const connectionConfirmations = [
  "rotate",
  "retarget",
  "access",
  "description",
  "disconnect",
  "delete"
] as const;

/** Every old route, as the last release before the move registered it. */
export const moves: ReadonlyArray<Move> = [
  move("/machines", "/agents", "GET"),
  move("/machines/revoke-all", "/agents/disconnect-all", "GET", "POST"),
  move("/machines/:id/revoke", "/agents/computers/:id/disconnect", "POST"),
  move("/machines/agents/:id/disconnect", "/agents/apps/:id/disconnect", "POST"),
  move("/settings", "/settings/people", "GET"),
  move("/company", "/settings/people", "GET"),
  move("/company/invites", "/settings/people/invites", "POST"),
  move("/company/invites/:id/revoke", "/settings/people/invites/:id/revoke", "POST"),
  move("/company/invites/:id/resend", "/settings/people/invites/:id/resend", "POST"),
  move("/company/users/:id/role", "/settings/people/users/:id/role", "POST"),
  move("/company/users/:id/deactivate", "/settings/people/users/:id/deactivate", "GET", "POST"),
  move("/company/users/:id/reactivate", "/settings/people/users/:id/reactivate", "GET", "POST"),
  move("/company/guests/:id/remove", "/settings/people/guests/:id/remove", "GET", "POST"),
  move("/company/agent-access", "/settings/agent-access", "GET", "POST"),
  move("/company/connections", "/settings/integrations", "GET"),
  move("/company/connections/connect", "/settings/integrations/connect", "GET"),
  move(
    "/company/connections/connect/:integration",
    "/settings/integrations/connect/:integration",
    "GET",
    "POST"
  ),
  move(
    "/company/connections/connect/pidgeon/addresses",
    "/settings/integrations/connect/pidgeon/addresses",
    "POST"
  ),
  move("/company/connections/:id", "/settings/integrations/:id", "GET"),
  ...connectionActs.map((act) =>
    move(`/company/connections/:id/${act}`, `/settings/integrations/:id/${act}`, "POST")
  ),
  ...connectionConfirmations.map((act) =>
    move(`/company/connections/:id/${act}`, `/settings/integrations/:id/${act}`, "GET", "POST")
  )
];

/**
 * The old routes as Effect's router finds them, under its default rules, which the server keeps:
 * a path matches whatever its letter case, trailing slash, repeated slashes or percent-encoding,
 * as it did before the move, and a static segment wins over a parameter.
 */
const old = FindMyWay.make<Move>();
for (const candidate of moves) old.on(candidate.methods, candidate.from, candidate);

/** A query's raw pairs, with each key as a page reads it. */
const pairs = (query: string) =>
  query === ""
    ? []
    : query.split("&").map((raw) => ({ raw, key: [...new URLSearchParams(raw).keys()][0] }));

/**
 * `/machines?agent=<app>` opened that app's steps, which are Connect an app's now, read from
 * `app`. Its first `agent` was the one shown, so every `agent` becomes an `app` and any `app` it
 * carried goes; the rest of the query stays as it was sent.
 */
const connectApp = (query: string) => {
  const kept = pairs(query).flatMap(({ raw, key }) =>
    key === "app"
      ? []
      : [key === "agent" ? `app${raw.includes("=") ? raw.slice(raw.indexOf("=")) : ""}` : raw]
  );
  return `/agents/connect?${kept.join("&")}`;
};

/**
 * Where a request target for an old route goes now, as a path and the query as it was sent, or
 * `undefined` for one no move names under that method.
 */
export const target = (method: string, url: string): string | undefined => {
  const found = old.find(method, url);
  if (found === undefined) return undefined;
  const at = url.indexOf("?");
  const query = at === -1 ? "" : url.slice(at + 1);
  if (found.handler.from === "/machines" && pairs(query).some(({ key }) => key === "agent"))
    return connectApp(query);
  const path = found.handler.to.replace(/:(\w+)/g, (_, name: string) =>
    encodeURIComponent(found.params[name] ?? "")
  );
  return query === "" ? path : `${path}?${query}`;
};

/** The request's target in origin form, as the router reads it. */
const requestTarget = (request: HttpServerRequest.HttpServerRequest) => {
  if (request.url.startsWith("/")) return request.url;
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
};

const redirect = Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
  const location = target("GET", requestTarget(request));
  return location === undefined
    ? Pages.notFound
    : HttpServerResponse.redirect(location, { status: 308 });
});

/** The old GET routes, each answering 308 to its new URL. */
export const routes: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.use((router) =>
  Effect.forEach(
    moves.filter((candidate) => candidate.methods.includes("GET")),
    (candidate) => router.add("GET", candidate.from, redirect),
    { discard: true }
  )
);

/** Hands an old POST to the router under its new URL, before the router matches a route. */
export const rewrite = HttpMiddleware.make((app) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const location = request.method === "POST" ? target("POST", requestTarget(request)) : undefined;
    return location === undefined
      ? app
      : Effect.provideService(
          app,
          HttpServerRequest.HttpServerRequest,
          request.modify({ url: location })
        );
  })
);
