import { registry } from "@patchy/limits/registry";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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
 * Pidgeon (pidgeon.ai), email inboxes for software, on its `/v1` API. The credentialed server
 * makes every call, only to Pidgeon's API host, and never follows a redirect. Answers, refusals
 * included, are read under a byte cap before they are decoded, and each inbox's calls pass one
 * gate per process, shared by connection administration, `patchy dev` and published patches.
 * The key a connection holds reaches the whole Pidgeon account; what keeps a call to the
 * connection's one inbox is the operations' own checks, never the key.
 */

export const BASE_URL = "https://pidgeon.ai/v1";
const base = new URL(`${BASE_URL}/`);

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });
/** Pidgeon's own explanation of a refusal, written to be shown to a person; bounded. */
const Explanation = Schema.String.check(Schema.isMaxLength(500));

/** Pidgeon didn't accept the key: revoked or mistyped. */
export class KeyRejected extends Schema.TaggedError<KeyRejected>()("PidgeonKeyRejected", {}) {
  readonly code = "pidgeon_key_rejected" as const;
  readonly status = 422;
  override get message() {
    return "Pidgeon didn't accept this key: it was revoked or mistyped.";
  }
}
/**
 * The key may not do this: its access is too low, the inbox only receives, or a send rule or the
 * do-not-send list refuses a recipient, which Pidgeon's message names.
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()("PidgeonForbidden", {
  details: Schema.Struct({ message: Explanation })
}) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return `Pidgeon refused: ${this.details.message}`;
  }
}
/**
 * The email carries text a key read in another conversation, which can only go back as a reply in
 * that conversation, so Pidgeon sent nothing. Pidgeon's own explanation names that conversation,
 * which may not be the connection's, so it never leaves Patchy.
 */
export class ExfiltrationBlocked extends Schema.TaggedError<ExfiltrationBlocked>()(
  "PidgeonExfiltrationBlocked",
  {}
) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  readonly details = { reason: "exfiltration_blocked" } as const;
  override get message() {
    return "This email carries text read in another conversation, which can only go back as a reply in that conversation, so Pidgeon sent nothing.";
  }
}
/**
 * Pidgeon Firewall holds this message for a person: no key reads it until someone releases it.
 * Its refusal says nothing about which inbox it's in, so the operations answer `not_found`.
 */
export class Held extends Schema.TaggedError<Held>()("PidgeonHeld", {}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return "Pidgeon Firewall is holding this message for a person.";
  }
}
/** Nothing by that id that Patchy can show is the connection's inbox's. */
export class NotFound extends Schema.TaggedError<NotFound>()("PidgeonNotFound", {}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return "This Pidgeon inbox has nothing by that id.";
  }
}
/** It conflicts with what is there, such as a draft that is no longer a draft. */
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
/** "in 40 seconds", "in 12 minutes": how long Pidgeon asked Patchy to wait. */
const wait = (seconds: number | undefined) =>
  seconds === undefined
    ? "in a few minutes"
    : seconds < 90
      ? `in ${seconds} ${seconds === 1 ? "second" : "seconds"}`
      : `in ${Math.ceil(seconds / 60)} minutes`;

/**
 * Pidgeon's limits said no, and nothing changed; Patchy never retries. `requests` is a 429: the
 * key's own rate, or the account's sending limit. `plan` is 402: the month's free emails are used
 * and usage billing is off.
 */
export class RateLimited extends Schema.TaggedError<RateLimited>()("PidgeonRateLimited", {
  limit: Schema.Literals(["requests", "plan"]),
  /** Pidgeon's Retry-After, where it gives one. */
  retryAfterSeconds: Schema.optionalKey(Schema.Int),
  details: Schema.Struct({ message: Explanation })
}) {
  readonly code = "source_rate_limited" as const;
  readonly status = 429;
  override get message() {
    switch (this.limit) {
      case "plan":
        return `Pidgeon's plan for this account doesn't allow that: ${this.details.message}`;
      case "requests":
        return `Pidgeon is limiting this account for now. Try again ${wait(this.retryAfterSeconds)}.`;
    }
  }
}
/**
 * Pidgeon said, in its own words, that the mail couldn't go: the mail service refused it
 * (`send_failed`), was busy (`unavailable`), or the account's storage is full (`storage_full`).
 * Nothing was sent.
 */
export class MailRefused extends Schema.TaggedError<MailRefused>()("PidgeonMailRefused", {
  reason: Schema.Literals(["send_failed", "unavailable", "storage_full"]),
  explanation: Explanation
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  get details() {
    return { reason: this.reason, message: this.explanation };
  }
  override get message() {
    return `Pidgeon couldn't take the mail, and nothing was sent: ${this.explanation}`;
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
    return this.milliseconds === 0
      ? "The time for this call ran out before Patchy sent it to Pidgeon."
      : `Pidgeon did not answer within ${Math.ceil(this.milliseconds / 1_000)} seconds.`;
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
/** Patchy's own gate for the inbox stayed full until the call's deadline; nothing was sent. */
export class Busy extends Schema.TaggedError<Busy>()("PidgeonBusy", {}) {
  readonly code = "busy" as const;
  readonly status = 503;
  readonly limitId = "pidgeon.calls.concurrent" as const;
  readonly scope = registry["pidgeon.calls.concurrent"].scope;
  readonly value = registry["pidgeon.calls.concurrent"].default;
  override get message() {
    return `This inbox already has ${this.value} calls to Pidgeon running from Patchy. Try again shortly.`;
  }
}

/** What one call can fail with once it holds a slot. */
export type CallError =
  | KeyRejected
  | Forbidden
  | ExfiltrationBlocked
  | Held
  | NotFound
  | Conflict
  | Invalid
  | RateLimited
  | MailRefused
  | Unavailable
  | Timeout
  | TooLarge;

/**
 * Whether Pidgeon answered in its own words, so the request is known to have been decided. A call
 * whose answer was lost, timed out or couldn't be read may have run.
 */
export const isDecided = (error: CallError): boolean =>
  error._tag !== "PidgeonUnavailable" &&
  error._tag !== "PidgeonTimeout" &&
  error._tag !== "PidgeonTooLarge";

/**
 * A Pidgeon API key: `pgn_` and 32 characters, `pgn_test_` and 32 for a test key, whose mail never
 * leaves Pidgeon. Keys from before the new API, `pgn_live_…`, still sign in.
 */
export const Token = Schema.String.check(Schema.isPattern(/^pgn_[A-Za-z0-9_-]{16,250}$/));
export const isToken = Schema.is(Token);
/** Whether a key is a test key, by its prefix. */
export const isTestToken = (token: string) => token.startsWith("pgn_test_");

/** What the ciphertext holds: the key the admin pasted, and the one inbox it serves here. */
export const Credentials = Schema.Struct({ inboxId: Schema.String, key: Token });
export type Credentials = typeof Credentials.Type;

/** Safe to show: the inbox, what patches may do with it, and the key's mode. */
export const Display = Schema.Struct({
  email: Schema.String,
  inboxId: Schema.String,
  /** Patchy's own setting: what patches may do, whatever more the key could. */
  access: Schema.Literals(["read", "send"]),
  /** The stored key is a test key: mail the inbox sends through Patchy stays in Pidgeon. */
  test: Schema.Boolean
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

/** One call to Pidgeon's REST API, by its path under `/v1`. */
export interface Request {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Starts with `/`; ids in it are already encoded with `encodeURIComponent`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
}
/** A success: Pidgeon's answer, and its status. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

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
 * says `{ error: { code, message, field? } }`, and a refusal is its own word only in that shape:
 * a 5xx also needs the code its docs give it. A status it doesn't document, such as a 422, or an
 * answer in any other shape, such as a proxy's page, is unavailable, since Patchy can't tell
 * whether the request ran. A 204 has no body.
 */
export const classify = (
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  text: string
): Effect.Effect<Answer, CallError> => {
  if (status === 204) return Effect.succeed({ status, body: null });
  if (status >= 200 && status < 300)
    return Option.match(decodeJson(text), {
      onNone: () => Effect.fail(new Unavailable({ stage: "response" })),
      onSome: (body) => Effect.succeed({ status, body })
    });
  const error = Option.getOrUndefined(decodeErrorBody(text))?.error;
  const message = explanation(error?.message, "Pidgeon refused the request.");
  const field = error?.field === undefined ? {} : { field: error.field.slice(0, 64) };
  if (status === 401) return Effect.fail(new KeyRejected({}));
  if (status === 402 && error !== undefined)
    return Effect.fail(new RateLimited({ limit: "plan", details: { message } }));
  if (status === 403 && error !== undefined)
    return Effect.fail(
      error.code === "exfiltration_blocked"
        ? new ExfiltrationBlocked({})
        : error.code === "held"
          ? new Held({})
          : new Forbidden({ details: { message } })
    );
  if (status === 404 && error !== undefined) return Effect.fail(new NotFound({}));
  if (status === 409 && error !== undefined)
    return Effect.fail(new Conflict({ details: { ...field, message } }));
  if (status === 400 && error !== undefined)
    return Effect.fail(new Invalid({ details: { ...field, message } }));
  if (status === 429 && error !== undefined) {
    const seconds = retryAfter(headers["retry-after"]);
    return Effect.fail(
      new RateLimited({
        limit: "requests",
        ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
        details: { message }
      })
    );
  }
  if (
    (status === 502 && error?.code === "send_failed") ||
    (status === 503 && error?.code === "unavailable") ||
    (status === 507 && error?.code === "storage_full")
  )
    return Effect.fail(new MailRefused({ reason: error.code, explanation: message }));
  return Effect.fail(new Unavailable({ stage: "status", upstreamStatus: status }));
};

/** One gate per inbox in this process, shared by its connections and every caller. */
export class Source extends Context.Service<
  Source,
  {
    /**
     * Sends one request with `token`, bounded by `deadline` (epoch milliseconds) and the answer
     * cap. Pidgeon's refusals come back classified; a success is its answer. Nothing is sent twice.
     */
    readonly call: (
      token: Redacted.Redacted<string>,
      request: Request,
      deadline: number
    ) => Effect.Effect<Answer, CallError>;
    /**
     * Runs `effect` holding one of the inbox's slots. Waiting keeps a one-second reserve before
     * `deadline`, then refuses `busy` with nothing sent. The slot is released however `effect`
     * ends, including interruption.
     */
    readonly withSlot: (
      inboxId: string,
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

/** The request's URL on Pidgeon's host, or nothing when its path would leave `/v1`. */
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
  const gate = (inboxId: string) => {
    let found = gates.get(inboxId);
    if (found === undefined) {
      found = Semaphore.makeUnsafe(registry["pidgeon.calls.concurrent"].default);
      gates.set(inboxId, found);
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
      HttpClientRequest.acceptJson
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
    // A 204, as a delete answers, has no body to read.
    const text = response.status === 204 ? "" : yield* collect(response, MAX_BYTES);
    return yield* classify(response.status, response.headers, text);
  });

  const call = (
    token: Redacted.Redacted<string>,
    request: Request,
    deadline: number
  ): Effect.Effect<Answer, CallError> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      // Past the deadline nothing is sent: a call then can't run after its caller gave up.
      if (deadline <= now) return Effect.fail(new Timeout({ milliseconds: 0 }));
      const milliseconds = Math.min(deadline - now, registry["integration.deadline"].default);
      return send(token, request).pipe(
        Effect.timeoutOrElse({
          duration: milliseconds,
          orElse: () => Effect.fail(new Timeout({ milliseconds }))
        })
      );
    });

  const withSlot =
    (inboxId: string, deadline: number) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Busy, R> => {
      const semaphore = gate(inboxId);
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
