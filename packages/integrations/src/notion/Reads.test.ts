import { assert, it } from "@effect/vitest";
import { type NotionListInput, type NotionSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as UrlParams from "effect/http/UrlParams";
import { planGet, planList, planMarkdown, planPeople, planSearch } from "./Reads.js";
import { Refusal } from "./Source.js";

const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;
const sourceId = id(1);
const otherId = id(2);
const userId = id(3);
const rowId = id(4);
const time = "2026-01-01T00:00:00.000Z";
const fields = [
  { id: "title", name: "Name", type: "title" },
  { id: "stat", name: "Status", type: "status" },
  { id: "who", name: "Assignee", type: "people" },
  { id: "flag", name: "Done", type: "checkbox" }
];
const snapshot = (
  properties: NotionSnapshot["dataSources"][number]["properties"] = fields
): NotionSnapshot => ({
  workspace: { id: "workspace", name: "Probe" },
  botId: "bot",
  access: "read",
  dataSources: [
    {
      id: sourceId,
      key: "Tasks",
      title: "Tasks",
      databaseTitle: "Tasks",
      url: "https://notion.so/tasks",
      properties
    }
  ],
  exclusions: []
});
const property = (id: string, type: string, value: unknown) => ({ id, type, [type]: value });
const row = (properties: Record<string, unknown>) => ({
  object: "page",
  id: rowId,
  url: "https://notion.so/task",
  created_time: time,
  last_edited_time: time,
  in_trash: false,
  parent: { type: "data_source_id", data_source_id: sourceId },
  properties,
  trace: "drop this"
});
const rowFields = {
  Name: property("title", "title", [{ plain_text: "Task" }]),
  Status: property("stat", "status", { name: "To do", color: "orange" }),
  Assignee: property("who", "people", []),
  Done: property("flag", "checkbox", false)
};
const task = row(rowFields);
const page = (results: readonly unknown[], next: string | null = null) => ({
  results,
  next_cursor: next,
  has_more: next !== null
});
/** A sender that answers with `reply` and keeps every request it was handed. */
const notion = (reply: (request: HttpClientRequest.HttpClientRequest) => unknown) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      requests.push(request);
      return reply(request);
    });
  return { send, requests };
};
const body = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON request");
  return JSON.parse(new TextDecoder().decode(request.body.body));
};
const list = (input: Omit<NotionListInput, "source">, saved = snapshot()) =>
  planList(saved, { source: "Tasks", ...input });
const notFound = () => Effect.fail(new Refusal({ code: "not_found" }));

it.effect("queries by property id, sends nothing else, and reads a renamed property", () =>
  Effect.gen(function* () {
    const sent = notion(() =>
      page([row({ Renamed: rowFields.Name, Status: rowFields.Status })], "upstream")
    );
    const read = yield* list({
      eq: { Status: "To do" },
      contains: { Assignee: userId },
      orderBy: { property: "createdTime", direction: "desc" },
      select: ["Name", "Status"],
      limit: 1
    });
    const first = yield* read(sent.send);
    assert.lengthOf(sent.requests, 1);
    const query = sent.requests[0]!;
    assert.equal(query.url, `/data_sources/${sourceId}/query`);
    assert.deepEqual(body(query), {
      result_type: "page",
      page_size: 1,
      filter: {
        and: [
          { property: "stat", status: { equals: "To do" } },
          { property: "who", people: { contains: userId } }
        ]
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }]
    });
    assert.deepEqual(UrlParams.getAll(query.urlParams, "filter_properties"), ["title", "stat"]);
    assert.deepEqual({ ...first.rows[0]!.properties }, { Name: "Task", Status: "To do" });
    assert.notProperty(first.rows[0]!, "trace");
    assert.equal(first.cursor, "upstream");
  })
);

it.effect("hands Notion's cursor back as its start cursor", () =>
  Effect.gen(function* () {
    const sent = notion(() => page([task]));
    const next = yield* (yield* list({ cursor: "upstream" }))(sent.send);
    assert.equal(body(sent.requests[0]!).start_cursor, "upstream");
    assert.isNull(next.cursor);
  })
);

it.effect("refuses arguments the snapshot doesn't take, with nothing to send", () =>
  Effect.gen(function* () {
    const refused: ReadonlyArray<Omit<NotionListInput, "source">> = [
      { eq: { Done: null } },
      { eq: { Missing: "x" } },
      { contains: { Assignee: "not an id" } },
      { range: { property: "createdTime", gt: "yesterday" } },
      { range: { property: "createdTime" } },
      { select: ["Unknown"] }
    ];
    for (const input of refused)
      assert.equal(
        (yield* list(input).pipe(Effect.flip)).code,
        "invalid_request",
        JSON.stringify(input)
      );
    const unknown = planList(snapshot(), { source: "Elsewhere" });
    assert.equal((yield* unknown.pipe(Effect.flip)).code, "invalid_request");
  })
);

it.effect("names a selected property Notion deleted or retyped", () =>
  Effect.gen(function* () {
    const read = yield* list({});
    const withoutName = {
      Status: rowFields.Status,
      Assignee: rowFields.Assignee,
      Done: rowFields.Done
    };
    for (const changed of [
      withoutName,
      { ...rowFields, Name: property("title", "rich_text", []) }
    ]) {
      const failure = yield* read(notion(() => page([row(changed)])).send).pipe(Effect.flip);
      assert.include(failure, { code: "shape_mismatch", property: "Name" });
    }
  })
);

it.effect("names the data source when Notion no longer finds it", () =>
  Effect.gen(function* () {
    const failure = yield* (yield* list({}))(notFound).pipe(Effect.flip);
    assert.include(failure, { code: "not_found", dataSource: "Tasks" });
  })
);

it.effect("refuses a page past Notion's 10,000-row stop", () =>
  Effect.gen(function* () {
    const sent = notion(() => ({
      ...page([task], "next"),
      request_status: { type: "incomplete" }
    }));
    const failure = yield* (yield* list({}))(sent.send).pipe(Effect.flip);
    assert.equal(failure.code, "offset_exhausted");
  })
);

it.effect("reads people, mentions and relations at Notion's cut whole, page after page", () =>
  Effect.gen(function* () {
    const relation = { id: "p%3Fid", name: "Project", type: "relation", relationTarget: otherId };
    const mention = { plain_text: "Page", mention: { type: "page", page: { id: rowId } } };
    const mentions = Array.from({ length: 26 }, () => mention);
    const people = Array.from({ length: 26 }, (_, i) => ({ id: id(i + 10), name: "Assignee" }));
    const sent = notion(({ method, url, urlParams }) => {
      if (url.endsWith("/properties/title"))
        return page(mentions.map((title) => ({ type: "title", title })));
      if (url.endsWith("/properties/who"))
        return page(people.map((person) => ({ type: "people", people: person })));
      if (url.endsWith(`/properties/${relation.id}`)) {
        const next = UrlParams.getAll(urlParams, "start_cursor")[0];
        return page(
          [{ type: "relation", relation: { id: next ? otherId : rowId } }],
          next ? null : "second"
        );
      }
      assert.equal(method, "POST");
      return page([
        row({
          Name: property("title", "title", mentions.slice(0, 25)),
          Assignee: property("who", "people", people.slice(0, 25)),
          Project: { ...property(relation.id, "relation", []), has_more: true }
        })
      ]);
    });
    const read = yield* list(
      { select: ["Name", "Assignee", "Project"] },
      snapshot([...fields, relation])
    );
    const { rows } = yield* read(sent.send);
    assert.deepEqual(
      { ...rows[0]!.properties },
      { Name: "Page".repeat(26), Assignee: people, Project: [rowId, otherId] }
    );
  })
);

it.effect("refuses a relation Notion says holds rows but shows none of, naming its target", () =>
  Effect.gen(function* () {
    const relation = { id: "rel", name: "Project", type: "relation", relationTarget: otherId };
    const projects = { ...snapshot().dataSources[0]!, id: otherId, key: "Projects" };
    const saved = snapshot([...fields, relation]);
    // What Notion answers once the target data source is no longer shared with the connection.
    const sent = notion(({ url }) =>
      url.endsWith("/properties/rel")
        ? page([])
        : page([row({ Project: { ...property("rel", "relation", []), has_more: true } })])
    );
    const read = yield* list(
      { select: ["Project"] },
      { ...saved, dataSources: [...saved.dataSources, projects] }
    );
    const refused = yield* read(sent.send).pipe(Effect.flip);
    assert.equal(refused.code, "not_found");
    assert.equal(refused.dataSource, "Projects");
  })
);

it.effect("gets one row, and null when it is missing or another data source's", () =>
  Effect.gen(function* () {
    const get = yield* planGet(snapshot(), { source: "Tasks", id: rowId });
    const sent = notion(() => task);
    assert.deepEqual(
      { ...(yield* get(sent.send))?.properties },
      { Name: "Task", Status: "To do", Assignee: [], Done: false }
    );
    assert.deepEqual(
      sent.requests.map(({ url }) => url),
      [`/pages/${rowId}`]
    );
    const foreign = notion(() => ({
      ...task,
      parent: { type: "data_source_id", data_source_id: otherId }
    }));
    assert.isNull(yield* get(foreign.send));
    assert.isNull(yield* get(notFound));
  })
);

it.effect("returns a page's Markdown with its truncation mark", () =>
  Effect.gen(function* () {
    const get = yield* planMarkdown(snapshot(), { id: rowId });
    const markdown = "# A page\n<unknown/>";
    const sent = notion(({ url }) =>
      url === `/pages/${rowId}/markdown`
        ? {
            object: "page_markdown",
            id: rowId,
            markdown,
            truncated: true,
            unknown_block_ids: [otherId]
          }
        : task
    );
    assert.deepEqual(yield* get(sent.send), {
      id: rowId,
      title: "Task",
      url: task.url,
      markdown,
      truncated: true
    });
    assert.isNull(yield* get(notFound));
  })
);

it.effect("searches titles, naming a row's data source and a new data source's database URL", () =>
  Effect.gen(function* () {
    const databaseId = id(5);
    const databaseUrl = "https://notion.so/archive";
    const sent = notion(({ method }) =>
      method === "POST"
        ? page(
            [
              task,
              {
                object: "data_source",
                id: otherId,
                title: [{ plain_text: "Task archive" }],
                last_edited_time: time,
                parent: { type: "database_id", database_id: databaseId }
              }
            ],
            "upstream"
          )
        : { object: "database", id: databaseId, url: databaseUrl }
    );
    const search = yield* planSearch(snapshot(), { text: "task", limit: 2 });
    const result = yield* search(sent.send);
    assert.deepEqual(body(sent.requests[0]!), {
      query: "task",
      page_size: 2,
      sort: { timestamp: "last_edited_time", direction: "descending" }
    });
    assert.equal(sent.requests[1]?.url, `/databases/${databaseId}`);
    assert.deepEqual(result, {
      results: [
        {
          kind: "page",
          id: rowId,
          title: "Task",
          url: task.url,
          lastEditedTime: time,
          dataSource: "Tasks"
        },
        {
          kind: "data_source",
          id: otherId,
          title: "Task archive",
          url: databaseUrl,
          lastEditedTime: time
        }
      ],
      cursor: "upstream"
    });
  })
);

it.effect("lists people without their email addresses", () =>
  Effect.gen(function* () {
    const sent = notion(() =>
      page(
        [
          { id: userId, name: "Probe", type: "person", person: { email: "omit@example.test" } },
          { id: otherId, type: "bot" }
        ],
        "upstream"
      )
    );
    const people = yield* (yield* planPeople(snapshot(), { limit: 2, cursor: "start" }))(sent.send);
    assert.deepEqual(people, {
      people: [
        { id: userId, name: "Probe", type: "person" },
        { id: otherId, name: null, type: "bot" }
      ],
      cursor: "upstream"
    });
    assert.equal(sent.requests[0]?.url, "/users");
    assert.deepEqual(UrlParams.getAll(sent.requests[0]!.urlParams, "page_size"), ["2"]);
    assert.deepEqual(UrlParams.getAll(sent.requests[0]!.urlParams, "start_cursor"), ["start"]);
  })
);
