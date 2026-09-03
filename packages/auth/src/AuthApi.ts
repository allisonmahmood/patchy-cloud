/**
 * The `auth` group of the Patchy API, implemented over `Tokens`, `Limits` and
 * `Analytics`: self-service minting with its three guardrails, `/api/me`,
 * admin token issue and revocation. The hosting server serves it through its
 * runtime seam until `serving` mounts the whole API.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Analytics } from "@patchy/analytics";
import {
  CreatedToken,
  CreateTokenRequest,
  CurrentIdentity,
  decodeBody,
  DeviceLoginComplete,
  DeviceLoginGone,
  DeviceLoginPending,
  DeviceLoginStarted,
  Forbidden,
  hasScope,
  malformedBody,
  MintedToken,
  MintQuotaExceeded,
  NotFound,
  PatchyApi,
  rateLimited,
  readBody,
  refuse,
  RevokedToken,
  SelfServiceDisabled
} from "@patchy/api";
import { randomToken } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as AuthConfig from "./AuthConfig.js";
import * as DeviceLogins from "./DeviceLogins.prototype.js";
import * as Tokens from "./Tokens.js";

/** A token request is small; this is room for one, not a document. */
const MAX_TOKEN_REQUEST_BYTES = 16 * 1024;
const decodeCreateToken = decodeBody(CreateTokenRequest);

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
    // PROTOTYPE for #131 (throwaway).
    const deviceLogins = yield* DeviceLogins.DeviceLogins;
    const publicBaseUrl = yield* AuthConfig.publicBaseUrl;

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
        // PROTOTYPE for #131 (throwaway): the handoff. Per address like the
        // mint, since the caller has no token to key on.
        .handle("deviceLoginStart", ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const sourceIp = Option.getOrNull(request.remoteAddress);
            const attempt = yield* limits.consume({
              key: `device-login-start:${sourceIp ?? ""}`,
              limit: mintRateLimitPerMinute,
              window: "1 minute"
            });
            if (!attempt.allowed) return rateLimited(attempt);
            const started = yield* deviceLogins
              .start({
                machineName: cleanText(payload.machineName)?.slice(0, 64) ?? null,
                previousTokenId: cleanText(payload.previousTokenId)
              })
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            return new DeviceLoginStarted({
              ok: true,
              deviceCode: started.deviceCode,
              userCode: started.userCode,
              verificationUrl: `${publicBaseUrl}/login/device`,
              verificationUrlComplete: `${publicBaseUrl}/login/device?code=${started.userCode}`,
              expiresAt: started.expiresAt.toISOString(),
              interval: DeviceLogins.POLL_INTERVAL_SECONDS
            });
          })
        )
        // PROTOTYPE for #131 (throwaway): the poll. Keyed by the device code
        // itself, which only the CLI that started the login holds.
        .handle("deviceLoginPoll", ({ payload }) =>
          Effect.gen(function* () {
            const result = yield* deviceLogins
              .poll(payload.deviceCode)
              .pipe(Effect.catchTags({ SqlError: Effect.die }));
            switch (result._tag) {
              case "pending":
                return new DeviceLoginPending({
                  ok: true,
                  status: result.slowDown ? "slow_down" : "pending",
                  expiresAt: result.expiresAt.toISOString()
                });
              case "complete":
                return new DeviceLoginComplete({
                  ok: true,
                  status: "complete",
                  token: result.token,
                  machine: result.machine,
                  accountId: result.accountId,
                  accountName: result.accountName
                });
              case "gone":
                return refuse(DeviceLoginGone, {
                  ok: false,
                  error:
                    result.code === "expired"
                      ? "This login expired before anyone confirmed it."
                      : result.code === "denied"
                        ? "This login was denied."
                        : "No login is pending for this device code.",
                  code: result.code
                });
            }
          })
        )
        .handle("me", () => CurrentIdentity)
        // Raw, so a body the schema refuses — or none at all, which is `{}` —
        // answers in the wire's words rather than an empty 400.
        .handleRaw("createToken", () =>
          Effect.gen(function* () {
            const identity = yield* CurrentIdentity;
            if (!hasScope(identity, "admin")) return forbidden();
            const payload = yield* readBody(MAX_TOKEN_REQUEST_BYTES).pipe(
              Effect.flatMap(decodeCreateToken),
              Effect.catchTags({
                MalformedBody: () => Effect.succeed(malformedBody()),
                BodyTooLarge: () => Effect.succeed(malformedBody())
              })
            );
            if (HttpServerResponse.isHttpServerResponse(payload)) return payload;

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
            if (!hasScope(identity, "admin")) return forbidden();

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
