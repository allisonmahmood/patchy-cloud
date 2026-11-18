import { assert, it } from "@effect/vitest";
import { type NotionSnapshot } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Source from "./Source.js";
import { planCreate, planRestore, planTrash, planUpdate } from "./Writes.js";

const sourceId = "00000000-0000-4000-8000-000000000001";
const rowId = "00000000-0000-4000-8000-000000000002";
const relationTarget = "00000000-0000-4000-8000-000000000003";
const url = "https://notion.so/task";
const input = { source: "Tasks", id: rowId };
const properties = [
  { id: "title", name: "Name", type: "title" },
  { id: "stat", name: "Status", type: "status", options: [{ id: "todo", name: "To do" }] },
  { id: "who", name: "Assignee", type: "people" },
  { id: "done", name: "Done", type: "checkbox" },
  { id: "formula", name: "Formula", type: "formula" },
  { id: "rel", name: "Project", type: "relation", relationTarget },
  { id: "url", name: "Link", type: "url" },
  { id: "notes", name: "Notes", type: "rich_text" },
  { id: "desc", name: "Description", type: "rich_text" }
];
const snapshot: NotionSnapshot = {
  workspace: { id: "workspace", name: "Probe" },
  botId: "bot",
  access: "write",
  dataSources: [
    { id: sourceId, key: "Tasks", title: "Tasks", databaseTitle: "Tasks", url, properties }
  ],
  exclusions: []
};
const live = {
  id: sourceId,
  properties: {
    Renamed: properties[0],
    Status: { id: "stat", type: "status", status: { options: [{ id: "todo", name: "Up next" }] } },
    Assignee: properties[2],
    Done: properties[3],
    Link: properties[6]
  }
};
const row = { id: rowId, parent: { type: "data_source_id", data_source_id: sourceId } };
const body = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON body");
  return JSON.parse(new TextDecoder().decode(request.body.body));
};

it.effect(
  "creates through stable property and option IDs and splits text at a Unicode boundary",
  () =>
    Effect.gen(function* () {
      const prefix = "a".repeat(1999);
      const create = yield* planCreate(snapshot, {
        source: "Tasks",
        properties: { Name: prefix + "🧩", Status: "To do", Assignee: [], Done: false, Link: null }
      });
      const calls: string[] = [];
      const result = yield* create((request, write) =>
        Effect.sync(() => {
          calls.push(`${request.method} ${request.url}`);
          if (request.method === "GET") {
            assert.notStrictEqual(write, true);
            return live;
          }
          assert.strictEqual(write, true);
          assert.deepEqual(body(request), {
            parent: { type: "data_source_id", data_source_id: sourceId },
            properties: {
              title: {
                title: [prefix, "🧩"].map((content) => ({ type: "text", text: { content } }))
              },
              stat: { status: { id: "todo" } },
              who: { people: [] },
              done: { checkbox: false },
              url: { url: null }
            }
          });
          return { id: rowId, url, properties: { unknown: "not part of the reply" } };
        })
      );
      assert.deepEqual(result, { id: rowId, url });
      assert.deepEqual(calls, [`GET /data_sources/${sourceId}`, "POST /pages"]);
    })
);

it.effect(
  "rejects invalid property writes before transport and catches an option deleted after discovery",
  () =>
    Effect.gen(function* () {
      const long = "x".repeat(166_000);
      const invalid: Readonly<Record<string, Schema.Json>>[] = [
        { Status: "unknown option" },
        { Formula: 1 },
        { Link: "a".repeat(2001) },
        { Name: "🧩".repeat(100_001) },
        { Name: long, Notes: long, Description: long }
      ];
      for (const values of invalid) {
        const error = yield* planCreate(snapshot, { source: "Tasks", properties: values }).pipe(
          Effect.flip
        );
        assert.equal(error.code, "invalid_request");
        if ("Status" in values) assert.deepEqual(error.knownOptions, ["To do"]);
      }
      const create = yield* planCreate(snapshot, {
        source: "Tasks",
        properties: { Status: "To do" }
      });
      const error = yield* create((request) => {
        assert.equal(request.method, "GET");
        return Effect.succeed({
          ...live,
          properties: {
            ...live.properties,
            Status: { id: "stat", type: "status", status: { options: [] } }
          }
        });
      }).pipe(Effect.flip);
      assert.equal(error.code, "shape_mismatch");
      const relation = yield* planCreate(snapshot, {
        source: "Tasks",
        properties: { Project: [rowId] }
      });
      const inaccessible = yield* relation((request) => {
        assert.equal(request.method, "GET");
        assert.equal(request.url, `/data_sources/${relationTarget}`);
        return Effect.fail(new Source.Refusal({ code: "not_found" }));
      }).pipe(Effect.flip);
      assert.equal(inaccessible.code, "not_found");
    })
);

it.effect("updates, trashes, and restores only a row owned by the requested source", () =>
  Effect.gen(function* () {
    const update = yield* planUpdate(snapshot, { ...input, properties: { Status: null } });
    const trash = yield* planTrash(snapshot, input);
    const restore = yield* planRestore(snapshot, input);
    for (const [plan, payload, answer] of [
      [update, { properties: { stat: { status: null } } }, { id: rowId }],
      [trash, { in_trash: true }, { id: rowId, inTrash: true }],
      [restore, { in_trash: false }, { id: rowId, inTrash: false }]
    ] as const) {
      const refusal = yield* plan((request) => {
        assert.equal(request.method, "GET");
        return Effect.succeed({
          ...row,
          parent: { type: "data_source_id", data_source_id: relationTarget }
        });
      }).pipe(Effect.flip);
      assert.equal(refusal.code, "not_found");
      assert.deepEqual<unknown>(
        yield* plan((request, write) =>
          Effect.sync(() => {
            if (request.method === "GET") return request.url.endsWith(sourceId) ? live : row;
            assert.equal(request.method, "PATCH");
            assert.equal(request.url, `/pages/${rowId}`);
            assert.strictEqual(write, true);
            assert.deepEqual(body(request), payload);
            return { ...row, ...payload };
          })
        ),
        answer
      );
    }
  })
);

it.effect("never repeats an uncertain write and only reports a validated committed ID", () =>
  Effect.gen(function* () {
    for (const [status, response, code, committed] of [
      [null, {}, "unknown_outcome", undefined],
      [503, { additional_data: { committed_resource_id: rowId } }, "unknown_outcome", rowId],
      [500, {}, "unknown_outcome", undefined],
      [200, "lost response", "unknown_outcome", undefined],
      [409, { code: "conflict_error" }, "write_conflict", undefined],
      [409, "unclassified conflict", "unknown_outcome", undefined],
      [529, {}, "source_rate_limited", undefined]
    ] as const) {
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          calls++;
          if (status === null)
            return yield* new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "lost answer" })
            });
          return HttpClientResponse.fromWeb(
            request,
            typeof response === "string"
              ? new Response(response, { status })
              : Response.json(response, { status })
          );
        })
      );
      const failure = yield* Effect.gen(function* () {
        const source = yield* Source.Source;
        return yield* source.send(
          Redacted.make("notion-test"),
          HttpClientRequest.post("/pages"),
          1000,
          undefined,
          true
        );
      }).pipe(
        Effect.provide(
          Layer.effect(Source.Source, Source.make).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
          )
        ),
        Effect.flip
      );
      assert.equal(failure.code, code);
      assert.equal(failure.rowId, committed);
      assert.equal(calls, 1);
    }
  })
);
