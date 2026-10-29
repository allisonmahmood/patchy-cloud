import type { PostHogDeclaration, PostHogSnapshot } from "@patchy/api";
import { shapeTypes, wireShape } from "../shapeClient.js";

export interface Generated {
  readonly client: string;
  readonly context: string;
}

const markdown = (value: string): string =>
  `<code>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("`", "&#96;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("|", "&#124;")}</code>`;
/** A description on one line, as plain text inside a list item. */
const prose = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ")
    .trim();

const client = `// Generated from an immutable PostHog snapshot. Tier 2 handlers type ctx.connections with it; the host supplies the transport.
import { PatchyError, decodeError } from "patchy/client";
import type { Call, Errors, BoundaryError as ClientBoundaryError } from "patchy/client";
import type { Column } from "patchy/config";
export type { ErrorCode, ErrorDetails, Errors, ShapeMismatchDetails } from "patchy/client";
export type Value = null | boolean | number | string | readonly (null | boolean | number | string)[];
export type BoundaryError = ClientBoundaryError | Errors<"connection_not_declared">;
// These unions describe known Patchy refusals, not checked or exhaustive TypeScript throws.
// PostHog's own details: narrow a caught error with isPatchyError(error, code, "posthog").
export type QueryError = BoundaryError | Errors<"invalid_query" | "shape_mismatch" | "source_rate_limited", "posthog.query">;
export type Rows<Row> = { readonly ok: true; readonly rows: readonly Row[] };
${shapeTypes}export interface QueryRequest<S extends Shape> {
  /** Labels the call in the connection's recent calls and in PostHog's own query log. */
  readonly name: string;
  /** HogQL, PostHog's ClickHouse-flavoured SQL. */
  readonly query: string;
  /** Constants for the query's {placeholders}. They are values, never table or column names. */
  readonly values?: Readonly<Record<string, Value>>;
  readonly shape: S;
}
export interface Client {
  query<const S extends Shape>(request: QueryRequest<S>): Promise<Rows<ShapeRow<S>>>;
}
${wireShape}export function createClient(connection: string, call: Call): Client {
  return {
    async query<const S extends Shape>(request: QueryRequest<S>): Promise<Rows<ShapeRow<S>>> {
      const args = { connection, name: request.name, query: request.query, ...(request.values === undefined ? {} : { values: request.values }), shape: wireShape(request.shape) };
      let value: unknown;
      try { value = await call("posthog.query", args); } catch (error) { throw decodeError(error, "posthog.query") ?? error; }
      const error = decodeError(value, "posthog.query");
      if (error) throw error;
      if (value === null || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("rows" in value) || !Array.isArray(value.rows)) throw new PatchyError("invalid_request", "The PostHog transport returned an invalid response.", {});
      return value as Rows<ShapeRow<S>>;
    }
  };
}
`;

const properties = (items: PostHogSnapshot["eventProperties"]) =>
  items.length === 0
    ? "None.\n"
    : `${items.map((item) => `- ${markdown(item.name)}${item.type === null ? "" : ` (${prose(item.type)})`}${item.description === undefined ? "" : `: ${prose(item.description)}`}`).join("\n")}\n`;

/** The client is the same for every PostHog connection; the context lists what it can read. */
export const generate = (
  declaration: typeof PostHogDeclaration.Type & { readonly description?: string },
  snapshot: PostHogSnapshot
): Generated => ({
  client,
  context: `# PostHog connection

Handle: ${markdown(declaration.handle)}

Description: ${markdown(declaration.description ?? "")}

Snapshot revision: ${declaration.revision}

Use the declared alias when constructing the client. \`query({ name, query, values, shape })\` runs one read-only HogQL query, PostHog's ClickHouse-flavoured SQL, as the viewer. Patchy builds the request, so nothing can be written.

- \`name\` is required. It labels the call in the connection's recent calls and in PostHog's own query log.
- \`values\` fills the query's \`{placeholders}\` with constants, never table or column names. Values are strings, finite numbers, booleans, null, or arrays of those.
- \`shape\` uses strict text/integer/number/boolean/timestamp/json descriptors with optional: true for nullability. Missing or duplicate columns, a type the kind can't hold and a nonoptional null fail with shape_mismatch; extra columns are dropped.
- Types: String, UUID, enums and dates are text; Int8 to UInt32 are integer or number; Int64 and UInt64 are numbers only while they are safe integers; Float32/64 are number; Bool is boolean; DateTime is timestamp, as UTC with six fractional digits and Z. Arrays, maps and tuples are json, with 64-bit integers inside them still safe. Decimal, 128- and 256-bit integers and unmapped types fail wherever they appear; cast them with toString(...) or toFloat64(...).
- At most 1,000 rows and 8 MB. PostHog returns 100 rows unless the query has a LIMIT; a result PostHog cut short fails with too_large, so add a LIMIT of at most 1,000 or aggregate.
- PostHog's rate, budget and concurrency limits fail with source_rate_limited, with retryAfter only when PostHog sent one. Patchy never retries a query.

The events and properties below are hints from discovery. Queries can name anything PostHog has; new events appear here after an admin refreshes the connection and \`patchy refresh\` runs.

## Events

${snapshot.events.length === 0 ? "None.\n" : `${snapshot.events.map((event) => `- ${markdown(event.name)}${event.description === undefined ? "" : `: ${prose(event.description)}`}`).join("\n")}\n`}
## Event properties

Read with \`properties.<name>\` on \`events\`, quoting names that aren't plain identifiers.

${properties(snapshot.eventProperties)}
## Person properties

Read with \`person.properties.<name>\` on \`events\`, or \`properties.<name>\` on \`persons\`.

${properties(snapshot.personProperties)}`
});
