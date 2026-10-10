/**
 * The sql capability: a Postgres client from config, Effect's Migrator over
 * the migration records the capability packages own, and a transaction that
 * reports its change with its commit. This package owns
 * no tables; see GLOSSARY.md for the migration contract and README.md for how
 * a capability decodes rows.
 */
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgTypes from "@effect/sql-pg/PgTypes";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

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
 * Runs `change` as the outermost transaction and `report` with its commit. Only
 * the change is cancellable, lock waits included: an interrupt that arrives
 * during COMMIT waits for the committed change to report, and a rolled-back or
 * cancelled change reports nothing. Inside a caller's transaction there is no
 * commit to wait for, so it reports nothing rather than report a rollback.
 */
export const withReportedCommit = <A, E, R, R2>(
  change: Effect.Effect<A, E, R>,
  report: (value: A) => Effect.Effect<void, never, R2>
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outer = yield* Effect.serviceOption(sql.transactionService);
    return yield* Effect.uninterruptibleMask((restore) =>
      sql
        .withTransaction(restore(change))
        .pipe(Effect.tap((value) => (Option.isSome(outer) ? Effect.void : report(value))))
    );
  });

/**
 * Runs statements in order on the ambient client; the shape of a migration
 * record. One statement per call: the client's extended protocol rejects
 * multi-statement strings.
 */
export const ddl = (...statements: ReadonlyArray<string>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true })
  );

/** A ledger row as the Migrator writes it. */
class LedgerRow extends Schema.Class<LedgerRow>("LedgerRow")({
  id: Schema.Int,
  name: Schema.String
}) {}

const ledgerRows = SqlSchema.findAll({
  Request: Schema.Void,
  Result: LedgerRow,
  execute: () =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`SELECT migration_id AS id, name FROM ${sql(LEDGER_TABLE)}`
    )
});

/**
 * The record as the Migrator's loader, refusing a ledger whose history it does
 * not share. The Migrator only runs ids above the ledger's highest, so a step
 * the ledger lacks below that mark, or holds under another name, would be
 * skipped silently: a database migrated before the pre-launch squash, or by a
 * branch's own steps. Up to the lower of the two highest ids, both must list
 * the same steps. Ids above the record's highest are a newer build's steps and
 * pass, so an earlier build can still start. The Migrator runs its loader in
 * its transaction, after it locks the ledger.
 */
const checkedLoader = Effect.fn("Sql.checkedLoader")(function* (migrations: Migrations) {
  const record = yield* Migrator.fromRecord(migrations);
  const ledger = yield* ledgerRows(undefined).pipe(
    Effect.mapError(
      (cause) =>
        new Migrator.MigrationError({
          kind: "BadState",
          cause,
          message: `Could not read the migration ledger ${LEDGER_TABLE}`
        })
    )
  );
  const recorded = new Map(record.map(([id, name]) => [id, name]));
  // The Migrator refuses a duplicate id itself, before anything runs.
  if (recorded.size !== record.length) return record;
  const applied = new Map(ledger.map((row) => [row.id, row.name]));
  const shared = Math.min(Math.max(0, ...recorded.keys()), Math.max(0, ...applied.keys()));
  const diverged = [...recorded.keys(), ...applied.keys()]
    .filter((id) => id <= shared && recorded.get(id) !== applied.get(id))
    .sort((a, b) => a - b)[0];
  if (diverged === undefined) return record;
  const name = (value: string | undefined) => (value === undefined ? "nothing" : `"${value}"`);
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message:
      `The migration ledger disagrees with this build at id ${diverged}: the ledger has ` +
      `${name(applied.get(diverged))}, this build has ${name(recorded.get(diverged))}. ` +
      "Nothing was applied: the database was migrated by another history, such as one " +
      "from before the platform baselines were squashed for launch. A local dev instance " +
      "recovers with `pnpm dev reset`, which wipes its data."
  });
});

/**
 * Applies every pending migration in one transaction under an `ACCESS
 * EXCLUSIVE` lock on the ledger, and answers with what it applied. Callers
 * spread the capability records into one: `migrate({ ...auth, ...patches })`.
 * Ids are sorted numerically and a duplicate fails with `MigrationError`
 * (`kind: "Duplicates"`) before anything runs; a ledger with another history
 * fails with `kind: "BadState"` (see `checkedLoader`).
 */
export const migrate = (migrations: Migrations) =>
  Migrator.make({})({ loader: checkedLoader(migrations), table: LEDGER_TABLE });
