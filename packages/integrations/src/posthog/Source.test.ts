import { assert, it } from "@effect/vitest";
import { registry } from "@patchy/limits/registry";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as PostHogDouble from "../test/posthog.js";
import * as Source from "./Source.js";

const product = {
  region: "eu",
  id: 12345,
  key: "phx_sourceTestKey0001",
  pageSize: 2,
  events: [
    { name: "patch.opened", description: "A patch opened in a browser." },
    { name: "$pageview", description: null },
    { name: "company.created" }
  ],
  eventProperties: [
    { name: "$browser", property_type: "String" },
    { name: "duration_ms", property_type: "Numeric", description: "How long it took." }
  ],
  personProperties: [{ name: "email", property_type: "String", description: "" }]
} satisfies PostHogDouble.Project;
const credentials = {
  region: product.region,
  projectId: product.id,
  apiKey: product.key
} satisfies Source.Credentials;

/** The production source over `handler`, with what PostHog received. */
const source = (handler: PostHogDouble.Handler) =>
  Effect.gen(function* () {
    const double = PostHogDouble.make(handler);
    return { source: yield* Source.Source.pipe(Effect.provide(double.layer)), ...double };
  });
const query = (handler: PostHogDouble.Handler, request: Source.QueryRequest) =>
  Effect.gen(function* () {
    const { source: posthog, requests } = yield* source(handler);
    const result = yield* posthog.query(credentials, request).pipe(Effect.result);
    return { result, requests };
  });

it.effect("sends one HogQL query with its name and values, never interpolating them", () =>
  Effect.gen(function* () {
    const hostile = "x'); DROP TABLE events; --";
    const { result, requests } = yield* query(
      PostHogDouble.project({
        ...product,
        query: () => PostHogDouble.rows([["visits", "UInt64"]], [[3]])
      }),
      {
        name: "dailyVisits",
        query:
          "SELECT count() AS visits FROM events WHERE properties.$browser = {browser} LIMIT 10",
        values: { browser: hostile, days: [1, 2] }
      }
    );
    if (result._tag !== "Success") return assert.fail(String(result.failure));
    assert.deepStrictEqual(result.success, {
      columns: ["visits"],
      types: [["visits", "UInt64"]],
      results: [[3]],
      hasMore: false
    });
    assert.strictEqual(requests.length, 1);
    const [request] = requests;
    assert.strictEqual(request!.method, "POST");
    assert.strictEqual(request!.url.href, "https://eu.posthog.com/api/projects/12345/query/");
    assert.strictEqual(request!.authorization, `Bearer ${product.key}`);
    // Default execution: no refresh mode, and the values travel beside the text, unchanged.
    assert.deepStrictEqual(request!.body, {
      query: {
        kind: "HogQLQuery",
        query:
          "SELECT count() AS visits FROM events WHERE properties.$browser = {browser} LIMIT 10",
        values: { browser: hostile, days: [1, 2] },
        name: "dailyVisits"
      }
    });
  })
);

it.effect("names each refusal by PostHog's status, keeping Retry-After only when sent", () =>
  Effect.gen(function* () {
    const refusal = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      query(() => PostHogDouble.json(status, body, headers), {
        name: "refused",
        query: "SELECT 1"
      }).pipe(Effect.map(({ result }) => (result._tag === "Failure" ? result.failure : undefined)));
    const invalid = yield* refusal(400, {
      type: "validation_error",
      code: "syntax_error",
      detail: `Syntax error at line 1, column 7: ${"x".repeat(2_000)}`,
      attr: null
    });
    assert.instanceOf(invalid, Source.InvalidQuery);
    if (invalid instanceof Source.InvalidQuery) {
      assert.strictEqual(invalid.code, "invalid_query");
      assert.strictEqual(invalid.details.message.length, 1_000);
      assert.match(invalid.details.message, /^Syntax error at line 1/);
    }
    const throttled = yield* refusal(
      429,
      { type: "throttled_error", code: "throttled", detail: "Request was throttled.", attr: null },
      { "retry-after": "17" }
    );
    assert.deepInclude(throttled, { reason: "throttled", retryAfterSeconds: 17 });
    const concurrency = yield* refusal(429, {
      type: "throttled_error",
      code: "throttled",
      detail: "Too many concurrent queries.",
      attr: null
    });
    assert.instanceOf(concurrency, Source.RateLimited);
    assert.isFalse(Object.hasOwn(concurrency!, "retryAfterSeconds"));
    const budget = yield* refusal(
      429,
      {
        type: "throttled_error",
        code: "api_queries_budget_exceeded",
        detail: "Query budget exhausted.",
        attr: null
      },
      { "retry-after": "3600" }
    );
    assert.deepInclude(budget, {
      code: "source_rate_limited",
      reason: "api_queries_budget_exceeded",
      retryAfterSeconds: 3600
    });
    assert.instanceOf(yield* refusal(401, { detail: "Invalid key." }), Source.KeyRejected);
    assert.instanceOf(yield* refusal(403, { detail: "No access." }), Source.AccessDenied);
    assert.instanceOf(yield* refusal(404, { detail: "Not found." }), Source.ProjectNotFound);
    assert.deepInclude(yield* refusal(502, "<html>bad gateway</html>"), {
      stage: "status",
      upstreamStatus: 502
    });
  })
);

it.effect("refuses a redirect without following it, wherever it points", () =>
  Effect.gen(function* () {
    const { result, requests } = yield* query(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/api/projects/12345/query/" }
        }),
      { name: "redirected", query: "SELECT 1" }
    );
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.deepInclude(result.failure, { stage: "redirect" });
    assert.strictEqual(requests.length, 1);
  })
);

it.effect("refuses a chunked body past the byte cap before decoding it", () =>
  Effect.gen(function* () {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    const { result } = yield* query(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              // An endless body: only the cap stops it.
              sent++;
              controller.enqueue(chunk);
            }
          }),
          { status: 200 }
        ),
      { name: "huge", query: "SELECT 1" }
    );
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.instanceOf(result.failure, Source.TooLarge);
    assert.isAtMost(sent, registry["runtime.result.bytes"].default / chunk.byteLength + 2);
  })
);

it.effect("refuses an answer missing its columns, types or rows", () =>
  Effect.gen(function* () {
    for (const body of [
      { columns: ["a"], results: [[1]] },
      { columns: ["a"], types: [["a", "UInt8"]], results: [[1]], error: "Query failed" },
      { query_status: { complete: false }, columns: ["a"], types: [["a", "UInt8"]] }
    ]) {
      const { result } = yield* query(() => PostHogDouble.json(200, body), {
        name: "partial",
        query: "SELECT 1"
      });
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.deepInclude(result.failure, { stage: "response" });
    }
  })
);

it.effect("tests a key, then reads every definition across pages, sorted and described", () =>
  Effect.gen(function* () {
    const { source: posthog, requests } = yield* source(PostHogDouble.project(product));
    const secret = PostHogDouble.credentials(product);
    assert.deepStrictEqual(yield* posthog.test(secret), {
      region: "eu",
      projectId: 12345,
      keyHint: "phx_…0001"
    });
    const inspected = yield* posthog.inspect(secret);
    assert.deepStrictEqual(inspected.snapshot, {
      version: 1,
      events: [
        { name: "$pageview" },
        { name: "company.created" },
        { name: "patch.opened", description: "A patch opened in a browser." }
      ],
      eventProperties: [
        { name: "$browser", type: "String" },
        { name: "duration_ms", type: "Numeric", description: "How long it took." }
      ],
      personProperties: [{ name: "email", type: "String" }]
    });
    // Two event pages, one page of each property kind, after the test query.
    assert.deepStrictEqual(
      requests.slice(1).map((request) => `${request.url.pathname}${request.url.search}`),
      [
        "/api/projects/12345/query/",
        "/api/projects/12345/event_definitions/?limit=500",
        "/api/projects/12345/event_definitions/?limit=500&offset=2",
        "/api/projects/12345/property_definitions/?limit=500&type=event",
        "/api/projects/12345/property_definitions/?limit=500&type=person"
      ]
    );
  })
);

it.effect("follows an empty page that still has a next link", () =>
  Effect.gen(function* () {
    const projectHandler = PostHogDouble.project(product);
    const { source: posthog } = yield* source((request) =>
      request.url.pathname.endsWith("/event_definitions/")
        ? request.url.searchParams.has("offset")
          ? PostHogDouble.json(200, { next: null, results: [{ name: "after.empty" }] })
          : PostHogDouble.json(200, {
              next: `${request.url.origin}${request.url.pathname}?offset=1`,
              results: []
            })
        : projectHandler(request)
    );
    const { snapshot } = yield* posthog.inspect(PostHogDouble.credentials(product));
    assert.deepStrictEqual(snapshot.events, [{ name: "after.empty" }]);
  })
);

it.effect("refuses pagination that leaves the project, its host or its kind of property", () =>
  Effect.gen(function* () {
    for (const next of [
      "https://eu.posthog.com/api/projects/999/event_definitions/?offset=2",
      "https://us.posthog.com/api/projects/12345/event_definitions/?offset=2",
      "https://elsewhere.example/api/projects/12345/event_definitions/?offset=2",
      "not a url"
    ]) {
      const projectHandler = PostHogDouble.project(product);
      const { source: posthog, requests } = yield* source((request) =>
        request.url.pathname.endsWith("/event_definitions/")
          ? PostHogDouble.json(200, { next, results: [{ name: "patch.opened" }] })
          : projectHandler(request)
      );
      const refused = yield* posthog.inspect(PostHogDouble.credentials(product)).pipe(Effect.flip);
      assert.deepInclude(refused, { stage: "pagination" }, next);
      assert.isFalse(requests.some((request) => request.url.href === next));
    }
  })
);

it.effect("refuses discovery past its bounds instead of keeping part of it", () =>
  Effect.gen(function* () {
    const many = Array.from(
      { length: registry["posthog.discovery.entries"].default + 1 },
      (_, index) => ({ name: `event.${index}` })
    );
    const overflow = yield* source(
      PostHogDouble.project({ ...product, pageSize: 5_000, events: many })
    ).pipe(
      Effect.flatMap(({ source }) => source.inspect(PostHogDouble.credentials(product))),
      Effect.flip
    );
    assert.deepInclude(overflow, { limitId: "posthog.discovery.entries" });

    const endless = yield* source((request) =>
      request.url.pathname.endsWith("/query/")
        ? PostHogDouble.rows([["1", "UInt8"]], [[1]])
        : PostHogDouble.json(200, {
            next: `${request.url.origin}${request.url.pathname}?offset=${Math.random()}${request.url.search.includes("type") ? `&type=${request.url.searchParams.get("type")}` : ""}`,
            results: [{ name: `event.${Math.random()}` }]
          })
    ).pipe(
      Effect.flatMap(({ source }) => source.inspect(PostHogDouble.credentials(product))),
      Effect.flip
    );
    assert.deepInclude(endless, { limitId: "posthog.discovery.pages" });
  })
);

it.effect("cuts a description past the bound and marks it, keeping surrogate pairs whole", () =>
  Effect.gen(function* () {
    const limit = registry["posthog.discovery.description"].default;
    const exact = "e".repeat(limit);
    const long = "d".repeat(limit + 1);
    // The cut lands inside an emoji, which must not be split.
    const emoji = `${"d".repeat(limit - " [truncated]".length - 1)}${"😀".repeat(10)}`;
    const { source: posthog } = yield* source(
      PostHogDouble.project({
        ...product,
        events: [
          { name: "a.exact", description: exact },
          { name: "b.long", description: long },
          { name: "c.emoji", description: emoji }
        ]
      })
    );
    const { snapshot } = yield* posthog.inspect(PostHogDouble.credentials(product));
    const [kept, cut, pair] = snapshot.events.map((event) => event.description!);
    assert.strictEqual(kept, exact);
    assert.strictEqual(cut, `${"d".repeat(limit - " [truncated]".length)} [truncated]`);
    assert.strictEqual(cut!.length, limit);
    assert.isAtMost(pair!.length, limit);
    assert.isTrue(pair!.endsWith(" [truncated]"));
    assert.notMatch(pair!, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  })
);

it.effect("refuses credentials that aren't a region, a project and a personal key", () =>
  Effect.gen(function* () {
    const { source: posthog, requests } = yield* source(PostHogDouble.project(product));
    for (const secret of [
      JSON.stringify({ region: "ap", projectId: 1, apiKey: product.key }),
      JSON.stringify({ region: "us", projectId: -1, apiKey: product.key }),
      JSON.stringify({ region: "us", projectId: 1, apiKey: "phc_projectToken0001" }),
      "postgresql://reader@warehouse.example/sales"
    ])
      assert.instanceOf(
        yield* posthog.test(Redacted.make(secret)).pipe(Effect.flip),
        Source.InvalidCredentials
      );
    assert.strictEqual(requests.length, 0);
  })
);

it.effect("gives up on an unanswered connection test at its deadline", () =>
  Effect.gen(function* () {
    const { source: posthog } = yield* source(() => new Promise<Response>(() => {}));
    const fiber = yield* posthog.test(PostHogDouble.credentials(product)).pipe(Effect.forkChild);
    yield* TestClock.adjust(registry["integration.deadline"].default);
    const refused = yield* Fiber.join(fiber).pipe(Effect.flip);
    assert.instanceOf(refused, Source.Timeout);
  })
);

it.effect("queues past a project's running queries and refuses busy before the deadline", () =>
  Effect.gen(function* () {
    const releases: Array<() => void> = [];
    const { source: posthog, requests } = yield* source(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(PostHogDouble.rows([["1", "UInt8"]], [[1]])));
        })
    );
    const slots = registry["posthog.queries.concurrent"].default;
    const run = (deadline: number) =>
      posthog
        .withSlot(
          credentials,
          deadline
        )(posthog.query(credentials, { name: "slow", query: "SELECT 1" }))
        .pipe(Effect.forkChild);
    const running = yield* Effect.forEach(Array.from({ length: slots }), () => run(60_000));
    for (let turn = 0; turn < 100 && requests.length < slots; turn++) yield* Effect.yieldNow;
    assert.strictEqual(requests.length, slots);
    // Another connection to the same project shares the gate; a different project does not.
    const queued = yield* run(5_000);
    const refused = yield* run(3_000);
    const elsewhere = yield* posthog
      .withSlot(
        { ...credentials, projectId: 54321 },
        3_000
      )(Effect.succeed("ran"))
      .pipe(Effect.forkChild);
    assert.strictEqual(yield* Fiber.join(elsewhere), "ran");
    yield* TestClock.adjust("2 seconds");
    assert.instanceOf(yield* Fiber.join(refused).pipe(Effect.flip), Source.Busy);
    assert.strictEqual(requests.length, slots);
    releases.shift()!();
    yield* Fiber.join(running[0]!);
    for (let turn = 0; turn < 100 && requests.length === slots; turn++) yield* Effect.yieldNow;
    assert.strictEqual(requests.length, slots + 1);
    for (const release of releases.splice(0)) release();
    yield* Fiber.join(queued);
    yield* Effect.forEach(running.slice(1), Fiber.join);
  })
);
