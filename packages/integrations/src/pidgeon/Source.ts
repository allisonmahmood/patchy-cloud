/**
 * PROTOTYPE (Pidgeon): one email address on Pidgeon (pidgeon.ai), reached with an API key the
 * company's admin minted for exactly that address. Connect reads the key's own description
 * (`GET /me`) and refuses a key that can administer, or reaches more or less than one address,
 * so Patchy holds the least the patches need. Every call goes to Pidgeon's one host and never
 * follows a redirect.
 */
import type { PidgeonSnapshot } from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Fake from "./Fake.js";

export const BASE_URL = "https://pidgeon.ai/api/v1";

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "PidgeonInvalidCredentials",
  { cause: Schema.optionalKey(SecretCause) }
) {
  readonly code = "invalid_credentials";
  readonly status = 422;
  override get message() {
    return "Paste a Pidgeon API key: it starts with pgn_.";
  }
}
/** Pidgeon refused the key: revoked, expired, or mistyped. */
export class KeyRejected extends Schema.TaggedError<KeyRejected>()("PidgeonKeyRejected", {}) {
  readonly code = "pidgeon_key_rejected";
  readonly status = 422;
  override get message() {
    return "Pidgeon refused this key. Check it's current: a revoked or expired key stops working at once.";
  }
}
/** The key reaches more than Patchy will hold, or nothing it can use. */
export class KeyTooBroad extends Schema.TaggedError<KeyTooBroad>()("PidgeonKeyTooBroad", {
  reason: Schema.Literals(["admin", "all_addresses", "addresses"]),
  reaches: Schema.Int
}) {
  readonly code = "pidgeon_key_too_broad";
  readonly status = 422;
  override get message() {
    return this.reason === "admin"
      ? "This key can administer the address. Mint one at read or send instead: Patchy never needs more."
      : this.reason === "all_addresses"
        ? "This key reaches every address in the workspace. Mint one for the single address patches should use."
        : `This key reaches ${this.reaches} addresses. Patchy connects exactly one: mint a key for just that address.`;
  }
}
export class NoInbox extends Schema.TaggedError<NoInbox>()("PidgeonNoInbox", {
  email: Schema.String
}) {
  readonly code = "pidgeon_no_inbox";
  readonly status = 422;
  override get message() {
    return `${this.email} keeps no inbox in Pidgeon, so there's nothing for patches to read. Turn its inbox on, or connect another address.`;
  }
}
/** The thread, message, label or attachment isn't on this address. */
export class NotFound extends Schema.TaggedError<NotFound>()("PidgeonNotFound", {}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return "Pidgeon has no such thread, message, label or attachment on this address.";
  }
}
/**
 * Pidgeon refused a write: the key can only read, or the address may not write to a recipient.
 * When a rule refuses one recipient, nothing is sent to anybody.
 */
export class Refused extends Schema.TaggedError<Refused>()("PidgeonRefused", {
  details: Schema.Struct({
    reason: Schema.Literals(["read_only", "blocked", "not_permitted"]),
    message: Schema.String
  })
}) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return this.details.reason === "read_only"
      ? "This connection's key can read the address but not send from it or change it."
      : `Pidgeon refused the send and sent nothing: ${this.details.message}`;
  }
}
export class RateLimited extends Schema.TaggedError<RateLimited>()("PidgeonRateLimited", {
  limit: Schema.Literals(["requests", "sending", "plan"]),
  retryAfterSeconds: Schema.optionalKey(Schema.Int),
  detail: Schema.optionalKey(Schema.String)
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  override get message() {
    const wait =
      this.retryAfterSeconds === undefined
        ? ""
        : ` Try again in ${this.retryAfterSeconds} seconds.`;
    return this.limit === "sending"
      ? `Pidgeon's sending allowance for this account is used up for now.${wait}`
      : this.limit === "plan"
        ? `Pidgeon's plan for this account doesn't allow that${this.detail === undefined ? "" : `: ${this.detail}`}`
        : `Pidgeon is limiting this account's calls for now.${wait}`;
  }
}
export class Unavailable extends Schema.TaggedError<Unavailable>()("PidgeonUnavailable", {
  stage: Schema.Literals(["request", "redirect", "status", "response"]),
  upstreamStatus: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(SecretCause)
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "Pidgeon could not be reached or answered unexpectedly. Try again.";
  }
}
export class Timeout extends Schema.TaggedError<Timeout>()("PidgeonTimeout", {
  milliseconds: Schema.Int
}) {
  readonly code = "timeout" as const;
  readonly status = 504;
  override get message() {
    return `Pidgeon did not answer within ${this.milliseconds / 1_000} seconds.`;
  }
}
export class TooLarge extends Schema.TaggedError<TooLarge>()("PidgeonTooLarge", {
  maxBytes: Schema.Int
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  readonly limitId = "runtime.result.bytes" as const;
  override get message() {
    return `Pidgeon's answer is larger than ${this.maxBytes} bytes. Ask for fewer threads or messages.`;
  }
}

/** What a call can fail with once the connection exists. */
export type CallError =
  KeyRejected | NotFound | Refused | RateLimited | Unavailable | Timeout | TooLarge;
export type SourceError = CallError | InvalidCredentials | KeyTooBroad | NoInbox;

export const Credentials = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^pgn_[A-Za-z0-9_]{4,200}$/))
});
export type Credentials = typeof Credentials.Type;
/** Safe to show: the address and the start of the key, which Pidgeon itself lists. */
export const Display = Schema.Struct({
  email: Schema.String,
  identityId: Schema.String,
  keyHint: Schema.String
});
export type Display = typeof Display.Type;

const credentialsJson = Schema.fromJsonString(Credentials);
const decodeCredentials = Schema.decodeUnknownEffect(credentialsJson, {
  onExcessProperty: "error"
});
const encodeCredentials = Schema.encodeSync(credentialsJson);
export const credentials = (value: Credentials): Redacted.Redacted<string> =>
  Redacted.make(encodeCredentials(value));
export const parseCredentials = Effect.fn("Pidgeon.parseCredentials")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* decodeCredentials(Redacted.value(secret)).pipe(
    Effect.mapError((cause) => new InvalidCredentials({ cause: Redacted.make(cause) }))
  );
});
// As long as the prefix Pidgeon itself lists, such as `pgn_live_a1b2`.
const hint = (key: string) => `${key.slice(0, 13)}…`;

/** One call to Pidgeon's REST API, relative to `/api/v1`. */
export interface Request {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: Readonly<Record<string, unknown>>;
  /** Sent as `Idempotency-Key`: a repeat answers with the first result and sends nothing. */
  readonly idempotencyKey?: string;
}
/** What Pidgeon answered: its status, headers and JSON body, `undefined` when it sent none. */
export interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

const ErrorBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String })
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const seconds = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.ceil(parsed) : undefined;
};

/** Pidgeon's statuses as Patchy's refusals; a success is its whole `{ data, … }` envelope. */
export const interpret = (answer: Answer): Effect.Effect<unknown, CallError> => {
  const error = Option.getOrUndefined(decodeErrorBody(answer.body))?.error;
  if (answer.status === 401) return Effect.fail(new KeyRejected({}));
  if (answer.status === 403)
    return Effect.fail(
      new Refused({
        details: {
          reason:
            error?.code === "blocked" || error?.code === "not_permitted" ? error.code : "read_only",
          message: (error?.message ?? "refused").slice(0, 500)
        }
      })
    );
  if (answer.status === 404) return Effect.fail(new NotFound({}));
  if (answer.status === 402)
    return Effect.fail(
      new RateLimited({
        limit: "plan",
        ...(error === undefined ? {} : { detail: error.message.slice(0, 300) })
      })
    );
  if (answer.status === 429) {
    const retry = seconds(answer.headers["retry-after"]);
    return Effect.fail(
      new RateLimited({
        limit: answer.headers["x-ratelimit-remaining-day"] === "0" ? "sending" : "requests",
        ...(retry === undefined ? {} : { retryAfterSeconds: retry })
      })
    );
  }
  if (answer.status < 200 || answer.status >= 300)
    return Effect.fail(new Unavailable({ stage: "status", upstreamStatus: answer.status }));
  return answer.body === undefined
    ? Effect.fail(new Unavailable({ stage: "response" }))
    : Effect.succeed(answer.body);
};

/** The `data` of a Pidgeon envelope, or nothing when the answer has none. */
export const data = (body: unknown): unknown =>
  Predicate.isObject(body) && "data" in body ? body.data : undefined;

export class Source extends Context.Service<
  Source,
  {
    /** Reads the key's reach and its one address; returns what pages show. */
    readonly test: (secret: Redacted.Redacted<string>) => Effect.Effect<Display, SourceError>;
    /** Tests, then reads the address's labels and the account's plan. */
    readonly inspect: (
      secret: Redacted.Redacted<string>
    ) => Effect.Effect<
      { readonly display: Display; readonly snapshot: PidgeonSnapshot },
      SourceError
    >;
    /** One call with the connection's key, bounded by `deadline` (epoch milliseconds). */
    readonly call: (
      credentials: Credentials,
      request: Request,
      deadline: number
    ) => Effect.Effect<unknown, CallError>;
  }
>()("@patchy/integrations/pidgeon/Source") {}

const ADMIN_DEADLINE_MS = registry["integration.deadline"].default;
const MAX_BYTES = registry["runtime.result.bytes"].default;
const decoder = new TextDecoder();

const collect = (response: HttpClientResponse.HttpClientResponse, maxBytes: number) =>
  Effect.gen(function* () {
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) return yield* new TooLarge({ maxBytes });
    const chunks = yield* response.stream.pipe(
      Stream.mapError(
        (cause) => new Unavailable({ stage: "response", cause: Redacted.make(cause) })
      ),
      Stream.runFoldEffect(
        () => ({ bytes: 0, chunks: [] as Uint8Array[] }),
        (state, chunk) => {
          if (state.bytes + chunk.byteLength > maxBytes)
            return Effect.fail(new TooLarge({ maxBytes }));
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

const Me = Schema.Struct({
  key: Schema.NullOr(
    Schema.Struct({
      access: Schema.Literals(["read", "send", "admin"]),
      reaches_all_addresses: Schema.Boolean
    })
  ),
  workspace: Schema.Struct({ plan: Schema.String }),
  reaches: Schema.Int
});
const Identity = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  display_name: Schema.NullOr(Schema.String),
  has_inbox: Schema.Boolean,
  send_policy: Schema.String
});
const Label = Schema.Struct({ id: Schema.String, name: Schema.String, colour: Schema.String });
const decodeMe = Schema.decodeUnknownEffect(Me);
const decodeIdentities = Schema.decodeUnknownEffect(Schema.Array(Identity));
const decodeLabels = Schema.decodeUnknownEffect(Schema.Array(Label));

const url = (request: Request) => {
  const target = new URL(`${BASE_URL}${request.path}`);
  for (const [name, value] of Object.entries(request.query ?? {}))
    if (value !== undefined) target.searchParams.set(name, String(value));
  return target.toString();
};

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const send = Effect.fn("Pidgeon.send")(function* (key: string, request: Request) {
    const base = HttpClientRequest.make(request.method)(url(request)).pipe(
      HttpClientRequest.bearerToken(key),
      HttpClientRequest.acceptJson,
      request.idempotencyKey === undefined
        ? (value) => value
        : HttpClientRequest.setHeader("idempotency-key", request.idempotencyKey)
    );
    const response = yield* client
      .execute(
        request.body === undefined
          ? base
          : base.pipe(HttpClientRequest.bodyJsonUnsafe(request.body))
      )
      .pipe(
        Effect.mapError(
          (cause) => new Unavailable({ stage: "request", cause: Redacted.make(cause) })
        ),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(Tracer.DisablePropagation, true)
      );
    if (response.status >= 300 && response.status < 400)
      return yield* new Unavailable({ stage: "redirect", upstreamStatus: response.status });
    const text = yield* collect(response, MAX_BYTES);
    return yield* interpret({
      status: response.status,
      headers: response.headers,
      body: Option.getOrUndefined(decodeJson(text))
    });
  });

  const call = (credentials: Credentials, request: Request, deadline: number) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const milliseconds = Math.max(1, deadline - now);
      return send(credentials.key, request).pipe(
        Effect.timeoutOrElse({
          duration: milliseconds,
          orElse: () => Effect.fail(new Timeout({ milliseconds }))
        })
      );
    });

  /** The key's one address, refused unless it is exactly one with an inbox at read or send. */
  const address = Effect.fn("Pidgeon.address")(function* (credentials: Credentials) {
    const deadline = (yield* Clock.currentTimeMillis) + ADMIN_DEADLINE_MS;
    const unexpected = (cause: unknown) =>
      new Unavailable({ stage: "response", cause: Redacted.make(cause) });
    const me = yield* call(credentials, { method: "GET", path: "/me" }, deadline).pipe(
      Effect.flatMap((body) => decodeMe(data(body))),
      Effect.mapError((cause) => (Schema.isSchemaError(cause) ? unexpected(cause) : cause))
    );
    if (me.key === null) return yield* new KeyRejected({});
    if (me.key.access === "admin")
      return yield* new KeyTooBroad({ reason: "admin", reaches: me.reaches });
    if (me.key.reaches_all_addresses)
      return yield* new KeyTooBroad({ reason: "all_addresses", reaches: me.reaches });
    if (me.reaches !== 1)
      return yield* new KeyTooBroad({ reason: "addresses", reaches: me.reaches });
    const identities = yield* call(
      credentials,
      { method: "GET", path: "/identities", query: { limit: 2 } },
      deadline
    ).pipe(
      Effect.flatMap((body) => decodeIdentities(data(body))),
      Effect.mapError((cause) => (Schema.isSchemaError(cause) ? unexpected(cause) : cause))
    );
    const identity = identities[0];
    if (identity === undefined || identities.length !== 1)
      return yield* new KeyTooBroad({ reason: "addresses", reaches: identities.length });
    if (!identity.has_inbox) return yield* new NoInbox({ email: identity.email });
    return {
      identity,
      access: me.key.access,
      plan: me.workspace.plan,
      display: { email: identity.email, identityId: identity.id, keyHint: hint(credentials.key) },
      deadline
    };
  });

  const test = Effect.fn("Pidgeon.test")(function* (secret: Redacted.Redacted<string>) {
    return (yield* address(yield* parseCredentials(secret))).display;
  });

  const inspect = Effect.fn("Pidgeon.inspect")(function* (secret: Redacted.Redacted<string>) {
    const credentials = yield* parseCredentials(secret);
    const found = yield* address(credentials);
    const labels = yield* call(
      credentials,
      { method: "GET", path: "/labels", query: { identity_id: found.identity.id } },
      found.deadline
    ).pipe(
      Effect.flatMap((body) => decodeLabels(data(body))),
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? new Unavailable({ stage: "response", cause: Redacted.make(cause) })
          : cause
      )
    );
    const snapshot: PidgeonSnapshot = {
      version: 1,
      address: {
        email: found.identity.email,
        displayName: found.identity.display_name,
        sendPolicy: found.identity.send_policy
      },
      access: found.access,
      labels: labels.map(({ id, name, colour }) => ({ id, name, colour })),
      plan: found.plan
    };
    return { display: found.display, snapshot };
  });

  return Source.of({ test, inspect, call });
});

/**
 * Real Pidgeon, except that `pnpm dev` (PATCHY_PIDGEON_FAKE) answers keys starting `pgn_fake_`
 * from the in-memory demo mailbox, so the prototype runs without a Pidgeon account.
 */
const http = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const real = yield* HttpClient.HttpClient;
    const fake = yield* Config.Boolean("PATCHY_PIDGEON_FAKE").pipe(
      Config.withDefault(false),
      Effect.orElseSucceed(() => false)
    );
    if (!fake) return real;
    const workspace = Fake.demo();
    return HttpClient.make((request, target) => {
      const key = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
      if (!key.startsWith(Fake.KEY_PREFIX)) return real.execute(request);
      return Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? Option.getOrUndefined(decodeJson(decoder.decode(request.body.body)))
            : undefined;
        const answer = workspace.respond(key, {
          method: request.method,
          path: target.pathname.replace(/^\/api\/v1/, ""),
          query: target.searchParams,
          body,
          idempotencyKey: request.headers["idempotency-key"]
        });
        return HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json", ...answer.headers }
          })
        );
      });
    });
  })
).pipe(Layer.provide(FetchHttpClient.layer));

export const layer = Layer.effect(Source, make).pipe(Layer.provide(http));
