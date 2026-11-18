import { assert, it } from "@effect/vitest";
import { ContractLimits } from "@patchy/limits";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as NotionDouble from "../test/notion.js";
import * as Source from "./Source.js";

it.effect("discovers both search pages and keeps a relation to a source on the next page", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const snapshot = yield* notion.inspect(Redacted.make(NotionDouble.internalToken), "read");
    assert.strictEqual(snapshot.workspace.name, "Notion Probe");
    assert.strictEqual(snapshot.access, "read");
    assert.deepStrictEqual(snapshot.dataSources.map(({ key }) => key).sort(), [
      "Projects",
      "Tasks"
    ]);
    const tasks = snapshot.dataSources.find(({ key }) => key === "Tasks")!;
    const projects = snapshot.dataSources.find(({ key }) => key === "Projects")!;
    assert.strictEqual(tasks.databaseTitle, "Project Tracker");
    assert.strictEqual(tasks.url, "https://app.notion.com/p/d52c7f0776a54f6fb33d88d496058f41");
    assert.deepStrictEqual(snapshot.exclusions, [
      { source: "Tasks", name: "Days open", reason: "unsupported_type" },
      { source: "Tasks", name: "Internal project", reason: "unshared_relation" }
    ]);
    assert.strictEqual(
      tasks.properties.find(({ name }) => name === "Project")?.relationTarget,
      projects.id
    );
    assert.deepStrictEqual(tasks.properties.find(({ type }) => type === "status")?.groups, [
      { id: "todo-group", name: "To do", optionIds: ["todo"] },
      { id: "done-group", name: "Complete", optionIds: ["done"] }
    ]);
  }).pipe(Effect.provide(NotionDouble.layer))
);

it.effect("refuses personal keys and replacement keys from another workspace", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const personal = yield* notion
      .inspect(Redacted.make(NotionDouble.personalToken), "read")
      .pipe(Effect.flip);
    assert.strictEqual(personal.code, "notion_not_workspace_key");
    const other = yield* notion
      .inspect(Redacted.make(NotionDouble.internalToken), "read", "a-different-workspace")
      .pipe(Effect.flip);
    assert.strictEqual(other.code, "notion_other_workspace");
  }).pipe(Effect.provide(NotionDouble.layer))
);

it.effect("refuses a second search page that exceeds the discovery bound", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const failure = yield* notion
      .inspect(Redacted.make(NotionDouble.internalToken), "read")
      .pipe(Effect.flip);
    assert.strictEqual(failure.code, "too_large");
    assert.strictEqual(
      failure.message,
      "Notion discovery exceeded the Patchy limit for data sources (1). Nothing was saved."
    );
  }).pipe(
    Effect.provide(NotionDouble.layer),
    Effect.provideService(ContractLimits.overrides, { "notion.discovery.sources": 1 })
  )
);

it.effect("classifies Notion refusals without returning the upstream message", () =>
  Effect.gen(function* () {
    for (const [status, message, code, missing] of [
      [400, "Could not find property with name or id: Old field", "shape_mismatch", "Old field"],
      [
        400,
        'status option "Old status" not found for property "Status".',
        "shape_mismatch",
        "Old status"
      ],
      [
        400,
        "body failed validation. Fix one:\nbody.filter.date.equals should be a valid ISO 8601 date string",
        "invalid_request",
        undefined
      ],
      [400, "body.filter is invalid", "invalid_query", undefined],
      [401, "Upstream detail", "source_unavailable", undefined],
      [403, "Upstream detail", "access_denied", undefined],
      [403, "Workspace block limit reached", "source_unavailable", undefined],
      [404, "Upstream detail", "not_found", undefined],
      [409, "Upstream detail", "write_conflict", undefined],
      [429, "Upstream detail", "source_rate_limited", undefined],
      [529, "Upstream detail", "source_rate_limited", undefined],
      [500, "Upstream detail", "source_unavailable", undefined]
    ] as const) {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              {
                code: "validation_error",
                message,
                retry_after: 4
              },
              { status }
            )
          )
        )
      );
      const provider = Layer.effect(Source.Source, Source.make).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
      );
      const refusal = yield* Effect.gen(function* () {
        const notion = yield* Source.Source;
        return yield* notion.check(Redacted.make(NotionDouble.internalToken)).pipe(Effect.flip);
      }).pipe(Effect.provide(provider));
      assert.strictEqual(refusal.code, code);
      assert.strictEqual(refusal.missing?.name, missing);
      if (code === "source_rate_limited") assert.strictEqual(refusal.retryAfterSeconds, 4);
      assert.notInclude(refusal.message, message);
    }
  })
);

it.effect("refuses a queued call before dispatch when all connection slots stay occupied", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const slots = yield* ContractLimits.get("notion.calls.concurrent");
    const deadline = yield* ContractLimits.get("notion.discovery.deadline");
    const hold = yield* Deferred.make<void>();
    for (let i = 0; i < slots; i++) {
      const entered = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        notion.withSlot("same-connection", () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(hold)))
        )
      );
      yield* Deferred.await(entered);
    }
    const queued = yield* Effect.forkScoped(
      notion.withSlot("same-connection", () => Effect.die("Queued call was dispatched"))
    );
    yield* TestClock.adjust(deadline - 1000);
    const refusal = yield* Fiber.join(queued).pipe(Effect.flip);
    assert.strictEqual(refusal.code, "busy");
    yield* Deferred.succeed(hold, undefined);
  }).pipe(Effect.provide(NotionDouble.layer))
);
