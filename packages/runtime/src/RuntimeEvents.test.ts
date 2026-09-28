import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as WideEvents from "@patchy/analytics/wide-events";
import { runtimeOperations, WIRE_VERSION } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { PUBLIC_BASE_URL, signedInCookies } from "@patchy/auth/testing";
import * as Binding from "./Binding.js";
import * as Fixtures from "./test/fixtures.js";
import { me } from "./me.js";
import * as Runtime from "./Runtime.js";

const recordEvents = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<WideEvents.WideEvent>();
  const records: WideEvents.WideEvent[] = [];
  const layer = WideEvents.layerWithSink.pipe(
    Layer.provide(
      Layer.succeed(WideEvents.Sink, {
        write: (event) =>
          Effect.gen(function* () {
            records.push(event);
            yield* Queue.offer(queue, event);
          })
      })
    )
  );
  const next = Queue.take(queue).pipe(
    Effect.map((event) => {
      if (event.type !== "request") assert.fail(`Unexpected event type: ${event.type}`);
      return event;
    })
  );
  const count = Effect.fnUntraced(function* (expected: number) {
    yield* Effect.yieldNow;
    assert.strictEqual(records.length, expected);
    assert.strictEqual(yield* Queue.size(queue), 0);
    assert.strictEqual(new Set(records.map((event) => event.eventId)).size, expected);
  });
  return { layer, next, count };
});

const payload = (op = "me", args: unknown = {}) => ({
  patchId: Fixtures.patchId,
  versionId: Fixtures.tier1VersionId,
  principal: { userId: DEV_SEED.userId },
  wire: WIRE_VERSION,
  op,
  args
});
const authenticated = () => ({
  ...Fixtures.headers({ userId: DEV_SEED.userId }),
  cookie: signedInCookies(),
  origin: PUBLIC_BASE_URL,
  "sec-fetch-site": "same-origin"
});
const attribution = {
  companyId: DEV_SEED.companyId,
  patchId: Fixtures.patchId,
  versionId: Fixtures.tier1VersionId,
  viewerId: DEV_SEED.userId,
  tier: 1
};

it.effect(
  "records one tier-1 request with loaded version and authenticated viewer attribution",
  () =>
    Effect.gen(function* () {
      const events = yield* recordEvents;
      yield* Effect.gen(function* () {
        const api = yield* Fixtures.client;
        const response = yield* api.call({
          payload: payload(),
          headers: { ...authenticated(), "x-trace-id": "untrusted-trace" },
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(yield* response.json, {
          ok: true,
          value: {
            user: { id: DEV_SEED.userId, name: "Patchy Dev", email: "dev@patchy.local" },
            company: {
              id: DEV_SEED.companyId,
              handle: DEV_SEED.companyHandle,
              name: DEV_SEED.companyName
            },
            admin: true
          }
        });
        const event = yield* events.next;
        assert.include(event, {
          ...attribution,
          type: "request",
          handler: "me",
          kind: "read",
          outcome: "success",
          sampleProbability: 1
        });
        assert.deepStrictEqual(event.operations, ["me"]);
        assert.notInclude(JSON.stringify(event), "untrusted-trace");
        assert.notInclude(JSON.stringify(event), "dev@patchy.local");
        assert.notProperty(event, "code");
        yield* events.count(1);
      }).pipe(Effect.provide(Fixtures.layer(undefined, {}, events.layer)));
    })
);

it.effect(
  "records refusals before invocation without trusting missing or hostile request identity",
  () =>
    Effect.gen(function* () {
      const events = yield* recordEvents;
      yield* Effect.gen(function* () {
        const api = yield* Fixtures.client;
        const missingSession = yield* api.call({
          payload: payload(),
          headers: Fixtures.headers({ userId: "forged-viewer" }),
          responseMode: "response-only"
        });
        assert.strictEqual(missingSession.status, 401);
        assert.include(yield* missingSession.json, { code: "session_expired" });
        const sessionEvent = yield* events.next;
        assert.include(sessionEvent, {
          companyId: DEV_SEED.companyId,
          patchId: Fixtures.patchId,
          versionId: Fixtures.tier1VersionId,
          tier: 1,
          outcome: "refused",
          code: "session_expired"
        });
        assert.notProperty(sessionEvent, "viewerId");

        const invalid = yield* api.call({
          payload: { ...payload(), companyId: "forged-company" },
          headers: authenticated(),
          responseMode: "response-only"
        });
        assert.strictEqual(invalid.status, 400);
        assert.include(yield* invalid.json, { code: "invalid_request" });
        const invalidEvent = yield* events.next;
        assert.include(invalidEvent, { outcome: "refused", code: "invalid_request" });
        for (const field of ["companyId", "patchId", "versionId", "viewerId", "handler", "tier"])
          assert.notProperty(invalidEvent, field);

        const secretOperation = "unknown-operation-with-private-input";
        const unknown = yield* api.call({
          payload: payload(secretOperation, { sql: "private-sql" }),
          headers: authenticated(),
          responseMode: "response-only"
        });
        assert.strictEqual(unknown.status, 400);
        const unknownEvent = yield* events.next;
        assert.include(unknownEvent, {
          ...attribution,
          outcome: "refused",
          code: "invalid_request"
        });
        assert.notProperty(unknownEvent, "operations");
        assert.notProperty(unknownEvent, "handler");
        assert.notInclude(JSON.stringify(unknownEvent), secretOperation);
        assert.notInclude(JSON.stringify(unknownEvent), "private-sql");

        const tooLarge = yield* api.call({
          payload: payload("me", { secret: "private-body".repeat(100) }),
          headers: authenticated(),
          responseMode: "response-only"
        });
        assert.strictEqual(tooLarge.status, 413);
        assert.include(yield* tooLarge.json, { code: "too_large", limitId: "runtime.batch.bytes" });
        const largeEvent = yield* events.next;
        assert.include(largeEvent, {
          outcome: "refused",
          code: "too_large",
          limitId: "runtime.batch.bytes"
        });
        assert.notProperty(largeEvent, "viewerId");
        assert.notProperty(largeEvent, "patchId");
        assert.notInclude(JSON.stringify(largeEvent), "private-body");
        yield* events.count(4);
      }).pipe(
        Effect.provide(
          Fixtures.layer(
            undefined,
            {
              "runtime.calls.perMinute": 20,
              "runtime.call.bytes": 512,
              "runtime.row.bytes": 64,
              "runtime.batch.bytes": 128,
              "runtime.postgres.bytes": 128
            },
            events.layer
          )
        )
      );
    })
);

it.effect(
  "records handler failures and their duration even after the route converts them to responses",
  () =>
    Effect.gen(function* () {
      const events = yield* recordEvents;
      const entered = yield* Deferred.make<void>();
      const handlers = {
        "tables.get": Runtime.handler(
          {
            kind: "read",
            input: runtimeOperations["tables.get"].request.fields.args,
            output: runtimeOperations["tables.get"].response
          },
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Effect.sleep(25);
              return yield* new Runtime.SourceUnavailable({
                cause: new Error("private-source-error")
              });
            })
        )
      };
      yield* Effect.gen(function* () {
        const api = yield* Fixtures.client;
        const pending = yield* api
          .call({
            payload: payload("tables.get", { table: "notes", id: "private-row" }),
            headers: authenticated(),
            responseMode: "response-only"
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust(25);
        const response = yield* Fiber.join(pending);
        assert.strictEqual(response.status, 503);
        assert.include(yield* response.json, { code: "source_unavailable" });
        const event = yield* events.next;
        assert.include(event, {
          ...attribution,
          handler: "tables.get",
          kind: "read",
          outcome: "failure",
          code: "source_unavailable",
          durationMs: 25
        });
        assert.deepStrictEqual(event.operations, ["tables.get"]);
        assert.notInclude(JSON.stringify(event), "private-row");
        assert.notInclude(JSON.stringify(event), "private-source-error");
        yield* events.count(1);
      }).pipe(Effect.provide(Fixtures.layer(handlers, {}, events.layer)));
    })
);

it.effect(
  "records PUT and GET bytes and their early refusals without retaining filenames or bodies",
  () =>
    Effect.gen(function* () {
      const events = yield* recordEvents;
      let stored: Uint8Array = new Uint8Array();
      const handlers: Readonly<Record<string, Runtime.Handler>> = {
        "files.put": {
          transport: "bytes-put",
          kind: "mutation",
          run: (_, bytes) =>
            Effect.sync(() => {
              stored = bytes;
              return null;
            })
        },
        "files.get": {
          transport: "bytes-get",
          kind: "read",
          run: () => Effect.succeed({ bytes: stored, contentType: "application/octet-stream" })
        }
      };
      yield* Effect.gen(function* () {
        const api = yield* Fixtures.client;
        const params = {
          patchId: Fixtures.patchId,
          versionId: Fixtures.tier1VersionId,
          store: "private-store",
          "*": "private-filename"
        };
        const bytes = new Uint8Array([1, 2, 3]);
        const put = yield* api.putFile({
          params,
          payload: bytes,
          headers: authenticated(),
          responseMode: "response-only"
        });
        assert.strictEqual(put.status, 200);
        assert.deepStrictEqual(yield* put.json, { ok: true, value: null });
        const putEvent = yield* events.next;
        assert.include(putEvent, {
          ...attribution,
          handler: "files.put",
          kind: "mutation",
          outcome: "success"
        });
        assert.deepStrictEqual(putEvent.operations, ["files.put"]);

        const oversized = yield* api.putFile({
          params,
          payload: new Uint8Array([1, 2, 3, 4, 5]),
          headers: authenticated(),
          responseMode: "response-only"
        });
        assert.strictEqual(oversized.status, 413);
        assert.include(yield* oversized.json, { code: "too_large", limitId: "runtime.file.bytes" });
        const oversizedEvent = yield* events.next;
        assert.include(oversizedEvent, {
          ...attribution,
          handler: "files.put",
          outcome: "refused",
          code: "too_large",
          limitId: "runtime.file.bytes"
        });

        const get = yield* api.getFile({
          params,
          headers: authenticated(),
          responseMode: "response-only"
        });
        assert.strictEqual(get.status, 200);
        assert.deepStrictEqual(new Uint8Array(yield* get.arrayBuffer), bytes);
        assert.strictEqual(get.headers["cache-control"], "no-store");
        assert.strictEqual(get.headers["content-disposition"], "attachment");
        const getEvent = yield* events.next;
        assert.include(getEvent, {
          ...attribution,
          handler: "files.get",
          kind: "read",
          outcome: "success"
        });
        assert.deepStrictEqual(getEvent.operations, ["files.get"]);

        for (const method of ["putFile", "getFile"] as const) {
          const refused = yield* method === "putFile"
            ? api.putFile({
                params,
                payload: bytes,
                headers: { ...authenticated(), "x-patchy-wire": "invalid" },
                responseMode: "response-only"
              })
            : api.getFile({
                params,
                headers: { ...authenticated(), "x-patchy-wire": "invalid" },
                responseMode: "response-only"
              });
          assert.strictEqual(refused.status, 400);
          assert.include(yield* refused.json, { code: "invalid_request" });
          const event = yield* events.next;
          const operation = method === "putFile" ? "files.put" : "files.get";
          assert.include(event, {
            handler: operation,
            outcome: "refused",
            code: "invalid_request"
          });
          assert.deepStrictEqual(event.operations, [operation]);
          for (const field of ["companyId", "patchId", "versionId", "viewerId", "tier"])
            assert.notProperty(event, field);
        }
        for (const event of [putEvent, oversizedEvent, getEvent]) {
          assert.notInclude(JSON.stringify(event), "private-store");
          assert.notInclude(JSON.stringify(event), "private-filename");
          assert.notProperty(event, "bytes");
        }
        yield* events.count(5);
      }).pipe(
        Effect.provide(
          Fixtures.layer(
            handlers,
            { "runtime.file.bytes": 4, "runtime.calls.perMinute": 20 },
            events.layer
          )
        )
      );
    })
);

it.effect("keeps concurrently active company and public request attribution separate", () =>
  Effect.gen(function* () {
    const events = yield* recordEvents;
    const companyEntered = yield* Deferred.make<void>();
    const publicEntered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const handlers = {
      me: {
        ...me,
        run: (args: unknown) =>
          Effect.gen(function* () {
            const binding = yield* Binding.Binding;
            yield* Deferred.succeed(
              binding.scope === "public" ? publicEntered : companyEntered,
              undefined
            );
            yield* Deferred.await(release);
            return yield* me.run(args);
          })
      }
    };
    yield* Effect.gen(function* () {
      const api = yield* Fixtures.client;
      const company = yield* api
        .call({
          payload: payload(),
          headers: authenticated(),
          responseMode: "response-only"
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(companyEntered);
      const publicRequest = yield* api
        .call({
          payload: {
            ...payload(),
            versionId: Fixtures.publicVersionId,
            principal: { userId: "forged-viewer" }
          },
          headers: { ...authenticated(), ...Fixtures.headers({ userId: "forged-viewer" }) },
          responseMode: "response-only"
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(publicEntered);
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* Fiber.join(company)).status, 200);
      const publicResponse = yield* Fiber.join(publicRequest);
      assert.deepStrictEqual(yield* publicResponse.json, { ok: true, value: null });
      const received = [yield* events.next, yield* events.next];
      const companyEvent = received.find((event) => event.versionId === Fixtures.tier1VersionId)!;
      const publicEvent = received.find((event) => event.versionId === Fixtures.publicVersionId)!;
      assert.include(companyEvent, { ...attribution, outcome: "success" });
      assert.include(publicEvent, {
        companyId: DEV_SEED.companyId,
        patchId: Fixtures.patchId,
        versionId: Fixtures.publicVersionId,
        tier: 0,
        outcome: "success"
      });
      assert.notProperty(publicEvent, "viewerId");
      assert.notStrictEqual(companyEvent.traceId, publicEvent.traceId);
      assert.deepStrictEqual(companyEvent.operations, ["me"]);
      assert.deepStrictEqual(publicEvent.operations, ["me"]);
      yield* events.count(2);
    }).pipe(Effect.provide(Fixtures.layer(handlers, {}, events.layer)));
  })
);
