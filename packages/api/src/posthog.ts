import * as Schema from "effect/Schema";
import { PostgresRows, PostgresShape } from "./postgres.js";
import { DefinitionName, PostgresText } from "./schemas.js";

const Scalar = Schema.Union([
  PostgresText,
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
  Schema.Null
]);
/** A constant for one `{placeholder}`; PostHog turns it into a literal, never a name. */
export const PostHogValue = Schema.Union([Scalar, Schema.Array(Scalar)]);
export const PostHogValues = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)),
  PostHogValue
);
/** Labels the call in Patchy's recent calls and in PostHog's own query log. */
export const PostHogQueryName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/)
);
export const PostHogQuery = Schema.Struct({
  connection: DefinitionName,
  name: PostHogQueryName,
  /** HogQL, PostHog's ClickHouse-flavoured SQL. */
  query: PostgresText.check(Schema.isMinLength(1)),
  values: Schema.optionalKey(PostHogValues),
  shape: PostgresShape
});
export const posthogOperations = {
  "posthog.query": {
    request: Schema.Struct({ op: Schema.Literal("posthog.query"), args: PostHogQuery }),
    response: PostgresRows,
    kind: "integration"
  }
} as const;
