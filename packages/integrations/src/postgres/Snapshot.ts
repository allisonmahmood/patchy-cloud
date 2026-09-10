import * as Schema from "effect/Schema";

export const MAX_RELATIONS = 500;
export const MAX_COLUMNS = 200;
export const MAX_EXCLUSIONS = 10_000;
export const MAX_ENUMS = 1_000;
export const MAX_ENUM_LABELS = 1_000;
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(63));
const Names = Schema.Array(Name).check(Schema.isMaxLength(MAX_COLUMNS));
const distinct = (values: ReadonlyArray<string>) => new Set(values).size === values.length;

export const ColumnType = Schema.Struct({
  schema: Name,
  name: Name,
  sql: Schema.String.check(Schema.isMaxLength(1_024)),
  baseSchema: Name,
  baseName: Name,
  kind: Schema.Literals(["base", "enum", "array"])
});

export const Column = Schema.Struct({
  name: Name,
  type: ColumnType,
  nullable: Schema.Boolean
});

export const PrimaryKey = Schema.Struct({
  name: Name,
  columns: Names.check(Schema.isMinLength(1))
});

export const ForeignKey = Schema.Struct({
  name: Name,
  columns: Names.check(Schema.isMinLength(1)),
  target: Schema.Struct({
    schema: Name,
    relation: Name,
    columns: Names.check(Schema.isMinLength(1))
  })
}).check(
  Schema.makeFilter(
    (key) =>
      key.columns.length === key.target.columns.length &&
      distinct(key.columns) &&
      distinct(key.target.columns)
  )
);

export const Relation = Schema.Struct({
  schema: Name,
  name: Name,
  kind: Schema.Literals(["table", "view"]),
  columns: Schema.Array(Column).check(Schema.isMaxLength(MAX_COLUMNS)),
  primaryKey: Schema.NullOr(PrimaryKey),
  foreignKeys: Schema.Array(ForeignKey).check(Schema.isMaxLength(MAX_COLUMNS))
}).check(
  Schema.makeFilter((relation) => {
    const columns = new Set(relation.columns.map((column) => column.name));
    return (
      columns.size === relation.columns.length &&
      (relation.kind !== "view" || relation.columns.every((column) => column.nullable)) &&
      (relation.primaryKey === null ||
        (distinct(relation.primaryKey.columns) &&
          relation.primaryKey.columns.every((name) => columns.has(name)))) &&
      distinct(relation.foreignKeys.map((key) => key.name)) &&
      relation.foreignKeys.every((key) => key.columns.every((name) => columns.has(name)))
    );
  })
);

export const Enum = Schema.Struct({
  schema: Name,
  name: Name,
  labels: Schema.Array(Schema.String.check(Schema.isMaxLength(63))).check(
    Schema.isMaxLength(MAX_ENUM_LABELS),
    Schema.makeFilter(distinct)
  )
});

export const Exclusion = Schema.Struct({
  schema: Name,
  relation: Name,
  column: Schema.optionalKey(Name),
  reason: Schema.Literals([
    "access_denied",
    "relation_limit",
    "column_limit",
    "unsupported_type",
    "reserved_name",
    "key_limit",
    "enum_limit"
  ])
});

export const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  relations: Schema.Array(Relation).check(Schema.isMaxLength(MAX_RELATIONS)),
  enums: Schema.Array(Enum).check(Schema.isMaxLength(MAX_ENUMS)),
  exclusions: Schema.Array(Exclusion).check(Schema.isMaxLength(MAX_EXCLUSIONS))
}).check(
  Schema.makeFilter((snapshot) => {
    const relations = new Map(
      snapshot.relations.map((relation) => [`${relation.schema}\u0000${relation.name}`, relation])
    );
    const enums = new Set(snapshot.enums.map((value) => `${value.schema}\u0000${value.name}`));
    return (
      relations.size === snapshot.relations.length &&
      enums.size === snapshot.enums.length &&
      snapshot.relations.every(
        (relation) =>
          relation.columns.every(
            (column) =>
              column.type.kind !== "enum" ||
              enums.has(`${column.type.baseSchema}\u0000${column.type.baseName}`)
          ) &&
          relation.foreignKeys.every((key) => {
            const target = relations.get(`${key.target.schema}\u0000${key.target.relation}`);
            return (
              target === undefined ||
              key.target.columns.every(
                (name) =>
                  target.columns.some((column) => column.name === name) ||
                  snapshot.exclusions.some(
                    (exclusion) =>
                      exclusion.schema === target.schema &&
                      exclusion.relation === target.name &&
                      exclusion.column === name
                  )
              )
            );
          })
      )
    );
  })
);

/** Source-native types understood by the upcoming constrained read surface. */
export const supportedType = (type: typeof ColumnType.Type): boolean =>
  type.kind === "enum" ||
  type.kind === "array" ||
  type.baseName === "citext" ||
  (type.baseSchema === "pg_catalog" &&
    [
      "int2",
      "int4",
      "int8",
      "numeric",
      "float4",
      "float8",
      "text",
      "varchar",
      "bpchar",
      "name",
      "char",
      "uuid",
      "bool",
      "timestamptz",
      "timestamp",
      "date",
      "json",
      "jsonb"
    ].includes(type.baseName));
