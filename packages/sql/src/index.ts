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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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
 * to `bigint`; Patchy keeps it as a decimal string, the shape PGlite (see
 * `@patchy/company-database`) answers too. Timestamps need no override: the
 * native client already decodes them to `Date`, a plain `timestamp` as UTC
 * wall time, so row schemas stay `Schema.Date`. An inferred parameter for an
 * integer beyond `int4` arrives as the built-in codec's `bigint`.
 */
const rowCodecs = PgTypes.makeRegistry();
rowCodecs.register(
  PgTypes.OID.int8,
  mapCodec<bigint, string | bigint>(PgTypes.OID.int8, String, BigInt),
  { arrayOid: PgTypes.OID.int8Array }
);

/** The URL parameters the native client reads; `pg` also read `ssl`, `statement_timeout` and more. */
const URL_PARAMETERS = new Set([
  "host",
  "port",
  "user",
  "password",
  "dbname",
  "application_name",
  "connect_timeout",
  "sslmode"
]);

/**
 * A Postgres URL carries a parameter the client does not read. Failing at
 * startup beats connecting without TLS or a timeout the URL asked for.
 */
export class UnsupportedUrlParameters extends Schema.TaggedError<UnsupportedUrlParameters>()(
  "UnsupportedUrlParameters",
  { parameters: Schema.Array(Schema.String) }
) {
  override get message() {
    return `Postgres URL parameters the client does not read: ${this.parameters.join(", ")}. It reads ${[...URL_PARAMETERS].join(", ")}; ask for TLS with sslmode=require or sslmode=verify-full.`;
  }
}

/**
 * The parameters on a URL that `pool` would refuse; config validation checks
 * the same list up front. Names are reported as printable ASCII, at most 64
 * characters and 8 of them, so a hostile URL cannot shape the diagnostic.
 */
export const unsupportedUrlParameters = (url: Redacted.Redacted<string>): ReadonlyArray<string> => {
  try {
    return [...new URL(Redacted.value(url)).searchParams.keys()]
      .filter((key) => !URL_PARAMETERS.has(key))
      .slice(0, 8)
      .map((key) => key.replace(/[^\x21-\x7e]/g, "?").slice(0, 64));
  } catch {
    return [];
  }
};

/**
 * A scoped connection pool on the shared row codecs. Pools keep time on the
 * wall clock: idle sweeps and connection lifetimes are infrastructure, and a
 * test that jumps its `TestClock` by years must not replay every pool tick
 * in between (which never finishes).
 */
export const pool = Effect.fn("Sql.pool")(function* (config: PgClient.PgPoolConfig) {
  const unsupported = config.url === undefined ? [] : unsupportedUrlParameters(config.url);
  if (unsupported.length > 0)
    return yield* new UnsupportedUrlParameters({ parameters: unsupported });
  return yield* PgClient.make({ ...config, types: rowCodecs }).pipe(
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())
  );
});

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
