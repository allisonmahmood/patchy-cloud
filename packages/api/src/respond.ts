/**
 * The server side of a refusal: a body encoded through the wire schema that
 * names it, at that schema's status. Several refusals share one body shape
 * (`Forbidden` and `NotFound` are both `{ ok, error }`), so which schema
 * encodes a body is the only thing that tells them apart — a handler chooses
 * it here rather than failing with a value the endpoint's error union could
 * encode as either.
 */
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const statusOf = SchemaAST.resolveAt<number>("httpApiStatus");

export const refuse = <S extends Schema.Top & Schema.Codec<unknown, unknown>>(
  schema: S,
  body: S["~type.make.in"],
  headers: Record<string, string> = {}
) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeSync(schema)(schema.make(body)), {
    status: statusOf(schema.ast) ?? 400,
    headers
  });
