/** Code-first definitions. Builders do not load the Node-only config executor. */
declare const idBrand: unique symbol;
export type Id<Table extends string> = string & { readonly [idBrand]: Table };
export type ColumnKind =
  "text" | "integer" | "number" | "boolean" | "timestamp" | "json" | "ref" | "member";
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
type WriteValue<K extends ColumnKind, Target extends string> = K extends "json"
  ? Exclude<Json, null>
  : Value<K, Target>;

export type ScalarKind = Exclude<ColumnKind, "ref" | "member">;
export type ValueDescriptor = (
  | { readonly kind: ScalarKind }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, ValueDescriptor>> }
  | { readonly kind: "array"; readonly element: ValueDescriptor }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "nullable"; readonly value: ValueDescriptor }
  | { readonly kind: "row"; readonly table: string }
  | { readonly kind: "fileHandle" | "upload" }
) & { readonly optional?: true };
type ColumnDescriptor<
  K extends ColumnKind,
  Optional extends boolean,
  Defaulted extends boolean,
  Target extends string
> = { readonly kind: K } & (K extends "ref" ? { readonly table: Target } : unknown) &
  (Optional extends true ? { readonly optional: true } : unknown) &
  (Defaulted extends true ? { readonly default: WriteValue<K, Target> } : unknown);
export type Descriptor = (
  | { readonly kind: ScalarKind | "member" }
  | { readonly kind: "ref" | "row"; readonly table: string }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, Descriptor>> }
  | { readonly kind: "array"; readonly element: Descriptor }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "nullable"; readonly value: Descriptor }
  | { readonly kind: "fileHandle" | "upload" }
) & { readonly optional?: true; readonly default?: unknown };
export interface SchemaInput {
  readonly isOptional: boolean;
  toJSON(): Descriptor;
}
export type Fields = Readonly<Record<string, SchemaInput>>;
export type DescriptorOf<S extends SchemaInput> = ReturnType<S["toJSON"]>;
type FieldDescriptors<F extends Fields> = { readonly [K in keyof F]: DescriptorOf<F[K]> };

/** Composite schemas have field optionality, but no table default or reference modifier. */
export class ValueSchema<D extends object, Optional extends boolean = false> {
  constructor(
    readonly descriptor: D,
    readonly isOptional: Optional
  ) {}

  optional(this: ValueSchema<D, false>): ValueSchema<D, true> {
    return new ValueSchema(this.descriptor, true);
  }

  toJSON(): D & (Optional extends true ? { readonly optional: true } : unknown) {
    return {
      ...this.descriptor,
      ...(this.isOptional ? { optional: true } : {})
    } as D & (Optional extends true ? { readonly optional: true } : unknown);
  }
}

declare const fileHandleBrand: unique symbol;
declare const uploadBrand: unique symbol;
export type FileHandle = string & { readonly [fileHandleBrand]: true };
export type Upload = {
  readonly token: string;
  /** Patchy's measured byte length; never inferred from the claimed media type. */
  readonly size: number;
  readonly contentType: string;
  readonly [uploadBrand]: true;
};

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
    value: K extends "member" ? never : WriteValue<K, Target>
  ): Column<K, false, true, Target> {
    if (this.kind === "member") throw new Error("A member column cannot have a default.");
    if (this.isOptional) throw new Error("An optional column cannot have a default.");
    if (value === null || value === undefined)
      throw new Error("A default cannot be null or undefined.");
    return new Column(this.kind, false, true, this.table, value);
  }

  /** Only JSON descriptors cross the process and wire boundary. */
  toJSON(): ColumnDescriptor<K, Optional, Defaulted, Target> {
    if (this.kind === "member" && this.hasDefault)
      throw new Error("A member column cannot have a default.");
    return {
      kind: this.kind,
      ...(this.kind === "ref" ? { table: this.table } : {}),
      ...(this.isOptional ? { optional: true } : {}),
      ...(this.hasDefault ? { default: this.defaultValue } : {})
    } as ColumnDescriptor<K, Optional, Defaulted, Target>;
  }
}

export const t = {
  text: () => new Column("text", false, false),
  integer: () => new Column("integer", false, false),
  number: () => new Column("number", false, false),
  boolean: () => new Column("boolean", false, false),
  timestamp: () => new Column("timestamp", false, false),
  json: () => new Column("json", false, false),
  ref: <const Target extends string>(table: Target) => new Column("ref", false, false, table),
  member: () => new Column("member", false, false),
  object: <const F extends Fields>(fields: F) =>
    new ValueSchema(
      {
        kind: "object" as const,
        fields: Object.fromEntries(
          Object.entries(fields).map(([name, field]) => [name, field.toJSON()])
        ) as FieldDescriptors<F>
      },
      false
    ),
  array: <const S extends SchemaInput>(element: S) =>
    new ValueSchema(
      { kind: "array" as const, element: element.toJSON() as DescriptorOf<S> },
      false
    ),
  enum: <const Values extends readonly [string, ...string[]]>(values: Values) => {
    if (values.length === 0 || new Set(values).size !== values.length)
      throw new Error("An enum needs at least one value and cannot contain duplicates.");
    return new ValueSchema({ kind: "enum" as const, values }, false);
  },
  nullable: <const S extends SchemaInput>(value: S) =>
    new ValueSchema({ kind: "nullable" as const, value: value.toJSON() as DescriptorOf<S> }, false),
  row: <const Name extends string>(table: Name) =>
    new ValueSchema({ kind: "row" as const, table }, false),
  fileHandle: () => new ValueSchema({ kind: "fileHandle" as const }, false),
  upload: () => new ValueSchema({ kind: "upload" as const }, false)
};

export type Columns = Readonly<Record<string, Column>>;
export type IndexDefinition = { readonly columns: readonly string[]; readonly unique?: boolean };
export type Indexes = Readonly<Record<string, IndexDefinition>>;
export interface TableDefinition<C extends Columns = Columns, I extends Indexes = Indexes> {
  readonly description: string;
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

export type NonEmptyString<S extends string> = S extends "" ? never : S;
export interface FileStoreDefinition {
  readonly description: string;
  readonly shared?: boolean;
}

const validateDescription = (description: string): void => {
  if (typeof description !== "string" || description.trim().length === 0)
    throw new Error("A table or file store description must be a nonblank string.");
};

export const table = <
  const Description extends string,
  const C extends Columns,
  const I extends Readonly<Record<string, IndexInput<C>>> = Record<never, never>
>(
  description: NonEmptyString<Description>,
  columns: C & { readonly [Name in SystemColumn]?: never },
  options: { readonly indexes?: I; readonly shared?: boolean } = {}
): TableDefinition<C, NormalizeIndexes<I>> => {
  validateDescription(description);
  const indexes = Object.fromEntries(
    Object.entries(options.indexes ?? {}).map(([name, index]) => [
      name,
      Array.isArray(index) ? { columns: index } : index
    ])
  ) as NormalizeIndexes<I>;
  return {
    description,
    columns,
    indexes,
    ...(options.shared === undefined ? {} : { shared: options.shared })
  };
};

export const files = <const Description extends string>(
  description: NonEmptyString<Description>,
  options: { readonly shared?: boolean } = {}
): FileStoreDefinition => {
  validateDescription(description);
  return { description, ...(options.shared === undefined ? {} : { shared: options.shared }) };
};
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
export const sharedStore = <const Patch extends string, const Store extends string>(
  patchId: Patch,
  store: Store
) => ({
  kind: "sharedStore" as const,
  patchId,
  store
});
export const members = () => ({ kind: "members" as const });
export type Declaration =
  | { readonly kind: "postgres"; readonly handle: string }
  | { readonly kind: "sharedTable"; readonly patchId: string; readonly table: string }
  | { readonly kind: "sharedStore"; readonly patchId: string; readonly store: string }
  | { readonly kind: "members" };
export interface Config {
  readonly name: string;
  readonly tier: 0 | 1 | 2 | 3;
  readonly tables: Readonly<Record<string, TableDefinition>>;
  readonly files: Readonly<Record<string, FileStoreDefinition>>;
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

/** A static import would load Node-only modules for every builder caller. */
export const executeConfig = async (path: string) =>
  (await import("./executeConfig.js")).executeConfig(path);

export type ColumnValue<C extends Column> =
  Value<C["kind"], NonNullable<C["table"]>> | (C["isOptional"] extends true ? null : never);
type TableColumns<C extends Config, Name extends keyof C["tables"]> = C["tables"][Name]["columns"];
type Readable<C extends Columns> = { -readonly [Name in keyof C]: ColumnValue<C[Name]> };
type Writable<C extends Columns> = {
  -readonly [Name in keyof C]:
    | WriteValue<C[Name]["kind"], NonNullable<C[Name]["table"]>>
    | (C[Name]["isOptional"] extends true ? null : never);
};
type SystemInput = { readonly [Name in SystemColumn]?: never };
type RequiredColumns<C extends Columns> = {
  [Name in keyof C]: C[Name]["isOptional"] extends false
    ? C[Name]["hasDefault"] extends false
      ? Name
      : never
    : never;
}[keyof C];

export type Row<C extends Config, Name extends keyof C["tables"] & string> = Readable<
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
