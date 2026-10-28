import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Source from "../attio/Source.js";

/**
 * Attio for offline tests: the production Attio source over an injected HTTP client that answers
 * in-process, in the shapes Attio's API answered the probe with (hand-written, never its output).
 * The host, redirects, body bounds and gates stay production code; nothing reaches the network.
 */

export interface Request {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
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
const refusal = (status: number, type: string, code: string, message: string) =>
  json(status, { status_code: status, type, code, message });

export interface Option {
  readonly title: string;
  readonly archived?: boolean;
}
export interface Attribute {
  readonly id: string;
  readonly slug: string | null;
  readonly title?: string;
  readonly type: string;
  readonly multiselect?: boolean;
  readonly archived?: boolean;
  /** A record reference's allowed objects, by id. */
  readonly targets?: ReadonlyArray<string>;
  readonly options?: ReadonlyArray<Option>;
}
export interface Container {
  readonly id: string;
  readonly slug: string | null;
  readonly name?: string;
  readonly attributes: ReadonlyArray<Attribute>;
}
export interface List extends Container {
  /** Parent objects as Attio names them: slugs, or ids for legacy lists. */
  readonly parents: ReadonlyArray<string>;
}
export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly objects: ReadonlyArray<Container>;
  readonly lists: ReadonlyArray<List>;
}
export interface Key {
  readonly token: string;
  readonly workspace: Workspace;
  readonly scopes: ReadonlyArray<string>;
  readonly level?: string;
  /** `/v2/self`'s whole answer, replacing the one this key would get. */
  readonly self?: unknown;
}

/** A read key as Attio's token page makes one with Read on what Patchy needs. */
export const readScopes = [
  "record_permission:read",
  "object_configuration:read",
  "list_entry:read",
  "list_configuration:read",
  "user_management:read"
] as const;

const attribute = (container: string, item: Attribute) => ({
  id: { workspace_id: "ws", object_id: container, attribute_id: item.id },
  title: item.title ?? item.slug ?? item.id,
  description: null,
  api_slug: item.slug,
  type: item.type,
  is_system_attribute: false,
  is_writable: true,
  is_required: false,
  is_unique: false,
  is_multiselect: item.multiselect ?? false,
  is_default_value_enabled: false,
  is_archived: item.archived ?? false,
  default_value: null,
  relationship: null,
  created_at: "2026-10-27T23:30:45.453000000Z",
  config: {
    currency: { default_currency_code: null, display_type: null },
    record_reference: { allowed_object_ids: item.targets ?? null }
  }
});

/** A workspace answering its keys; `/v2/self` answers any other key as Attio does. */
export const workspace =
  (...keys: ReadonlyArray<Key>): Handler =>
  (request) => {
    const token = request.authorization?.replace(/^Bearer /, "");
    const key = keys.find((item) => item.token === token);
    const path = request.url.pathname;
    if (path === "/v2/self") {
      if (key === undefined)
        return token !== undefined && /^[0-9a-f]{64}$/.test(token)
          ? json(200, { active: false })
          : refusal(
              400,
              "invalid_request_error",
              "missing_value",
              "Token was not recognised, please check your token and try again."
            );
      if (key.self !== undefined) return json(200, key.self);
      return json(200, {
        active: true,
        scope: key.scopes.join(" "),
        client_id: "client",
        token_type: "Bearer",
        exp: null,
        iat: 1_793_000_000,
        sub: key.workspace.id,
        aud: "client",
        iss: "attio.com",
        token_level: key.level ?? "workspace",
        authorized_by_workspace_member_id: "member",
        workspace_id: key.workspace.id,
        workspace_name: key.workspace.name,
        workspace_slug: key.workspace.slug,
        workspace_logo_url: null
      });
    }
    if (key === undefined)
      return refusal(
        401,
        "auth_error",
        "unauthorized",
        "The API Key provided could not be found. It may have been revoked."
      );
    const { workspace } = key;
    const denied = (scope: string) =>
      key.scopes.includes(scope)
        ? undefined
        : refusal(403, "auth_error", "unauthorized", `This request requires scopes: ${scope}.`);
    if (path === "/v2/objects")
      return (
        denied("object_configuration:read") ??
        json(200, {
          data: workspace.objects.map((object) => ({
            id: { workspace_id: workspace.id, object_id: object.id },
            api_slug: object.slug,
            singular_noun: object.name ?? null,
            plural_noun: object.name ?? null,
            created_at: "2026-10-27T23:30:45.453000000Z"
          }))
        })
      );
    if (path === "/v2/lists")
      return (
        denied("list_configuration:read") ??
        json(200, {
          data: workspace.lists.map((list) => ({
            id: { workspace_id: workspace.id, list_id: list.id },
            api_slug: list.slug,
            name: list.name ?? null,
            parent_object: list.parents,
            workspace_access: "full-access",
            workspace_member_access: [],
            created_by_actor: { type: "system", id: null },
            created_at: "2026-10-27T23:30:45.453000000Z"
          }))
        })
      );
    const match =
      /^\/v2\/(objects|lists)\/([^/]+)\/attributes(?:\/([^/]+)\/(options|statuses))?$/.exec(path);
    if (match === null) return refusal(404, "invalid_request_error", "not_found", "Not found.");
    const [, kind, id, attributeId, choices] = match;
    const scope = kind === "objects" ? "object_configuration:read" : "list_configuration:read";
    const container = (kind === "objects" ? workspace.objects : workspace.lists).find(
      (item) => item.id === id || item.slug === id
    );
    if (container === undefined)
      return (
        denied(scope) ??
        refusal(
          404,
          "invalid_request_error",
          "not_found",
          "Either the List/Object/Activity does not exist or you do not have permission to access it."
        )
      );
    const refused = denied(scope);
    if (refused !== undefined) return refused;
    if (attributeId !== undefined) {
      const found = container.attributes.find((item) => item.id === attributeId);
      if (found === undefined)
        return refusal(404, "invalid_request_error", "not_found", "Attribute not found.");
      const showArchived = request.url.searchParams.get("show_archived") === "true";
      return json(200, {
        data: (found.options ?? [])
          .filter((option) => showArchived || option.archived !== true)
          .map((option, index) => ({
            id: {
              workspace_id: workspace.id,
              object_id: container.id,
              attribute_id: found.id,
              [choices === "statuses" ? "status_id" : "option_id"]: `${found.id}-${index}`
            },
            title: option.title,
            is_archived: option.archived ?? false,
            ...(choices === "statuses"
              ? { target_time_in_status: null, celebration_enabled: false }
              : {})
          }))
      });
    }
    const showArchived = request.url.searchParams.get("show_archived") === "true";
    const all = container.attributes.filter((item) => showArchived || item.archived !== true);
    const limit = Number(request.url.searchParams.get("limit") ?? String(all.length));
    const offset = Number(request.url.searchParams.get("offset") ?? "0");
    return json(200, {
      data: all.slice(offset, offset + limit).map((item) => attribute(container.id, item))
    });
  };

/** The production source over `handler`; `requests` records every call it received. */
export const make = (handler: Handler) => {
  const requests: Request[] = [];
  const http = HttpClient.make((request, url) =>
    Effect.promise(async () => {
      const recorded: Request = {
        method: request.method,
        url: new URL(url),
        authorization: request.headers.authorization
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

/** A small CRM in the probe's shapes: companies, people, deals and a pipeline on deals. */
export const acme: Workspace = {
  id: "ws-acme",
  name: "Acme",
  slug: "acme",
  objects: [
    {
      id: "obj-companies",
      slug: "companies",
      name: "Companies",
      attributes: [
        { id: "att-c-name", slug: "name", title: "Name", type: "text" },
        {
          id: "att-c-domains",
          slug: "domains",
          title: "Domains",
          type: "domain",
          multiselect: true
        },
        {
          id: "att-c-old",
          slug: "legacy_score",
          title: "Legacy score",
          type: "number",
          archived: true
        }
      ]
    },
    {
      id: "obj-people",
      slug: "people",
      name: "People",
      attributes: [
        { id: "att-p-name", slug: "name", title: "Name", type: "personal-name" },
        {
          id: "att-p-email",
          slug: "email_addresses",
          title: "Email addresses",
          type: "email-address",
          multiselect: true
        },
        {
          id: "att-p-company",
          slug: "company",
          title: "Company",
          type: "record-reference",
          targets: ["obj-companies"]
        }
      ]
    },
    {
      id: "obj-deals",
      slug: "deals",
      name: "Deals",
      attributes: [
        { id: "att-d-name", slug: "name", title: "Deal name", type: "text" },
        {
          id: "att-d-stage",
          slug: "stage",
          title: "Deal stage",
          type: "status",
          options: [
            { title: "Lead" },
            { title: "In Progress" },
            { title: "Won 🎉" },
            { title: "Lost" },
            { title: "Stalled", archived: true }
          ]
        },
        { id: "att-d-owner", slug: "owner", title: "Deal owner", type: "actor-reference" },
        { id: "att-d-value", slug: "value", title: "Deal value", type: "currency" },
        {
          id: "att-d-segment",
          slug: "segment",
          title: "Segment",
          type: "select",
          multiselect: true,
          options: [{ title: "Enterprise" }, { title: "SMB" }]
        },
        {
          id: "att-d-company",
          slug: "associated_company",
          title: "Associated company",
          type: "record-reference",
          targets: ["obj-companies", "obj-disabled"]
        },
        { id: "att-d-future", slug: "forecast", title: "Forecast", type: "ai-forecast" }
      ]
    },
    { id: "obj-hidden", slug: null, name: "Workspace hidden", attributes: [] }
  ],
  lists: [
    {
      id: "lst-pipeline",
      slug: "pipeline",
      name: "Pipeline",
      parents: ["deals"],
      attributes: [
        {
          id: "att-l-stage",
          slug: "stage",
          title: "Stage",
          type: "status",
          options: [{ title: "Qualify" }, { title: "Close" }]
        },
        { id: "att-l-entered", slug: "entered_on", title: "Entered on", type: "date" }
      ]
    },
    { id: "lst-orphan", slug: "orphans", name: "Orphans", parents: ["obj-gone"], attributes: [] },
    { id: "lst-noslug", slug: null, name: "Untitled", parents: ["people"], attributes: [] }
  ]
};

/** A read key for `acme` with every scope Attio's token page offers at Read. */
export const readKey: Key = {
  token: "a".repeat(64),
  workspace: acme,
  scopes: [...readScopes, "note:read", "task:read", "comment:read", "webhook:read", "file:read"]
};
