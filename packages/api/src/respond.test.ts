import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import { refuse } from "./respond.js";
import { Conflict } from "./schemas.js";

const Body = Schema.Struct({ ok: Schema.Literal(false), error: Schema.String });
const body = { ok: false, error: "No." } as const;
const passes = () => true;

// HttpApi's own reader, which its published types leave out; `refuse` must agree with it.
const httpApiStatus = Reflect.get(HttpApiSchema, "getStatusErrorSchema") as (
  schema: Schema.Top
) => number;

it("answers each refusal at its schema's status, read as HttpApi reads it", () => {
  for (const [schema, status] of [
    // `HttpApiSchema.status` stores a key annotation; a plain one reads the same.
    [Conflict, 409],
    [Body.annotate({ httpApiStatus: 418 }), 418],
    // A check's status outranks the schema's own, inside a group of checks too.
    [Conflict.check(Schema.makeFilter(passes, { httpApiStatus: 422 })), 422],
    [
      Conflict.check(
        Schema.makeFilter(passes).and(Schema.makeFilter(passes, { httpApiStatus: 403 }))
      ),
      403
    ],
    // An explicit undefined clears a status, so the schema answers as one with none.
    [Conflict.annotate({ httpApiStatus: undefined }), 500],
    [Body, 500]
  ] as const) {
    assert.strictEqual(refuse(schema, body).status, status);
    assert.strictEqual(httpApiStatus(schema), status);
  }
});
