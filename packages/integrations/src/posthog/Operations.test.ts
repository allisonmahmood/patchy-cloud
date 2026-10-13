import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import { Binding } from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ConnectionStore from "../ConnectionStore.js";
import * as ConnectionStoreDev from "../ConnectionStoreDev.js";
import * as PostHogDouble from "../test/posthog.js";
import * as Operations from "./Operations.js";

const declaration = {
  kind: "posthog" as const,
  id: "conn_product",
  handle: "product",
  revision: 1
};
const binding = Binding.Binding.of({
  companyId: "cmp_posthog",
  patchId: "posthogops01",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 1,
    tables: {},
    files: {},
    uses: {
      analytics: declaration,
      warehouse: { kind: "postgres", id: "conn_warehouse", handle: "warehouse", revision: 1 }
    }
  },
  wireVersion: WIRE_VERSION,
  scope: "company",
  correlationId: "posthog-operation-test",
  principal: { userId: "usr_posthog" },
  identity: {
    user: { id: "usr_posthog", email: "member@example.test", name: "Member" },
    company: { id: "cmp_posthog", handle: "posthog", name: "Northwind" },
    admin: false
  }
});
const project = {
  region: "us",
  id: 12345,
  key: "phx_operationsKey0001"
} satisfies PostHogDouble.Project;
const connection = {
  id: declaration.id,
  companyId: binding.companyId,
  integration: "posthog",
  handle: declaration.handle,
  description: "Production analytics",
  mode: "company",
  status: "connected",
  display: { region: "us", projectId: project.id, keyHint: "phx_…0001" },
  credentialRevision: 1,
  metadataRevision: 1,
  lastTestedAt: null,
  lastDiscoveredAt: null,
  createdBy: "usr_admin"
} satisfies ConnectionStore.Connection;

/** The handler over a PostHog double, with the connection's live state and credentials. */
const operations = Effect.fn("test.posthogOperations")(function* (handler: PostHogDouble.Handler) {
  const double = PostHogDouble.make(handler);
  const store = yield* ConnectionStore.ConnectionStore.pipe(
    Effect.provide(
      ConnectionStoreDev.layer([
        {
          connection,
          snapshots: [
            {
              revision: 1,
              metadata: {
                integration: "posthog",
                snapshot: { version: 1, events: [], eventProperties: [], personProperties: [] }
              }
            }
          ]
        }
      ])
    )
  );
  const live = {
    connection: connection as ConnectionStore.Connection,
    secret: PostHogDouble.credentials(project)
  };
  const liveStore = ConnectionStore.ConnectionStore.of({
    ...store,
    get: (companyId, id) =>
      companyId === live.connection.companyId && id === live.connection.id
        ? Effect.succeed(live.connection)
        : store.get(companyId, id),
    poolCredentials: () => Effect.succeed(live.secret)
  });
  const handlers = yield* Operations.makeHandlers.pipe(
    Effect.provide(double.layer),
    Effect.provideService(ConnectionStore.ConnectionStore, liveStore)
  );
  const call = (args: unknown, requestBinding: Binding.Binding["Service"] = binding) =>
    handlers["posthog.query"]
      .run(args)
      .pipe(Effect.provideService(Binding.Binding, requestBinding));
  return { call, requests: double.requests, live };
});
const rowsOf = (
  columns: ReadonlyArray<readonly [string, string]>,
  results: ReadonlyArray<ReadonlyArray<unknown>>,
  extra = {}
) =>
  PostHogDouble.project({ ...project, query: () => PostHogDouble.rows(columns, results, extra) });
const request = (
  shape: Record<string, { kind: string; optional?: boolean }>,
  query = "SELECT 1"
) => ({
  connection: "analytics",
  name: "dailyVisits",
  query,
  values: { since: "2026-10-01" },
  shape
});

it.effect("maps ClickHouse columns through the shape, in UTC, dropping extra columns", () =>
  Effect.gen(function* () {
    const { call } = yield* operations(
      rowsOf(
        [
          ["day", "DateTime64(6, 'Europe/Berlin')"],
          ["visits", "UInt64"],
          ["browser", "LowCardinality(Nullable(String))"],
          ["share", "Float64"],
          ["returning", "UInt8"],
          ["props", "Map(String, String)"],
          ["ignored", "Decimal(18, 2)"]
        ],
        [
          ["2026-10-01T02:30:00.123456+02:00", 3, "Firefox", 0.25, 1, { a: "b" }, 1.5],
          ["2026-10-02 00:00:00", 9007199254740991, null, 1, 0, {}, 2]
        ]
      )
    );
    assert.deepStrictEqual(
      yield* call(
        request({
          day: { kind: "timestamp" },
          visits: { kind: "integer" },
          browser: { kind: "text", optional: true },
          share: { kind: "number" },
          returning: { kind: "boolean" },
          props: { kind: "json" }
        })
      ),
      {
        ok: true,
        rows: [
          {
            day: "2026-10-01T00:30:00.123456Z",
            visits: 3,
            browser: "Firefox",
            share: 0.25,
            returning: true,
            props: { a: "b" }
          },
          {
            day: "2026-10-02T00:00:00.000000Z",
            visits: 9007199254740991,
            browser: null,
            share: 1,
            returning: false,
            props: {}
          }
        ]
      }
    );
  })
);

it.effect("returns an empty result, and a full one when the query sets its own LIMIT", () =>
  Effect.gen(function* () {
    const empty = yield* operations(rowsOf([["n", "UInt64"]], []));
    assert.deepStrictEqual(yield* empty.call(request({ n: { kind: "integer" } })), {
      ok: true,
      rows: []
    });
    const limited = yield* operations(
      rowsOf(
        [["n", "UInt64"]],
        Array.from({ length: 1_000 }, (_, index) => [index])
      )
    );
    const result = yield* limited.call(
      request({ n: { kind: "integer" } }, "SELECT number AS n FROM numbers(5000) LIMIT 1000")
    );
    assert.strictEqual((result as { rows: unknown[] }).rows.length, 1_000);
  })
);

it.effect("refuses a result PostHog cut short, or one past 1,000 rows", () =>
  Effect.gen(function* () {
    const cut = yield* operations(rowsOf([["n", "UInt64"]], [[1]], { hasMore: true }));
    const truncated = yield* cut.call(request({ n: { kind: "integer" } })).pipe(Effect.flip);
    assert.instanceOf(truncated, Operations.Truncated);
    assert.include(truncated.message, "LIMIT of at most 1000");
    const many = yield* operations(
      rowsOf(
        [["n", "UInt64"]],
        Array.from({ length: 1_001 }, (_, index) => [index])
      )
    );
    assert.instanceOf(
      yield* many.call(request({ n: { kind: "integer" } })).pipe(Effect.flip),
      Operations.TooManyRows
    );
  })
);

it.effect("refuses shapes the result can't fill, naming the column", () =>
  Effect.gen(function* () {
    const mismatch = (
      columns: ReadonlyArray<readonly [string, string]>,
      results: ReadonlyArray<ReadonlyArray<unknown>>,
      shape: Record<string, { kind: string; optional?: boolean }>
    ) =>
      operations(rowsOf(columns, results)).pipe(
        Effect.flatMap(({ call }) => call(request(shape))),
        Effect.flip,
        Effect.map((error) => (error instanceof Operations.ShapeMismatch ? error.details : error))
      );
    assert.deepStrictEqual(yield* mismatch([["a", "UInt8"]], [[1]], { b: { kind: "integer" } }), {
      column: "b",
      reason: "missing"
    });
    assert.deepStrictEqual(
      yield* mismatch(
        [
          ["a", "UInt8"],
          ["a", "UInt8"]
        ],
        [[1, 2]],
        { a: { kind: "integer" } }
      ),
      { column: "a", reason: "duplicate" }
    );
    assert.deepStrictEqual(
      yield* mismatch([["revenue", "Decimal(18, 2)"]], [[1.5]], { revenue: { kind: "json" } }),
      { column: "revenue", reason: "type", type: "Decimal(18, 2)" }
    );
    assert.deepStrictEqual(
      yield* mismatch([["total", "UInt64"]], [[2 ** 53]], { total: { kind: "number" } }),
      { column: "total", reason: "value", type: "UInt64" }
    );
    assert.deepStrictEqual(
      yield* mismatch([["flag", "UInt8"]], [[2]], { flag: { kind: "boolean" } }),
      { column: "flag", reason: "value", type: "UInt8" }
    );
    assert.deepStrictEqual(
      yield* mismatch([["who", "Nullable(String)"]], [[null]], { who: { kind: "text" } }),
      { column: "who", reason: "null" }
    );
    assert.deepStrictEqual(
      yield* mismatch([["a", "UInt8"]], [[1, 2]], { a: { kind: "integer" } }),
      { column: "", reason: "row_width" }
    );
    // Rounded types are refused at any depth, and wide integers or unknown types at all.
    for (const [type, kind, raw] of [
      ["Tuple(Decimal(18, 2), String)", "json", [1.5, "a"]],
      ["Int128", "integer", 1],
      ["Array(UInt256)", "json", [1]],
      ["AggregateFunction(uniq, String)", "json", "opaque"]
    ] as const)
      assert.deepStrictEqual(yield* mismatch([["c", type]], [[raw]], { c: { kind } }), {
        column: "c",
        reason: "type",
        type
      });
    for (const [type, raw] of [
      ["Array(UInt64)", [1, 2 ** 53]],
      ["Map(String, Nullable(Int64))", { a: 2 ** 60 }]
    ] as const)
      assert.deepStrictEqual(yield* mismatch([["c", type]], [[raw]], { c: { kind: "json" } }), {
        column: "c",
        reason: "value",
        type
      });
  })
);

it.effect("keeps composite values whose integers are exact", () =>
  Effect.gen(function* () {
    const { call } = yield* operations(
      rowsOf([["counts", "Array(UInt64)"]], [[[1, 9007199254740991]]])
    );
    assert.deepStrictEqual(yield* call(request({ counts: { kind: "json" } })), {
      ok: true,
      rows: [{ counts: [1, 9007199254740991] }]
    });
  })
);

it.effect("refuses undeclared aliases, other kinds, public versions and other companies", () =>
  Effect.gen(function* () {
    const { call, requests, live } = yield* operations(PostHogDouble.project(project));
    const code = (args: unknown, requestBinding?: Binding.Binding["Service"]) =>
      call(args, requestBinding).pipe(
        Effect.flip,
        Effect.map((error) => error.code)
      );
    const query = request({ n: { kind: "integer" } });
    assert.strictEqual(yield* code({ ...query, connection: "missing" }), "connection_not_declared");
    assert.strictEqual(
      yield* code({ ...query, connection: "warehouse" }),
      "connection_not_declared"
    );
    assert.strictEqual(yield* code(query, { ...binding, scope: "public" }), "access_denied");
    assert.strictEqual(
      yield* code(query, {
        ...binding,
        companyId: "cmp_other",
        identity: {
          ...binding.identity!,
          company: { ...binding.identity!.company, id: "cmp_other" }
        }
      }),
      "access_denied"
    );
    live.connection = { ...connection, status: "disconnected" };
    assert.strictEqual(yield* code(query), "access_denied");
    // A name too long for PostHog's query log is refused before anything is sent.
    assert.strictEqual(yield* code({ ...query, name: "n".repeat(101) }), "invalid_request");
    assert.strictEqual(requests.length, 0);
  })
);

it.effect("surfaces PostHog's own refusals without retrying", () =>
  Effect.gen(function* () {
    const refused = (response: Response) =>
      operations(PostHogDouble.project({ ...project, query: () => response })).pipe(
        Effect.flatMap(({ call, requests }) =>
          call(request({ n: { kind: "integer" } })).pipe(
            Effect.flip,
            Effect.map((error) => ({ error, sent: requests.length }))
          )
        )
      );
    const invalid = yield* refused(
      PostHogDouble.json(400, {
        type: "validation_error",
        code: "syntax_error",
        detail: "Unknown table: evnts"
      })
    );
    assert.deepInclude(invalid.error, {
      code: "invalid_query",
      details: { message: "Unknown table: evnts" }
    });
    const limited = yield* refused(
      PostHogDouble.json(
        429,
        { type: "throttled_error", code: "throttled", detail: "Slow down." },
        {
          "retry-after": "30"
        }
      )
    );
    assert.deepInclude(limited.error, { code: "source_rate_limited", retryAfterSeconds: 30 });
    assert.strictEqual(limited.sent, 1);
    const revoked = yield* refused(PostHogDouble.json(401, { detail: "Invalid key." }));
    assert.instanceOf(revoked.error, Operations.ConnectionRefused);
    assert.deepInclude(revoked.error, { code: "source_unavailable" });
  })
);

it.effect(
  "re-reads the connection after waiting for a slot and never sends to a project it left",
  () =>
    Effect.gen(function* () {
      const releases: Array<() => void> = [];
      const { call, requests, live } = yield* operations(
        PostHogDouble.project({
          ...project,
          query: () =>
            new Promise<Response>((resolve) => {
              releases.push(() => resolve(PostHogDouble.rows([["n", "UInt8"]], [[1]])));
            })
        })
      );
      const deadline = { ...binding, deadline: 60_000 };
      const query = request({ n: { kind: "integer" } });
      const running = yield* Effect.forEach(
        Array.from({ length: registry["posthog.queries.concurrent"].default }),
        () => call(query, deadline).pipe(Effect.forkChild)
      );
      for (let turn = 0; turn < 100 && requests.length < running.length; turn++)
        yield* Effect.yieldNow;
      const queued = yield* call(query, deadline).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      // While it waits, an admin points the connection at another project.
      live.secret = PostHogDouble.credentials({ ...project, id: 777 });
      releases.shift()!();
      const refused = yield* Fiber.join(queued).pipe(Effect.flip);
      assert.strictEqual(refused.code, "source_unavailable");
      assert.isFalse(requests.some((request) => request.url.pathname.includes("/777/")));
      for (const release of releases.splice(0)) release();
      yield* Effect.forEach(running, Fiber.join);
    })
);
