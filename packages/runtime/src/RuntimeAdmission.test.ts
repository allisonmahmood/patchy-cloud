import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { RuntimeFailure, runtimeOperations, WIRE_VERSION } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { PUBLIC_BASE_URL, signedInCookies, signSession } from "@patchy/auth/testing";
import { OperatingLimits } from "@patchy/limits";
import * as Runtime from "./Runtime.js";
import * as Fixtures from "./test/fixtures.js";
import { me } from "./me.js";

const decodeFailure = Schema.decodeUnknownSync(RuntimeFailure);

it.effect(
  "counts non-database operations and server calls once against the same company burst",
  () => {
    let executions = 0;
    const serverCall = Runtime.handler(
      {
        kind: runtimeOperations["server.call"].kind,
        input: runtimeOperations["server.call"].request.fields.args,
        output: runtimeOperations["server.call"].response
      },
      () =>
        Effect.sync(() => {
          executions++;
          return { ok: true as const, value: "accepted" };
        })
    );
    return Effect.gen(function* () {
      const api = yield* Fixtures.client;
      const send = (op: string) =>
        api.call({
          payload: {
            patchId: Fixtures.patchId,
            versionId: Fixtures.tier1VersionId,
            principal: { userId: DEV_SEED.userId },
            wire: WIRE_VERSION,
            op,
            args: op === "server.call" ? { handler: "leads.list", args: {} } : {}
          },
          headers: {
            ...Fixtures.headers({ userId: DEV_SEED.userId }),
            cookie: signedInCookies(),
            origin: PUBLIC_BASE_URL
          },
          responseMode: "response-only"
        });
      for (let index = 0; index < 199; index++) {
        assert.strictEqual((yield* send("me")).status, 200);
      }
      assert.strictEqual((yield* send("server.call")).status, 200);
      assert.strictEqual(executions, 1);
      const refused = yield* send("server.call");
      assert.strictEqual(refused.status, 429);
      assert.strictEqual(refused.headers["retry-after"], "1");
      assert.include(decodeFailure(yield* refused.json), {
        code: "limit_exceeded",
        limitId: "company.admission.rate",
        scope: "company",
        value: 100,
        retryAfter: 1
      });
      assert.strictEqual(executions, 1);
      yield* TestClock.adjust(10);
      assert.strictEqual((yield* send("me")).status, 200);
      assert.strictEqual((yield* send("me")).status, 429);
    }).pipe(
      Effect.provide(
        Fixtures.layer(
          { me, "server.call": serverCall },
          {
            "runtime.calls.perMinute": 300
          }
        )
      )
    );
  }
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
