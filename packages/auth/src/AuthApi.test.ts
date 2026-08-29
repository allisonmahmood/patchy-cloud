import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import { Analytics } from "@patchy/analytics";
import { Authorization as AuthorizationTag, CreateTokenRequest, PatchyApi } from "@patchy/api";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AuthApi from "./AuthApi.js";
import * as Authorization from "./Authorization.js";
import { migrations } from "./migrations.js";
import * as Tokens from "./Tokens.js";

/** The client side of the bearer middleware: one layer per credential a test presents. */
const bearer = (token: string) =>
  HttpApiMiddleware.layerClient(AuthorizationTag, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token))
  );

const client = HttpApiTest.groups(PatchyApi, ["auth"]);

const layer = (env: Record<string, string>) =>
  Layer.mergeAll(AuthApi.layer, HttpServer.layerServices).pipe(
    // The group captures its middleware when it builds, so the server side
    // of the bearer middleware is provided to it, and merged for the client.
    Layer.provideMerge(Authorization.layer),
    Layer.provideMerge(Layer.mergeAll(Tokens.layer, Limits.layer, Analytics.layerNoop)),
    Layer.provideMerge(Testing.layer(migrations)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ PATCHY_BOOTSTRAP_API_TOKEN: "dev-token", ...env })
      )
    )
  );

it.layer(layer({}))("auth group: tokens and me", (it) => {
  it.effect("answers /api/me for a live token", () =>
    Effect.gen(function* () {
      const identity = yield* (yield* client).me();
      assert.deepStrictEqual(
        { ...identity },
        {
          accountId: Tokens.BOOTSTRAP_PRINCIPAL_ID,
          accountName: "Bootstrap Account",
          apiTokenId: Tokens.BOOTSTRAP_API_TOKEN_ID,
          apiTokenName: "Bootstrap API Token",
          scopes: ["admin", "upload"]
        }
      );
    }).pipe(Effect.provide(bearer("dev-token")))
  );

  it.effect("401s an unknown token with the pinned body", () =>
    Effect.gen(function* () {
      const error = yield* (yield* client).me().pipe(Effect.flip);
      assert.deepStrictEqual(error, { ok: false, error: "Missing or invalid API token." });
    }).pipe(Effect.provide(bearer("nope")))
  );

  it.effect("issues, scopes, and revokes tokens for an admin, and for nobody else", () =>
    Effect.gen(function* () {
      const admin = yield* client.pipe(Effect.provide(bearer("dev-token")));
      const issued = yield* admin.createToken({
        payload: new CreateTokenRequest({ name: "  Uploader  ", scopes: ["upload"] })
      });
      assert.strictEqual(issued.apiToken.name, "Uploader");
      assert.match(issued.token, /^pp_[A-Za-z0-9_-]{43}$/);
      const defaults = yield* admin.createToken({ payload: new CreateTokenRequest({}) });
      assert.strictEqual(defaults.apiToken.name, "CLI API Token");

      const asUploader = yield* client.pipe(Effect.provide(bearer(issued.token)));
      assert.deepStrictEqual((yield* asUploader.me()).scopes, ["upload"]);
      const forbidden = yield* asUploader
        .createToken({ payload: new CreateTokenRequest({}) })
        .pipe(Effect.flip);
      assert.deepStrictEqual(forbidden, {
        ok: false,
        error: "API token does not have the required scope."
      });
      assert.deepStrictEqual(
        yield* asUploader
          .revokeToken({ params: { apiTokenId: issued.apiToken.id } })
          .pipe(Effect.flip),
        { ok: false, error: "API token does not have the required scope." }
      );

      const revoked = yield* admin.revokeToken({ params: { apiTokenId: issued.apiToken.id } });
      assert.deepStrictEqual(
        { ...revoked, apiToken: { ...revoked.apiToken, revokedAt: "stamped" } },
        {
          ok: true,
          alreadyRevoked: false,
          apiToken: {
            id: issued.apiToken.id,
            name: "Uploader",
            principalId: Tokens.BOOTSTRAP_PRINCIPAL_ID,
            revokedAt: "stamped"
          }
        }
      );
      const again = yield* admin.revokeToken({ params: { apiTokenId: issued.apiToken.id } });
      assert.strictEqual(again.alreadyRevoked, true);
      assert.strictEqual(again.apiToken.revokedAt, revoked.apiToken.revokedAt);
      // Indistinguishable from a bad token from then on.
      assert.deepStrictEqual(yield* asUploader.me().pipe(Effect.flip), {
        ok: false,
        error: "Missing or invalid API token."
      });
      assert.deepStrictEqual(
        yield* admin.revokeToken({ params: { apiTokenId: "tok_never" } }).pipe(Effect.flip),
        { ok: false, error: "API token not found." }
      );
    })
  );

  it.effect("refuses to mint while the instance keeps its admin-only posture", () =>
    Effect.gen(function* () {
      const refused = yield* (yield* client).mint().pipe(Effect.flip);
      assert.deepStrictEqual(refused, {
        ok: false,
        error: "This instance does not issue self-service tokens. Ask its operator for a token.",
        code: "self_service_disabled"
      });
    }).pipe(Effect.provide(bearer("unused")))
  );
});

it.layer(
  layer({
    PATCHY_ALLOW_SELF_SERVICE_TOKENS: "true",
    PATCHY_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE: "2",
    PATCHY_SELF_SERVICE_MINTS_PER_IP_PER_DAY: "3"
  })
)("auth group: self-service minting", (it) => {
  it.effect("mints a token that authenticates, then throttles, then hits the quota", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const api = yield* client.pipe(Effect.provide(bearer("unused")));
      const minted = yield* api.mint();
      assert.deepStrictEqual(Object.keys(minted).sort(), ["ok", "token"]);

      const me = yield* (yield* client.pipe(Effect.provide(bearer(minted.token)))).me();
      assert.strictEqual(me.apiTokenName, "Self-service token 2026-01-01");
      assert.deepStrictEqual(me.scopes, ["upload"]);

      yield* api.mint();
      // The per-minute limit comes before the quota is counted.
      const throttled = yield* api.mint().pipe(Effect.flip);
      assert.deepStrictEqual(throttled, {
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      yield* TestClock.adjust("1 minute");
      yield* api.mint();
      const exceeded = yield* api.mint().pipe(Effect.flip);
      assert.include(exceeded, { ok: false, code: "mint_quota_exceeded", quota: 3 });
    })
  );
});
