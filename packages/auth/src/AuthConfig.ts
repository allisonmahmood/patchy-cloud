/** The auth capability's configuration, read from the environment through Effect `Config`. */
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/**
 * The operator's own credential, seeded as an admin token when the Postgres
 * layer builds. Absent or blank means no bootstrap principal is provisioned.
 */
export const bootstrapApiToken = Config.option(Config.string("PATCHY_BOOTSTRAP_API_TOKEN")).pipe(
  Config.map(Option.filter((value) => value.trim().length > 0)),
  Config.map(Option.map((value) => Redacted.make(value.trim())))
);

/** Whether the instance mints tokens for anyone who asks. Off by default. */
export const allowSelfServiceTokens = Config.boolean("PATCHY_ALLOW_SELF_SERVICE_TOKENS").pipe(
  Config.withDefault(false)
);

/** Mints admitted per source address per minute, in memory. */
export const mintRateLimitPerMinute = Config.int(
  "PATCHY_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE"
).pipe(Config.withDefault(5));

/** The mint quota: mints one source address may be handed across a rolling day. */
export const mintsPerIpPerDay = Config.int("PATCHY_SELF_SERVICE_MINTS_PER_IP_PER_DAY").pipe(
  Config.withDefault(5)
);

/**
 * PROTOTYPE for #131 (throwaway): where the confirm page lives, for the URL
 * the login handoff prints. The same variable Serving reads; a real build
 * would take it from one place.
 */
export const publicBaseUrl = Config.string("PATCHY_PUBLIC_BASE_URL").pipe(
  Config.withDefault("http://localhost:3000"),
  Config.map((value) => value.trim().replace(/\/+$/, ""))
);
