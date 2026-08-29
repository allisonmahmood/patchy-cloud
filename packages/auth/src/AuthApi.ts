/**
 * The `auth` group of the Patchy API, implemented over `Tokens`, `Limits` and
 * `Analytics`: self-service minting with its three guardrails, `/api/me`,
 * admin token issue and revocation. `routes` is the group as one router layer,
 * which the hosting server serves through its seam until `serving` mounts the
 * whole API.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Analytics } from "@patchy/analytics";
import {
  AuthGroup,
  CreatedToken,
  CurrentIdentity,
  Forbidden,
  MintedToken,
  MintQuotaExceeded,
  NotFound,
  PatchyApi,
  RateLimited,
  RevokedToken,
  SelfServiceDisabled
} from "@patchy/api";
import { randomToken } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as AuthConfig from "./AuthConfig.js";
import * as Authorization from "./Authorization.js";
import * as Tokens from "./Tokens.js";

const statusOf = SchemaAST.resolveAt<number>("httpApiStatus");

/**
 * A refusal encoded through the wire schema that names it, at that schema's
 * status. Several refusals share one body shape (`Forbidden` and `NotFound`
 * are both `{ ok, error }`), so which schema encodes a body is the only thing
 * that tells them apart — the handler chooses it here rather than failing
 * with a value the endpoint's error union could encode as either.
 */
const refuse = <S extends Schema.Top & Schema.Codec<unknown, unknown>>(
  schema: S,
  body: S["~type.make.in"],
  headers: Record<string, string> = {}
) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeSync(schema)(schema.make(body)), {
    status: statusOf(schema.ast) ?? 400,
    headers
  });

const rateLimited = (decision: Limits.ConsumeResult) =>
  refuse(
    RateLimited,
    {
      ok: false,
      error: "Rate limit exceeded.",
      code: "rate_limited",
      retryAfterSeconds: decision.retryAfterSeconds
    },
    { "retry-after": String(decision.retryAfterSeconds) }
  );

const forbidden = () =>
  refuse(Forbidden, { ok: false, error: "API token does not have the required scope." });

/** A new plaintext token: shown once in the response that issues it, stored only as a hash. */
const newToken = () => `pp_${randomToken(32)}`;

const cleanText = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
};

/**
 * The internal name a mint assigns its principal and token. The client
 * chooses nothing here — the operation takes no input — so the mint date is
 * what makes the row legible to an operator reading the table later.
 */
const selfServiceTokenName = Effect.map(
  Clock.currentTimeMillis,
  (now) => `Self-service token ${DateTime.formatIso(DateTime.makeUnsafe(now)).slice(0, 10)}`
);

export const layer = HttpApiBuilder.group(PatchyApi, "auth", (handlers) =>
  Effect.gen(function* () {
    const tokens = yield* Tokens.Tokens;
    const limits = yield* Limits.Limits;
    const analytics = yield* Analytics.Analytics;
    const allowSelfServiceTokens = yield* AuthConfig.allowSelfServiceTokens;
    const mintRateLimitPerMinute = yield* AuthConfig.mintRateLimitPerMinute;
    const mintsPerIpPerDay = yield* AuthConfig.mintsPerIpPerDay;

    return (
      handlers
        /**
         * Three refusals guard a mint, and the order they run in is the point.
         * The enabled flag first, because a private instance owes an
         * unauthenticated caller nothing but "no". The per-minute rate next,
         * before the quota is counted, so a caller parked at the daily ceiling
         * is throttled rather than left free to re-count the database as fast
         * as it can ask. The daily quota last, because it is the expensive one.
         */
        .handle("mint", () =>
          Effect.gen(function* () {
            if (!allowSelfServiceTokens) {
              return refuse(SelfServiceDisabled, {
                ok: false,
                error:
                  "This instance does not issue self-service tokens. Ask its operator for a token.",
                code: "self_service_disabled"
              });
            }

            // Keyed by source address, since a caller asking for its first
            // token has no token to key on yet.
            const request = yield* HttpServerRequest.HttpServerRequest;
            const sourceIp = Option.getOrNull(request.remoteAddress);
            const attempt = yield* limits.consume({
              key: `self-service-mint:${sourceIp ?? ""}`,
              limit: mintRateLimitPerMinute,
              window: "1 minute"
            });
            if (!attempt.allowed) return rateLimited(attempt);

            const token = newToken();
            const minted = yield* tokens
              .mint({ sourceIp, quota: mintsPerIpPerDay, name: yield* selfServiceTokenName, token })
              .pipe(
                Effect.map(Option.some),
                Effect.catchTags({
                  SqlError: Effect.die,
                  MintQuotaExceeded: () => Effect.succeedNone
                })
              );
            if (Option.isNone(minted)) {
              return refuse(MintQuotaExceeded, {
                ok: false,
                // "Within a day", not "tomorrow": the window rolls off each
                // mint 24 hours after it happened.
                error: `Mint quota reached: ${mintsPerIpPerDay} self-service tokens per address per 24 hours. Reuse the token you already hold, or retry once the oldest of those mints is a day old.`,
                code: "mint_quota_exceeded",
                quota: mintsPerIpPerDay
              });
            }

            // The principal and its token, and nothing about where the mint
            // came from: the source address is what the quota counts, not
            // something to report.
            yield* analytics.track({
              name: "token.minted",
              principalId: minted.value.accountId,
              properties: { apiTokenId: minted.value.apiTokenId, selfService: true }
            });
            return new MintedToken({ ok: true, token });
          })
        )
        .handle("me", () => CurrentIdentity)
        .handle("createToken", ({ payload }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            if (!Tokens.hasScope(identity, "admin")) return forbidden();

            const token = newToken();
            const apiToken = yield* tokens
              .create({
                accountId: identity.accountId,
                name: cleanText(payload.name) ?? "CLI API Token",
                scopes: normalizeScopes(payload.scopes),
                token
              })
              .pipe(Effect.catchTags({ SqlError: Effect.die }));

            // A token minted is a token minted, whichever door it came through;
            // the flag tells the operator's issuing apart from self-service.
            yield* analytics.track({
              name: "token.minted",
              principalId: identity.accountId,
              properties: { apiTokenId: apiToken.id, selfService: false }
            });
            return new CreatedToken({ ok: true, apiToken, token });
          })
        )
        // The moderation loop's last step and its only irreversible one. There
        // is no un-revoke — a replacement is a fresh mint.
        .handle("revokeToken", ({ params }) =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            if (!Tokens.hasScope(identity, "admin")) return forbidden();

            const revocation = yield* tokens
              .revoke(params.apiTokenId)
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            if (Option.isNone(revocation)) {
              return refuse(NotFound, { ok: false, error: "API token not found." });
            }
            return new RevokedToken({
              ok: true,
              alreadyRevoked: revocation.value.alreadyRevoked,
              apiToken: {
                id: revocation.value.id,
                name: revocation.value.name,
                principalId: revocation.value.accountId,
                revokedAt: revocation.value.revokedAt
              }
            });
          })
        )
    );
  })
);

function normalizeScopes(value: ReadonlyArray<string> | undefined): string[] {
  const scopes = (value ?? []).map(cleanText).filter((scope) => scope !== null);
  return scopes.length ? [...new Set(scopes)] : ["upload"];
}

/** The API with only this group in it: what the seam serves and what `HttpApiBuilder.layer` needs. */
const AuthOnlyApi = HttpApi.make("patchy").add(AuthGroup);

/**
 * The group's routes as one router layer, bearer middleware bound. Needs
 * `Tokens`, `Limits` and `Analytics` from the caller.
 */
export const routes = HttpApiBuilder.layer(AuthOnlyApi).pipe(
  Layer.provide(layer),
  Layer.provide(Authorization.layer),
  Layer.provide(HttpServer.layerServices)
);
