import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Source from "../notion/Source.js";

export const internalToken = "notion-test-internal";
export const personalToken = "notion-test-pat";
export const requestOwnerId = "30000000-0000-4000-8000-000000000001";
export const firstRequestId = "20000000-0000-4000-8000-000000000001";

const workspaceId = "58fe1df4-672b-418f-865e-b3ff941242ef";
const tasksId = "3a261add-da2a-4d6e-a243-4970abf59591";
const projectsId = "598bdfa9-43af-45f3-89a9-bc35aa6065fc";
const tasksDatabaseId = "d52c7f07-76a5-4f6f-b33d-88d496058f41";
const projectsDatabaseId = "8bc41a73-5c04-4d52-9dae-893eacb959cc";
const cursor = "another-data-source";
const stamp = "2026-11-01T12:00:00.000Z";
const title = (name: string) => [
  { type: "text", text: { content: name, link: null }, plain_text: name, href: null }
];
const notionUrl = (id: string) => `https://app.notion.com/p/${id.replaceAll("-", "")}`;
const owner = {
  object: "user",
  type: "person",
  id: requestOwnerId,
  name: "Sam Rivera",
  person: { email: "sam@example.test" }
};
const teammate = {
  object: "user",
  type: "person",
  id: "30000000-0000-4000-8000-000000000002",
  name: "Avery Chen",
  person: { email: "avery@example.test" }
};
const page = (id: string, parent: object) => ({
  object: "page",
  id,
  parent,
  url: notionUrl(id),
  created_time: stamp,
  last_edited_time: stamp,
  in_trash: false
});
const source = (
  id: string,
  name: string,
  databaseId: string,
  properties: Record<string, unknown>
) => ({
  object: "data_source",
  id,
  title: title(name),
  last_edited_time: stamp,
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
  Assignee: { id: "who", name: "Assignee", type: "people", people: {} },
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
const task = (id: string, name: string, status: "todo" | "done", assignee: typeof owner) => ({
  ...page(id, { type: "data_source_id", data_source_id: tasksId, database_id: tasksDatabaseId }),
  properties: {
    Name: { id: "title", type: "title", title: title(name) },
    Status: {
      id: "STs",
      type: "status",
      status: { id: status, name: status === "todo" ? "To do" : "Done" }
    },
    Assignee: { id: "who", type: "people", people: [assignee] },
    Project: { id: "proj", type: "relation", relation: [], has_more: false }
  }
});
const tasksRows = [
  task(firstRequestId, "Review signage", "todo", owner),
  task("20000000-0000-4000-8000-000000000002", "Book a studio", "todo", owner),
  task("20000000-0000-4000-8000-000000000003", "Send the brief", "todo", teammate),
  task("20000000-0000-4000-8000-000000000004", "Approve artwork", "done", owner)
];
const taskFilter = Schema.Union([
  Schema.Struct({
    property: Schema.Literal("STs"),
    status: Schema.Struct({ equals: Schema.String })
  }),
  Schema.Struct({
    property: Schema.Literal("who"),
    people: Schema.Struct({ contains: Schema.String })
  })
]);
const decodeQuery = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      page_size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      start_cursor: Schema.optionalKey(Schema.String),
      filter: Schema.optionalKey(
        Schema.Union([taskFilter, Schema.Struct({ and: Schema.Array(taskFilter) })])
      )
    })
  )
);
const list = <T>(results: readonly T[], next: string | null = null) => ({
  object: "list",
  results,
  has_more: next !== null,
  next_cursor: next
});
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

/** Exercises the live adapter against a disposable workspace without a network request. */
const client = HttpClient.make((request, url) =>
  Effect.sync(() => {
    const respond = (body: unknown, status = 200) =>
      HttpClientResponse.fromWeb(request, Response.json(body, { status }));
    const refuse = (status: number, code: string) =>
      respond({ object: "error", status, code }, status);
    const authorization = request.headers.authorization;
    const isPersonal = authorization === `Bearer ${personalToken}`;
    if (authorization !== `Bearer ${internalToken}` && !isPersonal)
      return refuse(401, "unauthorized");
    if (
      url.origin !== "https://api.notion.com" ||
      request.headers["notion-version"] !== "2026-03-11"
    )
      return refuse(400, "invalid_request");
    if (request.method === "GET" && url.pathname === "/v1/users/me")
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
    if (
      request.method === "POST" &&
      url.pathname === "/v1/search" &&
      request.body._tag === "Uint8Array"
    ) {
      const search = decodeSearch(decoder.decode(request.body.body));
      if (search._tag === "Some" && search.value.start_cursor === undefined)
        return respond({ object: "list", results: [tasks], has_more: true, next_cursor: cursor });
      if (search._tag === "Some" && search.value.start_cursor === cursor)
        return respond({ object: "list", results: [projects], has_more: false, next_cursor: null });
      return refuse(400, "validation_error");
    }
    if (request.method === "GET" && url.pathname === `/v1/data_sources/${tasksId}`)
      return respond(tasks);
    if (request.method === "GET" && url.pathname === `/v1/data_sources/${projectsId}`)
      return respond(projects);
    if (
      request.method === "POST" &&
      request.body._tag === "Uint8Array" &&
      url.pathname === `/v1/data_sources/${tasksId}/query`
    ) {
      const input = decodeQuery(decoder.decode(request.body.body));
      if (input._tag === "None") return refuse(400, "validation_error");
      const { filter, page_size, start_cursor } = input.value;
      const offset =
        start_cursor === undefined ? 0 : Number(/^tasks:(\d+)$/.exec(start_cursor)?.[1]);
      if (!Number.isSafeInteger(offset)) return refuse(400, "validation_error");
      const filters = filter === undefined ? [] : "and" in filter ? filter.and : [filter];
      const matching = tasksRows.filter(({ properties }) =>
        filters.every((f) => {
          if (f.property === "who")
            return properties.Assignee.people.some(({ id }) => id === f.people.contains);
          const { id, name } = properties.Status.status;
          return f.status.equals === name || f.status.equals === id;
        })
      );
      const next = offset + page_size;
      const projection = url.searchParams.getAll("filter_properties");
      const rows = matching.slice(offset, next).map((row) =>
        projection.length === 0
          ? row
          : {
              ...row,
              properties: Object.fromEntries(
                Object.entries(row.properties).filter(([, value]) => projection.includes(value.id))
              )
            }
      );
      return respond(list(rows, next < matching.length ? `tasks:${next}` : null));
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/databases/")) {
      const id = url.pathname.split("/").at(-1);
      const name = id && databases.get(id);
      if (id && name)
        return respond({
          object: "database",
          id,
          title: title(name),
          url: notionUrl(id)
        });
    }
    return refuse(404, "object_not_found");
  })
);

export const layer = Layer.effect(Source.Source, Source.make).pipe(
  Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
);
