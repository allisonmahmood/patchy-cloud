/**
 * The sql capability: a Postgres client from config, and Effect's Migrator
 * over the migration records the capability packages own. This package owns
 * no tables; see CONTEXT.md for the migration contract and README.md for how
 * a capability decodes rows.
 */
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgTypes from "@effect/sql-pg/PgTypes";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A capability's migrations: `<id>_<name>` keys over one global integer id sequence. */
export type Migrations = Parameters<typeof Migrator.fromRecord>[0];

/** The ledger Effect's Migrator keeps: `(migration_id integer, name, created_at)`. */
export const LEDGER_TABLE = "schema_migrations";

/** A built-in binary codec with its decoded value and parameter mapped through `to` and `from`. */
const mapCodec = <A, B>(
  oid: number,
  to: (value: A) => B,
  from: (value: B) => A
): PgTypes.Codec<B> => ({
  decode: (bytes) => Result.map(PgTypes.decode(bytes, oid, 1), (value) => to(value as A)),
  encode: (value) => PgTypes.encode(from(value), oid)
});

/**
 * The row codecs every Patchy client shares. The native client decodes `int8`
 * to `bigint` and timestamps to epoch milliseconds; Patchy keeps `int8` as a
 * decimal string and timestamps as `Date`, so row schemas stay `Schema.Date`
 * and PGlite (see `@patchy/company-database`) answers the same shapes.
 * Inferred parameters arrive as the built-in codec's value: a `bigint` for an
 * integer beyond `int4`, epoch milliseconds for a `Date`.
 */
export const types: PgTypes.Registry = PgTypes.makeRegistry();
types.register(
  PgTypes.OID.int8,
  mapCodec<bigint, string | bigint>(PgTypes.OID.int8, String, BigInt),
  { arrayOid: PgTypes.OID.int8Array }
);
for (const [oid, arrayOid] of [
  [PgTypes.OID.timestamptz, PgTypes.OID.timestamptzArray],
  [PgTypes.OID.timestamp, PgTypes.OID.timestampArray]
] as const) {
  types.register(
    oid,
    mapCodec<number, Date | number>(
      oid,
      (millis) => DateTime.toDateUtc(DateTime.makeUnsafe(millis)),
      (value) => (value instanceof Date ? value.getTime() : value)
    ),
    { arrayOid }
  );
}

/**
 * A scoped connection pool on the shared row codecs. Pools keep time on the
 * wall clock: idle sweeps and connection lifetimes are infrastructure, and a
 * test that jumps its `TestClock` by years must not replay every pool tick
 * in between (which never finishes).
 */
export const pool = (config: PgClient.PgPoolConfig) =>
  PgClient.make({ ...config, types }).pipe(
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())
  );

/** The client the server runs on: `DATABASE_URL`, read as a secret. */
export const layer = Layer.unwrap(Effect.map(Config.Redacted("DATABASE_URL"), layerFromUrl));

/** The same client on a URL already in hand — the migration seam and the test layer. */
export function layerFromUrl(url: Redacted.Redacted<string>) {
  return PgClient.layerFrom(pool({ url }));
}

const dollarQuote = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/;

/**
 * Splits a multi-statement script on the `;` that end statements, skipping
 * quoted strings and identifiers, dollar-quoted bodies and comments. The
 * native client speaks the extended protocol, which takes one statement per
 * query; migrations stay readable as one script and run one statement at a time.
 */
export const splitStatements = (source: string): ReadonlyArray<string> => {
  const statements: string[] = [];
  let start = 0;
  let content = false;
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    const pair = source.slice(i, i + 2);
    if (pair === "--") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (pair === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (char === "'" || char === '"') {
      const end = source.indexOf(char, i + 1);
      i = end === -1 ? source.length : end + 1;
      content = true;
    } else if (char === "$" && dollarQuote.test(source.slice(i))) {
      const tag = dollarQuote.exec(source.slice(i))![0];
      const end = source.indexOf(tag, i + tag.length);
      i = end === -1 ? source.length : end + tag.length;
      content = true;
    } else if (char === ";") {
      if (content) statements.push(source.slice(start, i).trim());
      start = i + 1;
      content = false;
      i++;
    } else {
      if (!/\s/.test(char)) content = true;
      i++;
    }
  }
  if (content) statements.push(source.slice(start).trim());
  return statements;
};

/** Runs a DDL script statement by statement on the ambient client; the shape of a migration record. */
export const ddl = (source: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(splitStatements(source), (statement) => sql.unsafe(statement), {
      discard: true
    })
  );

/**
 * Applies every pending migration in one transaction under an `ACCESS
 * EXCLUSIVE` lock on the ledger, and answers with what it applied. Callers
 * spread the capability records into one: `migrate({ ...auth, ...patches })`.
 * Ids are sorted numerically and a duplicate fails with `MigrationError`
 * (`kind: "Duplicates"`) before anything runs.
 */
export const migrate = (migrations: Migrations) =>
  Migrator.make({})({ loader: Migrator.fromRecord(migrations), table: LEDGER_TABLE });
