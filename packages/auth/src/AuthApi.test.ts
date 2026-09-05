import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import {
  Authorization as AuthorizationTag,
  PatchyApi,
  PollDeviceLoginRequest,
  StartDeviceLoginRequest
} from "@patchy/api";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AuthApi from "./AuthApi.js";
import * as Authorization from "./Authorization.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import { DEV_SEED } from "./seed.js";

const bearer = (token: string) =>
  HttpApiMiddleware.layerClient(AuthorizationTag, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token))
  );

const rawAuthorization = (value: string) =>
  HttpApiMiddleware.layerClient(AuthorizationTag, ({ next, request }) =>
    next(HttpClientRequest.setHeader(request, "authorization", value))
  );

const anonymous = HttpApiMiddleware.layerClient(AuthorizationTag, ({ next, request }) =>
  next(request)
);

const client = HttpApiTest.groups(PatchyApi, ["auth"]);
const layer = Layer.mergeAll(AuthApi.layer, HttpServer.layerServices).pipe(
  Layer.provideMerge(Authorization.layer),
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(Layer.mergeAll(Analytics.layerNoop, Limits.layer)),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ PATCHY_PUBLIC_BASE_URL: "https://patchy.example/" })
    )
  )
);

it.layer(layer)("auth group: machine identity and logout", (it) => {
  it.effect("answers the one identity wire shape for the seeded bearer", () =>
    Effect.gen(function* () {
      const identity = yield* (yield* client).me();
      assert.deepStrictEqual(
        { ...identity },
        {
          user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
          company: {
            id: DEV_SEED.companyId,
            handle: DEV_SEED.companyHandle,
            name: DEV_SEED.companyName
          },
          role: DEV_SEED.role,
          machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
        }
      );
    }).pipe(Effect.provide(bearer(DEV_SEED.token)))
  );

  it.effect("accepts the whitespace and casing allowed by Bearer.parse", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* (yield* client).me()).machine.id, DEV_SEED.tokenId);
    }).pipe(Effect.provide(rawAuthorization(`bEaReR\t ${DEV_SEED.token} \t`)))
  );

  it.effect("answers the same 401 for every dead credential on both protected routes", () =>
    Effect.gen(function* () {
      const now = Date.UTC(2026, 0, 1);
      yield* TestClock.setTime(now);
      const tokens = yield* MachineTokens.MachineTokens;
      const sql = yield* SqlClient.SqlClient;
      const revoked = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Revoked" });
      const expired = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Expired" });
      const idle = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Idle" });
      yield* tokens.revoke(revoked.id);
      yield* sql`UPDATE machine_tokens SET expires_at = to_timestamp(${(now - 1) / 1_000}) WHERE id = ${expired.id}`;
      yield* sql`UPDATE machine_tokens SET last_used_at = to_timestamp(${(now - 30 * 24 * 60 * 60 * 1_000 - 1) / 1_000}) WHERE id = ${idle.id}`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
      VALUES ('usr_api_inactive', 'user_api_inactive', ${DEV_SEED.companyId}, 'inactive@api.test', 'Inactive', 'member')`;
      const deactivated = yield* tokens.mint({ userId: "usr_api_inactive", name: "Deactivated" });
      yield* sql`UPDATE users SET deactivated_at = to_timestamp(${now / 1_000}) WHERE id = 'usr_api_inactive'`;
      for (const token of [
        "unknown-credential",
        revoked.token,
        expired.token,
        idle.token,
        deactivated.token
      ]) {
        const api = yield* client.pipe(Effect.provide(bearer(token)));
        const expected = { ok: false, error: "Missing or invalid API token." };
        assert.deepStrictEqual(yield* api.me().pipe(Effect.flip), expected);
        assert.deepStrictEqual(yield* api.logout().pipe(Effect.flip), expected);
      }
    })
  );

  it.effect("refuses missing and malformed authorization", () =>
    Effect.gen(function* () {
      const expected = { ok: false, error: "Missing or invalid API token." };
      const withoutHeader = HttpApiMiddleware.layerClient(AuthorizationTag, ({ next, request }) =>
        next(request)
      );
      const missing = yield* client.pipe(Effect.provide(withoutHeader));
      assert.deepStrictEqual(yield* missing.me().pipe(Effect.flip), expected);
      const malformed = yield* client.pipe(Effect.provide(rawAuthorization("Basic not-a-bearer")));
      assert.deepStrictEqual(yield* malformed.logout().pipe(Effect.flip), expected);
    })
  );

  it.effect("logout revokes only this machine, then refuses its credential", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const tokens = yield* MachineTokens.MachineTokens;
      const machine = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Logging out" });
      const other = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Other laptop" });
      const api = yield* client.pipe(Effect.provide(bearer(machine.token)));
      assert.deepStrictEqual({ ...(yield* api.logout()) }, { ok: true, alreadyRevoked: false });
      assert.deepStrictEqual(yield* api.me().pipe(Effect.flip), {
        ok: false,
        error: "Missing or invalid API token."
      });
      assert.deepStrictEqual(yield* api.logout().pipe(Effect.flip), {
        ok: false,
        error: "Missing or invalid API token."
      });
      const stillLive = yield* client.pipe(Effect.provide(bearer(other.token)));
      assert.strictEqual((yield* stillLive.me()).machine.id, other.id);
    })
  );
});

it.layer(layer)("auth group: anonymous device login", (it) => {
  it.effect(
    "starts on the configured origin with 201, then polls pending and slow_down with 200",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const api = yield* client;
        const [started, response] = yield* api.startDeviceLogin({
          payload: new StartDeviceLoginRequest({ machineNameHint: "Laptop" }),
          responseMode: "decoded-and-response"
        });
        assert.strictEqual(response.status, 201);
        assert.strictEqual(started.ok, true);
        assert.match(started.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
        assert.strictEqual(started.verificationUrlBare, "https://patchy.example/login/device");
        assert.strictEqual(
          started.verificationUrl,
          `https://patchy.example/login/device?code=${started.userCode}`
        );
        assert.strictEqual(started.interval, 5);
        assert.strictEqual(started.expiresAt, "2026-01-01T00:10:00.000Z");
        const payload = new PollDeviceLoginRequest({ deviceCode: started.deviceCode });
        const [pending, pendingResponse] = yield* api.pollDeviceLogin({
          payload,
          responseMode: "decoded-and-response"
        });
        assert.strictEqual(pendingResponse.status, 200);
        assert.deepStrictEqual(pending, { ok: true, status: "pending" });
        const [slow, slowResponse] = yield* api.pollDeviceLogin({
          payload,
          responseMode: "decoded-and-response"
        });
        assert.strictEqual(slowResponse.status, 200);
        assert.deepStrictEqual(slow, { ok: true, status: "slow_down" });
      }).pipe(Effect.provide(anonymous))
  );

  it.effect(
    "returns a confirmed machine's usable replacement token once, then typed 410 unknown",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const api = yield* client;
        const tokens = yield* MachineTokens.MachineTokens;
        const previous = yield* tokens.mint({ userId: DEV_SEED.userId, name: "Old laptop" });
        const started = yield* api.startDeviceLogin({
          payload: new StartDeviceLoginRequest({
            machineNameHint: "Laptop",
            previousMachineTokenId: previous.id
          })
        });
        yield* (yield* DeviceLogins.DeviceLogins).confirm({
          userCode: started.userCode,
          userId: DEV_SEED.userId,
          machineName: "Renamed laptop"
        });
        const payload = new PollDeviceLoginRequest({ deviceCode: started.deviceCode });
        const [complete, response] = yield* api.pollDeviceLogin({
          payload,
          responseMode: "decoded-and-response"
        });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(complete.status, "complete");
        if (complete.status !== "complete") throw new Error("Expected a completed device login");
        assert.strictEqual(complete.machine.name, "Renamed laptop");
        assert.strictEqual(complete.expiresAt, "2026-04-01T00:00:00.000Z");
        const signedIn = yield* client.pipe(Effect.provide(bearer(complete.token)));
        assert.deepStrictEqual((yield* signedIn.me()).machine, complete.machine);
        const replaced = yield* client.pipe(Effect.provide(bearer(previous.token)));
        assert.deepStrictEqual(yield* replaced.me().pipe(Effect.flip), {
          ok: false,
          error: "Missing or invalid API token."
        });
        const gone = yield* api.pollDeviceLogin({ payload, responseMode: "response-only" });
        assert.strictEqual(gone.status, 410);
        const typed = yield* api.pollDeviceLogin({ payload }).pipe(Effect.flip);
        assert.deepStrictEqual(yield* gone.json, typed);
        assert.strictEqual("code" in typed && typed.code, "unknown");
      }).pipe(Effect.provide(anonymous))
  );

  it.effect("uses 410 bodies for denied and expired logins, not authentication failures", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const api = yield* client;
      for (const code of ["denied", "expired"] as const) {
        const started = yield* api.startDeviceLogin({
          payload: new StartDeviceLoginRequest({ machineNameHint: "Laptop" })
        });
        if (code === "denied") {
          yield* (yield* DeviceLogins.DeviceLogins).deny(started.userCode);
        } else {
          yield* TestClock.adjust("10 minutes");
        }
        const gone = yield* api.pollDeviceLogin({
          payload: new PollDeviceLoginRequest({ deviceCode: started.deviceCode }),
          responseMode: "response-only"
        });
        assert.strictEqual(gone.status, 410);
        const body = yield* gone.json;
        assert.isObject(body);
        assert.propertyVal(body, "ok", false);
        assert.propertyVal(body, "code", code);
        assert.property(body, "error");
      }
    }).pipe(Effect.provide(anonymous))
  );
});
