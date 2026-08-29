/**
 * The server side of a refusal, and of a body: a refusal is encoded through
 * the wire schema that names it, at that schema's status, and a JSON body is
 * read and decoded through the schema that describes it.
 *
 * Several refusals share one body shape (`Forbidden` and `NotFound` are both
 * `{ ok, error }`), so which schema encodes a body is the only thing that
 * tells them apart — a handler chooses it here rather than failing with a
 * value the endpoint's error union could encode as either.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BadRequest, RateLimited } from "./schemas.js";

const statusOf = SchemaAST.resolveAt<number>("httpApiStatus");
const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

export const refuse = <S extends Schema.Top & Schema.Codec<unknown, unknown>>(
  schema: S,
  body: S["~type.make.in"],
  headers: Record<string, string> = {}
) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeSync(schema)(schema.make(body)), {
    status: statusOf(schema.ast) ?? 400,
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

/** The one 400 for a body the route could not decode. */
export const malformedBody = () =>
  refuse(BadRequest, { ok: false, error: "Malformed request body." });

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
 * The current request's body as JSON, capped at `maxBytes`. An absent or
 * blank body is `{}`: every payload the contract takes has only optional
 * fields, so nothing sent is the same request as nothing in it. A declared
 * length over the cap is refused before the body is read; a body that fails
 * to read — the cap hit mid-stream, or the client gone — is malformed, since
 * there is no whole body to decode.
 */
export const readBody = (maxBytes: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"]) > maxBytes) {
      return yield* new BodyTooLarge({ maxBytes });
    }
    const text = yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(maxBytes)),
      Effect.mapError((cause) => new MalformedBody({ cause }))
    );
    if (text.trim().length === 0) return {} as unknown;
    const parsed = parseJson(text);
    return Result.isSuccess(parsed)
      ? parsed.success
      : yield* new MalformedBody({ cause: parsed.failure });
  });

/** A decoder for one wire schema; compiled once, so build it outside the request. */
export const decodeBody = <S extends Schema.Top & Schema.Codec<unknown, unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownResult(schema);
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
