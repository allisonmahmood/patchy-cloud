import { assert, it } from "@effect/vitest";
import { ContractLimits } from "@patchy/limits";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as NotionDouble from "../test/notion.js";
import * as Source from "./Source.js";

const internal = Redacted.make(NotionDouble.internalToken);

it.effect("discovers both search pages and keeps a relation to a source on the next page", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const snapshot = yield* notion.inspect(internal, "read");
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
      .inspect(internal, "read", "a-different-workspace")
      .pipe(Effect.flip);
    assert.strictEqual(other.code, "notion_other_workspace");
  }).pipe(Effect.provide(NotionDouble.layer))
);

it.effect("refuses an answer past the byte cap before decoding it", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const refusal = yield* notion.inspect(internal, "read").pipe(Effect.flip);
    assert.strictEqual(refusal.code, "too_large");
  }).pipe(
    Effect.provide(NotionDouble.layer),
    Effect.provideService(ContractLimits.overrides, { "notion.response.bytes": 64 })
  )
);

it.effect("draws a call's budget down across its requests and refuses the one past it", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const me = HttpClientRequest.get("/users/me");
    const budget = { remaining: 10_000 };
    yield* notion.send(internal, me, { budget });
    const used = 10_000 - budget.remaining;
    assert.isAbove(used, 0);
    budget.remaining = used - 1;
    const refusal = yield* notion.send(internal, me, { budget }).pipe(Effect.flip);
    assert.strictEqual(refusal.code, "too_large");
  }).pipe(Effect.provide(NotionDouble.layer))
);

/** A Notion that answers every request with `status` and an error body in its own words. */
const answering = (status: number, body: Record<string, unknown> = {}) =>
  Layer.effect(Source.Source, Source.make).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                { object: "error", status, message: "Upstream detail", ...body },
                { status }
              )
            )
          )
        )
      )
    )
  );
const upstream = (status: number, body?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    return yield* notion.send(internal, HttpClientRequest.get("/users/me")).pipe(Effect.flip);
  }).pipe(Effect.provide(answering(status, body)));

const statuses: ReadonlyArray<{
  readonly status: number;
  readonly code: Source.Refusal["code"];
  readonly body?: Record<string, unknown>;
}> = [
  { status: 400, code: "invalid_request" },
  { status: 401, code: "source_unavailable" },
  { status: 403, code: "access_denied" },
  { status: 403, code: "source_unavailable", body: { additional_data: { limit_kind: "block" } } },
  { status: 404, code: "not_found" },
  { status: 409, code: "write_conflict" },
  { status: 429, code: "source_rate_limited", body: { retry_after: 4 } },
  { status: 529, code: "source_rate_limited" },
  { status: 500, code: "source_unavailable" }
];
for (const { status, code, body } of statuses)
  it.effect(`classifies Notion's ${status}${body ? " with its details" : ""} as ${code}`, () =>
    Effect.gen(function* () {
      const refusal = yield* upstream(status, body);
      assert.strictEqual(refusal.code, code);
      assert.notInclude(refusal.message, "Upstream detail");
      if (status === 429) assert.strictEqual(refusal.retryAfterSeconds, 4);
      if (status === 401) assert.include(refusal.message, "token");
    })
  );

it.effect("refuses a queued call before dispatch when all of the bot's slots stay occupied", () =>
  Effect.gen(function* () {
    const notion = yield* Source.Source;
    const slots = yield* ContractLimits.get("notion.calls.concurrent");
    const deadline = 10_000;
    const hold = yield* Deferred.make<void>();
    for (let i = 0; i < slots; i++) {
      const entered = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        notion.withSlot(
          "same-bot",
          deadline
        )(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(hold))))
      );
      yield* Deferred.await(entered);
    }
    const queued = yield* Effect.forkScoped(
      notion.withSlot("same-bot", deadline)(Effect.die("Queued call was dispatched"))
    );
    yield* TestClock.adjust(deadline - 1000);
    const refusal = yield* Fiber.join(queued).pipe(Effect.flip);
    assert.strictEqual(refusal.code, "busy");
    yield* Deferred.succeed(hold, undefined);
  }).pipe(Effect.provide(NotionDouble.layer))
);
