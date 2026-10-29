import * as PgClient from "@effect/sql-pg/PgClient";
import type * as PgConnection from "@effect/sql-pg/PgConnection";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Cryptography } from "@patchy/core";
import * as WideEvents from "@patchy/analytics/wide-events";
import { OperatingLimits } from "@patchy/limits";
import * as Sql from "@patchy/sql";
import { registry } from "@patchy/limits/registry";
import * as CompanyDatabases from "./CompanyDatabases.js";
import * as ConnectionTiming from "./ConnectionTiming.js";
import * as Inventory from "./Inventory.js";
import * as ResourceChanges from "./ResourceChanges.js";

const COMPANY_CONNECTIONS = registry["company.connections"].default;

export class CompanyDatabaseConfig extends Context.Service<
  CompanyDatabaseConfig,
  {
    readonly adminUrl: Redacted.Redacted<string>;
    readonly dataUrl: Redacted.Redacted<string>;
    readonly maxBackends: number;
    readonly capacity: number;
  }
>()("@patchy/company-database/PgCompanyDatabases/CompanyDatabaseConfig") {}

/** Separate from the platform and company clients; never inherits their transaction. */
export class AdminClient extends Context.Service<AdminClient, SqlClient.SqlClient>()(
  "@patchy/company-database/PgCompanyDatabases/AdminClient"
) {}

/** Placement and operating-limit reads never borrow a caller's platform connection. */
export class PlacementClient extends Context.Service<PlacementClient, SqlClient.SqlClient>()(
  "@patchy/company-database/PgCompanyDatabases/PlacementClient"
) {}

// The client uses the last `user` query value when nonempty, otherwise the authority.
const username = (url: URL): string =>
  url.searchParams.getAll("user").at(-1) || decodeURIComponent(url.username);

const DatabaseUrl = Schema.Redacted(Schema.String).check(
  Schema.makeFilter((secret) => {
    try {
      const url = new URL(Redacted.value(secret));
      decodeURIComponent(url.password);
      decodeURI(url.pathname);
      return (
        (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
        Sql.unsupportedUrlParameters(secret).length === 0 &&
        username(url).length > 0 &&
        url.hash === "" &&
        (url.hostname !== "" || Boolean(url.searchParams.getAll("host").at(-1)))
      );
    } catch {
      return false;
    }
  })
);

export const config = Config.all({
  adminUrl: Config.schema(DatabaseUrl, "PATCHY_COMPANY_DB_ADMIN_URL"),
  dataUrl: Config.schema(DatabaseUrl, "PATCHY_COMPANY_DB_URL"),
  maxBackends: Config.schema(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(COMPANY_CONNECTIONS)),
    "PATCHY_COMPANY_DB_MAX_BACKENDS"
  ).pipe(Config.withDefault(registry["company.connections.hostBackends"].default)),
  capacity: Config.succeed(registry["company.connections.pools"].default)
});

const duplicateDatabase = Schema.is(Schema.Struct({ code: Schema.Literal("42P04") }));

interface PoolTarget {
  readonly placement: CompanyDatabases.Placement;
  readonly connections: OperatingLimits.EffectiveLimit;
}

/** One company connection: a one-connection pool holding one host backend while open. */
interface Slot {
  readonly scope: Scope.Closeable;
  readonly context: Context.Context<SqlClient.SqlClient | CompanyDatabases.CompanyConnection>;
  readonly reserve: ConnectionTiming.Client["reserve"];
  /** Set by whichever path starts closing it, so no other path closes it again. */
  closing: boolean;
  /** Settles once its connection has closed and its host backend is free. */
  readonly closed: Deferred.Deferred<void>;
  /**
   * For another company evicting this idle slot: takes it from its company's
   * idle slots at once and returns its close. Its company counts it until the
   * close completes, so it never overlaps the connection that replaces it.
   */
  readonly retire: () => Effect.Effect<void>;
}

const samePool = (left: PoolTarget, right: PoolTarget) =>
  left.placement.serverId === right.placement.serverId &&
  left.placement.databaseName === right.placement.databaseName &&
  left.placement.placementVersion === right.placement.placementVersion &&
  left.connections.value === right.connections.value;

/**
 * A scoped pool on the shared row codecs: `int8` as a string, timestamps as
 * `Date`, the shapes PGlite answers too. The placement's `database` outranks
 * whatever database the URL names, in its path or a `dbname` parameter, and
 * the login is the validated one (last nonempty `user`, else the authority).
 */
const pool = (url: Redacted.Redacted<string>, max: number, database?: string) =>
  Sql.pool({
    url,
    username: username(new URL(Redacted.value(url))),
    database,
    maxConnections: max,
    minConnections: 0,
    idleTimeout: "60 seconds",
    connectTimeout: "5 seconds"
  }).pipe(
    // `DatabaseUrl` refused unsupported parameters at startup; here it is a bug.
    Effect.catchTags({ UnsupportedUrlParameters: Effect.die })
  );

export const adminLayer = Layer.effect(
  AdminClient,
  Effect.gen(function* () {
    const settings = yield* CompanyDatabaseConfig;
    return yield* pool(settings.adminUrl, 1);
  })
).pipe(Layer.provide(Reactivity.layer));

const placementClientLayer = Layer.effect(
  PlacementClient,
  Effect.gen(function* () {
    const platformPool = yield* PgClient.PgClient;
    // Callers hold platform patch-row transactions. Placement work must never
    // borrow from that pool: saturated callers would each wait for a second slot.
    // Clone credentials/options, not connections, and keep claims independently committed.
    return yield* Sql.pool({
      ...platformPool.config,
      maxConnections: 2,
      minConnections: 0,
      idleTimeout: "60 seconds",
      connectTimeout: "5 seconds"
    });
  })
).pipe(Layer.provide(Reactivity.layer));

/**
 * Placement queries and operating limits share one dedicated pool. The limits
 * instance is separate from the application's platform-backed layer.
 */
export const placementLayer = Layer.fresh(OperatingLimits.layer).pipe(
  Layer.provide(Layer.effect(SqlClient.SqlClient, PlacementClient)),
  Layer.provideMerge(placementClientLayer)
);

export const make = Effect.gen(function* () {
  const cryptography = yield* Cryptography.Cryptography;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* ResourceChanges.ResourceChanges;
  const platform = yield* PlacementClient;
  const limits = yield* OperatingLimits.OperatingLimits;
  const admin = yield* AdminClient;
  const settings = yield* CompanyDatabaseConfig;
  const reactivity = yield* Reactivity.Reactivity;
  const columns = platform`company_id AS "companyId", server_id AS "serverId",
    database_name AS "databaseName", placement_version AS "placementVersion", status,
    created_at AS "createdAt", ready_at AS "readyAt"`;
  const placements = SqlSchema.findAll({
    Request: Schema.String,
    Result: CompanyDatabases.Placement,
    execute: (companyId) =>
      platform`SELECT ${columns} FROM company_databases WHERE company_id = ${companyId}`
  });
  const lockedPlacement = SqlSchema.findAll({
    Request: Schema.String,
    Result: CompanyDatabases.Placement,
    execute: (companyId) =>
      platform`SELECT ${columns} FROM company_databases WHERE company_id = ${companyId} FOR UPDATE`
  });
  const readyPlacements = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CompanyDatabases.Placement,
    execute: () => platform`SELECT ${columns} FROM company_databases WHERE status = 'ready'`
  });
  const dieOnSchemaError = { SchemaError: Effect.die } as const;
  const timedPool = (database: string, maximum: number) =>
    pool(settings.dataUrl, maximum, database).pipe(
      Effect.flatMap((sql) =>
        ConnectionTiming.make(PgClient.makeCompiler()).pipe(
          Effect.provideService(SqlClient.SqlClient, sql)
        )
      )
    );

  const claim = Effect.fn("CompanyDatabases.claim")(
    function* (companyId: string) {
      const existing = yield* placements(companyId).pipe(Effect.catchTags(dieOnSchemaError));
      if (existing[0]) return existing[0];
      yield* platform`INSERT INTO company_databases (company_id, database_name)
        VALUES (${companyId}, ${yield* cryptography.internalId("patchy_company")}) ON CONFLICT (company_id) DO NOTHING`;
      const rows = yield* placements(companyId).pipe(Effect.catchTags(dieOnSchemaError));
      return rows[0]!;
    },
    (effect, companyId) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "claim", cause })
        )
      )
  );

  const ensureReady = Effect.fn("CompanyDatabases.ensureReady")(function* (companyId: string) {
    const placement = yield* claim(companyId);
    if (placement.status === "ready") return placement;
    return yield* platform
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* lockedPlacement(companyId).pipe(Effect.catchTags(dieOnSchemaError));
          const claimed = rows[0]!;
          if (claimed.status === "ready") return claimed;
          const name = Inventory.quoteIdentifier(claimed.databaseName);
          const roleUrl = new URL(Redacted.value(settings.dataUrl));
          const dataRole = Inventory.quoteIdentifier(username(roleUrl));
          // The committed claim is the authority. Only this exact claimed name can resume a duplicate CREATE.
          // Keep the row lock until CREATE settles; cancellation must not race a still-running CREATE.
          // Neon can run extension workers in template1; template0 needs no source sessions drained.
          yield* admin.unsafe(`CREATE DATABASE ${name} OWNER ${dataRole} TEMPLATE template0`).pipe(
            Effect.catchIf(
              (error) => duplicateDatabase(error.reason.cause),
              () => Effect.void
            ),
            Effect.mapError(
              (cause) =>
                new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "create", cause })
            ),
            Effect.uninterruptible
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { sql: data } = yield* timedPool(claimed.databaseName, 1);
              yield* Effect.gen(function* () {
                yield* data.unsafe(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
                yield* data.unsafe(`GRANT CONNECT, TEMPORARY ON DATABASE ${name} TO ${dataRole}`);
                yield* data.unsafe(`ALTER DATABASE ${name} SET timezone TO 'UTC'`);
                yield* data.unsafe(`ALTER DATABASE ${name} SET statement_timeout TO '30s'`);
                yield* data.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new CompanyDatabases.CompanyDatabaseError({
                      companyId,
                      operation: "configure",
                      cause
                    })
                )
              );
              yield* Inventory.initialize.pipe(
                Effect.provideService(SqlClient.SqlClient, data),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.mapError(
                  (cause) =>
                    new CompanyDatabases.CompanyDatabaseError({
                      companyId,
                      operation: "initialize",
                      cause
                    })
                )
              );
            })
          ).pipe(
            Effect.provideService(Reactivity.Reactivity, reactivity),
            Effect.catchTags({
              SqlError: (cause) =>
                Effect.fail(
                  new CompanyDatabases.CompanyDatabaseError({
                    companyId,
                    operation: "connect",
                    cause
                  })
                )
            })
          );
          return yield* Effect.gen(function* () {
            yield* platform`UPDATE company_databases SET status = 'ready', ready_at = now() WHERE company_id = ${companyId}`;
            const ready = yield* placements(companyId).pipe(Effect.catchTags(dieOnSchemaError));
            return ready[0]!;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "ready", cause })
            )
          );
        })
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "claim", cause })
            )
        })
      );
  });

  // Every open company slot holds one of the host's backends, working or idle.
  // Idle slots wait here, longest idle first, so a company that finds the host
  // full can close another company's idle connection and open its own.
  let openBackends = 0;
  const idleSlots = new Map<Scope.Closeable, Slot>();
  let backendFreed = yield* Deferred.make<void>();
  const notifyHost = Effect.sync(() => {
    const previous = backendFreed;
    backendFreed = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
  });

  // A slot's lifecycle. It is counted in `openBackends` from the moment a
  // company decides to open it until its last finalizer runs.
  //   opening: counted, its admission already in `active`, in no idle list.
  //     Its scope is a child of its company's, so teardown reaches it while it
  //     is built; forked after its company closed, it closes at once and the
  //     admission is refused without a connection.
  //   idle: in its company's `idle` and in `idleSlots`. Its company takes it
  //     back first; another company finding the host full may evict it.
  //   leased: held by one admission, in no idle list, never evicted. If its
  //     connection dies, the driver retires it: an ordinary admission's next
  //     statement outside a transaction opens a new one, but a retained lease
  //     pins its connection, so its later statements fail too and only a later
  //     admission reconnects. Nothing reconnects or replays inside a retained
  //     transaction.
  //   closing: out of `idleSlots`, so no other company evicts it. An eviction's
  //     or drain's close also takes it out of its company's `idle`; an eviction
  //     still counts against its company (`retiring`) and a drain holds it
  //     (`draining`) until the close completes. Company or service teardown
  //     leaves it in the closed company's `idle`, so a request that already
  //     held that registry entry can take it and run SQL until the pool shuts,
  //     then fails or is interrupted. Anyone else who asks to close it waits
  //     on `closed`.
  //   closed: its pool has shut its connection, and its backend is free. A
  //     discarded company entry may still reference it; it holds no connection.
  // closeSlot is the one close: whichever path asks first starts it, marking
  // the slot closing and taking it out of the eviction candidates before
  // yielding. Every caller then waits on `closed`. Company teardown closes the
  // slot's scope directly, as its parent; the slot's first finalizer marks it
  // closing, and an eviction that chose it just before then also waits on
  // `closed`, never on a second Scope.close, which would return at once.
  const closeSlot = (slot: Slot) => {
    const close = slot.closing ? Effect.void : Scope.close(slot.scope, Exit.void);
    slot.closing = true;
    idleSlots.delete(slot.scope);
    return close.pipe(Effect.andThen(Deferred.await(slot.closed)));
  };

  // The caller has already counted this slot's backend; closing the slot returns it.
  const openSlot = Effect.fnUntraced(function* (
    companyId: string,
    owner: Scope.Scope,
    target: PoolTarget,
    retire: (slot: Slot) => Effect.Effect<void>
  ) {
    // A child of the company's scope, so its teardown reaches a slot still
    // opening. Forked from a closed company, it is closed already, and every
    // finalizer below runs as soon as it is added.
    const scope = yield* Scope.fork(owner);
    const closed = yield* Deferred.make<void>();
    // Registered first, so it runs after the pool has closed its connection.
    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() => {
        idleSlots.delete(scope);
        openBackends--;
        Deferred.doneUnsafe(closed, Effect.void);
        return notifyHost;
      })
    );
    const timed = yield* timedPool(target.placement.databaseName, 1).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
      Effect.mapError(
        (cause) =>
          new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "connect", cause })
      )
    );
    const slot: Slot = {
      scope,
      reserve: timed.reserve,
      context: Context.make(SqlClient.SqlClient, timed.sql).pipe(
        Context.add(CompanyDatabases.CompanyConnection, timed.sql)
      ),
      closing: false,
      closed,
      retire: () => retire(slot)
    };
    // Registered last, so it runs first: a closing slot leaves the candidates.
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        slot.closing = true;
        idleSlots.delete(scope);
      })
    );
    // Its company closed while it was opening: no connection was opened, and
    // its backend is already returned.
    if (slot.closing) {
      return yield* new CompanyDatabases.CompanyDatabaseError({
        companyId,
        operation: "connect",
        cause: new Error("The company pool closed while a connection was opening.")
      });
    }
    return slot;
  });

  // One registry entry per company. Each admission holds one slot, so a
  // company's backends are its admissions, its idle slots and any slots
  // another company is still closing. A changed
  // maximum or placement drains and closes the previous slots before opening
  // another, never retaining overlapping generations.
  const pools = yield* RcMap.make({
    capacity: settings.capacity,
    idleTimeToLive: "60 seconds",
    lookup: Effect.fn("CompanyDatabases.companyPool")(function* (companyId: string) {
      const owner = yield* Effect.scope;
      // Slots belong to `pool`; a newer `target` replaces it once they drain.
      let pool: PoolTarget | undefined;
      let target: PoolTarget | undefined;
      // Most recently released last, so surplus slots age out and are evicted first.
      const idle: Array<Slot> = [];
      let draining = false;
      let retiring = 0;
      let active = 0;
      let waiters = 0;
      let changed = yield* Deferred.make<void>();
      const notify = Effect.sync(() => {
        const previous = changed;
        changed = Deferred.makeUnsafe<void>();
        Deferred.doneUnsafe(previous, Effect.void);
      });
      const release = (slot: Slot) =>
        Effect.sync(() => {
          active--;
          // Service teardown can close a leased slot; it never idles again.
          if (slot.closing) return;
          idle.push(slot);
          idleSlots.set(slot.scope, slot);
        }).pipe(Effect.andThen(notify), Effect.andThen(notifyHost));
      const retire = (slot: Slot) => {
        idle.splice(idle.indexOf(slot), 1);
        retiring++;
        return closeSlot(slot).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              retiring--;
              return notify;
            })
          )
        );
      };
      const enrichActive = Effect.suspend(() =>
        WideEvents.enrich({
          limits: [
            {
              limitId: "company.connections",
              value: target!.connections.value,
              peak: active,
              configRevision: target!.connections.configRevision
            }
          ]
        })
      );

      // Every check and count change runs without yielding in between, so
      // contenders interleaving at a yield always see the counts it left.
      const tryAcquire = (reserveAuthority: boolean) =>
        Effect.gen(function* () {
          while (true) {
            if (draining) return "company" as const;
            const limit = target!.connections.value - (reserveAuthority ? 1 : 0);
            if (active + retiring + 1 > limit) {
              yield* enrichActive;
              return "company" as const;
            }
            if (!pool || !samePool(pool, target!)) {
              if (active > 0 || retiring > 0) return "company" as const;
              const closes = idle.splice(0).map(closeSlot);
              pool = target!;
              if (closes.length === 0) continue;
              draining = true;
              yield* Effect.all(closes, { discard: true }).pipe(
                Effect.ensuring(
                  Effect.suspend(() => {
                    draining = false;
                    return notify;
                  })
                )
              );
              continue;
            }
            let slot = idle.pop();
            let evicting: Effect.Effect<void> | undefined;
            if (slot) idleSlots.delete(slot.scope);
            else if (openBackends >= settings.maxBackends) {
              // This company has none idle, so the longest idle is another company's.
              const victim = idleSlots.values().next().value;
              if (!victim) return "host" as const;
              evicting = victim.retire();
            }
            active++;
            if (!slot) {
              // Counted before the evicted slot closes, so no contender takes its backend.
              openBackends++;
              const generation = pool;
              slot = yield* Effect.gen(function* () {
                if (evicting) yield* evicting;
                return yield* openSlot(companyId, owner, generation, retire);
              }).pipe(
                Effect.onError(() =>
                  Effect.sync(() => {
                    active--;
                  }).pipe(Effect.andThen(notify))
                )
              );
            }
            const acquired = slot;
            yield* Effect.addFinalizer(() => release(acquired));
            yield* enrichActive;
            return acquired;
          }
        }).pipe(Effect.uninterruptible);

      const acquire = Effect.fn("CompanyDatabases.acquire")(function* (
        next: PoolTarget,
        waiterLimit: OperatingLimits.EffectiveLimit,
        waitLimit: OperatingLimits.EffectiveLimit,
        reserveAuthority: boolean
      ) {
        // An already-queued request must not restore an older override snapshot.
        if (
          !target ||
          next.placement.placementVersion > target.placement.placementVersion ||
          (next.placement.placementVersion === target.placement.placementVersion &&
            BigInt(next.connections.configRevision.overrideRevision) >=
              BigInt(target.connections.configRevision.overrideRevision))
        ) {
          target = next;
        }
        const immediate = yield* tryAcquire(reserveAuthority);
        if (typeof immediate !== "string") return immediate;
        let limited: "company" | "host" = immediate;
        const startedAt = yield* Clock.monotonicTimeNanos;
        return yield* Effect.acquireUseRelease(
          Effect.suspend(() => {
            if (waiters + 1 > waiterLimit.value) {
              return WideEvents.enrich({
                limits: [
                  {
                    limitId: waiterLimit.limitId,
                    value: waiterLimit.value,
                    peak: waiters,
                    configRevision: waiterLimit.configRevision
                  }
                ]
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new CompanyDatabases.Busy({
                      resource: "connection queue",
                      scope: "company",
                      limitId: waiterLimit.limitId,
                      value: waiterLimit.value,
                      retryAfterSeconds: Math.max(1, Math.ceil(waitLimit.value / 1_000))
                    })
                  )
                )
              );
            }
            waiters++;
            return WideEvents.enrich({
              limits: [
                {
                  limitId: waiterLimit.limitId,
                  value: waiterLimit.value,
                  peak: waiters,
                  configRevision: waiterLimit.configRevision
                }
              ]
            });
          }),
          () =>
            Effect.gen(function* () {
              while (true) {
                const company = changed;
                const host = backendFreed;
                const acquired = yield* tryAcquire(reserveAuthority);
                if (typeof acquired !== "string") return acquired;
                limited = acquired;
                // A full host wakes when any company's slot idles or closes.
                yield* Deferred.await(acquired === "host" ? host : company);
              }
            }).pipe(
              Effect.timeoutOrElse({
                duration: waitLimit.value,
                orElse: () =>
                  Effect.fail(
                    limited === "host"
                      ? new CompanyDatabases.Busy({
                          resource: "backend budget",
                          scope: "host",
                          limitId: "company.connections.hostBackends",
                          value: settings.maxBackends,
                          retryAfterSeconds: 1
                        })
                      : new CompanyDatabases.Busy({
                          resource: "connection wait",
                          scope: "company",
                          limitId: waitLimit.limitId,
                          value: waitLimit.value,
                          retryAfterSeconds: Math.max(1, Math.ceil(waitLimit.value / 1_000))
                        })
                  )
              })
            ),
          () =>
            Effect.gen(function* () {
              waiters--;
              const elapsed = Number((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000;
              yield* WideEvents.add({ queueWaitMs: elapsed, connectionWaitMs: elapsed });
              yield* WideEvents.enrich({
                limits: [
                  {
                    limitId: waitLimit.limitId,
                    value: waitLimit.value,
                    peak: elapsed,
                    configRevision: waitLimit.configRevision
                  }
                ]
              });
            })
        );
      });
      return { acquire };
    })
  });

  const acquireContext = Effect.fn("CompanyDatabases.acquireContext")(function* (
    companyId: string,
    reserveAuthority: boolean
  ) {
    const rows = yield* placements(companyId).pipe(
      Effect.catchTags(dieOnSchemaError),
      Effect.mapError(
        (cause) =>
          new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "connect", cause })
      )
    );
    const placement = rows[0];
    if (placement?.status !== "ready") {
      return yield* new CompanyDatabases.CompanyDatabaseNotReady({
        companyId,
        status: placement?.status ?? null
      });
    }
    const { connections, waiters, wait } = yield* limits
      .getMany({
        companyId,
        limits: {
          connections: "company.connections",
          waiters: "company.connections.waiters",
          wait: "company.connections.wait"
        }
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CompanyDatabases.CompanyDatabaseError({
              companyId,
              operation: "connect",
              cause
            })
        )
      );
    const entry = yield* RcMap.get(pools, companyId).pipe(
      Effect.catchTags({
        ExceededCapacityError: () =>
          Effect.fail(
            new CompanyDatabases.Busy({
              resource: "pool registry",
              scope: "host",
              limitId: "company.connections.pools",
              value: settings.capacity,
              retryAfterSeconds: 1
            })
          )
      })
    );
    return yield* entry.acquire({ placement, connections }, waiters, wait, reserveAuthority);
  });

  const withCompany: CompanyDatabases.CompanyDatabases["Service"]["withCompany"] =
    (companyId) => (effect) =>
      Effect.scoped(
        Effect.flatMap(acquireContext(companyId, false), ({ context }) =>
          effect.pipe(Effect.provideContext(context))
        )
      );

  const lease = Effect.fn("CompanyDatabases.lease")(function* (
    companyId: string,
    reserveAuthority: boolean
  ) {
    const acquired = yield* acquireContext(companyId, reserveAuthority);
    const { connection, release } = yield* acquired.reserve.pipe(
      Effect.mapError(
        (cause) =>
          new CompanyDatabases.CompanyDatabaseError({ companyId, operation: "connect", cause })
      )
    );
    // The pinned driver exposes no public dispose method. Its fatal path marks
    // the session dead, destroys its socket and notifies pool retirement hooks
    // synchronously. closeUnsafe is only for pool shutdown and skips those hooks.
    const reserved = connection as typeof connection & {
      readonly connection: PgConnection.PgConnection & {
        readonly base: {
          fatal(error: SqlError.SqlError): void;
        };
      };
    };
    const native = reserved.connection;
    const retained = yield* SqlClient.make({
      acquirer: Effect.succeed(connection),
      compiler: PgClient.makeCompiler(),
      spanAttributes: []
    }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
    const retainedContext = Context.make(SqlClient.SqlClient, retained).pipe(
      Context.add(CompanyDatabases.CompanyConnection, retained)
    );
    return {
      sql: retained,
      run: (effect) => effect.pipe(Effect.provideContext(retainedContext)),
      authority: withCompany(companyId),
      destroy: () => {
        release();
        native.base.fatal(
          new SqlError.SqlError({
            reason: new SqlError.ConnectionError({
              cause: new Error("Retained company connection destroyed."),
              message: "Retained company connection destroyed.",
              operation: "query"
            })
          })
        );
      }
    } satisfies CompanyDatabases.Lease;
  });

  return CompanyDatabases.CompanyDatabases.of({
    claim,
    ensureReady,
    withCompany,
    lease,
    withPatchLock: (patchId) => (effect) =>
      CompanyDatabases.withPatchLock(patchId)(effect).pipe(
        Effect.provideService(ResourceChanges.ResourceChanges, changes)
      ),
    withFileLock: CompanyDatabases.withFileLock,
    listReady: readyPlacements(undefined).pipe(
      Effect.catchTags(dieOnSchemaError),
      Effect.mapError(
        (cause) => new CompanyDatabases.CompanyDatabaseError({ operation: "list", cause })
      )
    )
  });
});

export const layer = Layer.effect(CompanyDatabases.CompanyDatabases, make).pipe(
  Layer.provide(placementLayer),
  Layer.provide(adminLayer),
  Layer.provide(Reactivity.layer),
  Layer.provide(Layer.effect(CompanyDatabaseConfig, config))
);
