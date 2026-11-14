import { GithubSnapshot, type GithubRepository } from "@patchy/api";
import { WideEvents } from "@patchy/analytics";
import { ContractLimits } from "@patchy/limits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as CredentialKeys from "../CredentialKeys.js";
import * as Connection from "./Connection.js";
import * as Source from "./Source.js";

/**
 * What a GitHub connection may reach, and the failures that change what it is. Every call holds
 * one of its installation's slots, reloads the connection after any wait, refuses a repository
 * outside the connection's current set before GitHub is asked, and reads with an installation
 * token minted for the set's ids, which GitHub refuses if any left the installation (shown). A
 * token is cached in this process by connection and credential revision until shortly before it
 * expires, and never leaves the host.
 *
 * The mint is what classifies a failure: 404 the App was uninstalled (paused, needing a
 * Reconnect), 403 suspended (recorded on the installation, never a pause) or refused, 422 a
 * repository gone or a permission lost (read, then reconciled at most once), 401 Patchy's own key.
 * A pause and a reconciliation's write apply only while the connection is as the attempt found
 * it: the same credential revision and the same count of successes.
 */

/** Which repository of which connection a call is for, and until when it waits. */
export interface Target {
  readonly companyId: string;
  readonly id: string;
  readonly repository: string;
  readonly deadline: number;
}

/** A token that may read the repository, by id; `fresh` when this call minted it. */
export interface Reach {
  readonly connectionId: string;
  readonly credentialRevision: number;
  readonly installationId: number;
  readonly repositoryId: number;
  readonly token: Redacted.Redacted<string>;
  readonly fresh: boolean;
}

/** The connection isn't connected: paused by an admin, or by Patchy for a reason it names. */
export class NotConnected extends Schema.TaggedError<NotConnected>()("GithubNotConnected", {}) {
  readonly code = "connection_not_connected" as const;
  readonly status = 409;
  override get message() {
    return "This connection is paused. Ask a company administrator to resume it.";
  }
}
/** No GitHub connection by this id in the company. */
export class Missing extends Schema.TaggedError<Missing>()("GithubConnectionMissing", {}) {
  readonly code = "connection_not_found" as const;
  readonly status = 404;
  override get message() {
    return "This connection could not be found.";
  }
}
/** The connection's row or snapshot couldn't be read or written. */
export class StorageFailed extends Schema.TaggedError<StorageFailed>()("GithubStorageFailed", {
  cause: Schema.Redacted(Schema.Defect())
}) {
  readonly code = "connection_storage_failed" as const;
  readonly status = 503;
  override get message() {
    return "The connection could not be read or saved. Please try again.";
  }
}

/** What reaching a repository can refuse with. */
export type ReachError =
  | Source.AppError
  | Source.Busy
  | Source.NotOffered
  | Connection.RepositoryNotFound
  | Connection.InstallationGone
  | Connection.PermissionsChanged
  | NotConnected
  | Missing
  | StorageFailed
  | CredentialKeys.CredentialDecryptionFailed;

/** What a check or discovery of a stored connection can refuse with. */
export type CheckError = Exclude<ReachError, Connection.RepositoryNotFound>;

/** A stored GitHub connection as the attempt found it: what its writes are guarded by. */
export interface Loaded {
  readonly companyId: string;
  readonly id: string;
  readonly status: "connected" | "disconnected";
  readonly credentialRevision: number;
  readonly metadataRevision: number;
  readonly display: Connection.Display;
  readonly sealed: Connection.Credentials;
}

/** What a connect, Add or Reconnect found before saving: the installation and the set's repositories. */
export interface Inspected {
  readonly installation: Source.Installation;
  readonly account: NonNullable<Option.Option.Value<Source.Installation["account"]>>;
  readonly repositories: ReadonlyArray<GithubRepository>;
}

export class Access extends Context.Service<
  Access,
  {
    /**
     * The seam reads call: given a connection and a repository name, a token that may read that
     * repository, or a refusal. Holds one of the installation's slots while it works.
     */
    readonly reach: (target: Target) => Effect.Effect<Reach, ReachError>;
    /**
     * Forgets a token a read found refused (a 401, or a 403 that isn't a limit answer), so the
     * next `reach` mints a new one.
     */
    readonly drop: (reach: Reach) => Effect.Effect<void>;
    /**
     * Writes the installation's cooldown after a limit answer, only ever later: every host then
     * refuses its calls until `retryAt` without asking GitHub. In its own statement, so a refused
     * change around it doesn't roll it back.
     */
    readonly cooldown: (installationId: number, retryAt: number) => Effect.Effect<void>;
    /**
     * Test and Resume's check of a stored connection: the installation exists, isn't suspended,
     * holds exactly the permissions Patchy reads with, and a token for the set can be minted.
     * Its failures pause, record or reconcile as a call's do.
     */
    readonly check: (
      input: { readonly companyId: string; readonly id: string },
      during: "test" | "reconnect",
      by: string
    ) => Effect.Effect<Loaded, CheckError>;
    /**
     * Refresh: the check, and every repository of the set read again from the installation, by
     * id: its name now, and whether it left or came back.
     */
    readonly discover: (
      input: { readonly companyId: string; readonly id: string },
      by: string
    ) => Effect.Effect<
      { readonly loaded: Loaded; readonly repositories: ReadonlyArray<GithubRepository> },
      CheckError
    >;
    /**
     * Connect, Add and Reconnect's check and discovery of repositories not yet saved: nothing is
     * written but a cooldown.
     */
    readonly inspect: (
      installationId: number,
      repositoryIds: ReadonlyArray<number>,
      /** The account's login as the person's listing named it, for a refusal's words. */
      login: string
    ) => Effect.Effect<
      Inspected,
      | Source.AppError
      | Source.Busy
      | Source.NotOffered
      | Connection.AccountType
      | Connection.InstallationGone
      | Connection.PermissionsChanged
      | Connection.NotInInstallation
    >;
    /** Forgets a deleted connection's tokens and revokes them at GitHub, best effort. */
    readonly forget: (connectionId: string) => Effect.Effect<void>;
    /** The installation's cooldown, when one is still running: what to refuse its calls with. */
    readonly cooling: (
      installationId: number
    ) => Effect.Effect<void, Source.RateLimited | StorageFailed>;
  }
>()("@patchy/integrations/github/Access") {}

const decodeDisplay = Schema.decodeUnknownEffect(Connection.Display);
const isRateLimited = Schema.is(Source.RateLimited);
const encodeDisplay = Schema.encodeSync(Schema.fromJsonString(Connection.Display));
const encodeAttention = Schema.encodeSync(Schema.fromJsonString(Connection.Attention));
const decodeSnapshot = Schema.decodeUnknownEffect(GithubSnapshot);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(GithubSnapshot));

const Row = Schema.Struct({
  status: Schema.Literals(["connected", "disconnected"]),
  display: Schema.Unknown,
  credentials: Schema.String,
  keyId: Schema.String,
  credentialRevision: Schema.Int,
  metadataRevision: Schema.Int
});

/** A cached token: what it was minted for, and when it stops being used. */
interface Cached {
  readonly reach: Omit<Reach, "repositoryId" | "fresh">;
  readonly until: number;
}

export const make = Effect.gen(function* () {
  const source = yield* Source.Source;
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* CredentialKeys.CredentialKeys;
  const margin = yield* ContractLimits.get("github.token.margin");
  const maxListed = yield* ContractLimits.get("github.installation.repositories");
  const tokens = new Map<string, Cached>();
  const cacheKey = (id: string, revision: number) => `${id}\n${revision}`;

  const stored = (cause: SqlError | Schema.SchemaError) =>
    new StorageFailed({ cause: Redacted.make(cause) });
  const now = Clock.currentTimeMillis;
  const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

  const rowOf = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, id: Schema.String }),
    Result: Row,
    execute: ({ companyId, id }) => sql`SELECT status, display, credentials, key_id AS "keyId",
      credential_revision AS "credentialRevision", metadata_revision AS "metadataRevision"
      FROM connections WHERE company_id = ${companyId} AND id = ${id} AND integration = 'github'`
  });
  /** The connection as it stands now, its credentials opened. */
  const load = Effect.fn("GithubAccess.load")(function* (input: {
    readonly companyId: string;
    readonly id: string;
  }) {
    const found = yield* rowOf(input).pipe(Effect.mapError(stored));
    if (Option.isNone(found)) return yield* new Missing({});
    const row = found.value;
    const display = yield* decodeDisplay(row.display).pipe(Effect.mapError(stored));
    const opened = yield* keys.decrypt(
      { companyId: input.companyId, id: input.id, integration: "github" },
      { credentials: row.credentials, keyId: row.keyId }
    );
    const sealed = yield* Connection.parseCredentials(opened);
    return {
      companyId: input.companyId,
      id: input.id,
      status: row.status,
      credentialRevision: row.credentialRevision,
      metadataRevision: row.metadataRevision,
      display,
      sealed
    } satisfies Loaded;
  });

  const cooldown = (installationId: number, retryAt: number) =>
    sql`INSERT INTO github_installations (installation_id, cooldown_until)
      VALUES (${installationId}, to_timestamp(${retryAt / 1_000}))
      ON CONFLICT (installation_id) DO UPDATE SET cooldown_until =
        GREATEST(COALESCE(github_installations.cooldown_until, EXCLUDED.cooldown_until), EXCLUDED.cooldown_until)`.pipe(
      Effect.asVoid,
      Effect.ignore
    );
  /** Runs `effect` against an installation, writing the cooldown any limit answer to it sets. */
  const guarded =
    (installationId: number) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.tapError((error) =>
          isRateLimited(error) && error.who === "installation"
            ? Effect.andThen(
                cooldown(installationId, error.retryAt),
                WideEvents.enrich({ githubCooldown: true })
              )
            : Effect.void
        )
      );
  const cooling = Effect.fn("GithubAccess.cooling")(function* (installationId: number) {
    const rows = yield* sql<{ readonly until: number | null }>`SELECT
        (extract(epoch FROM cooldown_until) * 1000)::float8 AS until
      FROM github_installations WHERE installation_id = ${installationId}`.pipe(
      Effect.mapError(stored)
    );
    const until = rows[0]?.until ?? null;
    const at = yield* now;
    if (until !== null && until > at)
      return yield* new Source.RateLimited({ retryAt: until, now: at, who: "installation" });
  });

  /** A mint found the App suspended on the account: what the pages say until a mint works. */
  const observeSuspended = (installationId: number) =>
    sql`INSERT INTO github_installations (installation_id, suspended_seen_at)
      VALUES (${installationId}, now())
      ON CONFLICT (installation_id) DO UPDATE SET suspended_seen_at = now()`.pipe(
      Effect.asVoid,
      Effect.ignore
    );
  const clearSuspended = (installationId: number) =>
    sql`UPDATE github_installations SET suspended_seen_at = NULL
      WHERE installation_id = ${installationId} AND suspended_seen_at IS NOT NULL`.pipe(
      Effect.asVoid,
      Effect.ignore
    );
  /**
   * A mint for the set worked: one more success, under the same credential revision, so a
   * failure that began before it can no longer pause, and the App isn't suspended any more.
   */
  const succeeded = (attempt: Loaded) =>
    Effect.andThen(
      sql`UPDATE connections SET display = jsonb_set(display, '{successes}',
          to_jsonb(COALESCE((display->>'successes')::int, 0) + 1))
        WHERE id = ${attempt.id} AND company_id = ${attempt.companyId}
          AND credential_revision = ${attempt.credentialRevision}`.pipe(Effect.ignore),
      clearSuspended(attempt.display.installationId)
    );
  /**
   * Pauses the connection for `attention`, once, and only while it's as the attempt found it:
   * the same credential revision and the same count of successes. A connection an admin already
   * paused keeps its status and is told why too.
   */
  const pause = (attempt: Loaded, attention: Omit<Connection.Attention, "at">) =>
    Effect.gen(function* () {
      const value = encodeAttention({ ...attention, at: iso(yield* now) });
      yield* sql`UPDATE connections SET
          display = display || jsonb_build_object('attention', ${value}::jsonb),
          credential_revision = credential_revision + CASE WHEN status = 'connected' THEN 1 ELSE 0 END,
          status = 'disconnected'
        WHERE id = ${attempt.id} AND company_id = ${attempt.companyId}
          AND credential_revision = ${attempt.credentialRevision}
          AND COALESCE((display->>'successes')::int, 0) = ${attempt.display.successes ?? 0}`;
    }).pipe(Effect.ignore);

  /** What the installation is, from the App's own read: gone, suspended, or with its permissions. */
  type Read =
    | { readonly _tag: "Gone" }
    | { readonly _tag: "Suspended" }
    | {
        readonly _tag: "Gaps";
        readonly missing: ReadonlyArray<string>;
        readonly above: ReadonlyArray<string>;
      }
    | { readonly _tag: "Fine"; readonly installation: Source.Installation };
  const read = (installationId: number) =>
    guarded(installationId)(source.installation(installationId)).pipe(
      Effect.map((found): Read => {
        if (Option.isNone(found)) return { _tag: "Gone" };
        if (found.value.suspended) return { _tag: "Suspended" };
        const gaps = Source.permissionGaps(found.value.permissions);
        return gaps.missing.length > 0 || gaps.above.length > 0
          ? { _tag: "Gaps", ...gaps }
          : { _tag: "Fine", installation: found.value };
      })
    );

  type During = Connection.Attention["during"];
  /**
   * What a read of the installation found that ends the attempt: a pause for an uninstalled App
   * or permissions it no longer grants, the suspension recorded, each refused as such.
   */
  const settle = (
    attempt: Loaded,
    found: Exclude<Read, { _tag: "Fine" }>,
    during: During,
    by?: string
  ) =>
    Effect.gen(function* () {
      const account = attempt.display.account.login;
      const who = by === undefined ? {} : { by };
      switch (found._tag) {
        case "Gone":
          yield* pause(attempt, { reason: "uninstalled", during, ...who });
          return yield* new Connection.InstallationGone({ account });
        case "Gaps":
          yield* pause(attempt, {
            reason: "permissions",
            during,
            ...who,
            missing: [...found.missing],
            above: [...found.above]
          });
          return yield* new Connection.PermissionsChanged({
            account,
            missing: found.missing,
            above: found.above
          });
        case "Suspended":
          yield* observeSuspended(attempt.display.installationId);
          return yield* new Source.Unavailable({
            stage: "status",
            upstreamStatus: 403,
            reason: "suspended",
            account
          });
      }
    });

  /** Caches a token minted for the attempt's set, dropping the connection's older ones. */
  const remember = (attempt: Loaded, minted: Extract<Source.Mint, { _tag: "Minted" }>) =>
    Effect.sync(() => {
      for (const key of tokens.keys()) if (key.startsWith(`${attempt.id}\n`)) tokens.delete(key);
      tokens.set(cacheKey(attempt.id, attempt.credentialRevision), {
        reach: {
          connectionId: attempt.id,
          credentialRevision: attempt.credentialRevision,
          installationId: attempt.display.installationId,
          token: minted.token
        },
        until: minted.expiresAt - margin
      });
      return minted.token;
    });

  /**
   * Marks the set's repositories missing from the installation as left, with a new snapshot and
   * credential revision, only while the connection is as the attempt found it. Writes nothing for
   * a set nothing left.
   */
  const markLeft = (attempt: Loaded, gone: ReadonlySet<number>) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [locked] = yield* sql<{
            readonly credentialRevision: number;
            readonly metadataRevision: number;
            readonly successes: number;
          }>`SELECT credential_revision AS "credentialRevision", metadata_revision AS "metadataRevision",
              COALESCE((display->>'successes')::int, 0) AS successes
            FROM connections WHERE id = ${attempt.id} AND company_id = ${attempt.companyId} FOR UPDATE`;
          if (
            locked === undefined ||
            locked.credentialRevision !== attempt.credentialRevision ||
            locked.successes !== (attempt.display.successes ?? 0)
          )
            return;
          const [current] = yield* sql<{ readonly snapshot: unknown }>`SELECT snapshot
            FROM connection_snapshots WHERE connection_id = ${attempt.id}
              AND company_id = ${attempt.companyId} AND revision = ${locked.metadataRevision}`;
          const snapshot = yield* decodeSnapshot(current?.snapshot);
          const revision = locked.metadataRevision + 1;
          const next: GithubSnapshot = {
            ...snapshot,
            repositories: snapshot.repositories.map((item) =>
              gone.has(item.id) ? { ...item, left: true as const } : item
            )
          };
          const display: Connection.Display = {
            ...attempt.display,
            repositories: attempt.display.repositories.map((item) =>
              gone.has(item.id) ? { ...item, left: true as const } : item
            )
          };
          yield* sql`INSERT INTO connection_snapshots
            (company_id, connection_id, integration, revision, snapshot)
            VALUES (${attempt.companyId}, ${attempt.id}, 'github', ${revision}, ${encodeSnapshot(next)})`;
          yield* sql`UPDATE connections SET display = ${encodeDisplay(display)}::jsonb,
              metadata_revision = ${revision}, credential_revision = credential_revision + 1
            WHERE id = ${attempt.id} AND company_id = ${attempt.companyId}`;
        })
      )
      .pipe(Effect.mapError(stored));

  /**
   * A mint for the connection's set, with what each refusal means. A 422 is read, not assumed:
   * the installation is read first, then the set reconciled against everything it holds, then the
   * repository `asked` for checked again, then one more mint for what remains. One reconciliation
   * and one replacement mint, never a loop.
   */
  const mintFor = (
    attempt: Loaded,
    during: During,
    asked?: { readonly name: string },
    by?: string
  ): Effect.Effect<
    { readonly attempt: Loaded; readonly token: Redacted.Redacted<string> },
    CheckError | Connection.RepositoryNotFound
  > =>
    Effect.gen(function* () {
      const installationId = attempt.display.installationId;
      const set = Connection.reachable(attempt.display, attempt.sealed);
      if (set.length === 0)
        return yield* new Connection.RepositoryNotFound({ repository: asked?.name ?? "" });
      const answer = yield* guarded(installationId)(
        source.mint(installationId, { repositoryIds: set.map((item) => item.id) })
      );
      if (answer._tag === "Minted") {
        yield* succeeded(attempt);
        yield* WideEvents.enrich({ githubMint: "minted" });
        return { attempt, token: yield* remember(attempt, answer) };
      }
      if (answer.status === 404) return yield* settle(attempt, { _tag: "Gone" }, during, by);
      if (answer.status === 403) {
        const found = yield* read(installationId);
        if (found._tag === "Suspended" || found._tag === "Gone")
          return yield* settle(attempt, found, during, by);
        // Neither a limit answer nor a suspension: refused, and nothing is written.
        return yield* new Source.Unavailable({ stage: "status", upstreamStatus: 403 });
      }
      if (answer.status !== 422)
        return yield* new Source.Unavailable({ stage: "status", upstreamStatus: answer.status });
      // A repository outside the installation, or a permission it doesn't hold: read which.
      const found = yield* read(installationId);
      if (found._tag !== "Fine") return yield* settle(attempt, found, during, by);
      const listing = yield* guarded(installationId)(
        source.mint(installationId, { metadataOnly: true })
      );
      if (listing._tag !== "Minted")
        return yield* new Source.Unavailable({ stage: "status", upstreamStatus: listing.status });
      const present = yield* guarded(installationId)(
        source.installationRepositories(listing.token, maxListed)
      ).pipe(Effect.ensuring(source.revokeInstallationToken(listing.token)));
      const ids = new Set(present.map((item) => item.id));
      const gone = new Set(set.filter((item) => !ids.has(item.id)).map((item) => item.id));
      if (gone.size === 0)
        return yield* new Source.Unavailable({ stage: "status", upstreamStatus: 422 });
      yield* markLeft(attempt, gone);
      const reloaded = yield* load(attempt);
      if (
        asked !== undefined &&
        Connection.lookup(reloaded.display, reloaded.sealed, asked.name) === undefined
      )
        return yield* new Connection.RepositoryNotFound({ repository: asked.name });
      const remaining = Connection.reachable(reloaded.display, reloaded.sealed);
      if (remaining.length === 0)
        return yield* new Connection.RepositoryNotFound({ repository: asked?.name ?? "" });
      const again = yield* guarded(installationId)(
        source.mint(installationId, { repositoryIds: remaining.map((item) => item.id) })
      );
      if (again._tag !== "Minted")
        return yield* new Source.Unavailable({ stage: "status", upstreamStatus: again.status });
      yield* succeeded(reloaded);
      yield* WideEvents.enrich({ githubMint: "reconciled" });
      return { attempt: reloaded, token: yield* remember(reloaded, again) };
    });

  /** A deadline for administration: the integration deadline from now. */
  const adminDeadline = Effect.gen(function* () {
    return (yield* now) + (yield* ContractLimits.get("integration.deadline"));
  });

  const reach = Effect.fn("GithubAccess.reach")(function* (target: Target) {
    const first = yield* load(target);
    if (first.status !== "connected") return yield* new NotConnected({});
    const installationId = first.display.installationId;
    yield* cooling(installationId);
    return yield* source.withSlot(
      installationId,
      target.deadline
    )(
      Effect.gen(function* () {
        // Reloaded after the wait for a slot: a token from before a change is never used.
        const current = yield* load(target);
        if (current.status !== "connected") return yield* new NotConnected({});
        const asked = Connection.lookup(current.display, current.sealed, target.repository);
        if (asked === undefined)
          return yield* new Connection.RepositoryNotFound({ repository: target.repository });
        const cached = tokens.get(cacheKey(current.id, current.credentialRevision));
        if (cached !== undefined && cached.until > (yield* now)) {
          yield* WideEvents.enrich({ githubMint: "cached" });
          return { ...cached.reach, repositoryId: asked.id, fresh: false } satisfies Reach;
        }
        const minted = yield* mintFor(current, "call", { name: target.repository });
        const repository = Connection.lookup(
          minted.attempt.display,
          minted.attempt.sealed,
          target.repository
        );
        if (repository === undefined)
          return yield* new Connection.RepositoryNotFound({ repository: target.repository });
        return {
          connectionId: current.id,
          credentialRevision: minted.attempt.credentialRevision,
          installationId,
          repositoryId: repository.id,
          token: minted.token,
          fresh: true
        } satisfies Reach;
      })
    );
  });

  const drop = (reach: Reach) =>
    Effect.sync(() => {
      const key = cacheKey(reach.connectionId, reach.credentialRevision);
      if (tokens.get(key)?.reach.token === reach.token) tokens.delete(key);
    });

  const check = Effect.fn("GithubAccess.check")(function* (
    input: { readonly companyId: string; readonly id: string },
    during: "test" | "reconnect",
    by: string
  ) {
    const attempt = yield* load(input);
    const installationId = attempt.display.installationId;
    yield* cooling(installationId);
    return yield* source.withSlot(
      installationId,
      yield* adminDeadline
    )(
      Effect.gen(function* () {
        const found = yield* read(installationId);
        if (found._tag !== "Fine") return yield* settle(attempt, found, during, by);
        return (yield* mintFor(attempt, during, undefined, by).pipe(
          Effect.catchTag("GithubRepositoryNotFound", () =>
            Effect.fail(new Source.Unavailable({ stage: "status", upstreamStatus: 422 }))
          )
        )).attempt;
      })
    );
  });

  const discover = Effect.fn("GithubAccess.discover")(function* (
    input: { readonly companyId: string; readonly id: string },
    by: string
  ) {
    const attempt = yield* load(input);
    if (attempt.status !== "connected") return yield* new NotConnected({});
    const installationId = attempt.display.installationId;
    yield* cooling(installationId);
    return yield* source.withSlot(
      installationId,
      yield* adminDeadline
    )(
      Effect.gen(function* () {
        const found = yield* read(installationId);
        if (found._tag !== "Fine") return yield* settle(attempt, found, "refresh", by);
        const listing = yield* guarded(installationId)(
          source.mint(installationId, { metadataOnly: true })
        );
        if (listing._tag === "Refused" && listing.status === 404)
          return yield* settle(attempt, { _tag: "Gone" }, "refresh", by);
        if (listing._tag !== "Minted")
          return yield* new Source.Unavailable({ stage: "status", upstreamStatus: listing.status });
        const present = yield* guarded(installationId)(
          source.installationRepositories(listing.token, maxListed)
        ).pipe(Effect.ensuring(source.revokeInstallationToken(listing.token)));
        const byId = new Map(present.map((item) => [item.id, item] as const));
        const repositories = attempt.display.repositories.map((item): GithubRepository => {
          const found = byId.get(item.id);
          return found === undefined
            ? {
                id: item.id,
                name: item.name,
                defaultBranch: "",
                private: item.private,
                archived: false,
                disabled: false,
                left: true
              }
            : {
                id: found.id,
                name: found.name,
                defaultBranch: found.defaultBranch,
                private: found.private,
                archived: found.archived,
                disabled: found.disabled
              };
        });
        return { loaded: attempt, repositories };
      })
    );
  });

  const inspect = Effect.fn("GithubAccess.inspect")(function* (
    installationId: number,
    repositoryIds: ReadonlyArray<number>,
    login: string
  ) {
    yield* cooling(installationId).pipe(
      Effect.catchTag("GithubStorageFailed", (cause) =>
        Effect.fail(new Source.Unavailable({ stage: "request", cause: Redacted.make(cause) }))
      )
    );
    return yield* source.withSlot(
      installationId,
      yield* adminDeadline
    )(
      Effect.gen(function* () {
        const found = yield* guarded(installationId)(source.installation(installationId));
        if (Option.isNone(found)) return yield* new Connection.InstallationGone({ account: login });
        const installation = found.value;
        if (Option.isNone(installation.account)) return yield* new Connection.AccountType({});
        const account = installation.account.value;
        if (installation.suspended)
          return yield* new Source.Unavailable({
            stage: "status",
            upstreamStatus: 403,
            reason: "suspended",
            account: account.login
          });
        const gaps = Source.permissionGaps(installation.permissions);
        if (gaps.missing.length > 0 || gaps.above.length > 0)
          return yield* new Connection.PermissionsChanged({ account: account.login, ...gaps });
        const minted = yield* guarded(installationId)(
          source.mint(installationId, { repositoryIds })
        );
        if (minted._tag === "Refused")
          return minted.status === 422
            ? yield* new Connection.NotInInstallation({ account: account.login })
            : minted.status === 404
              ? yield* new Connection.InstallationGone({ account: account.login })
              : yield* new Source.Unavailable({ stage: "status", upstreamStatus: minted.status });
        // A token minted for named repositories lists only those: their names and branches now.
        const listed = yield* guarded(installationId)(
          source.installationRepositories(minted.token, maxListed)
        ).pipe(Effect.ensuring(source.revokeInstallationToken(minted.token)));
        const byId = new Map(listed.map((item) => [item.id, item] as const));
        const repositories: Array<GithubRepository> = [];
        for (const id of repositoryIds) {
          const item = byId.get(id);
          if (item === undefined)
            return yield* new Connection.NotInInstallation({ account: account.login });
          repositories.push({
            id: item.id,
            name: item.name,
            defaultBranch: item.defaultBranch,
            private: item.private,
            archived: item.archived,
            disabled: item.disabled
          });
        }
        return { installation, account, repositories } satisfies Inspected;
      })
    );
  });

  const forget = (connectionId: string) =>
    Effect.gen(function* () {
      const held: Array<Redacted.Redacted<string>> = [];
      for (const [key, cached] of tokens)
        if (key.startsWith(`${connectionId}\n`)) {
          held.push(cached.reach.token);
          tokens.delete(key);
        }
      yield* Effect.forEach(held, source.revokeInstallationToken, { discard: true });
    });

  return Access.of({
    reach,
    drop,
    cooldown,
    check,
    discover,
    inspect,
    forget,
    cooling
  });
});

export const layer = Layer.effect(Access, make);
