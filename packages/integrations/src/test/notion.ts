import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Source from "../notion/Source.js";

export const internalToken = "notion-test-internal";
export const personalToken = "notion-test-pat";

const workspaceId = "58fe1df4-672b-418f-865e-b3ff941242ef";
const tasksId = "3a261add-da2a-4d6e-a243-4970abf59591";
const projectsId = "598bdfa9-43af-45f3-89a9-bc35aa6065fc";
const tasksDatabaseId = "d52c7f07-76a5-4f6f-b33d-88d496058f41";
const projectsDatabaseId = "8bc41a73-5c04-4d52-9dae-893eacb959cc";
const cursor = "another-data-source";
const title = (name: string) => [{ plain_text: name }];
const source = (
  id: string,
  name: string,
  databaseId: string,
  properties: Record<string, unknown>
) => ({
  object: "data_source",
  id,
  title: title(name),
  parent: { type: "database_id", database_id: databaseId },
  properties: { Name: { id: "title", name: "Name", type: "title", title: {} }, ...properties }
});
const tasks = source(tasksId, "Tasks", tasksDatabaseId, {
  Status: {
    id: "STs",
    name: "Status",
    type: "status",
    status: {
      options: [
        { id: "todo", name: "To do" },
        { id: "done", name: "Done" }
      ],
      groups: [
        { id: "todo-group", name: "To do", option_ids: ["todo"] },
        { id: "done-group", name: "Complete", option_ids: ["done"] }
      ]
    }
  },
  Project: {
    id: "proj",
    name: "Project",
    type: "relation",
    relation: { data_source_id: projectsId, type: "single_property", single_property: {} }
  },
  "Internal project": {
    id: "intr",
    name: "Internal project",
    type: "relation",
    relation: {
      data_source_id: "d8dda6aa-1ddb-43a8-abdb-d7286ea75ca8",
      type: "single_property",
      single_property: {}
    }
  },
  "Days open": {
    id: "days",
    name: "Days open",
    type: "formula",
    formula: { expression: "0" }
  }
});
const projects = source(projectsId, "Projects", projectsDatabaseId, {});
const databases = new Map([
  [tasksDatabaseId, "Project Tracker"],
  [projectsDatabaseId, "Project Portfolio"]
]);
const decodeSearch = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      filter: Schema.Struct({
        property: Schema.Literal("object"),
        value: Schema.Literal("data_source")
      }),
      page_size: Schema.Number,
      start_cursor: Schema.optionalKey(Schema.String)
    })
  )
);
const decoder = new TextDecoder();

/** An offline Notion response, used by integration tests and the dev scenario. */
const reply = (url: URL, method: string, headers: Headers, body: string | undefined) => {
  const respond = (body: unknown, status = 200) => Response.json(body, { status });
  const refuse = (status: number, code: string) =>
    respond({ object: "error", status, code }, status);
  const authorization = headers.get("authorization");
  const isPersonal = authorization === `Bearer ${personalToken}`;
  if (authorization !== `Bearer ${internalToken}` && !isPersonal)
    return refuse(401, "unauthorized");
  if (url.origin !== "https://api.notion.com" || headers.get("notion-version") !== "2026-03-11")
    return refuse(400, "invalid_request");
  if (method === "GET" && url.pathname === "/v1/users/me")
    return respond({
      object: "user",
      type: "bot",
      id: isPersonal
        ? "43a8babc-b582-4a97-b5ec-3274552f6ac7"
        : "a0955069-c85c-4497-bd27-978f5519b4b0",
      bot: {
        owner: { type: isPersonal ? "user" : "workspace" },
        workspace_id: workspaceId,
        workspace_name: isPersonal ? null : "Notion Probe"
      }
    });
  if (isPersonal) return refuse(403, "restricted_resource");
  if (method === "POST" && url.pathname === "/v1/search" && body !== undefined) {
    const search = decodeSearch(body);
    if (search._tag === "Some" && search.value.start_cursor === undefined)
      return respond({ object: "list", results: [tasks], has_more: true, next_cursor: cursor });
    if (search._tag === "Some" && search.value.start_cursor === cursor)
      return respond({ object: "list", results: [projects], has_more: false, next_cursor: null });
    return refuse(400, "validation_error");
  }
  if (method === "GET" && url.pathname.startsWith("/v1/databases/")) {
    const id = url.pathname.split("/").at(-1);
    const name = id && databases.get(id);
    if (id && name)
      return respond({
        object: "database",
        id,
        title: title(name),
        url: `https://app.notion.com/p/${id.replaceAll("-", "")}`
      });
  }
  return refuse(404, "object_not_found");
};

const client = HttpClient.make((request, url) =>
  Effect.sync(() =>
    HttpClientResponse.fromWeb(
      request,
      reply(
        url,
        request.method,
        new Headers(request.headers),
        request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : undefined
      )
    )
  )
);

/** In the disposable dev server, only Notion requests are intercepted. */
export const makeFetch =
  (fallback: typeof fetch): typeof fetch =>
  async (input, init) => {
    const url = URL.parse(input instanceof Request ? input.url : input);
    if (url?.origin !== "https://api.notion.com") return fallback(input, init);
    const request = new Request(input, init);
    return reply(
      url,
      request.method,
      request.headers,
      request.body === null ? undefined : await request.text()
    );
  };

export const layer = Layer.effect(Source.Source, Source.make).pipe(
  Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
);
