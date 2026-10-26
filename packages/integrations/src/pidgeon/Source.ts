import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
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
 * Pidgeon (pidgeon.ai), email addresses for software. The credentialed server makes every call,
 * only to Pidgeon's API host, and never follows a redirect. Answers, refusals included, are read
 * under a byte cap before they are decoded, and each address's calls pass one gate per process,
 * shared by connection administration, `patchy dev` and published patches.
 */

export const BASE_URL = "https://pidgeon.ai/api/v1";
const base = new URL(`${BASE_URL}/`);

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });
/** Pidgeon's own explanation of a refusal, written to be shown to a person; bounded. */
const Explanation = Schema.String.check(Schema.isMaxLength(500));

/** Pidgeon didn't accept the key: revoked, mistyped, or an old secret past its grace period. */
export class KeyRejected extends Schema.TaggedError<KeyRejected>()("PidgeonKeyRejected", {}) {
  readonly code = "pidgeon_key_rejected" as const;
  readonly status = 422;
  override get message() {
    return "Pidgeon didn't accept this key: it was revoked, mistyped, or it's an old secret past its grace period.";
  }
}
/** The key may not do this: its access is too low, or the account is on hold. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("PidgeonForbidden", {
  details: Schema.Struct({ message: Explanation })
}) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return `Pidgeon refused: ${this.details.message}`;
  }
}
/** The address's send policy, or a block, refused a send as a whole; nothing was sent. */
export class Refused extends Schema.TaggedError<Refused>()("PidgeonRefused", {
  details: Schema.Struct({
    reason: Schema.Literals(["not_permitted", "blocked"]),
    message: Explanation
  })
}) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return `Pidgeon refused the send and sent nothing: ${this.details.message}`;
  }
}
/** Nothing by that id that this key reaches; Pidgeon answers a missing id and another's alike. */
export class NotFound extends Schema.TaggedError<NotFound>()("PidgeonNotFound", {}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return "Pidgeon has nothing by that id that this key reaches.";
  }
}
/** It conflicts with what is there: a taken address, or an idempotency key used differently. */
export class Conflict extends Schema.TaggedError<Conflict>()("PidgeonConflict", {
  details: Schema.Struct({ field: Schema.optionalKey(Schema.String), message: Explanation })
}) {
  readonly code = "conflict" as const;
  readonly status = 409;
  override get message() {
    return `Pidgeon refused: ${this.details.message}`;
  }
}
/** Pidgeon refused the request as written, naming the field at fault when it's one. */
export class Invalid extends Schema.TaggedError<Invalid>()("PidgeonInvalid", {
  details: Schema.Struct({ field: Schema.optionalKey(Schema.String), message: Explanation })
}) {
  readonly code = "invalid_request" as const;
  readonly status = 400;
  override get message() {
    return `Pidgeon refused the request: ${this.details.message}`;
  }
}
/**
 * Pidgeon's rate or plan limit said no (429 and 402). Nothing changed, and Patchy never retries.
 * Key management has an account-wide limit whose 429 lasts about ten minutes and names no wait.
 */
export class RateLimited extends Schema.TaggedError<RateLimited>()("PidgeonRateLimited", {
  limit: Schema.Literals(["requests", "plan"]),
  /** Present only when Pidgeon sent Retry-After. */
  retryAfterSeconds: Schema.optionalKey(Schema.Int),
  details: Schema.Struct({ message: Explanation })
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  override get message() {
    return this.limit === "plan"
      ? `Pidgeon's plan for this account doesn't allow that: ${this.details.message}`
      : `Pidgeon is limiting this account for now. Try again${this.retryAfterSeconds === undefined ? " in a few minutes" : ` in ${this.retryAfterSeconds} seconds`}.`;
  }
}
/** Pidgeon couldn't be reached, redirected, or answered in a way Patchy doesn't read. */
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
    return `Pidgeon did not answer within ${Math.ceil(this.milliseconds / 1_000)} seconds.`;
  }
}
export class TooLarge extends Schema.TaggedError<TooLarge>()("PidgeonTooLarge", {
  maxBytes: Schema.Int
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  readonly limitId = "runtime.result.bytes" as const;
  override get message() {
    return `Pidgeon's answer is larger than ${this.maxBytes} bytes.`;
  }
  get details() {
    return { maxBytes: this.maxBytes };
  }
}
/** Patchy's own gate for the address stayed full until the call's deadline; nothing was sent. */
export class Busy extends Schema.TaggedError<Busy>()("PidgeonBusy", {}) {
  readonly code = "busy" as const;
  readonly status = 503;
  readonly limitId = "pidgeon.calls.concurrent" as const;
  readonly scope = registry["pidgeon.calls.concurrent"].scope;
  readonly value = registry["pidgeon.calls.concurrent"].default;
  override get message() {
    return `This address already has ${this.value} calls to Pidgeon running from Patchy. Try again shortly.`;
  }
}

/** What one call can fail with once it holds a slot. */
export type CallError =
  | KeyRejected
  | Forbidden
  | Refused
  | NotFound
  | Conflict
  | Invalid
  | RateLimited
  | Unavailable
  | Timeout
  | TooLarge;

/**
 * Whether a refusal proves Pidgeon changed nothing. Anything else may have run: an answer lost on
 * the way back, a timeout, or a server error.
 */
export const isRefusal = (error: CallError): boolean =>
  error._tag !== "PidgeonUnavailable" &&
  error._tag !== "PidgeonTimeout" &&
  error._tag !== "PidgeonTooLarge";

/** A Pidgeon secret: `pgn_live_…` for live keys, `pgn_test_…` for test-mode ones. */
export const Token = Schema.String.check(
  Schema.isPattern(/^pgn_(?:live|test)_[A-Za-z0-9_-]{4,250}$/)
);
export const isToken = Schema.is(Token);
/** Pidgeon's own word for test mode is in the secret alone: `/me` looks the same for both. */
export const isTestToken = (token: string) => token.startsWith("pgn_test_");

/** What the ciphertext holds: the address key Patchy minted, and old ones not yet revoked. */
/** One Pidgeon key: its id, which it can revoke and rotate itself by, and its secret. */
export const Key = Schema.Struct({ id: Schema.String, token: Token });
export type Key = typeof Key.Type;
export const Credentials = Schema.Struct({
  identityId: Schema.String,
  key: Key,
  /**
   * Keys Patchy replaced and hasn't revoked yet, saved with their replacement; each revokes itself
   * when Patchy tries again.
   */
  retired: Schema.optionalKey(Schema.Array(Key))
});
export type Credentials = typeof Credentials.Type;

const Instant = Schema.String;
/** Safe to show: the address, Patchy's key by name, and where its rotation stands. */
export const Display = Schema.Struct({
  email: Schema.String,
  identityId: Schema.String,
  /** Who the address may write to, as Pidgeon says: reply_only, open or list. */
  sendPolicy: Schema.String,
  access: Schema.Literals(["read", "send"]),
  key: Schema.Struct({ id: Schema.String, name: Schema.String, madeAt: Instant }),
  /**
   * A rotation Patchy saved, until its old secret stops; or one whose answer hasn't come, recorded
   * before Pidgeon is asked, so the stored secret may stop by `stopsBy`. Replacing the key clears it.
   */
  rotation: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ outcome: Schema.Literal("saved"), oldStopsAt: Instant }),
      Schema.Struct({ outcome: Schema.Literal("unknown"), at: Instant, stopsBy: Instant })
    ])
  ),
  /** Keys Patchy replaced and hasn't revoked yet, named until they are. */
  retired: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
  )
});
export type Display = typeof Display.Type;

const credentialsJson = Schema.fromJsonString(Credentials);
const decodeCredentials = Schema.decodeUnknownEffect(credentialsJson, {
  onExcessProperty: "error"
});
const encodeCredentials = Schema.encodeSync(credentialsJson);

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "PidgeonInvalidCredentials",
  { cause: SecretCause }
) {
  readonly code = "invalid_credentials";
  readonly status = 422;
  override get message() {
    return "The stored Pidgeon key could not be read. Replace the key.";
  }
}

export const credentials = (value: Credentials): Redacted.Redacted<string> =>
  Redacted.make(encodeCredentials(value));
export const parseCredentials = Effect.fn("Pidgeon.parseCredentials")(function* (
  secret: Redacted.Redacted<string>
) {
  return yield* decodeCredentials(Redacted.value(secret)).pipe(
    Effect.mapError((cause) => new InvalidCredentials({ cause: Redacted.make(cause) }))
  );
});

/** One call to Pidgeon's REST API, by its path under `/api/v1`. */
export interface Request {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Starts with `/`; ids in it are already encoded with `encodeURIComponent`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  /** Sent as `Idempotency-Key`: a repeat of the same request answers the first result. */
  readonly idempotencyKey?: string;
}
/** A success: Pidgeon's whole envelope, and whether it replayed an earlier answer. */
export interface Answer {
  readonly body: unknown;
  readonly replayed: boolean;
}

/** The `data` of Pidgeon's `{ data }` envelope, or nothing when the answer has none. */
export const data = (body: unknown): unknown =>
  Predicate.isObject(body) && "data" in body ? body.data : undefined;

const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    field: Schema.optionalKey(Schema.String)
  })
});
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Pidgeon's message, bounded, with anything shaped like a secret taken out. */
const explanation = (value: string | undefined, fallback: string) =>
  (value ?? fallback).replace(/pgn_[A-Za-z0-9_-]+/g, "pgn_…").slice(0, 500);
const retryAfter = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim());
};

/**
 * Pidgeon's statuses as Patchy's refusals, from an answer already read under the cap. Pidgeon
 * says `{ error: { code, message, field? } }`; a refusal that isn't one of its own is unavailable.
 */
export const classify = (
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  text: string
): Effect.Effect<Answer, CallError> => {
  if (status >= 200 && status < 300)
    return Option.match(decodeJson(text), {
      onNone: () => Effect.fail(new Unavailable({ stage: "response" })),
      onSome: (body) => Effect.succeed({ body, replayed: headers["idempotent-replay"] === "true" })
    });
  const error = Option.getOrUndefined(decodeErrorBody(text))?.error;
  const message = explanation(error?.message, "Pidgeon refused the request.");
  const field = error?.field === undefined ? {} : { field: error.field.slice(0, 64) };
  if (status === 401) return Effect.fail(new KeyRejected({}));
  if (status === 402) return Effect.fail(new RateLimited({ limit: "plan", details: { message } }));
  if (status === 403)
    return Effect.fail(
      error?.code === "not_permitted" || error?.code === "blocked"
        ? new Refused({ details: { reason: error.code, message } })
        : new Forbidden({ details: { message } })
    );
  if (status === 404) return Effect.fail(new NotFound({}));
  if (status === 409) return Effect.fail(new Conflict({ details: { ...field, message } }));
  if ((status === 400 || status === 422) && error !== undefined)
    return Effect.fail(new Invalid({ details: { ...field, message } }));
  if (status === 429) {
    const seconds = retryAfter(headers["retry-after"]);
    return Effect.fail(
      new RateLimited({
        limit: "requests",
        ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
        details: { message }
      })
    );
  }
  return Effect.fail(new Unavailable({ stage: "status", upstreamStatus: status }));
};

/** One gate per address in this process, shared by its connections and every caller. */
export class Source extends Context.Service<
  Source,
  {
    /**
     * Sends one request with `token`, bounded by `deadline` (epoch milliseconds) and the answer
     * cap. Pidgeon's refusals come back classified; a success is its envelope.
     */
    readonly call: (
      token: Redacted.Redacted<string>,
      request: Request,
      deadline: number
    ) => Effect.Effect<Answer, CallError>;
    /**
     * Runs `effect` holding one of the address's slots. Waiting keeps a one-second reserve before
     * `deadline`, then refuses `busy` with nothing sent. The slot is released however `effect`
     * ends, including interruption.
     */
    readonly withSlot: (
      identityId: string,
      deadline: number
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Busy, R>;
  }
>()("@patchy/integrations/pidgeon/Source") {}

/** The reserve a queued call keeps before its deadline, so a slot freed later isn't worth taking. */
const SLOT_RESERVE_MS = 1_000;
const MAX_BYTES = registry["runtime.result.bytes"].default;
const decoder = new TextDecoder();

/** Reads the whole body, refusing it once it passes `maxBytes`. */
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

/** The request's URL on Pidgeon's host, or nothing when its path would leave `/api/v1`. */
const target = (request: Request): URL | undefined => {
  if (!request.path.startsWith("/")) return undefined;
  const url = new URL(`.${request.path}`, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return undefined;
  for (const [name, value] of Object.entries(request.query ?? {}))
    if (value !== undefined) url.searchParams.set(name, String(value));
  return url;
};

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const gates = new Map<string, Semaphore.Semaphore>();
  const gate = (identityId: string) => {
    let found = gates.get(identityId);
    if (found === undefined) {
      found = Semaphore.makeUnsafe(registry["pidgeon.calls.concurrent"].default);
      gates.set(identityId, found);
    }
    return found;
  };

  const send = Effect.fn("Pidgeon.send")(function* (
    token: Redacted.Redacted<string>,
    request: Request
  ) {
    const url = target(request);
    if (url === undefined) return yield* new Unavailable({ stage: "request" });
    const prepared = HttpClientRequest.make(request.method)(url.href).pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      HttpClientRequest.acceptJson,
      request.idempotencyKey === undefined
        ? (value) => value
        : HttpClientRequest.setHeader("idempotency-key", request.idempotencyKey)
    );
    const response = yield* client
      .execute(
        request.body === undefined
          ? prepared
          : prepared.pipe(HttpClientRequest.bodyJsonUnsafe(request.body))
      )
      .pipe(
        Effect.mapError(
          (cause) => new Unavailable({ stage: "request", cause: Redacted.make(cause) })
        ),
        // Never follow a redirect: fetch would otherwise leave Pidgeon's host with the key.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        // Trace context stays inside Patchy.
        Effect.provideService(Tracer.DisablePropagation, true)
      );
    if (response.status >= 300 && response.status < 400)
      return yield* new Unavailable({ stage: "redirect", upstreamStatus: response.status });
    const text = yield* collect(response, MAX_BYTES);
    return yield* classify(response.status, response.headers, text);
  });

  const call = (token: Redacted.Redacted<string>, request: Request, deadline: number) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const milliseconds = Math.max(
        1,
        Math.min(deadline - now, registry["integration.deadline"].default)
      );
      return send(token, request).pipe(
        Effect.timeoutOrElse({
          duration: milliseconds,
          orElse: () => Effect.fail(new Timeout({ milliseconds }))
        })
      );
    });

  const withSlot =
    (identityId: string, deadline: number) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Busy, R> => {
      const semaphore = gate(identityId);
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!(yield* semaphore.takeIfAvailable(1))) {
            const budget = deadline - SLOT_RESERVE_MS - (yield* Clock.currentTimeMillis);
            if (budget <= 0) return yield* new Busy({});
            const taken = yield* restore(semaphore.take(1)).pipe(Effect.timeoutOption(budget));
            if (Option.isNone(taken)) return yield* new Busy({});
          }
          return yield* restore(effect).pipe(Effect.ensuring(semaphore.release(1)));
        })
      );
    };

  return Source.of({ call, withSlot });
});

/** Pidgeon itself, over fetch. */
export const layer = Layer.effect(Source, make).pipe(Layer.provide(FetchHttpClient.layer));
