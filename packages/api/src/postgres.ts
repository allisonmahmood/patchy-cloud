import * as Schema from "effect/Schema";
import { DefinitionName, PostgresText } from "./schemas.js";

const Name = PostgresText.check(Schema.isMaxLength(63));
const Scalar = Schema.Union([
  Schema.String,
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
  Schema.Null
]);
export const PostgresParameter = Schema.Union([Scalar, Schema.Array(Scalar)]);
export const PostgresRelation = Schema.Struct({ schema: Name, name: Name });
export const PostgresKey = Schema.Record(Name, Scalar);
export const PostgresShapeColumn = Schema.Struct({
  kind: Schema.Literals(["text", "integer", "number", "boolean", "timestamp", "json"]),
  optional: Schema.optionalKey(Schema.Boolean)
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export const PostgresShape = Schema.Record(Name, PostgresShapeColumn).check(
  Schema.makeFilter((shape) => Object.keys(shape).length > 0)
);
export const PostgresList = Schema.Struct({
  connection: DefinitionName,
  relation: PostgresRelation,
  eq: Schema.optionalKey(PostgresKey),
  range: Schema.optionalKey(
    Schema.Struct({
      column: Name,
      gt: Schema.optionalKey(Scalar),
      gte: Schema.optionalKey(Scalar),
      lt: Schema.optionalKey(Scalar),
      lte: Schema.optionalKey(Scalar)
    })
  ),
  orderBy: Schema.optionalKey(
    Schema.Struct({ column: Name, direction: Schema.Literals(["asc", "desc"]) })
  ),
  select: Schema.optionalKey(Schema.Array(Name).check(Schema.isMinLength(1))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1)))
});
export const PostgresGet = Schema.Struct({
  connection: DefinitionName,
  relation: PostgresRelation,
  key: PostgresKey
});
export const PostgresGetMany = Schema.Struct({
  connection: DefinitionName,
  relation: PostgresRelation,
  keys: Schema.Array(PostgresKey)
});
export const PostgresQuery = Schema.Struct({
  connection: DefinitionName,
  sql: PostgresText,
  params: Schema.Array(PostgresParameter),
  shape: PostgresShape
});
const Row = Schema.Record(Schema.String, Schema.Json);
export const PostgresRows = Schema.Struct({ ok: Schema.Literal(true), rows: Schema.Array(Row) });
export const PostgresPage = Schema.Struct({
  ok: Schema.Literal(true),
  rows: Schema.Array(Row),
  cursor: Schema.NullOr(Schema.String)
});
export const PostgresKeyRows = Schema.Struct({
  ok: Schema.Literal(true),
  rows: Schema.Array(Schema.NullOr(Row))
});
export const postgresOperations = {
  "postgres.list": {
    request: Schema.Struct({ op: Schema.Literal("postgres.list"), args: PostgresList }),
    response: PostgresPage,
    kind: "integration"
  },
  "postgres.get": {
    request: Schema.Struct({ op: Schema.Literal("postgres.get"), args: PostgresGet }),
    response: PostgresKeyRows,
    kind: "integration"
  },
  "postgres.getMany": {
    request: Schema.Struct({ op: Schema.Literal("postgres.getMany"), args: PostgresGetMany }),
    response: PostgresKeyRows,
    kind: "integration"
  },
  "postgres.query": {
    request: Schema.Struct({ op: Schema.Literal("postgres.query"), args: PostgresQuery }),
    response: PostgresRows,
    kind: "integration"
  }
} as const;
