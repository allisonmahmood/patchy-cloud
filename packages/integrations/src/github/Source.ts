import { type GithubAccount, GithubAccountType } from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * GitHub, through the environment's GitHub App: the App's own configuration, the authorization
 * that tells Patchy who someone is on GitHub, what that person may see, and installation tokens
 * minted with the App's key. Every request goes to `https://api.github.com` or, for
 * authorization, `https://github.com`, from the host process, and never follows a redirect.
 * Answers are collected under a byte bound before they're decoded. A limit answer is recognised
 * before anything else reads the answer, and nothing is retried here.
 */

export const API_URL = "https://api.github.com";
export const WEB_URL = "https://github.com";

/**
 * The permissions every token is minted with and every installation must hold, all read. An
 * installation missing one, or holding any above read, fails the check.
 */
export const permissions = {
  metadata: "read",
  actions: "read",
  checks: "read",
  statuses: "read",
  contents: "read",
  deployments: "read",
  issues: "read",
  pull_requests: "read"
} as const;
export type Permission = keyof typeof permissions;

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });

// ---------- the App's configuration ----------

/** The host settings the App's credentials come from, in the order an operator fills them. */
export const configKeys = [
  "PATCHY_GITHUB_APP_ID",
  "PATCHY_GITHUB_APP_SLUG",
  "PATCHY_GITHUB_APP_CLIENT_ID",
  "PATCHY_GITHUB_APP_CLIENT_SECRET",
  "PATCHY_GITHUB_APP_PRIVATE_KEY"
] as const;

/** Some of the App's settings are filled and some aren't: the server refuses to start. */
export class AppIncomplete extends Schema.TaggedError<AppIncomplete>()("GithubAppIncomplete", {
  missing: Schema.Array(Schema.String)
}) {
  override get message() {
    return `The GitHub App is partly configured: ${this.missing.join(", ")} ${this.missing.length === 1 ? "is" : "are"} empty. Fill every PATCHY_GITHUB_APP_* setting, or leave them all empty to not offer GitHub.`;
  }
}
/** The App's private key isn't an RSA key Patchy can sign with: the server refuses to start. */
export class AppKeyInvalid extends Schema.TaggedError<AppKeyInvalid>()("GithubAppKeyInvalid", {}) {
  override get message() {
    return "PATCHY_GITHUB_APP_PRIVATE_KEY is not the App's RSA private key in PEM.";
  }
}

/** The App, as Patchy reaches GitHub through it. Only its slug and client id are safe to show. */
export interface App {
  readonly id: string;
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly privateKey: Redacted.Redacted<string>;
}

/**
 * The App from the host's settings: none when every one is empty, which leaves GitHub unoffered,
 * and a refusal naming what's empty when only some are. A private key that can't sign refuses too.
 * A key written with `\n` escapes, as a one-line secret holds it, reads as its lines.
 */
export const appConfig = Effect.gen(function* () {
  const values = yield* Config.all(
    configKeys.map((key) => Config.String(key).pipe(Config.withDefault("")))
  );
  const trimmed = values.map((value) => value.trim());
  const missing = configKeys.filter((_, index) => trimmed[index] === "");
  if (missing.length === configKeys.length) return Option.none<App>();
  if (missing.length > 0) return yield* new AppIncomplete({ missing });
  const [id, slug, clientId, clientSecret, key] = trimmed as [
    string,
    string,
    string,
    string,
    string
  ];
  const privateKey = key.includes("\\n") ? key.replaceAll("\\n", "\n") : key;
  yield* (yield* Cryptography.Cryptography)
    .rsaSha256Sign(privateKey, "patchy")
    .pipe(Effect.mapError(() => new AppKeyInvalid({})));
  return Option.some<App>({
    id,
    slug,
    clientId,
    clientSecret: Redacted.make(clientSecret),
    privateKey: Redacted.make(privateKey)
  });
});

// ---------- refusals ----------

/** GitHub isn't offered on this instance: its App isn't configured. */
export class NotOffered extends Schema.TaggedError<NotOffered>()("GithubNotOffered", {}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return "GitHub isn't offered on this instance.";
  }
}
/**
 * GitHub answered with a limit: Patchy sends nothing more for the installation until `retryAt`
 * (epoch milliseconds), or, for a person's own token, refuses their sign-in until then.
 */
export class RateLimited extends Schema.TaggedError<RateLimited>()("GithubRateLimited", {
  retryAt: Schema.Number,
  now: Schema.Number,
  who: Schema.Literals(["installation", "user"])
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  get retryAfterSeconds() {
    return Math.max(1, Math.ceil((this.retryAt - this.now) / 1_000));
  }
  override get message() {
    return this.who === "user"
      ? `GitHub is refusing your requests for now: your own GitHub rate limit was reached. Try again in ${this.retryAfterSeconds} seconds.`
      : `GitHub is refusing requests for this account for now: its rate limit was reached. Try again in ${this.retryAfterSeconds} seconds.`;
  }
}
/**
 * GitHub couldn't be reached, answered unexpectedly, or refused for a reason that isn't the
 * connection's: `suspended` when the account suspended the App, `key` when GitHub refused the
 * App's own key, which is an operator's to fix.
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("GithubUnavailable", {
  stage: Schema.Literals(["request", "redirect", "status", "response"]),
  upstreamStatus: Schema.optionalKey(Schema.Int),
  reason: Schema.optionalKey(Schema.Literals(["suspended", "key", "listing"])),
  account: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(SecretCause)
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    switch (this.reason) {
      case "suspended":
        return `${this.account ?? "The account"} suspended Patchy Cloud on GitHub. Calls work again once it's unsuspended there; nothing needs doing in Patchy.`;
      case "key":
        return "GitHub refused Patchy's own App key. Patchy's operators have to fix this; try again later.";
      case "listing":
        return "GitHub couldn't list every repository in the installation, so Patchy couldn't tell which ones left. Try again.";
      default:
        return "GitHub could not be reached or answered unexpectedly. Try again.";
    }
  }
}
export class Timeout extends Schema.TaggedError<Timeout>()("GithubTimeout", {
  milliseconds: Schema.Int
}) {
  readonly code = "timeout" as const;
  readonly status = 504;
  override get message() {
    return `GitHub did not answer within ${this.milliseconds / 1_000} seconds.`;
  }
}
/** Patchy's slots for the installation, or for GitHub, stayed full until the deadline; nothing was sent. */
export class Busy extends Schema.TaggedError<Busy>()("GithubBusy", {
  limitId: Schema.Literals(["github.calls.concurrent", "github.host.concurrent"])
}) {
  readonly code = "busy" as const;
  readonly status = 503;
  override get message() {
    return this.limitId === "github.calls.concurrent"
      ? "This GitHub account already has as many requests running from Patchy as it allows. Try again shortly."
      : "Patchy is already reading GitHub as much as it allows at once. Try again shortly.";
  }
}
/** An answer larger than Patchy collects. Nothing was decoded. */
export class Overflow extends Schema.TaggedError<Overflow>()("GithubOverflow", {}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  override get message() {
    return "GitHub's answer is larger than Patchy reads.";
  }
}
/**
 * Signing in to GitHub didn't work: the code was refused, already used, or GitHub said nothing
 * Patchy could use. The status says nothing about it; only the body does.
 */
export class SignInFailed extends Schema.TaggedError<SignInFailed>()("GithubSignInFailed", {
  error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64)))
}) {
  readonly code = "github_sign_in_failed" as const;
  readonly status = 422;
  override get message() {
    return "GitHub didn't sign you in. Press Continue with GitHub to try again.";
  }
}
/** The person's sign-in to GitHub no longer works, as when they revoked Patchy Cloud's access. */
export class SignInEnded extends Schema.TaggedError<SignInEnded>()("GithubSignInEnded", {}) {
  readonly code = "github_sign_in_required" as const;
  readonly status = 409;
  override get message() {
    return "Your sign-in to GitHub ended. Press Continue with GitHub to sign in again.";
  }
}

/** What one request can fail with before its caller reads the answer. */
export type SendError = Unavailable | Overflow | Timeout;
/** What a request with an installation's token or the App's key can fail with. */
export type AppError = SendError | RateLimited;
/** What a request with a person's own token can fail with. */
export type UserError = SendError | RateLimited | SignInEnded;

// ---------- what GitHub answers ----------

/** An installation as GitHub describes it: its account, whether it's suspended, what it holds. */
export interface Installation {
  readonly id: number;
  /** None when the account is of a type Patchy doesn't connect, which is refused, never guessed. */
  readonly account: Option.Option<GithubAccount>;
  readonly suspended: boolean;
  readonly permissions: Readonly<Record<string, string>>;
}
/** A repository as a listing describes it. `admin` is true only where GitHub said exactly so. */
export interface Repository {
  readonly id: number;
  readonly name: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly disabled: boolean;
  readonly admin: boolean;
}
/**
 * A mint's answer: a token and when it expires (epoch milliseconds), or the status GitHub refused
 * with, which says why (shown): 404 gone, 403 suspended or otherwise refused, 422 a repository
 * outside the installation or a permission it lacks, 401 Patchy's own key.
 */
export type Mint =
  | {
      readonly _tag: "Minted";
      readonly token: Redacted.Redacted<string>;
      readonly expiresAt: number;
    }
  | { readonly _tag: "Refused"; readonly status: number };
/** What a mint is for: the repositories it names, or metadata alone across the installation. */
export type MintScope =
  { readonly repositoryIds: ReadonlyArray<number> } | { readonly metadataOnly: true };

const Account = Schema.Struct({
  id: Schema.Int,
  login: Schema.String,
  type: Schema.optionalKey(Schema.String)
});
const InstallationBody = Schema.Struct({
  id: Schema.Int,
  account: Schema.NullOr(Account),
  suspended_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  permissions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
});
const RepositoryBody = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  default_branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  private: Schema.Boolean,
  archived: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  permissions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
});
const decodeInstallations = Schema.decodeUnknownEffect(
  Schema.Struct({ total_count: Schema.Int, installations: Schema.Array(InstallationBody) })
);
const decodeInstallation = Schema.decodeUnknownEffect(InstallationBody);
const decodeRepositories = Schema.decodeUnknownEffect(
  Schema.Struct({ total_count: Schema.Int, repositories: Schema.Array(RepositoryBody) })
);
const decodeUser = Schema.decodeUnknownEffect(
  Schema.Struct({ id: Schema.Int, login: Schema.String })
);
const decodeToken = Schema.decodeUnknownEffect(
  Schema.Struct({ token: Schema.String, expires_at: Schema.String })
);
// The refresh token GitHub sends is never decoded: only the access token and an error are read.
const decodeExchange = Schema.decodeUnknownOption(
  Schema.Struct({
    access_token: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String)
  })
);
const decodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.optionalKey(Schema.String) })
);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeHeader = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ alg: Schema.Literal("RS256"), typ: Schema.Literal("JWT") }))
);
const encodeClaims = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ iat: Schema.Int, exp: Schema.Int, iss: Schema.String }))
);
const isAccountType = Schema.is(GithubAccountType);
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const PAGE = 100;

const installationOf = (body: typeof InstallationBody.Type): Installation => ({
  id: body.id,
  account:
    body.account !== null && body.account.type !== undefined && isAccountType(body.account.type)
      ? Option.some({ id: body.account.id, login: body.account.login, type: body.account.type })
      : Option.none(),
  suspended: body.suspended_at !== undefined && body.suspended_at !== null,
  permissions: body.permissions ?? {}
});
const repositoryOf = (body: typeof RepositoryBody.Type): Repository => ({
  id: body.id,
  name: body.name,
  defaultBranch: body.default_branch ?? "",
  private: body.private,
  archived: body.archived ?? false,
  disabled: body.disabled ?? false,
  admin: body.permissions?.admin === true
});

/**
 * The permissions an installation lacks, and any it holds above read, against `permissions`.
 * Both empty means it holds exactly what Patchy needs, as far as reading goes.
 */
export const permissionGaps = (held: Readonly<Record<string, string>>) => ({
  missing: (Object.keys(permissions) as Array<Permission>).filter(
    (name) => held[name] === undefined
  ),
  above: Object.entries(held)
    .filter(([, level]) => level !== "read")
    .map(([name]) => name)
    .sort()
});

/** An answer once its transport, redirect and server failures are taken out. */
interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

/**
 * When a limit answer lets Patchy try again, in epoch milliseconds, or none when the answer
 * isn't one: a 429; a 403 with `Retry-After` or `X-RateLimit-Remaining: 0`; or a 403 whose body
 * is GitHub's secondary-limit message, which may carry neither header (from the docs: not shown).
 * GitHub's own time when it names one, else `fallback` from now.
 */
export const limitAnswer = (
  answer: Answer,
  now: number,
  fallback: number
): Option.Option<number> => {
  const retryAfter = answer.headers["retry-after"]?.trim();
  const remaining = answer.headers["x-ratelimit-remaining"]?.trim();
  const message = Option.getOrUndefined(
    Option.flatMap(decodeJson(answer.text), (body) => decodeMessage(body))
  )?.message;
  const limited =
    answer.status === 429 ||
    (answer.status === 403 &&
      (retryAfter !== undefined ||
        remaining === "0" ||
        (message !== undefined && /secondary rate limit|abuse detection/i.test(message))));
  if (!limited) return Option.none();
  if (retryAfter !== undefined && /^\d{1,6}$/.test(retryAfter))
    return Option.some(now + Number(retryAfter) * 1_000);
  if (retryAfter !== undefined) {
    const at = DateTime.make(retryAfter);
    if (Option.isSome(at)) return Option.some(Math.max(now, DateTime.toEpochMillis(at.value)));
  }
  const reset = answer.headers["x-ratelimit-reset"]?.trim();
  if (remaining === "0" && reset !== undefined && /^\d{1,12}$/.test(reset))
    return Option.some(Math.max(now, Number(reset) * 1_000));
  return Option.some(now + fallback);
};

/** Base64url without padding, as a JWT's parts are. */
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

// ---------- the service ----------

/** GitHub through the App, with one admission gate per installation in this process. */
export class Source extends Context.Service<
  Source,
  {
    /** The App, or none when this instance doesn't offer GitHub. */
    readonly app: Option.Option<{ readonly slug: string; readonly clientId: string }>;
    /** Where the App is installed, and where an account's owner adds repositories to it. */
    readonly installUrl: Effect.Effect<string, NotOffered>;
    /**
     * Where to send a browser to sign in to GitHub: `state` carries the flow's fresh nonce and
     * `challenge` its S256 challenge. `selectAccount` asks GitHub to let them pick another account.
     */
    readonly authorizeUrl: (input: {
      readonly state: string;
      readonly challenge: string;
      readonly redirectUri: string;
      readonly selectAccount: boolean;
    }) => Effect.Effect<string, NotOffered>;
    /**
     * Exchanges the code with its PKCE verifier. It worked only when the body carries a token and
     * no error, whatever the status (shown: a used code answers 200 with an error).
     */
    readonly exchange: (input: {
      readonly code: string;
      readonly verifier: string;
      readonly redirectUri: string;
    }) => Effect.Effect<
      Redacted.Redacted<string>,
      SignInFailed | SendError | RateLimited | NotOffered
    >;
    /** Who a person's token belongs to, by GitHub's numeric id. */
    readonly user: (
      token: Redacted.Redacted<string>
    ) => Effect.Effect<{ readonly id: number; readonly login: string }, UserError>;
    /** Revokes a person's token at GitHub. Best effort: it never fails. */
    readonly revokeUser: (token: Redacted.Redacted<string>) => Effect.Effect<void>;
    /**
     * The installations of the App a person can see, up to `max`; `complete` is false when
     * there were more.
     */
    readonly userInstallations: (
      token: Redacted.Redacted<string>,
      max: number
    ) => Effect.Effect<
      { readonly installations: ReadonlyArray<Installation>; readonly complete: boolean },
      UserError
    >;
    /**
     * The repositories of one installation a person can see, with whether GitHub says they
     * administer each, up to `max`; `complete` is false when there were more.
     */
    readonly userRepositories: (
      token: Redacted.Redacted<string>,
      installationId: number,
      max: number
    ) => Effect.Effect<
      { readonly repositories: ReadonlyArray<Repository>; readonly complete: boolean },
      UserError
    >;
    /** The installation as the App reads it with its key; none when it's gone. */
    readonly installation: (
      installationId: number
    ) => Effect.Effect<Option.Option<Installation>, AppError | NotOffered>;
    /** An installation token for `scope`, read permissions named; see `Mint` for refusals. */
    readonly mint: (
      installationId: number,
      scope: MintScope
    ) => Effect.Effect<Mint, AppError | NotOffered>;
    /**
     * Every repository an installation token reaches, up to `max`, or `listing` unavailable
     * past it: a token minted for named repositories reaches only those.
     */
    readonly installationRepositories: (
      token: Redacted.Redacted<string>,
      max: number
    ) => Effect.Effect<ReadonlyArray<Repository>, AppError>;
    /** Revokes an installation token. Best effort: it never fails. */
    readonly revokeInstallationToken: (token: Redacted.Redacted<string>) => Effect.Effect<void>;
    /**
     * Runs `effect` holding one of the installation's slots and one of GitHub's, the whole of it
     * within `deadline` (epoch milliseconds), every page and request included. Waiting keeps a
     * one-second reserve before it, then refuses `busy` with nothing sent; work still running at
     * it is refused `timeout`. The slots are released however `effect` ends, interruption too.
     */
    readonly withSlot: (
      installationId: number,
      deadline: number
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Busy | Timeout, R>;
    /**
     * `withSlot` for requests with a person's own token while they connect, which no
     * installation's slots count: one of GitHub's slots alone, within `deadline` as there.
     */
    readonly withHost: (
      deadline: number
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Busy | Timeout, R>;
  }
>()("@patchy/integrations/github/Source") {}

/** The reserve a queued call keeps before its deadline, so a slot freed later isn't worth taking. */
const SLOT_RESERVE_MS = 1_000;

/** Reads the whole body, refusing it once it passes `max` bytes. */
const collect = (response: HttpClientResponse.HttpClientResponse, max: number) =>
  Effect.gen(function* () {
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) return yield* new Overflow({});
    const chunks = yield* response.stream.pipe(
      Stream.mapError(
        (cause) => new Unavailable({ stage: "response", cause: Redacted.make(cause) })
      ),
      Stream.runFoldEffect(
        () => ({ bytes: 0, chunks: [] as Uint8Array[] }),
        (state, chunk) => {
          if (state.bytes + chunk.byteLength > max) return Effect.fail(new Overflow({}));
          state.bytes += chunk.byteLength;
          state.chunks.push(chunk);
          return Effect.succeed(state);
        }
      )
    );
    const body = new Uint8Array(chunks.bytes);
    let offset = 0;
    for (const chunk of chunks.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return decoder.decode(body);
  });

/** `app` built from the host's settings, over the client this layer is given. */
export const makeWith = (app: Option.Option<App>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const cryptography = yield* Cryptography.Cryptography;
    const maxBytes = yield* ContractLimits.get("github.response.bytes");
    const deadline = yield* ContractLimits.get("integration.deadline");
    const cooldown = yield* ContractLimits.get("github.cooldown.default");
    const perInstallation = yield* ContractLimits.get("github.calls.concurrent");
    const host = Semaphore.makeUnsafe(yield* ContractLimits.get("github.host.concurrent"));
    const gates = new Map<number, Semaphore.Semaphore>();
    const gate = (installationId: number) => {
      let found = gates.get(installationId);
      if (found === undefined) {
        found = Semaphore.makeUnsafe(perInstallation);
        gates.set(installationId, found);
      }
      return found;
    };
    const configured = Option.match(app, {
      onNone: () => Effect.fail(new NotOffered({})),
      onSome: (value) => Effect.succeed(value)
    });

    /** One request; a redirect and a server error fail here, every other answer is returned. */
    const send = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const response = yield* client
          .execute(
            request.pipe(
              HttpClientRequest.setHeaders({
                accept: request.headers.accept ?? "application/vnd.github+json",
                "x-github-api-version": "2022-11-28",
                "user-agent": "Patchy-Cloud"
              })
            )
          )
          .pipe(
            Effect.mapError(
              (cause) => new Unavailable({ stage: "request", cause: Redacted.make(cause) })
            ),
            // Never follow a redirect: fetch would otherwise carry the token wherever it points.
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            // Trace context stays inside Patchy.
            Effect.provideService(Tracer.DisablePropagation, true)
          );
        if (response.status >= 300 && response.status < 400)
          return yield* new Unavailable({ stage: "redirect", upstreamStatus: response.status });
        if (response.status >= 500)
          return yield* new Unavailable({ stage: "status", upstreamStatus: response.status });
        return {
          status: response.status,
          headers: response.headers,
          text: yield* collect(response, maxBytes)
        } satisfies Answer;
      }).pipe(
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () => Effect.fail(new Timeout({ milliseconds: deadline }))
        })
      );
    /** A request whose limit answer is refused as `who`'s, before anything else reads it. */
    const limited = (who: RateLimited["who"]) => (answer: Answer) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const retryAt = limitAnswer(answer, now, cooldown);
        if (Option.isSome(retryAt))
          return yield* new RateLimited({ retryAt: retryAt.value, now, who });
        return answer;
      });
    const body = (answer: Answer) =>
      Option.match(decodeJson(answer.text), {
        onNone: () =>
          Effect.fail(new Unavailable({ stage: "response", upstreamStatus: answer.status })),
        onSome: Effect.succeed
      });
    const unexpected = (answer: Answer) =>
      Effect.fail(new Unavailable({ stage: "status", upstreamStatus: answer.status }));
    const malformed = (cause: unknown) =>
      new Unavailable({ stage: "response", cause: Redacted.make(cause) });

    const userRequest = (token: Redacted.Redacted<string>, path: string) =>
      send(
        HttpClientRequest.get(`${API_URL}${path}`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token))
        )
      ).pipe(
        Effect.flatMap(limited("user")),
        Effect.flatMap((answer) =>
          answer.status === 401 ? Effect.fail(new SignInEnded({})) : Effect.succeed(answer)
        )
      );

    /** The App's JWT: issued a minute back for clock drift, good for nine minutes. */
    const jwt = Effect.gen(function* () {
      const value = yield* configured;
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
      const head = base64url(encoder.encode(encodeHeader({ alg: "RS256", typ: "JWT" })));
      const claims = base64url(
        encoder.encode(encodeClaims({ iat: now - 60, exp: now + 540, iss: value.clientId }))
      );
      const signature = yield* cryptography
        .rsaSha256Sign(Redacted.value(value.privateKey), `${head}.${claims}`)
        .pipe(Effect.orDie);
      return `${head}.${claims}.${base64url(signature)}`;
    });
    const appRequest = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const token = yield* jwt;
        return yield* send(request.pipe(HttpClientRequest.bearerToken(token))).pipe(
          Effect.flatMap(limited("installation"))
        );
      });
    /** A 401 to the App's own key is an operator's problem, never a connection's. */
    const keyRefused = Effect.gen(function* () {
      yield* Effect.logError(
        "GitHub refused the App's key: check PATCHY_GITHUB_APP_PRIVATE_KEY, the App's id and this host's clock."
      );
      return yield* new Unavailable({ stage: "status", upstreamStatus: 401, reason: "key" });
    });

    const installUrl = Effect.map(
      configured,
      (value) => `${WEB_URL}/apps/${encodeURIComponent(value.slug)}/installations/new`
    );

    const authorizeUrl = (input: {
      readonly state: string;
      readonly challenge: string;
      readonly redirectUri: string;
      readonly selectAccount: boolean;
    }) =>
      Effect.map(configured, (value) => {
        const url = new URL(`${WEB_URL}/login/oauth/authorize`);
        url.searchParams.set("client_id", value.clientId);
        url.searchParams.set("redirect_uri", input.redirectUri);
        url.searchParams.set("state", input.state);
        url.searchParams.set("code_challenge", input.challenge);
        url.searchParams.set("code_challenge_method", "S256");
        if (input.selectAccount) url.searchParams.set("prompt", "select_account");
        return url.toString();
      });

    const exchange = Effect.fn("Github.exchange")(function* (input: {
      readonly code: string;
      readonly verifier: string;
      readonly redirectUri: string;
    }) {
      const value = yield* configured;
      const answer = yield* send(
        HttpClientRequest.post(`${WEB_URL}/login/oauth/access_token`).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.bodyUrlParams({
            client_id: value.clientId,
            client_secret: Redacted.value(value.clientSecret),
            code: input.code,
            code_verifier: input.verifier,
            redirect_uri: input.redirectUri
          })
        )
      ).pipe(Effect.flatMap(limited("user")));
      const decoded = Option.getOrUndefined(
        Option.flatMap(decodeJson(answer.text), (json) => decodeExchange(json))
      );
      if (
        decoded === undefined ||
        decoded.error !== undefined ||
        decoded.access_token === undefined ||
        decoded.access_token === ""
      )
        return yield* new SignInFailed(
          decoded?.error === undefined ? {} : { error: decoded.error.slice(0, 64) }
        );
      return Redacted.make(decoded.access_token);
    });

    const user = Effect.fn("Github.user")(function* (token: Redacted.Redacted<string>) {
      const answer = yield* userRequest(token, "/user");
      if (answer.status !== 200) return yield* unexpected(answer);
      return yield* decodeUser(yield* body(answer)).pipe(Effect.mapError(malformed));
    });

    const revokeUser = (token: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const value = yield* configured;
        yield* send(
          HttpClientRequest.make("DELETE")(
            `${API_URL}/applications/${encodeURIComponent(value.clientId)}/token`
          ).pipe(
            HttpClientRequest.basicAuth(value.clientId, Redacted.value(value.clientSecret)),
            HttpClientRequest.bodyJsonUnsafe({ access_token: Redacted.value(token) })
          )
        );
      }).pipe(Effect.ignore);

    const userInstallations = Effect.fn("Github.userInstallations")(function* (
      token: Redacted.Redacted<string>,
      max: number
    ) {
      const installations: Array<Installation> = [];
      for (let page = 1; installations.length < max; page++) {
        const answer = yield* userRequest(
          token,
          `/user/installations?per_page=${PAGE}&page=${page}`
        );
        if (answer.status !== 200) return yield* unexpected(answer);
        const decoded = yield* decodeInstallations(yield* body(answer)).pipe(
          Effect.mapError(malformed)
        );
        installations.push(...decoded.installations.map(installationOf));
        if (decoded.installations.length < PAGE || installations.length >= decoded.total_count)
          return {
            installations: installations.slice(0, max),
            complete: installations.length <= max
          };
      }
      return { installations: installations.slice(0, max), complete: false };
    });

    const userRepositories = Effect.fn("Github.userRepositories")(function* (
      token: Redacted.Redacted<string>,
      installationId: number,
      max: number
    ) {
      const repositories: Array<Repository> = [];
      for (let page = 1; repositories.length < max; page++) {
        const answer = yield* userRequest(
          token,
          `/user/installations/${installationId}/repositories?per_page=${PAGE}&page=${page}`
        );
        // An installation the person has no part in answers 404 (shown): nothing to offer.
        if (answer.status === 404) return { repositories: [], complete: true };
        if (answer.status !== 200) return yield* unexpected(answer);
        const decoded = yield* decodeRepositories(yield* body(answer)).pipe(
          Effect.mapError(malformed)
        );
        repositories.push(...decoded.repositories.map(repositoryOf));
        if (decoded.repositories.length < PAGE || repositories.length >= decoded.total_count)
          return { repositories: repositories.slice(0, max), complete: repositories.length <= max };
      }
      return { repositories: repositories.slice(0, max), complete: false };
    });

    const installation = Effect.fn("Github.installation")(function* (installationId: number) {
      const answer = yield* appRequest(
        HttpClientRequest.get(`${API_URL}/app/installations/${installationId}`)
      );
      if (answer.status === 404) return Option.none<Installation>();
      if (answer.status === 401) return yield* keyRefused;
      if (answer.status !== 200) return yield* unexpected(answer);
      return Option.some(
        installationOf(
          yield* decodeInstallation(yield* body(answer)).pipe(Effect.mapError(malformed))
        )
      );
    });

    const mint = Effect.fn("Github.mint")(function* (installationId: number, scope: MintScope) {
      const answer = yield* appRequest(
        HttpClientRequest.post(`${API_URL}/app/installations/${installationId}/access_tokens`).pipe(
          HttpClientRequest.bodyJsonUnsafe(
            "metadataOnly" in scope
              ? { permissions: { metadata: "read" } }
              : { repository_ids: scope.repositoryIds, permissions }
          )
        )
      );
      if (answer.status === 401) return yield* keyRefused;
      if (answer.status !== 201)
        return { _tag: "Refused", status: answer.status } satisfies Mint as Mint;
      const decoded = yield* decodeToken(yield* body(answer)).pipe(Effect.mapError(malformed));
      const expiresAt = DateTime.make(decoded.expires_at);
      if (Option.isNone(expiresAt))
        return yield* new Unavailable({ stage: "response", upstreamStatus: 201 });
      return {
        _tag: "Minted",
        token: Redacted.make(decoded.token),
        expiresAt: DateTime.toEpochMillis(expiresAt.value)
      } satisfies Mint as Mint;
    });

    const installationRepositories = Effect.fn("Github.installationRepositories")(function* (
      token: Redacted.Redacted<string>,
      max: number
    ) {
      const repositories: Array<Repository> = [];
      for (let page = 1; ; page++) {
        const answer = yield* send(
          HttpClientRequest.get(
            `${API_URL}/installation/repositories?per_page=${PAGE}&page=${page}`
          ).pipe(HttpClientRequest.bearerToken(Redacted.value(token)))
        ).pipe(Effect.flatMap(limited("installation")));
        if (answer.status !== 200)
          return yield* new Unavailable({
            stage: "status",
            upstreamStatus: answer.status,
            reason: "listing"
          });
        const decoded = yield* decodeRepositories(yield* body(answer)).pipe(
          Effect.mapError(malformed)
        );
        if (decoded.total_count > max)
          return yield* new Unavailable({ stage: "response", reason: "listing" });
        repositories.push(...decoded.repositories.map(repositoryOf));
        if (decoded.repositories.length < PAGE || repositories.length >= decoded.total_count)
          return repositories;
      }
    });

    const revokeInstallationToken = (token: Redacted.Redacted<string>) =>
      send(
        HttpClientRequest.make("DELETE")(`${API_URL}/installation/token`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token))
        )
      ).pipe(Effect.ignore);

    /** `effect` within what's left until `until`, refused `timeout` past it. */
    const bounded = <A, E, R>(until: number, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        until <= now
          ? Effect.fail(new Timeout({ milliseconds: deadline }))
          : effect.pipe(
              Effect.timeoutOrElse({
                duration: until - now,
                orElse: () => Effect.fail(new Timeout({ milliseconds: deadline }))
              })
            )
      );
    /**
     * Runs `effect` holding one permit of each of `semaphores` in order, all of it within `until`.
     * As Semaphore's own `withPermits`: only the waiting may be interrupted, never the taking, so
     * an interrupted caller never holds a permit it won't release.
     */
    const admitted =
      (semaphores: ReadonlyArray<readonly [Semaphore.Semaphore, Busy["limitId"]]>, until: number) =>
      <A, E, R>(effect: Effect.Effect<A, E | Busy | Timeout, R>) =>
        Effect.uninterruptibleMask((restore) => {
          const take = (semaphore: Semaphore.Semaphore, limitId: Busy["limitId"]) =>
            Effect.gen(function* () {
              while (!(yield* semaphore.takeIfAvailable(1))) {
                const budget = until - SLOT_RESERVE_MS - (yield* Clock.currentTimeMillis);
                if (budget <= 0) return yield* new Busy({ limitId });
                const freed = yield* restore(
                  semaphore.withPermits(1)(Effect.void).pipe(Effect.timeoutOption(budget))
                );
                if (Option.isNone(freed)) return yield* new Busy({ limitId });
              }
            });
          return semaphores.reduceRight<Effect.Effect<A, E | Busy | Timeout, R>>(
            (inner, [semaphore, limitId]) =>
              take(semaphore, limitId).pipe(
                Effect.andThen(inner.pipe(Effect.ensuring(semaphore.release(1))))
              ),
            restore(bounded(until, effect))
          );
        });
    const withSlot =
      (installationId: number, until: number) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Busy | Timeout, R> =>
        admitted(
          [
            [gate(installationId), "github.calls.concurrent"],
            [host, "github.host.concurrent"]
          ],
          until
        )(effect);
    const withHost =
      (until: number) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Busy | Timeout, R> =>
        admitted([[host, "github.host.concurrent"]], until)(effect);

    return Source.of({
      app: Option.map(app, (value) => ({ slug: value.slug, clientId: value.clientId })),
      installUrl,
      authorizeUrl,
      exchange,
      user,
      revokeUser,
      userInstallations,
      userRepositories,
      installation,
      mint,
      installationRepositories,
      revokeInstallationToken,
      withSlot,
      withHost
    });
  });

/** The App from the host's settings; a partial or unusable one fails the layer, and the server. */
export const make = Effect.flatMap(appConfig, makeWith);

export const layer = Layer.effect(Source, make).pipe(Layer.provide(FetchHttpClient.layer));
