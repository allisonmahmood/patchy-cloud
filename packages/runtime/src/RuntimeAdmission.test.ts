import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { RuntimeFailure, WIRE_VERSION } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import * as WideEvents from "@patchy/analytics/wide-events";
import { OperatingLimits } from "@patchy/limits";
import * as Fixtures from "./test/fixtures.js";
import { me } from "./me.js";

const decodeFailure = Schema.decodeUnknownSync(RuntimeFailure);

it.effect("public me keeps its caller limit without spending company admission tokens", () =>
  Effect.gen(function* () {
    const limits = yield* OperatingLimits.OperatingLimits;
    yield* limits.setOverride({
      companyId: DEV_SEED.companyId,
      limitId: "company.admission.burst",
      value: 2,
      actor: "runtime-admission-test"
    });
    const api = yield* Fixtures.client;
    const send = (publicVersion: boolean, op = "me") =>
      api.call({
        payload: {
          patchId: Fixtures.patchId,
          versionId: publicVersion ? Fixtures.publicVersionId : Fixtures.tier1VersionId,
          principal: publicVersion ? null : { userId: DEV_SEED.userId },
          wire: WIRE_VERSION,
          op,
          args: op === "server.call" ? { handler: "leads.list", args: {} } : {}
        },
        headers: {
          ...Fixtures.headers(publicVersion ? null : { userId: DEV_SEED.userId }),
          ...(publicVersion ? {} : { cookie: signedInCookies() }),
          origin: PUBLIC_BASE_URL
        },
        responseMode: "response-only"
      });
    for (let index = 0; index < 2; index++) {
      const response = yield* send(true);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* response.json, { ok: true, value: null });
    }
    for (const op of ["tables.insert", "server.call"]) {
      assert.include(decodeFailure(yield* (yield* send(true, op)).json), {
        code: "not_available_on_public"
      });
    }
    assert.strictEqual((yield* send(false)).status, 200);
    assert.strictEqual((yield* send(false)).status, 200);
    const companyRefusal = yield* send(false);
    assert.strictEqual(companyRefusal.status, 429);
    assert.include(decodeFailure(yield* companyRefusal.json), {
      code: "limit_exceeded",
      limitId: "company.admission.rate",
      scope: "company"
    });
    assert.strictEqual((yield* send(true)).status, 200);
    const callerRefusal = yield* send(true);
    assert.strictEqual(callerRefusal.status, 429);
    assert.include(decodeFailure(yield* callerRefusal.json), {
      code: "rate_limited",
      limitId: "runtime.calls.perMinute",
      scope: "viewer",
      value: 3
    });
  }).pipe(Effect.provide(Fixtures.layer()))
);

it.effect("admission burst peaks exclude refused calls and fall after refill", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<WideEvents.WideEvent>();
    const eventLayer = WideEvents.layerWithSink.pipe(
      Layer.provide(
        Layer.succeed(WideEvents.Sink, {
          write: (event) => Queue.offer(events, event).pipe(Effect.asVoid)
        })
      ),
      Layer.provide(WideEvents.layerMetadata),
      Layer.orDie
    );
    yield* Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      yield* limits.setOverride({
        companyId: DEV_SEED.companyId,
        limitId: "company.admission.burst",
        value: 2,
        actor: "runtime-admission-test"
      });
      const api = yield* Fixtures.client;
      for (const [elapsed, status, peak] of [
        [0, 200, 1],
        [0, 200, 2],
        [0, 429, 2],
        [20, 200, 1]
      ] as const) {
        yield* TestClock.adjust(elapsed);
        const response = yield* api.call({
          payload: {
            patchId: Fixtures.patchId,
            versionId: Fixtures.tier1VersionId,
            principal: { userId: DEV_SEED.userId },
            wire: WIRE_VERSION,
            op: "me",
            args: {}
          },
          headers: {
            ...Fixtures.headers({ userId: DEV_SEED.userId }),
            cookie: signedInCookies(),
            origin: PUBLIC_BASE_URL
          },
          responseMode: "response-only"
        });
        assert.strictEqual(response.status, status);
        const event = yield* Queue.take(events);
        assert.include(
          event.limits?.find((limit) => limit.limitId === "company.admission.burst"),
          { value: 2, peak }
        );
      }
    }).pipe(Effect.provide(Fixtures.layer({ me }, { "runtime.calls.perMinute": 300 }, eventLayer)));
  })
);

it.effect(
  "shares company admission across patches and applies overrides only to their company",
  () =>
    Effect.gen(function* () {
      const limits = yield* OperatingLimits.OperatingLimits;
      yield* limits.setOverride({
        companyId: DEV_SEED.companyId,
        limitId: "company.admission.burst",
        value: 2,
        actor: "runtime-admission-test"
      });
      yield* limits.setOverride({
        companyId: DEV_SEED.companyId,
        limitId: "company.admission.rate",
        value: 50,
        actor: "runtime-admission-test"
      });
      const api = yield* Fixtures.client;
      const send = (patchId: string, other = false) =>
        api.call({
          payload: {
            patchId,
            versionId: Fixtures.tier1VersionId,
            principal: { userId: other ? "usr_other" : DEV_SEED.userId },
            wire: WIRE_VERSION,
            op: "me",
            args: {}
          },
          headers: {
            ...Fixtures.headers({ userId: other ? "usr_other" : DEV_SEED.userId }),
            cookie: other
              ? signedInCookies(signSession({ sub: "user_other", email: "other@patchy.local" }))
              : signedInCookies(),
            origin: PUBLIC_BASE_URL
          },
          responseMode: "response-only"
        });
      assert.strictEqual((yield* send(Fixtures.patchId)).status, 200);
      assert.strictEqual((yield* send("secondpatch1")).status, 200);
      const refused = yield* send(Fixtures.patchId);
      assert.include(decodeFailure(yield* refused.json), {
        code: "limit_exceeded",
        limitId: "company.admission.rate",
        scope: "company",
        value: 50
      });
      for (let index = 0; index < 3; index++) {
        assert.strictEqual((yield* send("otherpatch11", true)).status, 200);
      }
      yield* TestClock.adjust(19);
      assert.strictEqual((yield* send(Fixtures.patchId)).status, 429);
      yield* TestClock.adjust(1);
      assert.strictEqual((yield* send(Fixtures.patchId)).status, 200);
      assert.strictEqual((yield* send("secondpatch1")).status, 429);
    }).pipe(Effect.provide(Fixtures.layer({ me }, { "runtime.calls.perMinute": 300 })))
);
