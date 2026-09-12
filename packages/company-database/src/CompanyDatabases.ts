import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export class Placement extends Schema.Class<Placement>("Placement")({
  companyId: Schema.String,
  serverId: Schema.String,
  databaseName: Schema.String,
  placementVersion: Schema.Int,
  status: Schema.Literals(["claimed", "ready"]),
  createdAt: Schema.Date,
  readyAt: Schema.NullOr(Schema.Date)
}) {}

export class Busy extends Schema.TaggedError<Busy>()("Busy", {
  resource: Schema.String,
  limit: Schema.Int
}) {
  override get message() {
    return `Company database ${this.resource} capacity (${this.limit}) is exhausted. Try again shortly.`;
  }
}

export class CompanyDatabaseNotReady extends Schema.TaggedError<CompanyDatabaseNotReady>()(
  "CompanyDatabaseNotReady",
  {
    companyId: Schema.String,
    status: Schema.NullOr(Schema.Literal("claimed"))
  }
) {
  override get message() {
    return "Company database is not ready.";
  }
}

export class CompanyIdentityMismatch extends Schema.TaggedError<CompanyIdentityMismatch>()(
  "CompanyIdentityMismatch",
  { expectedCompanyId: Schema.String, actualCompanyId: Schema.String }
) {
  override get message() {
    return "This local database belongs to a different company. Use a separate development directory.";
  }
}

export class CompanyDatabaseError extends Schema.TaggedError<CompanyDatabaseError>()(
  "CompanyDatabaseError",
  {
    companyId: Schema.optional(Schema.String),
    operation: Schema.Literals([
      "claim",
      "create",
      "configure",
      "initialize",
      "ready",
      "connect",
      "list"
    ]),
    cause: Schema.Defect()
  }
) {
  override get message() {
    return `Company database ${this.operation} failed.`;
  }
}

export class CompanyConnection extends Context.Service<CompanyConnection, SqlClient.SqlClient>()(
  "@patchy/company-database/CompanyDatabases/CompanyConnection"
) {}

export class PatchLock extends Context.Service<
  PatchLock,
  {
    readonly patchId: string;
    readonly sql: SqlClient.SqlClient;
  }
>()("@patchy/company-database/CompanyDatabases/PatchLock") {}

export class CompanyDatabases extends Context.Service<
  CompanyDatabases,
  {
    readonly claim: (
      companyId: string
    ) => Effect.Effect<Placement, CompanyDatabaseError | CompanyIdentityMismatch | Busy>;
    readonly ensureReady: (
      companyId: string
    ) => Effect.Effect<Placement, CompanyDatabaseError | CompanyIdentityMismatch | Busy>;
    readonly withCompany: (
      companyId: string
    ) => <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<
      A,
      E | CompanyDatabaseError | CompanyDatabaseNotReady | CompanyIdentityMismatch | Busy,
      Exclude<R, CompanyConnection | SqlClient.SqlClient>
    >;
    readonly withPatchLock: typeof withPatchLock;
    readonly listReady: Effect.Effect<
      ReadonlyArray<Placement>,
      CompanyDatabaseError | CompanyIdentityMismatch
    >;
  }
>()("@patchy/company-database/CompanyDatabases") {}

const encoder = new TextEncoder();

/** Stable signed 64-bit FNV-1a, independent of process seeds and database collation. */
const patchLockKey = (patchId: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(patchId)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return BigInt.asIntN(64, hash).toString();
};

/** The caller holds the platform patch-row lock before entering this transaction. */
export const withPatchLock =
  (patchId: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<
    A,
    E | SqlError,
    Exclude<R, PatchLock | SqlClient.SqlClient> | CompanyConnection
  > =>
    Effect.flatMap(CompanyConnection, (sql) =>
      sql.withTransaction(
        sql`SELECT pg_advisory_xact_lock(${patchLockKey(patchId)}::bigint)`.pipe(
          Effect.andThen(effect),
          Effect.provideContext(
            Context.make(PatchLock, { patchId, sql }).pipe(Context.add(SqlClient.SqlClient, sql))
          )
        )
      )
    );
