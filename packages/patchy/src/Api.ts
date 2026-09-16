/**
 * The instance over HTTP: the client derived from `@patchy/api`, pointed at
 * the resolved instance, and the one place a refusal or a failed request is
 * turned into a `CliError` whose kind says who has to act.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import {
  Authorization,
  authorizationClient,
  makeClient,
  PublishCreated,
  type PublishRequest,
  PublishUpdated
} from "@patchy/api";
import { LocalError, RejectedError, UnreachableError } from "./CliError.js";
import * as Instance from "./Instance.js";

/** Retained receipts predate description metadata; validate it only when present. */
const PublishReceipt = Schema.Struct({
  ...PublishCreated.fields,
  description: Schema.optionalKey(PublishCreated.fields.description),
  descriptionUpdatedAt: Schema.optionalKey(PublishCreated.fields.descriptionUpdatedAt)
});
const decodePublishReceipt = Schema.decodeUnknownEffect(PublishReceipt);
const encodePublish = Schema.encodeSync(Schema.Union([PublishCreated, PublishUpdated]));

/** Public login requests need no bearer; protected calls supply one explicitly. */
export const client = (token?: Redacted.Redacted) =>
  Effect.gen(function* () {
    const instance = yield* Instance.Instance;
    return yield* makeClient(instance.apiUrl).pipe(
      Effect.provide(
        token === undefined
          ? HttpApiMiddleware.layerClient(Authorization, ({ next, request }) => next(request))
          : authorizationClient(token)
      )
    );
  });

/** Preserve generated transport/refusals; only a recovered attempt may use an old receipt. */
export const publish = Effect.fn("Api.publish")(function* (
  token: Redacted.Redacted,
  payload: PublishRequest,
  replay: boolean
) {
  const http = yield* HttpClient.HttpClient;
  const observed: { response?: HttpClientResponse.HttpClientResponse } = {};
  const api = yield* client(token).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.tap(http, (response) =>
        Effect.sync(() => {
          observed.response = response;
        })
      )
    )
  );
  const result = yield* api.publish({ payload }).pipe(Effect.result);
  const response = observed.response;
  if (
    replay &&
    response !== undefined &&
    (response.status === 200 || response.status === 201) &&
    (result._tag === "Success" || Schema.isSchemaError(result.failure))
  ) {
    const document = yield* response.json;
    return { published: yield* decodePublishReceipt(document), document };
  }
  if (result._tag === "Failure") {
    const error = result.failure;
    return yield* Effect.fail(isRefusal(error) ? { ...error, status: response?.status } : error);
  }
  return { published: result.success, document: encodePublish(result.success) };
});

/** What any refusal on the wire looks like: `{ ok: false, error }`, or the 422's `errors`. */
export interface Refusal {
  readonly ok: false;
  readonly error?: string;
  readonly errors?: ReadonlyArray<string>;
  readonly code?: string;
  /** Internal only: the publish transport observed this before wire decoding. */
  readonly status?: number | undefined;
}

export type ClientFailure = Refusal | HttpClientError.HttpClientError | Schema.SchemaError;

export const isRefusal = (error: ClientFailure): error is Refusal => "ok" in error;

/** Generic refusal text includes the wire's optional validation errors. */
export const refusalMessage = (refusal: Refusal, fallback: string): string => {
  const errors = refusal.errors ?? [];
  const details = errors.length > 0 ? `\n- ${errors.join("\n- ")}` : "";
  return `${refusal.error ?? fallback}${details}`;
};

const decodeRefusal = Schema.decodeUnknownOption(RejectedError.fields.refusal);

/** Both wire responses and installed CLI failures carry the same refusal context. */
export const fromRefusal = (error: Refusal, fallback: string): RejectedError => {
  const decoded = decodeRefusal(error);
  const message = refusalMessage(error, fallback);
  return new RejectedError({
    refusal: Option.isSome(decoded)
      ? { ...decoded.value, error: message }
      : { ok: false, error: message, ...(error.code === undefined ? {} : { code: error.code }) },
    ...(Option.isNone(decoded) ? { hint: message } : {}),
    cause: error
  });
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
    if (isRefusal(error)) return yield* fromRefusal(error, fallback);
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
            refusal: { ok: false, error: `${apiUrl} answered ${status}.` },
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
