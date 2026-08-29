/**
 * The instance over HTTP: the client derived from `@patchy/api`, pointed at
 * the resolved instance, and the one place a refusal or a failed request is
 * turned into a `CliError` whose kind says who has to act.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type { SchemaError } from "effect/Schema";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { Authorization, authorizationClient, makeClient } from "@patchy/api";
import { LocalError, RejectedError, UnreachableError } from "./CliError.js";
import * as Instance from "./Instance.js";

/** The routes that admit a request with no credential: only the self-service mint. */
const anonymousClient = HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
  next(request)
);

/** A client for the resolved instance; the token rides on every protected route. */
export const client = (token: Option.Option<Redacted.Redacted>) =>
  Effect.gen(function* () {
    const instance = yield* Instance.Instance;
    return yield* makeClient(instance.apiUrl).pipe(
      Effect.provide(
        Option.match(token, { onNone: () => anonymousClient, onSome: authorizationClient })
      )
    );
  });

/** What any refusal on the wire looks like: `{ ok: false, error }`, or the 422's `errors`. */
export interface Refusal {
  readonly ok: false;
  readonly error?: string;
  readonly errors?: ReadonlyArray<string>;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
}

export type ClientFailure = Refusal | HttpClientError.HttpClientError | SchemaError;

export const isRefusal = (error: ClientFailure): error is Refusal => "ok" in error;

/** The refusal's own sentence, or the 422's list. */
export const refusalMessage = (refusal: Refusal, fallback: string): string => {
  const errors = refusal.errors ?? [];
  const details = errors.length > 0 ? `\n- ${errors.join("\n- ")}` : "";
  return `${refusal.error ?? fallback}${details}`;
};

/**
 * Status → kind. A refusal the wire describes is the instance's answer
 * (`rejected`); a transport failure, a 5xx or an undeclared status, or a body
 * the schemas cannot read is no answer at all (`unreachable`).
 */
export const classify = (
  error: ClientFailure,
  fallback: string
): Effect.Effect<never, RejectedError | UnreachableError | LocalError, Instance.Instance> =>
  Effect.gen(function* () {
    const { apiUrl } = yield* Instance.Instance;
    if (isRefusal(error)) {
      return yield* new RejectedError({ message: refusalMessage(error, fallback) });
    }
    if (error._tag === "SchemaError") {
      return yield* new UnreachableError({
        instanceUrl: apiUrl,
        message: `${apiUrl} answered with a body the CLI could not read.`,
        cause: error
      });
    }
    const reason = error.reason;
    switch (reason._tag) {
      case "TransportError":
        return yield* new UnreachableError({
          instanceUrl: apiUrl,
          message:
            `${apiUrl} could not be reached.\n` +
            "Check the address and your network connection, then run the same command again.",
          cause: error
        });
      case "InvalidUrlError":
        return yield* new LocalError({ message: `Invalid API URL: ${apiUrl}`, cause: error });
      case "EncodeError":
        return yield* new LocalError({
          message: `The request could not be encoded.`,
          cause: error
        });
      default: {
        const { status } = reason.response;
        if (status >= 400 && status < 500) {
          return yield* new RejectedError({
            message: `${apiUrl} answered ${status}.`,
            cause: error
          });
        }
        return yield* new UnreachableError({
          instanceUrl: apiUrl,
          message: `${apiUrl} answered ${status}. Try again later, or tell the operator.`,
          cause: error
        });
      }
    }
  });
