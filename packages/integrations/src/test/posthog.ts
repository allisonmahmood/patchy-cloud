import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Source from "../posthog/Source.js";

/**
 * PostHog Cloud for tests: the production PostHog source over an injected HTTP client that
 * answers in-process. Hosts, redirects, body caps and the project gate stay production code;
 * nothing reaches the network, so the fetch guard holds.
 */

export interface Request {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly body: unknown;
}
export type Handler = (request: Request) => Response | Promise<Response>;

export const json = (
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });

export interface Definition {
  readonly name: string;
  readonly description?: string | null;
  readonly property_type?: string | null;
}
export interface Project {
  readonly region: Source.Region;
  readonly id: number;
  readonly key: string;
  readonly events?: ReadonlyArray<Definition>;
  readonly eventProperties?: ReadonlyArray<Definition>;
  readonly personProperties?: ReadonlyArray<Definition>;
  /** Pages smaller than the request asks for, to exercise pagination with few definitions. */
  readonly pageSize?: number;
  /** Answers a HogQL query; the connection test's `SELECT 1` is answered when this is absent. */
  readonly query?: (query: {
    readonly query: string;
    readonly name?: string;
    readonly values?: Readonly<Record<string, unknown>>;
  }) => Response | Promise<Response>;
}

export const rows = (
  columns: ReadonlyArray<readonly [string, string]>,
  results: ReadonlyArray<ReadonlyArray<unknown>>,
  extra: Readonly<Record<string, unknown>> = {}
) =>
  json(200, {
    columns: columns.map(([name]) => name),
    types: columns,
    results,
    hasMore: false,
    ...extra
  });

/** One key per project, as a key limited to one project behaves. */
export const project =
  (...projects: ReadonlyArray<Project>): Handler =>
  async (request) => {
    const found = projects.find(
      (item) =>
        request.authorization === `Bearer ${item.key}` &&
        request.url.origin === Source.hosts[item.region]
    );
    if (found === undefined)
      return json(401, {
        type: "authentication_error",
        code: "authentication_failed",
        detail: "Invalid personal API key.",
        attr: null
      });
    const prefix = `/api/projects/${found.id}/`;
    if (!request.url.pathname.startsWith(prefix))
      return json(403, {
        type: "authentication_error",
        code: "permission_denied",
        detail: "You don't have access to the project.",
        attr: null
      });
    const rest = request.url.pathname.slice(prefix.length);
    if (rest === "query/" && request.method === "POST") {
      const body = request.body as {
        readonly query: {
          readonly query: string;
          readonly name?: string;
          readonly values?: Record<string, unknown>;
        };
      };
      return found.query === undefined ? rows([["1", "UInt8"]], [[1]]) : found.query(body.query);
    }
    const list =
      rest === "event_definitions/"
        ? found.events
        : rest === "property_definitions/"
          ? request.url.searchParams.get("type") === "person"
            ? found.personProperties
            : found.eventProperties
          : undefined;
    if (list === undefined || request.method !== "GET")
      return json(404, {
        type: "invalid_request",
        code: "not_found",
        detail: "Not found.",
        attr: null
      });
    const limit = Math.min(
      Number(request.url.searchParams.get("limit") ?? "100"),
      found.pageSize ?? Number.POSITIVE_INFINITY
    );
    const offset = Number(request.url.searchParams.get("offset") ?? "0");
    const next = new URL(request.url);
    next.searchParams.set("offset", String(offset + limit));
    return json(200, {
      count: list.length,
      next: offset + limit < list.length ? next.href : null,
      previous: null,
      results: list.slice(offset, offset + limit)
    });
  };

/** The production source over `handler`; `requests` records every call it received. */
export const make = (handler: Handler) => {
  const requests: Request[] = [];
  const decoder = new TextDecoder();
  const http = HttpClient.make((request, url) =>
    Effect.promise(async () => {
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(decoder.decode(request.body.body)) as unknown)
          : undefined;
      const recorded: Request = {
        method: request.method,
        url: new URL(url),
        authorization: request.headers.authorization,
        body
      };
      requests.push(recorded);
      return HttpClientResponse.fromWeb(request, await handler(recorded));
    })
  );
  return {
    requests,
    layer: Layer.effect(Source.Source, Source.make).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
    )
  };
};

/** Credentials as the connect form sends them. */
export const credentials = (item: Pick<Project, "region" | "id" | "key">) =>
  Source.credentials({ region: item.region, projectId: item.id, apiKey: item.key });
