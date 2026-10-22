import * as Schema from "effect/Schema";
import { SalesforceObjectName, SalesforceField, SalesforceCursor } from "./salesforceSnapshot.js";
export * from "./salesforceSnapshot.js";
import { DefinitionName } from "./schemas.js";

export const SalesforceDescribe = Schema.Struct({
  connection: DefinitionName,
  object: SalesforceObjectName
});
export const SalesforceDescription = Schema.Struct({
  ok: Schema.Literal(true),
  object: SalesforceObjectName,
  fields: Schema.Array(SalesforceField)
});
// A cursor is a Salesforce locator, never an upstream URL or a Nango connection id.
export const SalesforceRead = Schema.Union([
  Schema.Struct({ query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384)) }),
  Schema.Struct({ cursor: SalesforceCursor })
]);
export const SalesforceQuery = Schema.Struct({
  connection: DefinitionName,
  request: SalesforceRead
});
export const SalesforceRows = Schema.Struct({
  ok: Schema.Literal(true),
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
  cursor: Schema.NullOr(SalesforceCursor),
  totalSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export const salesforceOperations = {
  "salesforce.query": {
    request: Schema.Struct({ op: Schema.Literal("salesforce.query"), args: SalesforceQuery }),
    response: SalesforceRows,
    kind: "integration"
  },
  "salesforce.describe": {
    request: Schema.Struct({ op: Schema.Literal("salesforce.describe"), args: SalesforceDescribe }),
    response: SalesforceDescription,
    kind: "integration"
  }
} as const;
