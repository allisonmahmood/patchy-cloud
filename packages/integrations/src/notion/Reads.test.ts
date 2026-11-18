import { assert, it } from "@effect/vitest";
import { NodeCryptography } from "@patchy/core";
import type { NotionListInput, NotionSnapshot } from "@patchy/api";
import { ContractLimits } from "@patchy/limits";
import * as Effect from "effect/Effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as UrlParams from "effect/http/UrlParams";
import { planList } from "./Reads.js";
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

it.effect(
  "checks a relation target once and finishes its paginated property within the bound",
  () =>
    Effect.gen(function* () {
      const related = { id: "project", name: "Project", type: "relation", relationTarget: otherId };
      const saved = snapshot([...schema, related]);
      const mock = response((request) => {
        if (request.url.includes("/properties/"))
          return UrlParams.getAll(request.urlParams, "start_cursor").length === 0
            ? page([{ type: "relation", relation: { id: rowId, discard: true } }], "second")
            : page([{ type: "relation", relation: { id: otherId } }]);
        if (request.method === "POST")
          return page([row({ Project: property("project", "relation", [], { has_more: true }) })]);
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
      const missing = yield* (yield* list({ source: "Tasks", select: ["Project"] }, saved))(() =>
        Effect.fail(new Refusal({ code: "not_found" }))
      ).pipe(Effect.flip);
      assert.equal(missing.code, "not_found");
      const bounded = yield* list({ source: "Tasks", select: ["Project"] }, saved).pipe(
        Effect.provideService(ContractLimits.overrides, { "notion.read.propertyItems": 1 })
      );
      const overflow = yield* bounded(mock.send).pipe(Effect.flip);
      assert.equal(overflow.code, "too_large");
    })
);
