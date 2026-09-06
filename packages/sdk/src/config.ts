/**
 * PROTOTYPE (#176). The code-first config a patch repo holds in
 * `patchy.config.ts`: the tier, the tables and file stores the patch
 * **defines** (owns), and the connections and shared tables it **declares**
 * (uses). The CLI executes this file locally and calls `toManifest` on the
 * result; the server only ever sees the manifest and never runs the config.
 *
 * Types are inferred from the config value itself, Convex-style: the client
 * is typed from `typeof config`, so no generation step is needed for what a
 * patch owns. The generated directory is for what comes from the server.
 */

// --- column types ----------------------------------------------------------

/** The Postgres-backed column types the SDK offers. Deliberately few. */
export type ColumnKind = "text" | "integer" | "boolean" | "timestamp" | "json";

export interface ColumnSpec<Kind extends ColumnKind, Optional extends boolean> {
  readonly kind: Kind;
  readonly optional: Optional;
  /** `now` fills a timestamp on insert; a literal is the SQL default. */
  readonly default?: "now" | string | number | boolean;
}

type ValueOf<Kind extends ColumnKind> = Kind extends "text"
  ? string
  : Kind extends "integer"
    ? number
    : Kind extends "boolean"
      ? boolean
      : Kind extends "timestamp"
        ? string
        : unknown;

class Column<Kind extends ColumnKind, Optional extends boolean> {
  constructor(readonly spec: ColumnSpec<Kind, Optional>) {}
  /** The column may be null; an insert may leave it out. */
  optional(): Column<Kind, true> {
    return new Column({ ...this.spec, optional: true });
  }
  /** A default the database fills when an insert leaves the column out. */
  default(value: Kind extends "timestamp" ? "now" : ValueOf<Kind>): Column<Kind, true> {
    return new Column({
      ...this.spec,
      optional: true,
      default: value as ColumnSpec<Kind, true>["default"]
    });
  }
}

const column = <Kind extends ColumnKind>(kind: Kind) =>
  new Column<Kind, false>({ kind, optional: false });

/** Column builders: `t.text()`, `t.integer().optional()`, `t.timestamp().default("now")`. */
export const t = {
  text: () => column("text"),
  integer: () => column("integer"),
  boolean: () => column("boolean"),
  timestamp: () => column("timestamp"),
  json: () => column("json")
};

// --- tables and files ------------------------------------------------------

export type Columns = Record<string, Column<ColumnKind, boolean>>;

export interface TableDefinition<C extends Columns> {
  readonly columns: C;
  /** Let other patches in the company read this table (read-only for them). */
  readonly shared: boolean;
}

/** A table the patch owns. Every table also gets an `id` the cloud fills. */
export const table = <C extends Columns>(
  columns: C,
  options?: { readonly shared?: boolean }
): TableDefinition<C> => ({ columns, shared: options?.shared ?? false });

export interface FilesDefinition {
  readonly kind: "files";
}

/** A file store the patch owns: named files, bytes in, bytes out. */
export const files = (): FilesDefinition => ({ kind: "files" });

// --- the config ------------------------------------------------------------

export type Tier = 0 | 1;

export interface PatchConfig<
  Tables extends Record<string, TableDefinition<Columns>>,
  Files extends Record<string, FilesDefinition>
> {
  readonly tier: Tier;
  readonly tables: Tables;
  readonly files: Files;
}

/** The identity function that pins the config's types; `patchy.config.ts` default-exports its result. */
export const defineConfig = <
  const Tables extends Record<string, TableDefinition<Columns>>,
  const Files extends Record<string, FilesDefinition>
>(
  config: PatchConfig<Tables, Files>
) => config;

export type AnyConfig = PatchConfig<
  Record<string, TableDefinition<Columns>>,
  Record<string, FilesDefinition>
>;

// --- the row types the client derives ---------------------------------------

type RequiredKeys<C extends Columns> = {
  [K in keyof C]: C[K] extends Column<ColumnKind, true> ? never : K;
}[keyof C];
type OptionalKeys<C extends Columns> = Exclude<keyof C, RequiredKeys<C>>;
type ColumnValue<Col> = Col extends Column<infer Kind, boolean> ? ValueOf<Kind> : never;

/** What an insert takes: required columns present, optional ones may be left out. */
export type InsertOf<C extends Columns> = { [K in RequiredKeys<C>]: ColumnValue<C[K]> } & {
  [K in OptionalKeys<C>]?: ColumnValue<C[K]> | null;
};

/** What a read returns: every column, optional ones nullable, plus the cloud's `id`. */
export type RowOf<C extends Columns> = { readonly id: string } & {
  readonly [K in keyof C]: C[K] extends Column<ColumnKind, true>
    ? ColumnValue<C[K]> | null
    : ColumnValue<C[K]>;
};

// --- the manifest ----------------------------------------------------------

/**
 * The serialisable shape of a config, the only thing that crosses the wire.
 * Mirrors `Manifest` in `@patchy/api`, which validates it on the server.
 */
export interface Manifest {
  readonly manifestVersion: 1;
  readonly tier: Tier;
  readonly tables: Record<
    string,
    {
      readonly shared: boolean;
      readonly columns: Record<
        string,
        { readonly kind: ColumnKind; readonly optional: boolean; readonly default?: unknown }
      >;
    }
  >;
  readonly files: Record<string, Record<never, never>>;
}

// Quoted everywhere, so camelCase survives into Postgres as written.
const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;

/** Executes nothing; walks the config value and checks the names the database will see. */
export const toManifest = (config: AnyConfig): Manifest => {
  const tables: Manifest["tables"] = {};
  for (const [name, definition] of Object.entries(config.tables)) {
    if (!NAME.test(name)) throw new Error(`Table name ${JSON.stringify(name)} must match ${NAME}.`);
    if (name === "id") throw new Error("A table cannot be named id.");
    const columns: Manifest["tables"][string]["columns"] = {};
    for (const [columnName, col] of Object.entries(definition.columns)) {
      if (!NAME.test(columnName) || columnName === "id") {
        throw new Error(`Column ${name}.${columnName} must match ${NAME} and cannot be id.`);
      }
      columns[columnName] = {
        kind: col.spec.kind,
        optional: col.spec.optional,
        ...(col.spec.default !== undefined ? { default: col.spec.default } : {})
      };
    }
    tables[name] = { shared: definition.shared, columns };
  }
  const filesOut: Manifest["files"] = {};
  for (const name of Object.keys(config.files)) {
    if (!NAME.test(name))
      throw new Error(`File store name ${JSON.stringify(name)} must match ${NAME}.`);
    filesOut[name] = {};
  }
  return { manifestVersion: 1, tier: config.tier, tables, files: filesOut };
};
