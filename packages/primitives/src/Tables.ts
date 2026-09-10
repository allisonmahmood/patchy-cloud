import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ColumnDefinition, Manifest, ProvisioningReport, TableDefinition } from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";

export class NotAdditive extends Schema.TaggedError<NotAdditive>()("NotAdditive", {
  changes: Schema.Array(
    Schema.Struct({ object: Schema.String, change: Schema.String, fix: Schema.String })
  )
}) {
  readonly code = "not_additive" as const;
  override get message() {
    return this.changes.map(({ object, change, fix }) => `${object}: ${change}; ${fix}.`).join(" ");
  }
}

export interface Provisioned {
  readonly provisioned: typeof ProvisioningReport.Type;
  readonly unused: typeof ProvisioningReport.Type;
  readonly warnings: readonly string[];
  readonly schemaRevision: number;
}

export interface Plan extends Provisioned {
  readonly newTables: readonly string[];
  readonly newColumns: readonly { readonly table: string; readonly name: string }[];
  readonly newIndexes: readonly { readonly table: string; readonly name: string }[];
  readonly sharing: readonly string[];
}

export class Tables extends Context.Service<
  Tables,
  {
    readonly diff: (
      manifest: typeof Manifest.Type,
      snapshot: Inventory.Snapshot | null
    ) => Effect.Effect<Plan, NotAdditive>;
    readonly provision: (
      patchId: string,
      manifest: typeof Manifest.Type
    ) => Effect.Effect<
      Provisioned,
      NotAdditive | SqlError,
      CompanyDatabases.CompanyConnection | CompanyDatabases.PatchLock
    >;
  }
>()("@patchy/primitives/Tables") {}

const report = () => ({
  tables: [] as string[],
  columns: [] as string[],
  indexes: [] as string[],
  stores: [] as string[]
});
const defaultKind = (column: typeof ColumnDefinition.Type): Inventory.Column["defaultKind"] =>
  !Object.hasOwn(column, "default")
    ? null
    : column.kind === "timestamp" && column.default === "now"
      ? "now"
      : "constant";
const quote = Inventory.quoteIdentifier;
const literal = (value: string): string =>
  `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
const sqlTypes = {
  text: "text",
  ref: "text",
  integer: "integer",
  number: "double precision",
  boolean: "boolean",
  timestamp: "timestamptz",
  json: "jsonb"
} as const;
const columnSql = (name: string, column: typeof ColumnDefinition.Type): string => {
  const kind = defaultKind(column);
  const value = column.default;
  const defaultSql =
    kind === null
      ? ""
      : kind === "now"
        ? " DEFAULT statement_timestamp()"
        : ` DEFAULT ${column.kind === "json" ? `${literal(JSON.stringify(value))}::jsonb` : typeof value === "string" ? literal(value) : String(value)}`;
  return `${quote(name)} ${sqlTypes[column.kind]}${column.optional === true ? "" : " NOT NULL"}${defaultSql}`;
};

// PostgreSQL index names share a schema namespace and are limited to 63 bytes.
const indexName = (table: string, kind: string, name: string): string =>
  `_patchy_${createHash("sha256")
    .update(JSON.stringify([table, kind, name]))
    .digest("hex")
    .slice(0, 48)}`;

/** Reconstruct the cumulative definition, not the current version's manifest. */
export const inventoryManifest = (
  snapshot: Inventory.Snapshot
): Pick<typeof Manifest.Type, "tables" | "files"> => {
  const tables: Record<string, typeof TableDefinition.Type> = Object.create(null);
  for (const table of snapshot.tables) {
    const columns: Record<string, typeof ColumnDefinition.Type> = Object.create(null);
    const indexes: Record<string, (typeof TableDefinition.Type)["indexes"][string]> =
      Object.create(null);
    for (const column of snapshot.columns) {
      if (column.table !== table.name) continue;
      const modifiers = {
        ...(column.optional ? { optional: true } : {}),
        ...(column.defaultKind === null
          ? {}
          : { default: column.defaultKind === "now" ? "now" : column.defaultValue })
      };
      // Inventory was written from a validated manifest; decoding also catches corrupt persisted defaults.
      columns[column.name] = decodeColumn({
        kind: column.kind,
        ...(column.kind === "ref" ? { table: column.refTable } : {}),
        ...modifiers
      });
    }
    for (const index of snapshot.indexes) {
      if (index.table === table.name)
        indexes[index.name] = { columns: index.columns, unique: index.unique };
    }
    tables[table.name] = { columns, indexes, shared: table.shared };
  }
  return { tables, files: Object.fromEntries(snapshot.stores.map((store) => [store.name, {}])) };
};
const decodeColumn = Schema.decodeUnknownSync(ColumnDefinition);

const diff = Effect.fn("Tables.diff")(function* (
  manifest: typeof Manifest.Type,
  snapshot: Inventory.Snapshot | null
) {
  const provisioned = report();
  const unused = report();
  const warnings: string[] = [];
  const changes: Array<{ object: string; change: string; fix: string }> = [];
  const newTables: string[] = [];
  const newColumns: Array<{ table: string; name: string }> = [];
  const newIndexes: Array<{ table: string; name: string }> = [];
  const sharing: string[] = [];
  const oldTables = new Map(snapshot?.tables.map((table) => [table.name, table]));
  const oldColumns = new Map(
    snapshot?.columns.map((column) => [`${column.table}.${column.name}`, column])
  );
  const oldIndexes = new Map(
    snapshot?.indexes.map((index) => [`${index.table}.${index.name}`, index])
  );
  const oldColumnCounts = new Map<string, number>();
  for (const column of snapshot?.columns ?? []) {
    oldColumnCounts.set(column.table, (oldColumnCounts.get(column.table) ?? 0) + 1);
  }

  for (const store of Object.keys(manifest.files)) {
    changes.push({
      object: store,
      change: "file stores are not supported yet",
      fix: "remove the file store definition"
    });
  }
  for (const [table, definition] of Object.entries(manifest.tables)) {
    const oldTable = oldTables.get(table);
    if (!oldTable) {
      newTables.push(table);
      provisioned.tables.push(table);
    } else if (oldTable.shared !== (definition.shared === true)) {
      sharing.push(table);
      provisioned.tables.push(table);
      warnings.push(
        definition.shared === true
          ? `\`${table}\` is now shared.`
          : `\`${table}\` is no longer shared; 0 declaring patches are affected.`
      );
    }
    let columnCount = oldColumnCounts.get(table) ?? 0;
    for (const [name, column] of Object.entries(definition.columns)) {
      const object = `${table}.${name}`;
      const old = oldColumns.get(object);
      if (
        column.kind === "ref" &&
        !Object.hasOwn(manifest.tables, column.table) &&
        !oldTables.has(column.table)
      ) {
        changes.push({
          object,
          change: `ref target ${column.table} does not exist`,
          fix: "define the target table"
        });
      }
      if (!old) {
        columnCount++;
        if (oldTable && column.optional !== true && defaultKind(column) === null) {
          changes.push({
            object,
            change: "adding a required column without a default",
            fix: "add an optional or defaulted column instead"
          });
        } else {
          newColumns.push({ table, name });
          provisioned.columns.push(object);
        }
        continue;
      }
      if (old.kind !== column.kind)
        changes.push({
          object,
          change: `changing kind from ${old.kind} to ${column.kind}`,
          fix: "keep the column and add a new column with the desired kind"
        });
      if (old.kind === "ref" && column.kind === "ref" && old.refTable !== column.table)
        changes.push({
          object,
          change: `changing ref target from ${old.refTable} to ${column.table}`,
          fix: "keep the ref and add a new ref column"
        });
      if (old.optional !== (column.optional === true))
        changes.push({
          object,
          change: old.optional ? "changing optional to required" : "changing required to optional",
          fix: "keep the column and add a new column with the desired optionality"
        });
      if (
        old.defaultKind !== defaultKind(column) ||
        (old.defaultKind === "constant" && !isDeepStrictEqual(old.defaultValue, column.default))
      )
        changes.push({
          object,
          change:
            defaultKind(column) === null ? "removing a default" : "adding or changing a default",
          fix: "keep the existing default and add a new column instead"
        });
    }
    if (columnCount > 1597)
      changes.push({
        object: table,
        change: "exceeding the 1597-column cumulative limit, including unused columns",
        fix: "keep existing columns and put new columns in a new table"
      });
    for (const [name, index] of Object.entries(definition.indexes)) {
      const object = `${table}.${name}`;
      const old = oldIndexes.get(object);
      if (!old) {
        if (oldTable && index.unique === true)
          changes.push({
            object,
            change: "adding a unique index to an existing table",
            fix: "add a non-unique index instead"
          });
        else {
          newIndexes.push({ table, name });
          provisioned.indexes.push(object);
        }
      } else if (
        old.unique !== (index.unique === true) ||
        !isDeepStrictEqual(old.columns, index.columns)
      ) {
        changes.push({
          object,
          change: "changing an existing index's columns, order or uniqueness",
          fix: "keep the index and add a new non-unique index with a different name"
        });
      }
    }
  }
  for (const table of snapshot?.tables ?? []) {
    if (Object.hasOwn(manifest.tables, table.name)) continue;
    unused.tables.push(table.name);
    warnings.push(
      `\`${table.name}\` is no longer defined; its data is kept and this version cannot reach it.`
    );
  }
  for (const column of snapshot?.columns ?? []) {
    const definition = Object.hasOwn(manifest.tables, column.table)
      ? manifest.tables[column.table]
      : undefined;
    if (!definition || Object.hasOwn(definition.columns, column.name)) continue;
    const object = `${column.table}.${column.name}`;
    if (!column.optional && column.defaultKind === null)
      changes.push({ object, change: "omitting a required column", fix: "keep the column" });
    else unused.columns.push(object);
  }
  for (const index of snapshot?.indexes ?? []) {
    const definition = Object.hasOwn(manifest.tables, index.table)
      ? manifest.tables[index.table]
      : undefined;
    if (definition && Object.hasOwn(definition.indexes, index.name)) continue;
    unused.indexes.push(`${index.table}.${index.name}`);
    if (index.unique) warnings.push(`uniqueness on \`${index.table}.${index.name}\` still applies`);
  }
  for (const store of snapshot?.stores ?? []) {
    unused.stores.push(store.name);
    warnings.push(
      `\`${store.name}\` is no longer defined; its data is kept and this version cannot reach it.`
    );
  }
  if (changes.length > 0) return yield* new NotAdditive({ changes });
  const changed = newTables.length + newColumns.length + newIndexes.length + sharing.length > 0;
  return {
    provisioned,
    unused,
    warnings,
    schemaRevision: (snapshot?.schemaRevision ?? 0) + (changed ? 1 : 0),
    newTables,
    newColumns,
    newIndexes,
    sharing
  } satisfies Plan;
});

export const make = Effect.gen(function* () {
  const inventory = yield* Inventory.Inventory;
  const provision = Effect.fn("Tables.provision")(function* (
    patchId: string,
    manifest: typeof Manifest.Type
  ) {
    const lock = yield* CompanyDatabases.PatchLock;
    if (lock.patchId !== patchId)
      return yield* Effect.die(new Error("Table provisioning requires a matching patch lock"));
    const snapshot = yield* inventory.read(patchId);
    // Never execute even the first DDL statement until the entire diff has passed.
    const plan = yield* diff(manifest, snapshot);
    if (plan.schemaRevision === (snapshot?.schemaRevision ?? 0)) return plan;
    const sql = lock.sql;
    const namespace = quote(Inventory.namespace(patchId));
    const qualified = (table: string) => `${namespace}.${quote(table)}`;
    yield* inventory.ensurePatch(patchId);
    if (plan.newTables.length > 0) {
      yield* sql.unsafe(
        `CREATE OR REPLACE FUNCTION ${namespace}."_patchy_updated_at"() RETURNS trigger LANGUAGE plpgsql AS $patchy$ BEGIN NEW."updatedAt" = statement_timestamp(); RETURN NEW; END; $patchy$`
      );
    }
    for (const table of plan.newTables) {
      const definition = manifest.tables[table]!;
      const columns = Object.entries(definition.columns).map(([name, column]) =>
        columnSql(name, column)
      );
      yield* sql.unsafe(
        `CREATE TABLE ${qualified(table)} ("id" text PRIMARY KEY, "createdAt" timestamptz NOT NULL DEFAULT statement_timestamp(), "updatedAt" timestamptz NOT NULL DEFAULT statement_timestamp()${columns.length === 0 ? "" : `, ${columns.join(", ")}`})`
      );
      yield* sql.unsafe(
        `CREATE TRIGGER "_patchy_updated_at" BEFORE UPDATE ON ${qualified(table)} FOR EACH ROW EXECUTE FUNCTION ${namespace}."_patchy_updated_at"()`
      );
      yield* sql.unsafe(
        `CREATE INDEX ${quote(indexName(table, "system", "createdAt"))} ON ${qualified(table)} ("createdAt", "id")`
      );
      yield* inventory.putTable({ patchId, name: table, shared: definition.shared === true });
    }
    const createdTables = new Set(plan.newTables);
    for (const { table, name } of plan.newColumns) {
      const column = manifest.tables[table]!.columns[name]!;
      if (!createdTables.has(table))
        yield* sql.unsafe(`ALTER TABLE ${qualified(table)} ADD COLUMN ${columnSql(name, column)}`);
      if (column.kind === "ref")
        yield* sql.unsafe(
          `CREATE INDEX ${quote(indexName(table, "ref", name))} ON ${qualified(table)} (${quote(name)}, "id")`
        );
      const kind = defaultKind(column);
      yield* inventory.putColumn({
        patchId,
        table,
        name,
        kind: column.kind,
        refTable: column.kind === "ref" ? column.table : null,
        optional: column.optional === true,
        defaultKind: kind,
        defaultValue: kind === "constant" ? column.default : null
      });
    }
    for (const { table, name } of plan.newIndexes) {
      const index = manifest.tables[table]!.indexes[name]!;
      yield* sql.unsafe(
        `CREATE ${index.unique === true ? "UNIQUE " : ""}INDEX ${quote(indexName(table, "declared", name))} ON ${qualified(table)} (${index.columns.map(quote).join(", ")})`
      );
      yield* inventory.putIndex({
        patchId,
        table,
        name,
        columns: index.columns,
        unique: index.unique === true
      });
    }
    for (const table of plan.sharing)
      yield* inventory.putTable({
        patchId,
        name: table,
        shared: manifest.tables[table]!.shared === true
      });
    const schemaRevision = yield* inventory.bumpRevision(patchId);
    return {
      provisioned: plan.provisioned,
      unused: plan.unused,
      warnings: plan.warnings,
      schemaRevision
    };
  });
  return Tables.of({ diff, provision });
});

export const layer = Layer.effect(Tables, make);
