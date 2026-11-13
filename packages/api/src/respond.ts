/**
 * The server side of a refusal, and of a body: a refusal is encoded through
 * the wire schema that names it, at that schema's status, and a JSON body is
 * read and decoded through the schema that describes it.
 *
 * Several refusals share one body shape (`BadRequest` and `NotFound` are both
 * `{ ok, error }`), so which schema encodes a body is the only thing that
 * tells them apart — a handler chooses it here rather than failing with a
 * value the endpoint's error union could encode as either.
 */
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { RateLimited } from "./schemas.js";

/**
 * The annotations that set a node's `httpApiStatus`: its last check that sets one, looking into
 * check groups, else its own.
 */
const statusAnnotations = (node: {
  readonly checks: SchemaAST.Checks | undefined;
  readonly annotations: Schema.Annotations.Annotations | undefined;
}): Schema.Annotations.Annotations | undefined => {
  for (const check of [...(node.checks ?? [])].reverse()) {
    if (check.annotations !== undefined && "httpApiStatus" in check.annotations)
      return check.annotations;
    if (check._tag === "FilterGroup") {
      const nested = statusAnnotations(check);
      if (nested !== undefined) return nested;
    }
  }
  return node.annotations !== undefined && "httpApiStatus" in node.annotations
    ? node.annotations
    : undefined;
};

/**
 * A node's status: set by its annotations, where an explicit `undefined` clears it, else by the
 * key annotation `HttpApiSchema.status` stores.
 */
const resolveStatus = (ast: SchemaAST.AST): number | undefined => {
  const annotations = statusAnnotations(ast);
  const status =
    annotations !== undefined ? annotations.httpApiStatus : ast.context?.annotations?.httpApiStatus;
  return Predicate.isNumber(status) ? status : undefined;
};

/**
 * The status an error schema answers at, by HttpApi's rules (its `getStatusErrorSchema`, which it
 * doesn't export), so a refusal answers what its endpoint declares; 500 when none is set.
 */
const statusOf = (schema: Schema.Top): number =>
  (HttpApiSchema.isWithHeaders(schema)
    ? (resolveStatus(schema.ast) ?? resolveStatus(schema.schema.ast))
    : resolveStatus(schema.ast)) ?? 500;
const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

export const refuse = <S extends Schema.Top & Schema.Codec<unknown, unknown>>(
  schema: S,
  body: S["~type.make.in"],
  headers: Record<string, string> = {}
) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeSync(schema)(schema.make(body)), {
    status: statusOf(schema),
    headers
  });

/** The one 429, with `Retry-After` saying the same seconds as the body. */
export const rateLimited = (decision: { readonly retryAfterSeconds: number }) =>
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

/**
 * A body that is not JSON, or JSON the schema refused. `field` is the
 * top-level key the first issue points at, when it points at one, so a
 * handler can keep a per-field answer (`Invalid patch ID.`) without reading
 * the issue tree itself.
 */
export class MalformedBody extends Schema.TaggedError<MalformedBody>()("MalformedBody", {
  field: Schema.optionalKey(Schema.String),
  /** The read or parse failure underneath; absent for a body that decoded to the wrong shape. */
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return this.field === undefined
      ? "Malformed request body."
      : `Malformed request body: ${this.field}.`;
  }
}

/** The body is larger than the route reads. Refused before a byte of it is. */
export class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()("BodyTooLarge", {
  maxBytes: Schema.Int
}) {
  override get message() {
    return `Request body is larger than ${this.maxBytes} bytes.`;
  }
}

/**
 * Closes the connection once the current request's answer is sent. Every refusal of a body by its
 * size runs it first, whatever answer it gives: Effect's server would otherwise keep the
 * connection and go on reading the unread rest, waiting on a sender that may never finish.
 */
export const closeAfterAnswer = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "connection", "close"))
);

/**
 * `read`, a read of the request body, capped at `maxBytes`. A declared length over the cap fails
 * before a byte is read, and a body that crosses it mid-stream fails the read; both fail as the
 * platform does, so a page answers them as it answers any unreadable form. Either closes the
 * connection after the answer (`closeAfterAnswer`), so a sender that stalls is never waited on.
 */
export const capBody =
  (maxBytes: number) =>
  <A, E, R>(
    read: Effect.Effect<A, E, R>
  ): Effect.Effect<
    A,
    E | HttpServerError.HttpServerError,
    R | HttpServerRequest.HttpServerRequest
  > =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (Number(request.headers["content-length"]) > maxBytes) {
        yield* closeAfterAnswer;
        return yield* new HttpServerError.HttpServerError({
          reason: new HttpServerError.RequestParseError({ request, reason: "BodyTooLarge" })
        });
      }
      return yield* read.pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(maxBytes)),
        Effect.tapError((error): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> =>
          HttpServerError.isHttpServerError(error) &&
          error.reason._tag === "RequestParseError" &&
          error.reason.reason === "BodyTooLarge"
            ? closeAfterAnswer
            : Effect.void
        )
      );
    });

/**
 * The current request's body as JSON, capped at `maxBytes`. An absent or
 * blank body is `{}`; the route's schema decides whether it is valid.
 * A declared length over the cap is refused before the body is read; a body
 * that fails to read — the cap hit mid-stream, or the client gone — is
 * malformed, since there is no whole body to decode. Either size refusal
 * closes the connection after the answer (`closeAfterAnswer`).
 */
export const readBody = (maxBytes: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"]) > maxBytes) {
      yield* closeAfterAnswer;
      return yield* new BodyTooLarge({ maxBytes });
    }
    const text = yield* request.text.pipe(
      capBody(maxBytes),
      Effect.mapError((cause) => new MalformedBody({ cause }))
    );
    if (text.trim().length === 0) return {} as unknown;
    const parsed = parseJson(text);
    return Result.isSuccess(parsed)
      ? parsed.success
      : yield* new MalformedBody({ cause: parsed.failure });
  });

/** A decoder for one wire schema; compiled once, so build it outside the request. */
export const decodeBody = <S extends Schema.Top & Schema.Codec<unknown, unknown>>(
  schema: S,
  options?: SchemaAST.ParseOptions
) => {
  const decode = Schema.decodeUnknownResult(schema, options);
  return (body: unknown): Effect.Effect<S["Type"], MalformedBody> => {
    const result = decode(body);
    return Result.isSuccess(result)
      ? Effect.succeed(result.success)
      : Effect.fail(new MalformedBody({ field: failingField(result.failure.issue) }));
  };
};

/** The first key under the body root that the issue tree points at. */
function failingField(issue: SchemaIssue.Issue): string | undefined {
  if (issue._tag === "Pointer") {
    const [head] = issue.path;
    if (typeof head === "string") return head;
  }
  // A class decode wraps its struct's issues in an Encoding node, a struct
  // reports its fields in a Composite, a union its arms in an AnyOf: walk
  // whatever nests until a Pointer names the field.
  if ("issues" in issue) return issue.issues.map(failingField).find((field) => field !== undefined);
  if ("issue" in issue && issue.issue !== undefined) return failingField(issue.issue);
  return undefined;
}
