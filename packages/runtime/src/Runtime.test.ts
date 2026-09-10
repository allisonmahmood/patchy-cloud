import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  PostgresList,
  PostgresPage,
  PostgresQuery,
  PostgresRows,
  RuntimeFailure,
  WIRE_VERSION
} from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { PUBLIC_BASE_URL, signedInCookies } from "@patchy/auth/testing";
import * as Binding from "./Binding.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as Fixtures from "./test/fixtures.js";
import { me } from "./me.js";

const decodeFailure = Schema.decodeUnknownSync(RuntimeFailure);
const envelope = (op: string, args: unknown = {}) => ({
  patchId: Fixtures.patchId,
  versionId: Fixtures.versionId,
  principal: { userId: DEV_SEED.userId },
  wire: WIRE_VERSION,
  op,
  args
});
const authenticatedHeaders = () => ({
  ...Fixtures.headers({ userId: DEV_SEED.userId }),
  cookie: signedInCookies(),
  origin: PUBLIC_BASE_URL
});

const connectionId = (_args: unknown, binding: Binding.Binding["Service"]) => {
  const declaration = binding.manifest.uses.sales;
  return declaration?.kind === "postgres" ? declaration.id : null;
};
const queryText = (args: unknown) =>
  typeof args === "object" && args !== null && "sql" in args && typeof args.sql === "string"
    ? args.sql
    : undefined;

it.effect(
  "logs trusted connection metadata before query decoding and preserves source error details",
  () =>
    Effect.gen(function* () {
      const api = yield* Fixtures.client;
      const query = `SELECT $1 -- ${"é".repeat(5000)}`;
      const args = {
        connection: "sales",
        sql: query,
        params: ["parameter-secret"],
        shape: { result: { kind: "text" } }
      };
      for (const [payload, code] of [
        [{ ...args, connectionId: "forged-connection" }, "invalid_request"],
        [args, "invalid_query"]
      ] as const) {
        const response = yield* api.call({
          payload: envelope("postgres.query", payload),
          headers: authenticatedHeaders(),
          responseMode: "response-only"
        });
        const refusal = decodeFailure(yield* response.json);
        assert.strictEqual(refusal.code, code);
        const log = yield* RuntimeLog.RuntimeLog;
        const call = yield* log.find({
          companyId: DEV_SEED.companyId,
          correlationId: refusal.correlationId!
        });
        assert.strictEqual(call?.connectionId, "connection-runtime");
        assert.strictEqual(call?.companyId, DEV_SEED.companyId);
        assert.strictEqual(call?.userId, DEV_SEED.userId);
        assert.strictEqual(call?.versionId, Fixtures.versionId);
        assert.strictEqual(call?.outcomeCode, code);
        assert.strictEqual(new TextEncoder().encode(call!.sql!).byteLength, 8191);
        assert.isTrue(query.startsWith(call!.sql!));
        assert.notInclude(JSON.stringify(call), "parameter-secret");
        if (code === "invalid_query")
          assert.deepStrictEqual(refusal.details, {
            sqlstate: "42703",
            message: "column does not exist",
            position: "8"
          });
      }
      const listed = yield* api.call({
        payload: envelope("postgres.list", {
          connection: "sales",
          relation: { schema: "public", name: "orders" }
        }),
        headers: authenticatedHeaders(),
        responseMode: "response-only"
      });
      assert.strictEqual(listed.status, 200);
      const log = yield* RuntimeLog.RuntimeLog;
      const calls = yield* log.recent({
        companyId: DEV_SEED.companyId,
        connectionId: "connection-runtime"
      });
      const list = calls.find((call) => call.op === "postgres.list")!;
      assert.strictEqual(list.sql, null);
      assert.strictEqual(list.rowCount, 1);
      assert.strictEqual(list.outcome, "success");
    }).pipe(
      Effect.provide(
        Fixtures.layer({
          "postgres.query": Runtime.handler(
            {
              kind: "integration",
              input: PostgresQuery,
              output: PostgresRows,
              connectionId,
              sql: queryText
            },
            () =>
              Effect.fail({
                code: "invalid_query",
                status: 422,
                message: "The query is invalid.",
                details: { sqlstate: "42703", message: "column does not exist", position: "8" }
              } satisfies Runtime.OperationError)
          ),
          "postgres.list": Runtime.handler(
            {
              kind: "integration",
              input: PostgresList,
              output: PostgresPage,
              connectionId,
              sql: () => "generated SQL must not be logged",
              rowCount: () => 1
            },
            () => Effect.succeed({ ok: true, rows: [{ id: 1 }], cursor: null })
          )
        })
      )
    )
);

it.effect(
  "attributes integration origin, principal and size denials without trusting the envelope identity",
  () =>
    Effect.gen(function* () {
      let executions = 0;
      yield* Effect.gen(function* () {
        const api = yield* Fixtures.client;
        const args = {
          connection: "sales",
          sql: "SELECT $1",
          params: ["secret"],
          shape: { result: { kind: "text" } }
        };
        for (const [payload, headers, code] of [
          [
            envelope("postgres.query", args),
            { ...authenticatedHeaders(), origin: `${PUBLIC_BASE_URL}/` },
            "access_denied"
          ],
          [
            { ...envelope("postgres.query", args), principal: { userId: "forged" } },
            { ...authenticatedHeaders(), "x-patchy-principal": '{"userId":"forged"}' },
            "principal_changed"
          ],
          [
            envelope("postgres.query", { ...args, params: ["x".repeat(256 * 1024)] }),
            authenticatedHeaders(),
            "too_large"
          ]
        ] as const) {
          const response = yield* api.call({ payload, headers, responseMode: "response-only" });
          const refusal = decodeFailure(yield* response.json);
          assert.strictEqual(refusal.code, code);
          const log = yield* RuntimeLog.RuntimeLog;
          const call = yield* log.find({
            companyId: DEV_SEED.companyId,
            correlationId: refusal.correlationId!
          });
          assert.strictEqual(call?.connectionId, "connection-runtime");
          assert.strictEqual(call?.userId, DEV_SEED.userId);
          assert.strictEqual(call?.companyId, DEV_SEED.companyId);
          assert.strictEqual(call?.outcome, "failure");
          assert.strictEqual(call?.outcomeCode, code);
          assert.strictEqual(call?.sql, "SELECT $1");
        }
        assert.strictEqual(executions, 0);
        for (let index = 0; index < 3; index++) {
          const response = yield* api.call({
            payload: envelope("postgres.query", args),
            headers: authenticatedHeaders(),
            responseMode: "response-only"
          });
          assert.strictEqual(response.status, 200);
        }
        const limited = yield* api.call({
          payload: envelope("postgres.query", args),
          headers: authenticatedHeaders(),
          responseMode: "response-only"
        });
        const refusal = decodeFailure(yield* limited.json);
        assert.strictEqual(refusal.code, "rate_limited");
        const log = yield* RuntimeLog.RuntimeLog;
        const call = yield* log.find({
          companyId: DEV_SEED.companyId,
          correlationId: refusal.correlationId!
        });
        assert.strictEqual(call?.connectionId, "connection-runtime");
        assert.strictEqual(call?.outcomeCode, "rate_limited");
        assert.strictEqual(executions, 3);
      }).pipe(
        Effect.provide(
          Fixtures.layer({
            "postgres.query": Runtime.handler(
              {
                kind: "integration",
                input: PostgresQuery,
                output: PostgresRows,
                connectionId,
                sql: queryText
              },
              () =>
                Effect.sync(() => {
                  executions++;
                  return { ok: true as const, rows: [] };
                })
            )
          })
        )
      );
    })
);
it.effect(
  "a mutation refuses wrong origins before execution and uses only the admitted binding",
  () =>
    Effect.gen(function* () {
      const api = yield* Fixtures.client;
      const payload = envelope("tables.insert", { companyId: "forged", correlationId: "forged" });
      for (const origin of [undefined, "null", "https://foreign.example", `${PUBLIC_BASE_URL}/`]) {
        const response = yield* api.call({
          payload,
          headers: {
            ...Fixtures.headers({ userId: DEV_SEED.userId }),
            cookie: signedInCookies(),
            ...(origin === undefined ? {} : { origin })
          },
          responseMode: "response-only"
        });
        assert.include(yield* response.json, { code: "access_denied" });
      }
      const runtime = yield* Runtime.Runtime;
      const result = yield* runtime.call(payload).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`${PUBLIC_BASE_URL}/api/runtime/call`, {
              method: "POST",
              headers: authenticatedHeaders()
            })
          )
        )
      );
      assert.deepInclude(result, {
        companyId: DEV_SEED.companyId,
        userId: DEV_SEED.userId,
        patchId: Fixtures.patchId,
        versionId: Fixtures.versionId
      });
    }).pipe(
      Effect.provide(
        Fixtures.layer({
          me,
          "tables.insert": {
            kind: "mutation",
            run: () =>
              Effect.map(Binding.Binding, (binding) => ({
                companyId: binding.companyId,
                userId: binding.principal?.userId,
                patchId: binding.patchId,
                versionId: binding.versionId
              }))
          }
        })
      )
    )
);

it.effect("a failing handler's HTTP correlation finds the attributed failure row", () =>
  Effect.gen(function* () {
    const api = yield* Fixtures.client;
    const response = yield* api.call({
      payload: envelope("tables.insert"),
      headers: authenticatedHeaders(),
      responseMode: "response-only"
    });
    const failure = decodeFailure(yield* response.json);
    assert.strictEqual(failure.code, "too_large");
    assert.strictEqual(response.status, 413);
    assert.include(failure.error, "1024");
    assert.isDefined(failure.correlationId);
    const log = yield* RuntimeLog.RuntimeLog;
    const row = yield* log.find({
      companyId: DEV_SEED.companyId,
      correlationId: failure.correlationId!
    });
    assert.strictEqual(row?.outcome, "failure");
    assert.strictEqual(row?.userId, DEV_SEED.userId);
    assert.strictEqual(row?.patchId, Fixtures.patchId);
    // In-process consumers can still recover the original domain error by tag.
    const runtime = yield* Runtime.Runtime;
    const maxBytes = yield* runtime.call(envelope("tables.insert")).pipe(
      Effect.catchTags({ TooLarge: (error) => Effect.succeed(error.maxBytes) }),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`${PUBLIC_BASE_URL}/api/runtime/call`, {
            method: "POST",
            headers: authenticatedHeaders()
          })
        )
      )
    );
    assert.strictEqual(maxBytes, 1024);
  }).pipe(
    Effect.provide(
      Fixtures.layer({
        me,
        "tables.insert": {
          kind: "mutation",
          run: () => new Runtime.TooLarge({ maxBytes: 1024 })
        }
      })
    )
  )
);

it.effect(
  "times out the entire integration handler and interrupts its resources before recording the correlated failure",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<Binding.Binding["Service"]>();
      const released = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const api = yield* Fixtures.client;
        const fiber = yield* api
          .call({
            payload: envelope("postgres.query", {
              connection: "sales",
              sql: "SELECT 1",
              params: [],
              shape: { result: { kind: "integer" } }
            }),
            headers: authenticatedHeaders(),
            responseMode: "response-only"
          })
          .pipe(Effect.forkChild);
        const binding = yield* Deferred.await(entered);
        const log = yield* RuntimeLog.RuntimeLog;
        const lookup = { companyId: DEV_SEED.companyId, correlationId: binding.correlationId };
        yield* TestClock.adjust(14_999);
        assert.strictEqual((yield* log.find(lookup))?.outcome, "pending");
        assert.isFalse(yield* Deferred.isDone(released));
        yield* TestClock.adjust(1);
        const response = yield* Fiber.join(fiber);
        const failure = decodeFailure(yield* response.json);
        assert.strictEqual(response.status, 504);
        assert.strictEqual(failure.code, "timeout");
        assert.strictEqual(failure.correlationId, binding.correlationId);
        assert.isTrue(yield* Deferred.isDone(released));
        const call = yield* log.find(lookup);
        assert.strictEqual(call?.outcome, "failure");
        assert.strictEqual(call?.outcomeCode, "timeout");
        assert.strictEqual(call?.connectionId, "connection-runtime");
        assert.strictEqual(call?.durationMs, 15_000);
      }).pipe(
        Effect.provide(
          Fixtures.layer({
            "postgres.query": Runtime.handler(
              {
                kind: "integration",
                input: PostgresQuery,
                output: PostgresRows,
                connectionId,
                sql: queryText
              },
              () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, yield* Binding.Binding);
                  return yield* Effect.never;
                }).pipe(Effect.ensuring(Deferred.succeed(released, undefined)))
            )
          })
        )
      );
    })
);

it.effect(
  "a never-returning handler is logged pending before execution and remains unknown after interruption",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<Binding.Binding["Service"]>();
      yield* Effect.gen(function* () {
        const api = yield* Fixtures.client;
        const fiber = yield* api
          .call({
            payload: envelope("tables.insert"),
            headers: authenticatedHeaders(),
            responseMode: "response-only"
          })
          .pipe(Effect.forkChild);
        const binding = yield* Deferred.await(entered);
        const log = yield* RuntimeLog.RuntimeLog;
        const lookup = { companyId: DEV_SEED.companyId, correlationId: binding.correlationId };
        assert.strictEqual((yield* log.find(lookup))?.outcome, "pending");
        yield* TestClock.adjust(30_001);
        assert.strictEqual((yield* log.find(lookup))?.outcome, "unknown");
        yield* Fiber.interrupt(fiber);
        assert.strictEqual((yield* log.find(lookup))?.outcome, "unknown");
      }).pipe(
        Effect.provide(
          Fixtures.layer({
            me,
            "tables.insert": {
              kind: "mutation",
              run: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, yield* Binding.Binding);
                  return yield* Effect.never;
                })
            }
          })
        )
      );
    })
);

it.effect("operation body bounds count UTF-8 bytes and allow only the operation's own cap", () =>
  Effect.gen(function* () {
    const api = yield* Fixtures.client;
    for (const [op, length, code] of [
      ["me", 64 * 1024, "too_large"],
      ["tables.insert", 64 * 1024, undefined],
      ["tables.insert", 1100 * 1024, "too_large"],
      ["tables.insertMany", 1100 * 1024, undefined],
      ["tables.insertMany", 9 * 1024 * 1024, "too_large"],
      ["postgres.query", 256 * 1024, "too_large"]
    ] as const) {
      const response = yield* api.call({
        payload: envelope(op, { text: "é".repeat(Math.ceil(length / 2)) }),
        headers: authenticatedHeaders(),
        responseMode: "response-only"
      });
      if (code === undefined) {
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(yield* response.json, { ok: true, value: null });
      } else {
        assert.strictEqual(response.status, 413);
        assert.include(yield* response.json, { code });
      }
    }
  }).pipe(
    Effect.provide(
      Fixtures.layer({
        me,
        "tables.insert": { kind: "mutation", run: () => Effect.succeed(null) },
        "tables.insertMany": { kind: "mutation", run: () => Effect.succeed(null) }
      })
    )
  )
);

it.effect("public calls refuse unknown operations before even malformed principal checks", () =>
  Effect.gen(function* () {
    const api = yield* Fixtures.client;
    for (const op of ["tables.insert", "constructor", "__proto__"]) {
      const response = yield* api.call({
        payload: { ...envelope(op), versionId: Fixtures.publicVersionId, principal: "malformed" },
        headers: { ...authenticatedHeaders(), "x-patchy-principal": "malformed" },
        responseMode: "response-only"
      });
      assert.include(yield* response.json, { code: "not_available_on_public" });
      assert.notProperty(yield* response.json, "correlationId");
    }
    const response = yield* api.call({
      payload: envelope("constructor"),
      headers: authenticatedHeaders(),
      responseMode: "response-only"
    });
    assert.include(yield* response.json, { code: "invalid_request" });
  }).pipe(Effect.provide(Fixtures.layer()))
);

it.effect("a logged integration refusal preserves Retry-After with its correlation", () =>
  Effect.gen(function* () {
    const api = yield* Fixtures.client;
    const response = yield* api.call({
      payload: envelope("postgres.query"),
      headers: authenticatedHeaders(),
      responseMode: "response-only"
    });
    const failure = decodeFailure(yield* response.json);
    assert.strictEqual(response.status, 429);
    assert.strictEqual(response.headers["retry-after"], "12");
    assert.strictEqual(failure.code, "rate_limited");
    assert.isDefined(failure.correlationId);
    const log = yield* RuntimeLog.RuntimeLog;
    assert.strictEqual(
      (yield* log.find({ companyId: DEV_SEED.companyId, correlationId: failure.correlationId! }))
        ?.outcome,
      "failure"
    );
  }).pipe(
    Effect.provide(
      Fixtures.layer({
        me,
        "postgres.query": {
          kind: "integration",
          run: () => new Runtime.RateLimited({ retryAfterSeconds: 12 })
        }
      })
    )
  )
);

it.effect(
  "a failed log insert prevents execution and does not advertise a missing correlation",
  () =>
    Effect.gen(function* () {
      let executed = false;
      const rejectedLog = Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`ALTER TABLE runtime_calls ADD CONSTRAINT reject_insert CHECK (false)`;
        })
      ).pipe(
        Layer.provideMerge(
          Fixtures.layer({
            me,
            "tables.insert": {
              kind: "mutation",
              run: () => {
                executed = true;
                return Effect.succeed(true);
              }
            }
          })
        )
      );
      yield* Effect.gen(function* () {
        const api = yield* Fixtures.client;
        const response = yield* api.call({
          payload: envelope("tables.insert"),
          headers: authenticatedHeaders(),
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, 503);
        assert.include(yield* response.json, { code: "source_unavailable" });
        assert.notProperty(yield* response.json, "correlationId");
        assert.isFalse(executed);
      }).pipe(Effect.provide(rejectedLog));
    })
);

it.effect(
  "capability errors and safe mutation metadata cross the central runtime log boundary",
  () =>
    Effect.gen(function* () {
      const api = yield* Fixtures.client;
      const failed = yield* api.call({
        payload: envelope("tables.update"),
        headers: authenticatedHeaders(),
        responseMode: "response-only"
      });
      const refusal = decodeFailure(yield* failed.json);
      assert.strictEqual(failed.status, 404);
      assert.strictEqual(refusal.code, "row_not_found");
      const log = yield* RuntimeLog.RuntimeLog;
      const failureRow = yield* log.find({
        companyId: DEV_SEED.companyId,
        correlationId: refusal.correlationId!
      });
      assert.strictEqual(failureRow?.outcome, "failure");
      assert.strictEqual(failureRow?.resource, "notes");
      const succeeded = yield* api.call({
        payload: envelope("tables.insertMany"),
        headers: authenticatedHeaders(),
        responseMode: "response-only"
      });
      assert.strictEqual(succeeded.status, 200);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        resource: string;
        row_count: number;
        outcome: string;
      }>`SELECT resource, row_count, outcome FROM runtime_calls WHERE op = 'tables.insertMany'`;
      assert.deepStrictEqual(rows, [{ resource: "notes", row_count: 2, outcome: "success" }]);
    }).pipe(
      Effect.provide(
        Fixtures.layer({
          me,
          "tables.update": {
            kind: "mutation",
            resource: () => "notes",
            run: () =>
              Effect.fail({
                code: "row_not_found",
                status: 404,
                message: "Row not found in notes."
              } satisfies Runtime.OperationError)
          },
          "tables.insertMany": {
            kind: "mutation",
            resource: () => "notes",
            rowCount: (value) => (Array.isArray(value) ? value.length : null),
            run: () => Effect.succeed([{ id: "a" }, { id: "b" }])
          }
        })
      )
    )
);

it.effect("raw uploads read bytes only after admission and a pending mutation log", () =>
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const sql = yield* SqlClient.SqlClient;
    let reads = 0;
    const readBytes = Effect.gen(function* () {
      reads++;
      assert.deepStrictEqual(yield* sql`SELECT op, resource, outcome FROM runtime_calls`, [
        {
          op: "files.put",
          resource: "docs/data.bin",
          outcome: "pending"
        }
      ]);
      return new Uint8Array([0, 255]);
    });
    const input = envelope("files.put", {
      store: "docs",
      name: "data.bin",
      contentType: "application/octet-stream"
    });
    const denied = yield* runtime.putFile(input, readBytes).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`${PUBLIC_BASE_URL}/api/runtime/files`, {
            method: "PUT",
            headers: { ...authenticatedHeaders(), origin: "https://foreign.invalid" }
          })
        )
      ),
      Effect.flip
    );
    assert.strictEqual(denied.code, "access_denied");
    assert.strictEqual(reads, 0);
    yield* runtime.putFile(input, readBytes).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`${PUBLIC_BASE_URL}/api/runtime/files`, {
            method: "PUT",
            headers: authenticatedHeaders()
          })
        )
      )
    );
    assert.strictEqual(reads, 1);
    assert.deepStrictEqual(yield* sql`SELECT op, resource, outcome FROM runtime_calls`, [
      {
        op: "files.put",
        resource: "docs/data.bin",
        outcome: "success"
      }
    ]);
  }).pipe(
    Effect.provide(
      Fixtures.layer({
        "files.put": {
          kind: "mutation",
          transport: "bytes-put",
          resource: () => "docs/data.bin",
          run: (_args, bytes) =>
            Effect.sync(() => {
              assert.deepStrictEqual(bytes, new Uint8Array([0, 255]));
              return null;
            })
        }
      })
    )
  )
);
