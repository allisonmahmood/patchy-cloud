import * as Schema from "effect/Schema";
export const SalesforceObjectName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,127}$/)
);
export const SalesforceObject = Schema.Struct({
  name: SalesforceObjectName,
  label: Schema.String,
  queryable: Schema.Boolean
});
export const SalesforceSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  objects: Schema.Array(SalesforceObject)
});
export const SalesforceField = Schema.Struct({
  name: SalesforceObjectName,
  label: Schema.String,
  type: Schema.String,
  nillable: Schema.Boolean
});
export const SalesforceCursor = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/));
