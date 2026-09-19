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

/**
 * A built-in binary codec with its decoded value and parameter mapped through
 * `to` and `from`. The registry is deliberately left off both calls: with it,
 * lookup would land on this wrapper again and recurse.
 */
const mapCodec = <A, B>(
  oid: number,
  to: (value: A) => B,
  from: (value: B) => A
): PgTypes.Codec<B> => ({
  decode: (bytes) => Result.map(PgTypes.decode(bytes, oid, 1), (value) => to(value as A)),
  encode: (value) => PgTypes.encode(from(value), oid)
});

/**
 * The row codecs every Patchy pool shares. The native client decodes `int8`
 * to `bigint` and timestamps to epoch milliseconds; Patchy keeps `int8` as a
 * decimal string and timestamps as `Date`, so row schemas stay `Schema.Date`
 * and PGlite (see `@patchy/company-database`) answers the same shapes. A plain
 * `timestamp` is read as UTC wall time on both. Inferred parameters arrive as
 * the built-in codec's value: a `bigint` for an integer beyond `int4`, epoch
 * milliseconds for a `Date`.
 */
const rowCodecs = PgTypes.makeRegistry();
rowCodecs.register(
  PgTypes.OID.int8,
  mapCodec<bigint, string | bigint>(PgTypes.OID.int8, String, BigInt),
  { arrayOid: PgTypes.OID.int8Array }
);
for (const [oid, arrayOid] of [
  [PgTypes.OID.timestamptz, PgTypes.OID.timestamptzArray],
  [PgTypes.OID.timestamp, PgTypes.OID.timestampArray]
] as const) {
  rowCodecs.register(
    oid,
    mapCodec<number, Date | number>(
      oid,
      // The `globalDate` guardrail forbids `new Date`; this is the same instant.
      (millis) => DateTime.toDateUtc(DateTime.makeUnsafe(millis)),
      (value) => (value instanceof Date ? value.getTime() : value)
    ),
    { arrayOid }
  );
}

/**
 * `pg` read `?ssl=true|false` on a URL; the native client only reads
 * `sslmode`. Existing URLs keep meaning what they meant instead of silently
 * connecting in the clear.
 */
const legacySsl = (url: Redacted.Redacted<string>): boolean | undefined => {
  try {
    const value = new URL(Redacted.value(url)).searchParams.get("ssl");
    return value === null ? undefined : value === "true" || value === "1";
  } catch {
    return undefined;
  }
};

/**
 * A scoped connection pool on the shared row codecs. Pools keep time on the
 * wall clock: idle sweeps and connection lifetimes are infrastructure, and a
 * test that jumps its `TestClock` by years must not replay every pool tick
 * in between (which never finishes).
 */
export const pool = (config: PgClient.PgPoolConfig) =>
  PgClient.make({
    ...config,
    ssl: config.ssl ?? (config.url === undefined ? undefined : legacySsl(config.url)),
    types: rowCodecs
  }).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()));

/** The client on a URL already in hand — the migration seam and the test layer. */
export const layerFromUrl = (url: Redacted.Redacted<string>) => PgClient.layerFrom(pool({ url }));

/** The client the server runs on: `DATABASE_URL`, read as a secret. */
export const layer = Layer.unwrap(Effect.map(Config.Redacted("DATABASE_URL"), layerFromUrl));

/**
 * Runs statements in order on the ambient client; the shape of a migration
 * record. One statement per call: the client's extended protocol rejects
 * multi-statement strings.
 */
export const ddl = (...statements: ReadonlyArray<string>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true })
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
