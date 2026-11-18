import { assert, it } from "@effect/vitest";
import { NodeCryptography } from "@patchy/core";
import { notionPropertyTypes, type NotionListInput, type NotionSnapshot } from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as UrlParams from "effect/http/UrlParams";
import { planGet, planList, planMarkdown, planPeople, planSearch } from "./Reads.js";
import { Refusal } from "./Source.js";

const id = (last: string) => `00000000-0000-4000-8000-0000000000${last}`;
const sourceId = id("01");
const otherId = id("02");
const userId = id("03");
const rowId = id("04");
const time = "2026-01-01T00:00:00.000Z";
const schema = [
  { id: "title", name: "Name", type: "title" },
  { id: "stat", name: "Status", type: "status" },
  { id: "who", name: "Assignee", type: "people" },
  { id: "flag", name: "Done", type: "checkbox" }
];
const source = (properties: NotionSnapshot["dataSources"][number]["properties"] = schema) => ({
  id: sourceId,
  key: "Tasks",
  title: "Tasks",
  databaseTitle: "Tasks",
  url: "https://notion.so/tasks",
  properties
});
const snapshot = (
  properties: NotionSnapshot["dataSources"][number]["properties"] = schema
): NotionSnapshot => ({
  workspace: { id: "workspace", name: "Probe" },
  botId: "bot",
  access: "read",
  dataSources: [source(properties)],
  exclusions: []
});
const binding = { id: "conn_probe", revision: 1 };
const property = (id: string, type: string, value: unknown, extra = {}) => ({
  id,
  type,
  [type]: value,
  ...extra
});
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
const page = (results: readonly unknown[], next: string | null = null, status = "complete") => ({
  results,
  next_cursor: next,
  has_more: next !== null,
  request_status: { type: status }
});
const schemaBody = (properties: typeof schema = schema) => ({
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
const list = (input: NotionListInput, saved = snapshot()) =>
  planList(saved, input, binding).pipe(Effect.provide(NodeCryptography.layer));

it.effect(
  "queries stable property IDs and returns only the selected snapshot names across pages",
  () =>
    Effect.gen(function* () {
      const input = {
        source: "Tasks",
        eq: { Status: "To do" },
        contains: { Assignee: userId },
        orderBy: { property: "createdTime", direction: "desc" },
        select: ["Name", "Status"],
        limit: 1
      } as const;
      const mock = response((request) =>
        request.method === "GET"
          ? schemaBody(
              schema.map((item) =>
                item.id === "title" ? { ...item, name: "Renamed title" } : item
              )
            )
          : page(
              [
                row({
                  "Renamed title": property("title", "title", [{ plain_text: "Task" }]),
                  Status: property("stat", "status", { name: "To do", color: "orange" }),
                  Assignee: property("who", "people", [
                    { id: userId, name: "Private", email: "drop@example.test" }
                  ])
                })
              ],
              body(request).start_cursor ? null : "upstream-cursor"
            )
      );
      const first = yield* (yield* list(input))(mock.send);
      assert.deepEqual(body(mock.requests[1]!), {
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
      assert.deepEqual(UrlParams.getAll(mock.requests[1]!.urlParams, "filter_properties"), [
        "title",
        "stat"
      ]);
      assert.deepEqual(
        first.rows.map(({ properties }) => ({ ...properties })),
        [{ Name: "Task", Status: "To do" }]
      );
      assert.deepEqual(Object.keys(first.rows[0]!), [
        "id",
        "url",
        "createdTime",
        "lastEditedTime",
        "inTrash",
        "properties"
      ]);
      assert.isString(first.cursor);
      assert.notEqual(first.cursor, "upstream-cursor");

      const second = yield* (yield* list({ ...input, cursor: first.cursor! }))(mock.send);
      assert.equal(body(mock.requests[3]!).start_cursor, "upstream-cursor");
      assert.isNull(second.cursor);

      const rejected = yield* list({
        ...input,
        eq: { Status: "Done" },
        cursor: first.cursor!
      }).pipe(Effect.flip);
      assert.equal(rejected.code, "invalid_cursor");
      const differentRevision = yield* planList(
        snapshot(),
        { ...input, cursor: first.cursor! },
        { ...binding, revision: 2 }
      ).pipe(Effect.provide(NodeCryptography.layer), Effect.flip);
      assert.equal(differentRevision.code, "invalid_cursor");
    })
);

it.effect("refuses unsupported filters during planning, before a sender exists", () =>
  Effect.gen(function* () {
    const cases: NotionListInput[] = [
      { source: "Unknown" },
      { source: "Tasks", eq: { Done: null } },
      { source: "Tasks", eq: { Assignee: "Someone" } },
      { source: "Tasks", contains: { Assignee: "not an id" } },
      { source: "Tasks", contains: { Status: "urgent" } },
      { source: "Tasks", range: { property: "createdTime", gt: "yesterday" } },
      { source: "Tasks", select: ["Unknown"] }
    ];
    for (const input of cases) {
      const failed = yield* list(input).pipe(Effect.flip);
      assert.equal(failed.code, "invalid_request");
    }
  })
);

it.effect("refuses deleted and retyped properties by their snapshot name", () =>
  Effect.gen(function* () {
    for (const changed of [
      schema.slice(1),
      [{ ...schema[0]!, type: "rich_text" }, ...schema.slice(1)]
    ]) {
      const mock = response(() => schemaBody(changed));
      const failure = yield* (yield* list({ source: "Tasks" }))(mock.send).pipe(Effect.flip);
      assert.equal(failure.code, "shape_mismatch");
      assert.equal(failure.missing?.name, "Name");
      assert.deepEqual(
        mock.requests.map(({ method }) => method),
        ["GET"]
      );
    }
  })
);

it.effect("refuses a first page marked incomplete before returning rows or a cursor", () =>
  Effect.gen(function* () {
    const mock = response(({ method }) =>
      method === "GET" ? schemaBody() : page([], "next", "incomplete")
    );
    const failure = yield* (yield* list({ source: "Tasks" }))(mock.send).pipe(Effect.flip);
    assert.equal(failure.code, "offset_exhausted");
  })
);

it.effect("normalizes the supported Notion property types and empty values", () =>
  Effect.gen(function* () {
    const user = { id: userId, name: "Probe", email: "omit@example.test" };
    const date = { start: "2026-01-01", end: null };
    const choices = [{ name: "A", color: "blue" }, { name: "B" }];
    const normalized = { id: userId, name: "Probe" };
    const unnamed = { id: userId, name: null };
    const types = {
      title: [[{ plain_text: "Task" }], "Task", [], null],
      rich_text: [[{ plain_text: "Two " }, { plain_text: "parts" }], "Two parts", [], null],
      number: [0, 0, null, null],
      checkbox: [true, true, false, false],
      select: [choices[0], "A", null, null],
      status: [choices[1], "B", null, null],
      multi_select: [choices, ["A", "B"], [], []],
      date: [{ ...date, time_zone: "drop" }, date, null, null],
      url: ["https://example.test", "https://example.test", null, null],
      email: ["person@example.test", "person@example.test", null, null],
      phone_number: ["+15555550100", "+15555550100", null, null],
      people: [[user], [normalized], [], []],
      relation: [[{ id: otherId, discard: true }], [otherId], [], []],
      files: [[{ name: "file.txt", file: { url: "drop" } }], ["file.txt"], [], []],
      created_time: [time, time, time, time],
      last_edited_time: [time, time, time, time],
      created_by: [user, normalized, { id: userId }, unnamed],
      last_edited_by: [user, normalized, { id: userId }, unnamed],
      unique_id: [{ prefix: "TSK", number: 1 }, "TSK-1", { prefix: null, number: 2 }, "2"]
    } satisfies Record<
      keyof typeof notionPropertyTypes,
      readonly [unknown, unknown, unknown, unknown]
    >;
    const entries = Object.entries(types);
    const properties = entries.map(([type]) => ({ id: type, name: type, type }));
    const providerRow = (raw: 0 | 2) =>
      row(
        Object.fromEntries(
          entries.map(([type, values]) => [type, property(type, type, values[raw])])
        )
      );
    const mock = response(({ method }) =>
      method === "GET" ? schemaBody(properties) : page([providerRow(0), providerRow(2)])
    );
    const result = yield* (yield* list({ source: "Tasks" }, snapshot(properties)))(mock.send);
    for (const [index, expected] of ([1, 3] as const).entries()) {
      const expectedProperties: Record<string, unknown> = Object.fromEntries(
        entries.map(([type, values]) => [type, values[expected]])
      );
      assert.deepEqual({ ...result.rows[index]?.properties }, expectedProperties);
    }
  })
);

it.effect("reads people and page mentions through their property endpoint at the inline cut", () =>
  Effect.gen(function* () {
    const mention = { plain_text: "Page", mention: { type: "page", page: { id: rowId } } };
    const user = { id: userId, name: "Assignee" };
    const mentions = Array.from({ length: 26 }, () => mention);
    const people = Array.from({ length: 26 }, (_, i) => ({
      ...user,
      id: id(i.toString(16).padStart(2, "0"))
    }));
    const mock = response(({ method, url }) => {
      if (url.endsWith("/properties/title"))
        return page(mentions.map((title) => ({ type: "title", title })));
      if (url.endsWith("/properties/who"))
        return page(people.map((person) => ({ type: "people", people: person })));
      if (method === "GET") return schemaBody();
      return page([
        row({
          Name: property("title", "title", mentions.slice(0, 25)),
          Assignee: property("who", "people", people.slice(0, 25))
        })
      ]);
    });
    const output = yield* (yield* list({ source: "Tasks", select: ["Name", "Assignee"] }))(
      mock.send
    );
    assert.deepEqual(
      { ...output.rows[0]?.properties },
      { Name: "Page".repeat(26), Assignee: people }
    );
    assert.deepEqual(
      mock.requests.slice(2).map(({ url }) => url),
      [`/pages/${rowId}/properties/title`, `/pages/${rowId}/properties/who`]
    );
  })
);

it.effect(
  "checks a relation target once and finishes its paginated property within the bound",
  () =>
    Effect.gen(function* () {
      const related = { id: "p%3Fid", name: "Project", type: "relation", relationTarget: otherId };
      const saved = snapshot([...schema, related]);
      const mock = response((request) => {
        if (request.url.includes("/properties/"))
          return UrlParams.getAll(request.urlParams, "start_cursor").length === 0
            ? page([{ type: "relation", relation: { id: rowId, discard: true } }], "second")
            : page([{ type: "relation", relation: { id: otherId } }]);
        if (request.method === "POST")
          return page([row({ Project: property(related.id, "relation", [], { has_more: true }) })]);
        return request.url.endsWith(otherId)
          ? { id: otherId, properties: {} }
          : {
              id: sourceId,
              properties: {
                ...schemaBody().properties,
                Project: { ...related, relation: { data_source_id: otherId } }
              }
            };
      });
      const output = yield* (yield* list({ source: "Tasks", select: ["Project"] }, saved))(
        mock.send
      );
      assert.deepEqual(output.rows[0]?.properties.Project, [rowId, otherId]);
      assert.equal(mock.requests.filter(({ url }) => url.endsWith(otherId)).length, 1);
      assert.equal(
        mock.requests.filter(({ url }) => url.endsWith(`/properties/${related.id}`)).length,
        2
      );
      const missing = yield* (yield* list({ source: "Tasks", select: ["Project"] }, saved))(() =>
        Effect.fail(new Refusal({ code: "not_found" }))
      ).pipe(Effect.flip);
      assert.equal(missing.code, "not_found");
      assert.equal(missing.dataSource, otherId);
      const bounded = yield* list({ source: "Tasks", select: ["Project"] }, saved).pipe(
        Effect.provideService(ContractLimits.overrides, { "notion.read.propertyItems": 1 })
      );
      const overflow = yield* bounded(mock.send).pipe(Effect.flip);
      assert.equal(overflow.code, "too_large");
    })
);

const titledRow = row({
  Name: property("title", "title", [{ plain_text: "Task" }]),
  Status: property("stat", "status", { name: "To do" }),
  Assignee: property("who", "people", []),
  Done: property("flag", "checkbox", false)
});

it.effect("gets and normalizes a row only from the requested data source", () =>
  Effect.gen(function* () {
    const input = { source: "Tasks", id: rowId };
    const get = yield* planGet(snapshot(), input);
    const matching = response(({ url }) => (url.endsWith(rowId) ? titledRow : schemaBody()));
    const result = yield* get(matching.send);
    assert.deepEqual(
      { ...result?.properties },
      { Name: "Task", Status: "To do", Assignee: [], Done: false }
    );
    assert.deepEqual(
      matching.requests.map(({ url }) => url),
      [`/pages/${rowId}`, `/data_sources/${sourceId}`]
    );

    const foreign = response(() => ({
      ...titledRow,
      parent: { type: "data_source_id", data_source_id: otherId }
    }));
    assert.isNull(yield* get(foreign.send));
    assert.equal(foreign.requests.length, 1);
    assert.isNull(yield* get(() => Effect.fail(new Refusal({ code: "not_found" }))));
  })
);

it.effect("returns native Markdown and its truncation flag without exposing provider details", () =>
  Effect.gen(function* () {
    const get = yield* planMarkdown(snapshot(), { id: rowId });
    const mock = response(({ url }) =>
      url.endsWith("/markdown")
        ? {
            object: "page_markdown",
            id: rowId,
            markdown: "# A page\n",
            truncated: true,
            unknown_block_ids: [otherId]
          }
        : titledRow
    );
    assert.deepEqual(yield* get(mock.send), {
      id: rowId,
      title: "Task",
      url: titledRow.url,
      markdown: "# A page\n",
      truncated: true
    });
    assert.deepEqual(
      mock.requests.map(({ method, url }) => [method, url]),
      [
        ["GET", `/pages/${rowId}`],
        ["GET", `/pages/${rowId}/markdown`]
      ]
    );
    assert.isNull(yield* get(() => Effect.fail(new Refusal({ code: "not_found" }))));
  })
);

it.effect("searches by title, returns a row's source, and resolves a new source's URL", () =>
  Effect.gen(function* () {
    const databaseId = id("05");
    const sourceInfo = {
      object: "data_source",
      id: otherId,
      title: [{ plain_text: "Task archive" }],
      last_edited_time: time,
      parent: { type: "database_id", database_id: databaseId }
    };
    const dbUrl = "https://notion.so/archive";
    const mock = response(({ method }) =>
      method === "POST"
        ? page([titledRow, sourceInfo], "upstream-search")
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
        url: titledRow.url,
        lastEditedTime: time,
        dataSource: "Tasks"
      },
      { kind: "data_source", id: otherId, title: "Task archive", url: dbUrl, lastEditedTime: time }
    ]);
    const invalid = yield* planPeople(snapshot(), { cursor: result.cursor! }, binding).pipe(
      Effect.flip
    );
    assert.equal(invalid.code, "invalid_cursor");
  }).pipe(Effect.provide(NodeCryptography.layer))
);

it.effect("paginates workspace people and retains only the directory fields", () =>
  Effect.gen(function* () {
    const mock = response(({ urlParams }) =>
      UrlParams.getAll(urlParams, "start_cursor").length === 0
        ? page(
            [{ id: userId, name: "Probe", type: "person", person: { email: "omit@example.test" } }],
            "upstream-people"
          )
        : page([{ id: otherId, type: "bot", bot: { owner: "omit" } }])
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
    assert.deepEqual(UrlParams.getAll(mock.requests[1]!.urlParams, "start_cursor"), [
      "upstream-people"
    ]);
  }).pipe(Effect.provide(NodeCryptography.layer))
);
