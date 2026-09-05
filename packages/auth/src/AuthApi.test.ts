import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Authorization as AuthorizationTag, PatchyApi } from "@patchy/api";
import * as Testing from "@patchy/sql/testing";
import * as AuthApi from "./AuthApi.js";
import * as Authorization from "./Authorization.js";
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

const client = HttpApiTest.groups(PatchyApi, ["auth"]);
const layer = Layer.mergeAll(AuthApi.layer, HttpServer.layerServices).pipe(
  Layer.provideMerge(Authorization.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(Testing.layer())
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
