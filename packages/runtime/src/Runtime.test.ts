import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { RuntimeFailure, WIRE_VERSION } from "@patchy/api";
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
      const response = yield* api.call({
        payload,
        headers: authenticatedHeaders(),
        responseMode: "response-only"
      });
      const result = yield* response.json;
      assert.deepInclude(result, {
        ok: true,
        value: {
          companyId: DEV_SEED.companyId,
          userId: DEV_SEED.userId,
          patchId: Fixtures.patchId,
          versionId: Fixtures.versionId
        }
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
    assert.strictEqual(failure.code, "invalid_row");
    assert.isDefined(failure.correlationId);
    const log = yield* RuntimeLog.RuntimeLog;
    const row = yield* log.find({
      companyId: DEV_SEED.companyId,
      correlationId: failure.correlationId!
    });
    assert.strictEqual(row?.outcome, "failure");
    assert.strictEqual(row?.userId, DEV_SEED.userId);
    assert.strictEqual(row?.patchId, Fixtures.patchId);
  }).pipe(
    Effect.provide(
      Fixtures.layer({
        me,
        "tables.insert": {
          kind: "mutation",
          run: () => new Runtime.RuntimeError({ code: "invalid_row" })
        }
      })
    )
  )
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
      if (code === undefined)
        assert.deepStrictEqual(yield* response.json, { ok: true, value: true });
      else assert.include(yield* response.json, { code });
    }
  }).pipe(
    Effect.provide(
      Fixtures.layer({
        me,
        "tables.insert": { kind: "mutation", run: () => Effect.succeed(true) },
        "tables.insertMany": { kind: "mutation", run: () => Effect.succeed(true) }
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
