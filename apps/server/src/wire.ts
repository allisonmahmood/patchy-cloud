/**
 * The seam between Fastify and `@patchy/api`: every route decodes its body
 * and encodes its response through a wire schema here, so the server cannot
 * send a shape the contract does not name. Interim — the `HttpApi` handlers
 * replace this when the server moves onto Effect's router.
 */
import type { FastifyReply } from "fastify";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";

const statusOf = SchemaAST.resolveAt<number>("httpApiStatus");

/**
 * Sends `value` encoded through `schema`, at the status the schema declares
 * (200 when it declares none). `make` validates the plain object and, for a
 * `Schema.Class`, builds the instance the encoder wants.
 */
export function sendWire<S extends Schema.Top & Schema.Codec<unknown, unknown>>(
  reply: FastifyReply,
  schema: S,
  value: S["~type.make.in"]
): FastifyReply {
  return reply
    .status(statusOf(schema.ast) ?? 200)
    .send(Schema.encodeSync(schema)(schema.make(value)));
}

/**
 * Decodes a request body. A failure names the top-level field that failed —
 * the caller maps it to today's message for that field, or falls back to a
 * generic one — so a bad `html` and a bad `patchId` keep their own answers.
 */
export function decodeBody<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  body: unknown
): { ok: true; value: S["Type"] } | { ok: false; field: string | undefined } {
  const result = Schema.decodeUnknownResult(schema)(body ?? {});
  if (result._tag === "Success") return { ok: true, value: result.success };
  return { ok: false, field: failingField(result.failure.issue) };
}

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
