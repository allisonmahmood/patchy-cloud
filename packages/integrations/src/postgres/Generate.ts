import type { PostgresDeclaration } from "@patchy/api";
import { nativeType, quoteIdentifier, surface, typeMapping } from "./Mapping.js";
import type { Snapshot } from "./Snapshot.js";

export interface Generated {
  readonly client: string;
  readonly context: string;
  readonly fixture: string;
}

const literal = (value: string): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
const markdown = (value: string): string =>
  `<code>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("`", "&#96;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("|", "&#124;")}</code>`;

const prelude = `// Generated from an immutable Postgres snapshot. Browser-only; transport is supplied by the host.
import { PatchyError, decodeError } from "patchy/client";
import type { Call, ErrorDetails, Errors, BoundaryError as ClientBoundaryError } from "patchy/client";
import type { Column } from "patchy/config";
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Parameter = null | boolean | number | string | readonly (null | boolean | number | string)[];
export type { ErrorCode, ErrorDetails, Errors, RelationIdentifier, ShapeMismatchDetails } from "patchy/client";
export type BoundaryError = ClientBoundaryError | Errors<"connection_not_declared">;
// These unions describe known Patchy refusals, not checked or exhaustive TypeScript throws.
export type GetError = BoundaryError | Errors<"relation_unknown" | "invalid_query" | "shape_mismatch">;
export type GetManyError = GetError;
export type ListError = GetError | Errors<"invalid_cursor" | "offset_exhausted">;
export type QueryError = BoundaryError | Errors<"invalid_query" | "shape_mismatch">;
export type Page<Row> = { readonly ok: true; readonly rows: readonly Row[]; readonly cursor: string | null };
export type Rows<Row> = { readonly ok: true; readonly rows: readonly Row[] };
export type Range<Row, Columns extends keyof Row> = { [K in Columns]: { readonly column: K; readonly gt?: NonNullable<Row[K]>; readonly gte?: NonNullable<Row[K]>; readonly lt?: NonNullable<Row[K]>; readonly lte?: NonNullable<Row[K]> } }[Columns];
export type ListOptions<Row, Columns extends keyof Row, Select extends readonly (keyof Row)[] | undefined = undefined> = {
  readonly eq?: Partial<Pick<Row, Columns>>;
  readonly range?: Range<Row, Columns>;
  readonly orderBy?: { readonly column: Columns; readonly direction: "asc" | "desc" };
  readonly select?: Select;
  readonly limit?: number;
  readonly cursor?: string;
};
export type Selected<Row, Select> = Select extends readonly (keyof Row)[] ? Pick<Row, Select[number]> : Row;
export interface Relation<Row, Columns extends keyof Row> {
  list<const Select extends readonly (keyof Row)[] | undefined = undefined>(options?: ListOptions<Row, Columns, Select>): Promise<Page<Selected<Row, Select>>>;
}
export interface KeyedRelation<Row, Columns extends keyof Row, Key> extends Relation<Row, Columns> {
  get(key: Key): Promise<Row | null>;
  getMany(keys: readonly Key[]): Promise<readonly (Row | null)[]>;
}
export type ShapeKind = "text" | "integer" | "number" | "boolean" | "timestamp" | "json";
export type ShapeColumn = { readonly kind: ShapeKind; readonly optional?: boolean; readonly default?: never; readonly table?: never };
export type BuilderColumn = Column<ShapeKind, boolean, false>;
export type Shape = Readonly<Record<string, ShapeColumn | BuilderColumn>>;
export type ShapeValue<K extends ShapeKind> = K extends "integer" | "number" ? number : K extends "boolean" ? boolean : K extends "json" ? unknown : string;
export type ShapeRow<S extends Shape> = { readonly [K in keyof S]: ShapeValue<S[K]["kind"]> | (S[K] extends { readonly isOptional: infer Optional } ? true extends Optional ? null : never : S[K] extends { readonly optional?: infer Optional } ? true extends Optional ? null : never : never) };
export type Query = <const S extends Shape>(sql: string, params: readonly Parameter[], shape: S) => Promise<Rows<ShapeRow<S>>>;
function wireShape(shape: Shape): Readonly<Record<string, ShapeColumn>> {
  return Object.fromEntries(Object.entries(shape).map(([name, column]) => {
    if ((column.kind as string) === "ref" || ("hasDefault" in column && column.hasDefault))
      throw new PatchyError("invalid_request", "Query shapes do not accept references or defaults.", {});
    if (!("isOptional" in column) && Object.keys(column).some((key) => key !== "kind" && key !== "optional"))
      throw new PatchyError("invalid_request", "Query shapes accept only kind and optional fields.", {});
    const optional = "isOptional" in column ? column.isOptional : column.optional;
    return [name, { kind: column.kind, ...(optional === undefined ? {} : { optional }) }];
  }));
}
async function invoke(call: Call, op: Parameters<Call>[0], args: unknown): Promise<{ readonly ok: true; readonly rows: readonly unknown[]; readonly cursor?: string | null }> {
  let value: unknown;
  try { value = await call(op, args); } catch (error) { throw decodeError(error) ?? error; }
  const error = decodeError(value);
  if (error) throw error;
  if (value === null || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("rows" in value) || !Array.isArray(value.rows)) throw new PatchyError("invalid_request", "The Postgres transport returned an invalid response.", {});
  return value as { readonly ok: true; readonly rows: readonly unknown[]; readonly cursor?: string | null };
}
function relation<Row, Columns extends keyof Row, Key>(connection: string, call: Call, schema: string, name: string, keyed: true): KeyedRelation<Row, Columns, Key>;
function relation<Row, Columns extends keyof Row>(connection: string, call: Call, schema: string, name: string, keyed: false): Relation<Row, Columns>;
function relation(connection: string, call: Call, schema: string, name: string, keyed: boolean): unknown {
  const identity = { connection, relation: { schema, name } };
  const list = (options: object = {}) => invoke(call, "postgres.list", { ...options, ...identity });
  if (!keyed) return { list };
  return { list, get: async (key: unknown) => (await invoke(call, "postgres.get", { ...identity, key })).rows[0] ?? null, getMany: async (keys: readonly unknown[]) => (await invoke(call, "postgres.getMany", { ...identity, keys })).rows };
}
`;

export const generate = (
  declaration: typeof PostgresDeclaration.Type & { readonly description?: string },
  input: typeof Snapshot.Type
): Generated => {
  const snapshot = surface(input);
  const rowTypes: string[] = [];
  const top: string[] = [];
  const schemas = new Map<string, string[]>();
  const topTypes: string[] = [];
  const schemaTypes = new Map<string, string[]>();
  const listing: string[] = [];
  const fixture = [
    "-- Agent-authored fixture. Write INSERT statements using the quoted names below.",
    "-- Views are synthetic tables in local development; populate their output columns.",
    "-- Domains use their resolved source base types. No production rows are fetched."
  ];
  for (const [index, relation] of snapshot.relations.entries()) {
    const row = `Row${index}`;
    rowTypes.push(
      `export interface ${row} {\n${relation.columns
        .map((column) => {
          const type = typeMapping(column.type)!.typescript;
          return `  readonly [${literal(column.name)}]: ${type}${column.nullable ? " | null" : ""};`;
        })
        .join("\n")}\n}`
    );
    const comparable =
      relation.columns
        .filter((column) => typeMapping(column.type)!.comparable)
        .map((column) => literal(column.name))
        .join(" | ") || "never";
    const keyed = relation.primaryKey !== null;
    const key = keyed
      ? `Pick<${row}, ${relation.primaryKey!.columns.map(literal).join(" | ")}>`
      : undefined;
    const member = `[${literal(relation.name)}]: relation<${row}, ${comparable}${key ? `, ${key}` : ""}>(connection, call, ${literal(relation.schema)}, ${literal(relation.name)}, ${keyed})`;
    const memberType = `readonly [${literal(relation.name)}]: ${key ? `KeyedRelation<${row}, ${comparable}, ${key}>` : `Relation<${row}, ${comparable}>`};`;
    if (relation.schema === "public") topTypes.push(memberType);
    else {
      const members = schemaTypes.get(relation.schema) ?? [];
      members.push(memberType);
      schemaTypes.set(relation.schema, members);
    }
    if (relation.schema === "public") top.push(member);
    else {
      const members = schemas.get(relation.schema) ?? [];
      members.push(member);
      schemas.set(relation.schema, members);
    }
    listing.push(
      `### ${markdown(`${relation.schema}.${relation.name}`)}\n\n${relation.kind === "view" ? "View (nullable columns; synthetic fixture table)." : "Table."} ${keyed ? `Key: ${relation.primaryKey!.columns.map(markdown).join(", ")}. Exposes get, getMany and list.` : "No usable primary key: exposes list only; bounded offset pagination."}\n\n${relation.columns.map((column) => `- ${markdown(column.name)}: ${markdown(nativeType(column.type, snapshot)!)}${column.nullable ? ", nullable" : ""}`).join("\n")}\n`
    );
    fixture.push(
      `-- ${JSON.stringify(`${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`)} (${relation.kind === "view" ? "synthetic view" : "table"})`
    );
    for (const column of relation.columns)
      fixture.push(
        `--   ${JSON.stringify(quoteIdentifier(column.name))}: ${JSON.stringify(nativeType(column.type, snapshot))}${column.nullable ? " nullable" : " required"}`
      );
  }
  for (const [schema, members] of schemas)
    top.push(`[${literal(schema)}]: { ${members.join(",\n")} }`);
  for (const [schema, members] of schemaTypes)
    topTypes.push(`readonly [${literal(schema)}]: { ${members.join("\n")} };`);
  const client = `${prelude}\n${rowTypes.join("\n")}\nexport interface Client {\n  readonly query: Query;\n${topTypes.join("\n")}\n}\nexport function createClient(connection: string, call: Call): Client {\n  const query: Query = async <const S extends Shape>(sql: string, params: readonly Parameter[], shape: S) => await invoke(call, "postgres.query", { connection, sql, params, shape: wireShape(shape) }) as Rows<ShapeRow<S>>;\n  return { query,\n${top.map((member) => `    ${member}`).join(",\n")}\n  };\n}\n`;
  const exclusions =
    snapshot.exclusions
      .map(
        (item) =>
          `- ${markdown(`${item.schema}.${item.relation}${item.column ? `.${item.column}` : ""}`)}: ${item.reason}`
      )
      .join("\n") || "None.";
  for (const item of snapshot.exclusions)
    fixture.push(
      `-- Excluded ${JSON.stringify(`${item.schema}.${item.relation}${item.column ? `.${item.column}` : ""}`)}: ${item.reason}`
    );
  const context = `# Postgres connection\n\nHandle: ${markdown(declaration.handle)}\n\nDescription: ${markdown(declaration.description ?? "")}\n\nSnapshot revision: ${declaration.revision}\n\nUse the declared alias when constructing the client. Public relations are top-level; other schemas are namespaces. Names are preserved exactly; use brackets when not dottable. The query member is reserved.\n\nint8 and numeric are strings. Finite floating-point values are numbers. Dates are YYYY-MM-DD; timestamps without zone are YYYY-MM-DDTHH:MM:SS.ffffff; timestamps with zone are UTC with six fractional digits and Z. JSON and arrays are unknown.\n\nlist accepts typed eq, range, orderBy, select, limit and cursor. Keyed cursors bind filters, order and this snapshot revision. Unkeyed pagination stops at 10,000 rows. Calls are read-only, at most 1,000 rows and 8 MB, with 10-second statement and 15-second service deadlines.\n\nquery(sql, params, shape) uses strict text/integer/number/boolean/timestamp/json descriptors with optional: true for nullability. Missing or duplicate columns and nonoptional null fail with shape_mismatch; extra columns are dropped. Defaults and references are not query shape kinds. Catch unknown errors and narrow with isPatchyError; method error unions document known refusals, not exhaustive throws.\n\n## Relations\n\n${listing.join("\n")}\n## Exclusions\n\n${exclusions}\n\n## Fixture\n\nWrite ${markdown(`fixtures/postgres-${declaration.handle}.sql`)}. Views are synthetic tables. The fixture never contacts the source; unsupported PGlite SQL fails locally with the reason.\n`;
  return { client, context, fixture: `${fixture.join("\n")}\n` };
};
