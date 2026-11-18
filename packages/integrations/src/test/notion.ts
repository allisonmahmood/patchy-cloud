import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Source from "../notion/Source.js";

export const internalToken = "notion-test-internal";
export const personalToken = "notion-test-pat";
const requestOwnerId = "30000000-0000-4000-8000-000000000001";
const handbookId = "40000000-0000-4000-8000-000000000001";
const firstRequestId = "20000000-0000-4000-8000-000000000001";

const workspaceId = "58fe1df4-672b-418f-865e-b3ff941242ef";
const tasksId = "3a261add-da2a-4d6e-a243-4970abf59591";
const projectsId = "598bdfa9-43af-45f3-89a9-bc35aa6065fc";
const tasksDatabaseId = "d52c7f07-76a5-4f6f-b33d-88d496058f41";
const projectsDatabaseId = "8bc41a73-5c04-4d52-9dae-893eacb959cc";
const cursor = "another-data-source";
const stamp = "2026-11-01T12:00:00.000Z";
const title = (plain_text: string) => [{ plain_text }];
const notionUrl = (id: string) => `https://app.notion.com/p/${id.replaceAll("-", "")}`;
const person = (id: string, name: string, email: string) => ({
  id,
  name,
  type: "person",
  person: { email }
});
const owner = person(requestOwnerId, "Sam Rivera", "sam@example.test");
const teammate = person("30000000-0000-4000-8000-000000000002", "Avery Chen", "avery@example.test");
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
const database = (id: string, name: string) => ({
  object: "database",
  id,
  title: title(name),
  url: notionUrl(id)
});
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
const initialRows = [
  task(firstRequestId, "Review signage", "todo", owner),
  task("20000000-0000-4000-8000-000000000002", "Book a studio", "todo", owner),
  task("20000000-0000-4000-8000-000000000003", "Send the brief", "todo", teammate),
  task("20000000-0000-4000-8000-000000000004", "Approve artwork", "done", owner)
];
const handbook = {
  ...page(handbookId, { type: "workspace", workspace: true }),
  properties: { title: { id: "title", type: "title", title: title("Requests handbook") } }
};
const sources = [tasks, projects];
const reads = new Map<string, unknown>([
  [`/v1/pages/${handbook.id}`, handbook],
  ...sources.map((source) => [`/v1/data_sources/${source.id}`, source] as const),
  [`/v1/databases/${tasksDatabaseId}`, database(tasksDatabaseId, "Project Tracker")],
  [`/v1/databases/${projectsDatabaseId}`, database(projectsDatabaseId, "Project Portfolio")],
  [
    `/v1/pages/${handbookId}/markdown`,
    {
      object: "page_markdown",
      id: handbookId,
      markdown: '# Requests handbook\n\nFile requests with Sam Rivera.\n\n<unknown type="embed"/>',
      truncated: false
    }
  ]
]);

const offsetOf = (name: string, raw: string | null) =>
  raw === null ? 0 : Number(raw.startsWith(`${name}:`) ? raw.slice(name.length + 1) : NaN);
const paginate = <T>(name: string, rows: readonly T[], offset: number, size: number) => {
  const next = offset + size;
  return list(rows.slice(offset, next), next < rows.length ? `${name}:${next}` : null);
};

const list = <T>(results: readonly T[], next: string | null = null) => ({
  object: "list",
  results,
  has_more: next !== null,
  next_cursor: next
});
const paging = {
  page_size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  start_cursor: Schema.optionalKey(Schema.String)
};
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
      ...paging,
      filter: Schema.optionalKey(
        Schema.Union([taskFilter, Schema.Struct({ and: Schema.Array(taskFilter) })])
      )
    })
  )
);
const decodeSearch = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ...paging,
      filter: Schema.optionalKey(
        Schema.Struct({
          property: Schema.Literal("object"),
          value: Schema.Literals(["page", "data_source"])
        })
      ),
      query: Schema.optionalKey(Schema.String),
      sort: Schema.optionalKey(
        Schema.Struct({
          timestamp: Schema.Literal("last_edited_time"),
          direction: Schema.Literal("descending")
        })
      )
    })
  )
);
const decodeWrite = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      parent: Schema.optionalKey(Schema.Struct({ data_source_id: Schema.String })),
      properties: Schema.optionalKey(
        Schema.Struct({
          title: Schema.optionalKey(
            Schema.Struct({
              title: Schema.Array(
                Schema.Struct({ text: Schema.Struct({ content: Schema.String }) })
              )
            })
          ),
          STs: Schema.optionalKey(
            Schema.Struct({ status: Schema.Struct({ id: Schema.Literals(["todo", "done"]) }) })
          ),
          who: Schema.optionalKey(
            Schema.Struct({ people: Schema.Array(Schema.Struct({ id: Schema.String })) })
          )
        })
      ),
      in_trash: Schema.optionalKey(Schema.Boolean)
    })
  )
);
const decoder = new TextDecoder();

interface Workspace {
  readonly tasksRows: Map<string, ReturnType<typeof task>>;
  nextRow: number;
}

/** An offline Notion response, used by integration tests and the dev scenario. */
const reply = (
  workspace: Workspace,
  url: URL,
  method: string,
  headers: Headers,
  requestBody: string | undefined
) => {
  const { tasksRows } = workspace;
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
  const row = tasksRows.get(url.pathname.slice("/v1/pages/".length));
  const create = method === "POST" && url.pathname === "/v1/pages";
  const update = method === "PATCH" && url.pathname.startsWith("/v1/pages/");
  if ((create || update) && requestBody !== undefined) {
    if (update && !row) return refuse(404, "object_not_found");
    const write = decodeWrite(requestBody);
    if (write._tag === "None") return refuse(400, "validation_error");
    const { parent, properties, in_trash } = write.value;
    if (create && (parent?.data_source_id !== tasksId || properties?.title === undefined))
      return refuse(400, "validation_error");
    const id =
      row?.id ?? `20000000-0000-4000-8000-${String(workspace.nextRow++).padStart(12, "0")}`;
    const name =
      properties?.title?.title.map(({ text }) => text.content).join("") ??
      row?.properties.Name.title.map(({ plain_text }) => plain_text).join("") ??
      "";
    const status = properties?.STs?.status.id ?? row?.properties.Status.status.id ?? "todo";
    const next = task(id, name, status, owner);
    const assignee =
      properties?.who?.people.map(({ id }) => (id === teammate.id ? teammate : owner)) ??
      row?.properties.Assignee.people ??
      [];
    next.properties.Assignee.people = assignee;
    next.in_trash = in_trash ?? row?.in_trash ?? false;
    tasksRows.set(id, next);
    return respond(next);
  }
  if (method === "GET" && url.pathname.startsWith("/v1/pages/") && row) return respond(row);
  if (method === "POST" && url.pathname === "/v1/search" && requestBody !== undefined) {
    const search = decodeSearch(requestBody);
    if (search._tag === "None") return refuse(400, "validation_error");
    const { query, sort, filter, page_size, start_cursor } = search.value;
    if (query !== undefined || sort !== undefined) {
      const offset = offsetOf("search", start_cursor ?? null);
      if (!Number.isSafeInteger(offset)) return refuse(400, "validation_error");
      const text = query?.toLowerCase() ?? "";
      const includes = (parts: ReturnType<typeof title>) =>
        parts.some(({ plain_text }) => plain_text.toLowerCase().includes(text));
      const pages =
        filter?.value === "data_source"
          ? []
          : [handbook, ...tasksRows.values()].filter(({ properties }) =>
              includes("Name" in properties ? properties.Name.title : properties.title.title)
            );
      const dataSources =
        filter?.value === "page" ? [] : sources.filter(({ title }) => includes(title));
      const matches = [...pages, ...dataSources];
      return respond(paginate("search", matches, offset, page_size));
    }
    if (filter?.value === "data_source" && start_cursor === undefined)
      return respond(list([tasks], cursor));
    if (filter?.value === "data_source" && start_cursor === cursor)
      return respond(list([projects]));
    return refuse(400, "validation_error");
  }
  if (method === "GET" && url.pathname === "/v1/users") {
    const offset = offsetOf("people", url.searchParams.get("start_cursor"));
    const size = Number(url.searchParams.get("page_size") ?? 100);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 1 || size > 100)
      return refuse(400, "validation_error");
    return respond(paginate("people", [owner, teammate], offset, size));
  }
  if (method === "GET" && reads.has(url.pathname)) return respond(reads.get(url.pathname));
  if (
    method === "POST" &&
    requestBody !== undefined &&
    url.pathname === `/v1/data_sources/${tasksId}/query`
  ) {
    const input = decodeQuery(requestBody);
    if (input._tag === "None") return refuse(400, "validation_error");
    const { filter, page_size, start_cursor } = input.value;
    const offset = offsetOf("tasks", start_cursor ?? null);
    if (!Number.isSafeInteger(offset)) return refuse(400, "validation_error");
    const filters = filter === undefined ? [] : "and" in filter ? filter.and : [filter];
    const matching = [...tasksRows.values()].filter(
      ({ properties, in_trash }) =>
        !in_trash &&
        filters.every((f) => {
          if (f.property === "who")
            return properties.Assignee.people.some(({ id }) => id === f.people.contains);
          const { id, name } = properties.Status.status;
          return f.status.equals === name || f.status.equals === id;
        })
    );
    const projection = url.searchParams.getAll("filter_properties");
    const result = paginate("tasks", matching, offset, page_size);
    if (projection.length === 0) return respond(result);
    const results = result.results.map((row) => ({
      ...row,
      properties: Object.fromEntries(
        Object.entries(row.properties).filter(([, value]) => projection.includes(value.id))
      )
    }));
    return respond({ ...result, results });
  }
  return refuse(404, "object_not_found");
};

const makeClient = () => {
  const workspace = { tasksRows: new Map(initialRows.map((row) => [row.id, row])), nextRow: 5 };
  return HttpClient.make((request, url) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        reply(
          workspace,
          url,
          request.method,
          new Headers(request.headers),
          request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : undefined
        )
      )
    )
  );
};

/** In the disposable dev server, only Notion requests are intercepted. */
export const makeFetch = (fallback: typeof fetch): typeof fetch => {
  const workspace = { tasksRows: new Map(initialRows.map((row) => [row.id, row])), nextRow: 5 };
  return async (input, init) => {
    const url = URL.parse(input instanceof Request ? input.url : input);
    if (url?.origin !== "https://api.notion.com") return fallback(input, init);
    const request = new Request(input, init);
    return reply(
      workspace,
      url,
      request.method,
      request.headers,
      request.body === null ? undefined : await request.text()
    );
  };
};

export const layer = Layer.effect(Source.Source, Source.make).pipe(
  Layer.provide(Layer.effect(HttpClient.HttpClient, Effect.sync(makeClient)))
);
