/** Code-first definitions. This entry point has no runtime dependencies. */
declare const idBrand: unique symbol;
export type Id<Table extends string> = string & { readonly [idBrand]: Table };
export type ColumnKind = "text" | "integer" | "number" | "boolean" | "timestamp" | "json" | "ref";
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Value<K extends ColumnKind, Target extends string> = K extends "ref"
  ? Id<Target>
  : K extends "integer" | "number"
    ? number
    : K extends "boolean"
      ? boolean
      : K extends "json"
        ? unknown
        : string;
type DefaultValue<K extends ColumnKind, Target extends string> = K extends "json"
  ? Exclude<Json, null>
  : Value<K, Target>;

export class Column<
  K extends ColumnKind = ColumnKind,
  Optional extends boolean = boolean,
  Defaulted extends boolean = boolean,
  Target extends string = string
> {
  constructor(
    readonly kind: K,
    readonly isOptional: Optional,
    readonly hasDefault: Defaulted,
    readonly table: Target | undefined = undefined,
    readonly defaultValue: unknown = undefined
  ) {}

  optional(this: Column<K, false, false, Target>): Column<K, true, false, Target> {
    if (this.hasDefault) throw new Error("A defaulted column cannot be optional.");
    return new Column(this.kind, true, false, this.table);
  }

  default(
    this: Column<K, false, false, Target>,
    value: DefaultValue<K, Target>
  ): Column<K, false, true, Target> {
    if (this.isOptional) throw new Error("An optional column cannot have a default.");
    if (value === null || value === undefined)
      throw new Error("A default cannot be null or undefined.");
    return new Column(this.kind, false, true, this.table, value);
  }

  /** Only the existing manifest descriptor crosses the process/wire boundary. */
  toJSON() {
    return {
      kind: this.kind,
      ...(this.kind === "ref" ? { table: this.table } : {}),
      ...(this.isOptional ? { optional: true } : {}),
      ...(this.hasDefault ? { default: this.defaultValue } : {})
    };
  }
}

export const t = {
  text: () => new Column("text", false, false),
  integer: () => new Column("integer", false, false),
  number: () => new Column("number", false, false),
  boolean: () => new Column("boolean", false, false),
  timestamp: () => new Column("timestamp", false, false),
  json: () => new Column("json", false, false),
  ref: <const Target extends string>(table: Target) => new Column("ref", false, false, table)
};

export type Columns = Readonly<Record<string, Column>>;
export type IndexDefinition = { readonly columns: readonly string[]; readonly unique?: boolean };
export type Indexes = Readonly<Record<string, IndexDefinition>>;
export interface TableDefinition<C extends Columns = Columns, I extends Indexes = Indexes> {
  readonly columns: C;
  readonly indexes: I;
  readonly shared?: boolean;
}
type SystemColumn = "id" | "createdAt" | "updatedAt";
type IndexInput<C extends Columns> =
  | readonly ((keyof C & string) | SystemColumn)[]
  | { readonly columns: readonly ((keyof C & string) | SystemColumn)[]; readonly unique?: boolean };
type NormalizeIndexes<I> = {
  readonly [Name in keyof I]: I[Name] extends IndexDefinition
    ? I[Name]
    : I[Name] extends readonly string[]
      ? { readonly columns: I[Name] }
      : never;
};

export const table = <
  const C extends Columns,
  const I extends Readonly<Record<string, IndexInput<C>>> = Record<never, never>
>(
  columns: C & { readonly [Name in SystemColumn]?: never },
  options: { readonly indexes?: I; readonly shared?: boolean } = {}
): TableDefinition<C, NormalizeIndexes<I>> => {
  const indexes = Object.fromEntries(
    Object.entries(options.indexes ?? {}).map(([name, index]) => [
      name,
      Array.isArray(index) ? { columns: index } : index
    ])
  ) as NormalizeIndexes<I>;
  return { columns, indexes, ...(options.shared === undefined ? {} : { shared: options.shared }) };
};

export const files = (): Readonly<Record<string, never>> => ({});
export const postgres = <const Handle extends string>(handle: Handle) => ({
  kind: "postgres" as const,
  handle
});
export const sharedTable = <const Patch extends string, const Table extends string>(
  patchId: Patch,
  table: Table
) => ({
  kind: "sharedTable" as const,
  patchId,
  table
});
export type Declaration =
  | { readonly kind: "postgres"; readonly handle: string }
  | { readonly kind: "sharedTable"; readonly patchId: string; readonly table: string };
export interface Config {
  readonly name: string;
  readonly tier: 0 | 1 | 2 | 3;
  readonly tables: Readonly<Record<string, TableDefinition>>;
  readonly files: Readonly<Record<string, Readonly<Record<string, never>>>>;
  readonly uses: Readonly<Record<string, Declaration>>;
}

export const defineConfig = <
  const Tables extends Config["tables"] = Record<never, never>,
  const Files extends Config["files"] = Record<never, never>,
  const Uses extends Config["uses"] = Record<never, never>,
  const Tier extends Config["tier"] = Config["tier"]
>(config: {
  readonly name: string;
  readonly tier: Tier;
  readonly tables?: Tables;
  readonly files?: Files;
  readonly uses?: Uses;
}) => ({
  name: config.name,
  tier: config.tier,
  tables: (config.tables ?? {}) as Tables,
  files: (config.files ?? {}) as Files,
  uses: (config.uses ?? {}) as Uses
});

export type ColumnValue<C extends Column> =
  Value<C["kind"], NonNullable<C["table"]>> | (C["isOptional"] extends true ? null : never);
type TableColumns<C extends Config, Name extends keyof C["tables"]> = C["tables"][Name]["columns"];
type Writable<C extends Columns> = { -readonly [Name in keyof C]: ColumnValue<C[Name]> };
type SystemInput = { readonly [Name in SystemColumn]?: never };
type RequiredColumns<C extends Columns> = {
  [Name in keyof C]: C[Name]["isOptional"] extends false
    ? C[Name]["hasDefault"] extends false
      ? Name
      : never
    : never;
}[keyof C];

export type Row<C extends Config, Name extends keyof C["tables"] & string> = Writable<
  TableColumns<C, Name>
> & {
  readonly id: Id<Name>;
  readonly createdAt: string;
  readonly updatedAt: string;
};
export type Insert<C extends Config, Name extends keyof C["tables"] & string> = Pick<
  Writable<TableColumns<C, Name>>,
  RequiredColumns<TableColumns<C, Name>>
> &
  Partial<Omit<Writable<TableColumns<C, Name>>, RequiredColumns<TableColumns<C, Name>>>> &
  SystemInput;
export type Update<C extends Config, Name extends keyof C["tables"] & string> = Partial<
  Writable<TableColumns<C, Name>>
> &
  SystemInput;
