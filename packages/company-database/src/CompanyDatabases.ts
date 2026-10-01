import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as ResourceChanges from "./ResourceChanges.js";

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
  scope: Schema.Literals(["company", "host"]),
  limitId: Schema.String,
  value: Schema.Number,
  retryAfterSeconds: Schema.Number
}) {
  override get message() {
    return `Company database ${this.resource} capacity (${this.value}) is exhausted. Try again shortly.`;
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
      "upgrade",
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
    readonly resources: Set<string>;
  }
>()("@patchy/company-database/CompanyDatabases/PatchLock") {}

/** One reserved session. The caller closes its scope only after SQL has settled. */
export interface Lease {
  readonly sql: SqlClient.SqlClient;
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, Exclude<R, CompanyConnection | SqlClient.SqlClient>>;
  /** Fresh production authority; local fixtures are fixed for the dev process. */
  readonly authority: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<
    A,
    E | CompanyDatabaseError | CompanyDatabaseNotReady | CompanyIdentityMismatch | Busy,
    Exclude<R, CompanyConnection | SqlClient.SqlClient>
  >;
  readonly destroy: () => void;
}

export class FileLock extends Context.Service<
  FileLock,
  {
    readonly patchId: string;
    readonly store: string;
    readonly name: string;
    readonly sql: SqlClient.SqlClient;
  }
>()("@patchy/company-database/CompanyDatabases/FileLock") {}

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
    /** Shared queries leave one configured slot free for live inventory authority. */
    readonly lease: (
      companyId: string,
      reserveAuthority: boolean
    ) => Effect.Effect<
      Lease,
      CompanyDatabaseError | CompanyDatabaseNotReady | CompanyIdentityMismatch | Busy,
      Scope.Scope
    >;
    readonly withPatchLock: (
      patchId: string
    ) => <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<
      A,
      E | SqlError,
      | Exclude<Exclude<R, PatchLock | SqlClient.SqlClient>, ResourceChanges.ResourceChanges>
      | CompanyConnection
    >;
    readonly withFileLock: typeof withFileLock;
    readonly listReady: Effect.Effect<
      ReadonlyArray<Placement>,
      CompanyDatabaseError | CompanyIdentityMismatch
    >;
  }
>()("@patchy/company-database/CompanyDatabases") {}

const encoder = new TextEncoder();

/** Stable signed 64-bit FNV-1a, independent of process seeds and database collation. */
const advisoryLockKey = (key: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(key)) {
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
    | Exclude<R, PatchLock | SqlClient.SqlClient>
    | CompanyConnection
    | ResourceChanges.ResourceChanges
  > =>
    Effect.gen(function* () {
      const sql = yield* CompanyConnection;
      const outer = yield* Effect.serviceOption(PatchLock);
      const resources = new Set<string>();
      const result = yield* sql.withTransaction(
        sql`SELECT pg_advisory_xact_lock(${advisoryLockKey(patchId)}::bigint)`.pipe(
          Effect.andThen(effect),
          Effect.provideContext(
            Context.make(PatchLock, { patchId, sql, resources }).pipe(
              Context.add(SqlClient.SqlClient, sql)
            )
          )
        )
      );
      if (Option.isSome(outer) && outer.value.sql === sql) {
        for (const key of resources) outer.value.resources.add(key);
      } else if (resources.size > 0) {
        const changes = yield* ResourceChanges.ResourceChanges;
        yield* changes.publish([...resources]);
      }
      return result;
    });

/** Serialize one file-index entry; blob I/O and platform state stay outside this transaction. */
export const withFileLock =
  (patchId: string, store: string, name: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<
    A,
    E | SqlError,
    Exclude<R, FileLock | SqlClient.SqlClient> | CompanyConnection
  > =>
    Effect.flatMap(CompanyConnection, (sql) =>
      sql.withTransaction(
        sql`SELECT pg_advisory_xact_lock(${advisoryLockKey(JSON.stringify(["file", patchId, store, name]))}::bigint)`.pipe(
          Effect.andThen(effect),
          Effect.provideContext(
            Context.make(FileLock, { patchId, store, name, sql }).pipe(
              Context.add(SqlClient.SqlClient, sql)
            )
          )
        )
      )
    );
