import { assert, it } from "@effect/vitest";
import { type NotionListInput, type NotionSnapshot } from "@patchy/api";
import { NodeCryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
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
const binding = { id: "conn_probe", revision: 1 };
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
const liveSchema = (properties = fields) => ({
  id: sourceId,
  properties: Object.fromEntries(properties.map((value) => [value.name, value]))
});
const response = (reply: (request: HttpClientRequest.HttpClientRequest) => unknown) => {
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
  planList(saved, { source: "Tasks", ...input }, binding).pipe(
    Effect.provide(NodeCryptography.layer)
  );
const notFound = () => Effect.fail(new Refusal({ code: "not_found" }));

it.effect("queries stable IDs and paginates with the selected snapshot names after a rename", () =>
  Effect.gen(function* () {
    const input = {
      eq: { Status: "To do" },
      contains: { Assignee: userId },
      orderBy: { property: "createdTime", direction: "desc" },
      select: ["Name", "Status"],
      limit: 1
    } as const;
    const mock = response((request) =>
      request.method === "GET"
        ? liveSchema(
            fields.map((field) => (field.id === "title" ? { ...field, name: "Renamed" } : field))
          )
        : page(
            [
              row({
                Renamed: rowFields.Name,
                Status: rowFields.Status,
                Assignee: rowFields.Assignee
              })
            ],
            body(request).start_cursor ? null : "upstream"
          )
    );
    const first = yield* (yield* list(input))(mock.send);
    const query = mock.requests[1]!;
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
    assert.deepEqual({ ...first.rows[0]?.properties }, { Name: "Task", Status: "To do" });
    assert.notProperty(first.rows[0]!, "trace");
    assert.isString(first.cursor);
    assert.notEqual(first.cursor, "upstream");
    const cursor = first.cursor!;
    assert.isNull((yield* (yield* list({ ...input, cursor }))(mock.send)).cursor);
    assert.equal(body(mock.requests[3]!).start_cursor, "upstream");
    assert.equal(
      (yield* list({ ...input, eq: { Status: "Done" }, cursor }).pipe(Effect.flip)).code,
      "invalid_cursor"
    );
    const otherRevision = planList(
      snapshot(),
      { ...input, source: "Tasks", cursor },
      { ...binding, revision: 2 }
    );
    assert.equal(
      (yield* otherRevision.pipe(Effect.provide(NodeCryptography.layer), Effect.flip)).code,
      "invalid_cursor"
    );
  })
);

it.effect("refuses unsupported filters before a sender exists", () =>
  Effect.gen(function* () {
    for (const options of [
      { eq: { Done: null } },
      { contains: { Assignee: "not an id" } },
      { range: { property: "createdTime", gt: "yesterday" } },
      { select: ["Unknown"] }
    ] satisfies Omit<NotionListInput, "source">[]) {
      assert.equal((yield* list(options).pipe(Effect.flip)).code, "invalid_request");
    }
  })
);

it.effect("names a deleted or retyped property before querying rows", () =>
  Effect.gen(function* () {
    const execute = yield* list({});
    for (const changed of [
      fields.slice(1),
      fields.map((field) => (field.id === "title" ? { ...field, type: "rich_text" } : field))
    ]) {
      const mock = response(() => liveSchema(changed));
      const failure = yield* execute(mock.send).pipe(Effect.flip);
      assert.equal(failure.code, "shape_mismatch");
      assert.equal(failure.missing?.name, "Name");
      assert.deepEqual(
        mock.requests.map(({ method }) => method),
        ["GET"]
      );
    }
  })
);

it.effect("refuses the first page when Notion has already hit its query limit", () =>
  Effect.gen(function* () {
    const mock = response(({ method }) =>
      method === "GET"
        ? liveSchema()
        : { ...page([task], "next"), request_status: { type: "incomplete" } }
    );
    const failure = yield* (yield* list({}))(mock.send).pipe(Effect.flip);
    assert.equal(failure.code, "offset_exhausted");
  })
);

it.effect("loads complete people and page mentions at the inline cap", () =>
  Effect.gen(function* () {
    const mention = { plain_text: "Page", mention: { type: "page", page: { id: rowId } } };
    const mentions = Array.from({ length: 26 }, () => mention);
    const people = Array.from({ length: 26 }, (_, i) => ({ id: id(i + 1), name: "Assignee" }));
    const mock = response(({ method, url }) => {
      if (url.endsWith("/properties/title"))
        return page(mentions.map((title) => ({ type: "title", title })));
      if (url.endsWith("/properties/who"))
        return page(people.map((person) => ({ type: "people", people: person })));
      if (method === "GET") return liveSchema();
      return page([
        row({
          Name: property("title", "title", mentions.slice(0, 25)),
          Assignee: property("who", "people", people.slice(0, 25))
        })
      ]);
    });
    const { rows } = yield* (yield* list({ select: ["Name", "Assignee"] }))(mock.send);
    assert.deepEqual({ ...rows[0]?.properties }, { Name: "Page".repeat(26), Assignee: people });
  })
);

it.effect(
  "requires a readable relation target and follows the property cursor up to the bound",
  () =>
    Effect.gen(function* () {
      const relation = { id: "p%3Fid", name: "Project", type: "relation", relationTarget: otherId };
      const liveRelation = { ...relation, relation: { data_source_id: otherId } };
      const options = { select: ["Project"] };
      const saved = snapshot([...fields, relation]);
      const execute = yield* list(options, saved);
      const mock = response(({ url, urlParams, method }) => {
        if (url === `/data_sources/${otherId}`) return { id: otherId, properties: {} };
        if (url === `/pages/${rowId}/properties/${relation.id}`) {
          const next = UrlParams.getAll(urlParams, "start_cursor")[0];
          return page(
            [{ type: "relation", relation: { id: next ? otherId : rowId } }],
            next ? null : "second"
          );
        }
        if (method === "POST")
          return page([
            row({ Project: { ...property(relation.id, "relation", []), has_more: true } })
          ]);
        return liveSchema([...fields, liveRelation]);
      });
      const { rows } = yield* execute(mock.send);
      assert.deepEqual(rows[0]?.properties.Project, [rowId, otherId]);
      assert.equal(mock.requests.filter(({ url }) => url.endsWith(otherId)).length, 1);
      const missing = yield* execute(notFound).pipe(Effect.flip);
      assert.equal(missing.code, "not_found");
      assert.equal(missing.dataSource, otherId);
      const bounded = yield* list(options, saved).pipe(
        Effect.provideService(ContractLimits.overrides, { "notion.read.propertyItems": 1 })
      );
      assert.equal((yield* bounded(mock.send).pipe(Effect.flip)).code, "too_large");
    })
);

it.effect("gets a normalized row only from the requested data source", () =>
  Effect.gen(function* () {
    const get = yield* planGet(snapshot(), { source: "Tasks", id: rowId });
    const mock = response(({ url }) => (url === `/pages/${rowId}` ? task : liveSchema()));
    const result = yield* get(mock.send);
    assert.deepEqual(
      { ...result?.properties },
      { Name: "Task", Status: "To do", Assignee: [], Done: false }
    );
    const foreign = response(() => ({
      ...task,
      parent: { type: "data_source_id", data_source_id: otherId }
    }));
    assert.isNull(yield* get(foreign.send));
    assert.isNull(yield* get(notFound));
  })
);

it.effect("returns native Markdown and its truncation flag without provider details", () =>
  Effect.gen(function* () {
    const get = yield* planMarkdown(snapshot(), { id: rowId });
    const markdown = "# A page\n<unknown/>";
    const mock = response(({ url }) =>
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
    assert.deepEqual(yield* get(mock.send), {
      id: rowId,
      title: "Task",
      url: task.url,
      markdown,
      truncated: true
    });
    assert.isNull(yield* get(notFound));
  })
);

it.effect(
  "searches by title and returns the snapshot key for a row and the URL for a new source",
  () =>
    Effect.gen(function* () {
      const databaseId = id(5);
      const dbUrl = "https://notion.so/archive";
      const mock = response(({ method }) =>
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
          : { object: "database", id: databaseId, url: dbUrl }
      );
      const search = yield* planSearch(snapshot(), { text: "task", limit: 2 }, binding);
      const result = yield* search(mock.send);
      assert.deepEqual(body(mock.requests[0]!), {
        query: "task",
        page_size: 2,
        sort: { timestamp: "last_edited_time", direction: "descending" }
      });
      assert.equal(mock.requests[1]?.url, `/databases/${databaseId}`);
      assert.deepEqual(result.results, [
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
          url: dbUrl,
          lastEditedTime: time
        }
      ]);
      const invalid = yield* planPeople(snapshot(), { cursor: result.cursor! }, binding).pipe(
        Effect.flip
      );
      assert.equal(invalid.code, "invalid_cursor");
    }).pipe(Effect.provide(NodeCryptography.layer))
);

it.effect("paginates people and omits their email addresses", () =>
  Effect.gen(function* () {
    const mock = response(({ urlParams }) =>
      UrlParams.getAll(urlParams, "start_cursor")[0] === "upstream"
        ? page([{ id: otherId, type: "bot" }])
        : page(
            [{ id: userId, name: "Probe", type: "person", person: { email: "omit@example.test" } }],
            "upstream"
          )
    );
    const first = yield* (yield* planPeople(snapshot(), { limit: 1 }, binding))(mock.send);
    const second = yield* (yield* planPeople(
      snapshot(),
      { limit: 1, cursor: first.cursor! },
      binding
    ))(mock.send);
    assert.deepEqual(first.people, [{ id: userId, name: "Probe", type: "person" }]);
    assert.deepEqual(second, { people: [{ id: otherId, name: null, type: "bot" }], cursor: null });
    assert.equal(mock.requests[0]?.url, "/users");
    assert.deepEqual(UrlParams.getAll(mock.requests[0]!.urlParams, "page_size"), ["1"]);
  }).pipe(Effect.provide(NodeCryptography.layer))
);
