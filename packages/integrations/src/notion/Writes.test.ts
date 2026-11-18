import { assert, it } from "@effect/vitest";
import { type NotionSnapshot } from "@patchy/api";
import { Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Source from "./Source.js";
import { planCreate, planRestore, planTrash, planUpdate } from "./Writes.js";

const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;
const sourceId = id(1);
const projectsId = id(2);
const rowId = id(3);
const userId = id(4);
const snapshot: NotionSnapshot = {
  workspace: { id: "workspace", name: "Probe" },
  botId: "bot",
  access: "write",
  dataSources: [
    {
      id: sourceId,
      key: "Tasks",
      title: "Tasks",
      databaseTitle: "Tasks",
      url: "https://notion.so/tasks",
      properties: [
        { id: "title", name: "Name", type: "title" },
        {
          id: "stat",
          name: "Status",
          type: "status",
          options: [
            { id: "todo", name: "To do" },
            { id: "done", name: "Done" }
          ]
        },
        {
          id: "tags",
          name: "Tags",
          type: "multi_select",
          options: [{ id: "red", name: "Urgent" }]
        },
        { id: "who", name: "Assignee", type: "people" },
        { id: "due", name: "Due", type: "date" },
        { id: "link", name: "Link", type: "url" },
        { id: "proj", name: "Project", type: "relation", relationTarget: projectsId },
        { id: "made", name: "Created", type: "created_time" }
      ]
    },
    {
      id: projectsId,
      key: "Projects",
      title: "Projects",
      databaseTitle: "Projects",
      url: "https://notion.so/projects",
      properties: [{ id: "title", name: "Name", type: "title" }]
    }
  ],
  exclusions: []
};
/** A sender that answers with `reply` and keeps every request it was handed. */
const notion = (reply: (request: HttpClientRequest.HttpClientRequest) => unknown) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.suspend(() => {
      requests.push(request);
      const answer = reply(request);
      return answer instanceof Source.Refusal ? Effect.fail(answer) : Effect.succeed(answer);
    });
  return { send, requests, sent: () => requests.map(({ method, url }) => `${method} ${url}`) };
};
const body = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON request");
  return JSON.parse(new TextDecoder().decode(request.body.body));
};
const ours = { parent: { type: "data_source_id", data_source_id: sourceId } };
const create = (properties: Record<string, Schema.Json>) =>
  planCreate(snapshot, { source: "Tasks", properties });

/** A create through the real sender, against a Notion that answers each request with `answer`. */
const createThrough = (
  answer: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>
) =>
  Effect.gen(function* () {
    let requests = 0;
    const source = yield* Source.make.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests++;
          return Effect.map(answer(request), (response) =>
            HttpClientResponse.fromWeb(request, response)
          );
        })
      )
    );
    const execute = yield* create({ Name: "Review signage" });
    const error = yield* execute((request) =>
      source.send(Redacted.make("notion-test"), request)
    ).pipe(Effect.flip);
    return { error, requests };
  });

it.effect("creates a row by property and option ids, sending only the write", () =>
  Effect.gen(function* () {
    const notionSide = notion(() => ({ id: rowId, url: "https://notion.so/row", in_trash: false }));
    const execute = yield* create({
      Name: "Review signage",
      Status: "To do",
      Tags: ["Urgent"],
      Assignee: [userId],
      Due: { start: "2026-01-01" },
      Link: null
    });
    assert.deepEqual(yield* execute(notionSide.send), { id: rowId, url: "https://notion.so/row" });
    assert.deepEqual(notionSide.sent(), ["POST /pages"]);
    assert.deepEqual(body(notionSide.requests[0]!), {
      ...ours,
      properties: {
        title: { title: [{ type: "text", text: { content: "Review signage" } }] },
        stat: { status: { id: "todo" } },
        tags: { multi_select: [{ id: "red" }] },
        who: { people: [{ id: userId }] },
        due: { date: { start: "2026-01-01", end: null } },
        link: { url: null }
      }
    });
  })
);

it.effect("updates only the properties named, once the row is this data source's", () =>
  Effect.gen(function* () {
    const notionSide = notion((request) =>
      request.method === "GET" ? { id: rowId, ...ours } : { id: rowId }
    );
    const execute = yield* planUpdate(snapshot, {
      source: "Tasks",
      id: rowId,
      properties: { Name: "", Status: null }
    });
    assert.deepEqual(yield* execute(notionSide.send), { id: rowId });
    assert.deepEqual(notionSide.sent(), [`GET /pages/${rowId}`, `PATCH /pages/${rowId}`]);
    assert.deepEqual(body(notionSide.requests[1]!), {
      properties: { title: { title: [] }, stat: { status: null } }
    });
  })
);

it.effect("trashes and restores a row of this data source", () =>
  Effect.gen(function* () {
    for (const [plan, inTrash] of [
      [planTrash, true],
      [planRestore, false]
    ] as const) {
      const notionSide = notion((request) =>
        request.method === "GET" ? { id: rowId, ...ours } : { id: rowId, in_trash: inTrash }
      );
      const execute = yield* plan(snapshot, { source: "Tasks", id: rowId });
      assert.deepEqual(yield* execute(notionSide.send), { id: rowId, inTrash });
      assert.deepEqual(body(notionSide.requests[1]!), { in_trash: inTrash });
    }
  })
);

it.effect("refuses an option this version doesn't know, naming the ones it does", () =>
  Effect.gen(function* () {
    const refused = yield* create({ Status: "Doing" }).pipe(Effect.flip);
    if (!(refused instanceof Source.Refusal)) return assert.fail("Expected a Notion refusal");
    assert.include(refused, { code: "invalid_request", property: "Status" });
    assert.deepEqual(refused.knownOptions, ["To do", "Done"]);
  })
);

it.effect("refuses a read-only property and an overlong value before planning a request", () =>
  Effect.gen(function* () {
    const refusals: Array<Record<string, Schema.Json>> = [
      { Created: "2026-01-01" },
      { Link: `https://${"x".repeat(2000)}` }
    ];
    for (const properties of refusals)
      assert.instanceOf(yield* create(properties).pipe(Effect.flip), Runtime.InvalidRequest);
  })
);

it.effect("splits text into Notion's text objects between code points", () =>
  Effect.gen(function* () {
    const notionSide = notion(() => ({ id: rowId, url: "https://notion.so/row" }));
    // The 2,000th character starts a surrogate pair, which stays whole in the next object.
    yield* (yield* create({ Name: `${"a".repeat(1999)}🧩b` }))(notionSide.send);
    const parts = body(notionSide.requests[0]!).properties.title.title.map(
      (part: { text: { content: string } }) => part.text.content
    );
    assert.deepEqual(parts, ["a".repeat(1999), "🧩b"]);
  })
);

it.effect("refuses a row of another data source before writing", () =>
  Effect.gen(function* () {
    const notionSide = notion(() => ({
      id: rowId,
      parent: { type: "data_source_id", data_source_id: projectsId }
    }));
    const execute = yield* planTrash(snapshot, { source: "Tasks", id: rowId });
    assert.include(yield* execute(notionSide.send).pipe(Effect.flip), { code: "not_found" });
    assert.deepEqual(notionSide.sent(), [`GET /pages/${rowId}`]);
  })
);

it.effect("refuses a relation to a data source no longer shared, with nothing written", () =>
  Effect.gen(function* () {
    const notionSide = notion(() => new Source.Refusal({ code: "not_found" }));
    const execute = yield* create({ Project: [rowId] });
    assert.include(yield* execute(notionSide.send).pipe(Effect.flip), {
      code: "not_found",
      dataSource: "Projects"
    });
    assert.deepEqual(notionSide.sent(), [`GET /data_sources/${projectsId}`]);
  })
);

it.effect("a lost answer is unknown_outcome, the write sent once", () =>
  Effect.gen(function* () {
    const { error, requests } = yield* createThrough((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "lost" })
        })
      )
    );
    assert.equal(error.code, "unknown_outcome");
    assert.equal(requests, 1);
  })
);

it.effect("a 5xx is unknown_outcome, the write sent once", () =>
  Effect.gen(function* () {
    const { error, requests } = yield* createThrough(() =>
      Effect.succeed(
        Response.json({ object: "error", code: "internal_server_error" }, { status: 500 })
      )
    );
    assert.equal(error.code, "unknown_outcome");
    assert.isUndefined(error.rowId);
    assert.equal(requests, 1);
  })
);

it.effect("a 503 naming the row Notion committed carries it as rowId", () =>
  Effect.gen(function* () {
    const { error } = yield* createThrough(() =>
      Effect.succeed(
        Response.json(
          {
            object: "error",
            code: "service_unavailable",
            additional_data: { committed_resource_id: rowId }
          },
          { status: 503 }
        )
      )
    );
    assert.include(error, { code: "unknown_outcome", rowId });
  })
);

it.effect("a 409 is write_conflict: Notion saved nothing", () =>
  Effect.gen(function* () {
    const { error } = yield* createThrough(() =>
      Effect.succeed(Response.json({ object: "error", code: "conflict_error" }, { status: 409 }))
    );
    assert.equal(error.code, "write_conflict");
  })
);
