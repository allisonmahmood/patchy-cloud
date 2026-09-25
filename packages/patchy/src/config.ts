/** Code-first definitions. Builders do not load the Node-only config executor. */
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
type WriteValue<K extends ColumnKind, Target extends string> = K extends "json"
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
    value: WriteValue<K, Target>
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
  ref: <const Target extends string>(table: Target) => new Column("ref", false, false, table),
  // PROTOTYPE for #314: handler argument and result shapes.
  object: <const F extends Fields>(fields: F) => new ObjectDescriptor(fields, false),
  array: <const I extends FieldDescriptor>(items: I) => new ArrayDescriptor(items, false),
  enum: <const V extends string>(values: readonly V[]) => new EnumDescriptor(values, false),
  nullable: <const I extends FieldDescriptor>(inner: I) => new NullableDescriptor(inner, false),
  row: <const T extends string>(table: T) => new RowDescriptor(table, false)
};

// PROTOTYPE for #314: descriptors for handler arguments and results. Serialised to JSON
// beside the column descriptors; `optional` on a field means the key may be omitted, `nullable`
// admits null. `.default()` keeps its table-only meaning and is refused in a handler descriptor.
export type FieldDescriptor = Column | Descriptor;
export type Fields = Readonly<Record<string, FieldDescriptor>>;
abstract class DescriptorBase<Optional extends boolean> {
  constructor(readonly isOptional: Optional) {}
  abstract toJSON(): Record<string, unknown>;
}
export class ObjectDescriptor<
  F extends Fields = Fields,
  Optional extends boolean = false
> extends DescriptorBase<Optional> {
  constructor(
    readonly fields: F,
    isOptional: Optional
  ) {
    super(isOptional);
  }
  optional(this: ObjectDescriptor<F, false>): ObjectDescriptor<F, true> {
    return new ObjectDescriptor(this.fields, true);
  }
  toJSON() {
    return { kind: "object", fields: this.fields, ...(this.isOptional ? { optional: true } : {}) };
  }
}
export class ArrayDescriptor<
  I extends FieldDescriptor = FieldDescriptor,
  Optional extends boolean = false
> extends DescriptorBase<Optional> {
  constructor(
    readonly items: I,
    isOptional: Optional
  ) {
    super(isOptional);
  }
  optional(this: ArrayDescriptor<I, false>): ArrayDescriptor<I, true> {
    return new ArrayDescriptor(this.items, true);
  }
  toJSON() {
    return { kind: "array", items: this.items, ...(this.isOptional ? { optional: true } : {}) };
  }
}
export class EnumDescriptor<
  V extends string = string,
  Optional extends boolean = false
> extends DescriptorBase<Optional> {
  constructor(
    readonly values: readonly V[],
    isOptional: Optional
  ) {
    super(isOptional);
  }
  optional(this: EnumDescriptor<V, false>): EnumDescriptor<V, true> {
    return new EnumDescriptor(this.values, true);
  }
  toJSON() {
    return { kind: "enum", values: this.values, ...(this.isOptional ? { optional: true } : {}) };
  }
}
export class NullableDescriptor<
  I extends FieldDescriptor = FieldDescriptor,
  Optional extends boolean = false
> extends DescriptorBase<Optional> {
  constructor(
    readonly inner: I,
    isOptional: Optional
  ) {
    super(isOptional);
  }
  optional(this: NullableDescriptor<I, false>): NullableDescriptor<I, true> {
    return new NullableDescriptor(this.inner, true);
  }
  toJSON() {
    return { kind: "nullable", inner: this.inner, ...(this.isOptional ? { optional: true } : {}) };
  }
}
export class RowDescriptor<
  T extends string = string,
  Optional extends boolean = false
> extends DescriptorBase<Optional> {
  constructor(
    readonly table: T,
    isOptional: Optional
  ) {
    super(isOptional);
  }
  optional(this: RowDescriptor<T, false>): RowDescriptor<T, true> {
    return new RowDescriptor(this.table, true);
  }
  toJSON() {
    return { kind: "row", table: this.table, ...(this.isOptional ? { optional: true } : {}) };
  }
}
export type Descriptor =
  | ObjectDescriptor<Fields, boolean>
  | ArrayDescriptor<FieldDescriptor, boolean>
  | EnumDescriptor<string, boolean>
  | NullableDescriptor<FieldDescriptor, boolean>
  | RowDescriptor<string, boolean>;

/** The TypeScript type a descriptor admits, with `t.row` resolved against the config `C`. */
export type Infer<D, C extends Config = Config> =
  D extends Column<infer K, boolean, boolean, infer Target>
    ? K extends "ref"
      ? Id<Target>
      : Value<K, Target>
    : D extends ObjectDescriptor<infer F, boolean>
      ? InferObject<F, C>
      : D extends ArrayDescriptor<infer I, boolean>
        ? readonly Infer<I, C>[]
        : D extends EnumDescriptor<infer V, boolean>
          ? V
          : D extends NullableDescriptor<infer I, boolean>
            ? Infer<I, C> | null
            : D extends RowDescriptor<infer T, boolean>
              ? T extends keyof C["tables"] & string
                ? Row<C, T>
                : never
              : never;
type OptionalFields<F> = {
  [K in keyof F]: F[K] extends { readonly isOptional: true } ? K : never;
}[keyof F];
type InferObject<F, C extends Config> = {
  readonly [K in Exclude<keyof F, OptionalFields<F>>]: Infer<F[K], C>;
} & { readonly [K in OptionalFields<F>]?: Infer<F[K], C> };

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
  description: NonEmptyString<Description>
): FileStoreDefinition => {
  validateDescription(description);
  return { description };
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
export type Declaration =
  | { readonly kind: "postgres"; readonly handle: string }
  | { readonly kind: "sharedTable"; readonly patchId: string; readonly table: string };
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
