/**
 * The `auth` group of the Patchy API, implemented over `Tokens`, `Limits` and
 * `Analytics`: self-service minting with its three guardrails and `/api/me`.
 * The hosting server serves it through its runtime seam until `serving`
 * mounts the whole API.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Analytics } from "@patchy/analytics";
import {
  CurrentIdentity,
  MintedToken,
  MintQuotaExceeded,
  PatchyApi,
  rateLimited,
  refuse,
  SelfServiceDisabled
} from "@patchy/api";
import { randomToken } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as AuthConfig from "./AuthConfig.js";
import * as Tokens from "./Tokens.js";

/** A new plaintext token: shown once in the response that issues it, stored only as a hash. */
const newToken = () => `pp_${randomToken(32)}`;

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
    );
  })
);
