// @effect-diagnostics nodeBuiltinImport:off -- The one recoverable secret needs AES-GCM and HKDF; Effect has neither.
/**
 * Agent connections, the `work` credential: one person's consent for one install of an MCP
 * client, and the tokens that carry it. Access tokens are opaque, last an hour and are checked
 * here on every call, which stamps last used. A refresh token rotates on every use, and every
 * token a connection ever issued stays, so any reuse is recognised however far back. A retry
 * within a minute of a rotation gets the same new tokens, kept encrypted under the refresh token
 * it rotated, so only whoever presents that token can read them, and swept once the minute is
 * up. Every other secret is stored as a hash.
 *
 * Every time here is the database's clock, read in the statement that uses it: app servers'
 * clocks can disagree, and none of them moves an hour, a minute, 30 idle days or the person's
 * credentials-ended stamp. Creation and refresh share the person's row lock, after the company
 * lock a caller may already hold, then refresh takes the connection's own. Ending everything a
 * person holds, by Disconnect everything or deactivation, takes the person's row for update and
 * stamps it, so nothing is created or rotated against an ending that has committed. Ending one
 * connection, by disconnecting it or reusing its refresh token, takes that connection's row.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Identity } from "@patchy/api";
import { newInternalId, randomToken, sha256 } from "@patchy/core";
import { UserUnavailable } from "./MachineTokens.js";

const ACCESS_SECONDS = 60 * 60;

/**
 * The token endpoint answers `invalid_grant`. `reason` is for the request's event: an unknown
 * token, an ended connection, or a refresh token reused after its minute, whose connection
 * this refusal ended.
 */
export class RefreshRefused extends Schema.TaggedError<RefreshRefused>()("RefreshRefused", {
  reason: Schema.Literals(["unknown", "ended", "reused"])
}) {
  override get message() {
    return "This refresh token is unknown, was reused, or its agent connection has ended.";
  }
}

/** No agent connection of the person's has this id; another person's is never found. */
export class AgentConnectionNotFound extends Schema.TaggedError<AgentConnectionNotFound>()(
  "AgentConnectionNotFound",
  { id: Schema.String }
) {
  override get message() {
    return `Agent connection ${this.id} was not found.`;
  }
}

/** Who an agent connection's access token acts as, and the connection acting. */
export const AgentIdentity = Schema.Struct({
  user: Identity.fields.user,
  company: Identity.fields.company,
  role: Identity.fields.role,
  agentConnection: Schema.Struct({
    id: Schema.String,
    clientName: Schema.String,
    /** The host of the client's metadata document, shown at consent beside its name. */
    clientSite: Schema.String
  })
});
export type AgentIdentity = typeof AgentIdentity.Type;

/** What the token endpoint hands a client. `expiresIn` is the access token's seconds left. */
export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

/** A live agent connection, as Your machines lists it. Times are ISO strings. */
export interface Listed {
  readonly id: string;
  readonly clientName: string;
  readonly clientSite: string;
  readonly connectedAt: string;
  /** Its last call, or `null` before the first. */
  readonly lastUsedAt: string | null;
  /** When it ends on its own: 30 days after its last call, or after connecting if never called. */
  readonly endsAt: string;
}

/** A new agent connection, as the consent page showed it, and its first tokens. */
export interface Connected {
  readonly connection: {
    readonly id: string;
    readonly clientName: string;
    readonly clientSite: string;
  };
  readonly tokens: Tokens;
}

export class AgentConnections extends Context.Service<
  AgentConnections,
  {
    /**
     * Connects `clientId`'s client as the person: a code exchange's one write. It joins the
     * caller's transaction, so issuance can hold the company lock first.
     */
    readonly create: (input: {
      readonly userId: string;
      /** The client's metadata document URL. */
      readonly clientId: string;
      /** The name the document gives, cleaned as `clientName` cleans it. */
      readonly clientName: string;
    }) => Effect.Effect<Connected, UserUnavailable | SqlError>;
    /** The `work` bearer check: who the access token acts as, or `null`. A call stamps last used. */
    readonly authenticate: (accessToken: string) => Effect.Effect<AgentIdentity | null, SqlError>;
    /**
     * Who a live connection acts as now, or `null` once it has ended in any way: what an admitted
     * call rechecks before each company callback, as a page's callbacks recheck its session. It
     * reads without using the connection, so last used stays the call's, and its access token
     * expiring mid-call ends nothing.
     */
    readonly current: (connectionId: string) => Effect.Effect<AgentIdentity | null, SqlError>;
    /**
     * The connection a refresh token was issued to, its client's id and whether the token is the
     * chain's current one, which `refresh` would rotate, or `null`: what the token endpoint checks
     * and limits by before it calls `refresh`. Unlocked, so `current` can be stale by the time
     * `refresh` runs; only a limit reads it.
     */
    readonly chainOf: (refreshToken: string) => Effect.Effect<
      {
        readonly id: string;
        readonly clientId: string;
        readonly current: boolean;
      } | null,
      SqlError
    >;
    /** Rotates the chain, or answers a retry within the minute; any other reuse ends it. */
    readonly refresh: (refreshToken: string) => Effect.Effect<Tokens, RefreshRefused | SqlError>;
    /** Drops every retry copy whose minute is up; the server runs it every few seconds. */
    readonly sweepRetries: Effect.Effect<void, SqlError>;
    /** The person's live connections for Your machines, newest first. */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<Listed>, SqlError>;
    /**
     * Your machines' Disconnect: ends one of the person's own connections, so its next call and
     * refresh are refused. Nobody ends another person's, an admin included. Disconnecting one
     * that has already ended keeps when it first ended.
     */
    readonly disconnect: (input: {
      readonly id: string;
      readonly userId: string;
    }) => Effect.Effect<void, AgentConnectionNotFound | SqlError>;
  }
>()("@patchy/auth/AgentConnections") {}

// Characters that must never reach a consent page or a log line: controls, lone surrogates,
// line breaks and the bidirectional controls that could reorder a name to look like another.
const UNSHOWN = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * The name a consent page shows for a client, which its connection keeps as the "via" name:
 * the document's own without control characters, cut to 64 characters, or the document's
 * host when nothing is left.
 */
export const clientName = (name: string, clientId: string): string => {
  const shown = Array.from(name.replace(UNSHOWN, "").trim()).slice(0, 64).join("").trim();
  return shown === "" ? Array.from(new URL(clientId).host).slice(0, 64).join("") : shown;
};

const Retried = Schema.fromJsonString(
  Schema.Struct({ accessToken: Schema.String, refreshToken: Schema.String })
);
const encodeRetried = Schema.encodeSync(Retried);
const decodeRetried = Schema.decodeUnknownSync(Retried);

/** The key only the rotated refresh token yields; its stored hash yields nothing. */
const retryKey = (refreshToken: string) =>
  Buffer.from(hkdfSync("sha256", refreshToken, "", "patchy agent connection retry", 32));

const sealRetry = (refreshToken: string, connectionId: string, tokens: typeof Retried.Type) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", retryKey(refreshToken), nonce);
  cipher.setAAD(Buffer.from(connectionId));
  const sealed = Buffer.concat([cipher.update(encodeRetried(tokens), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString("base64");
};

const openRetry = (refreshToken: string, connectionId: string, retry: string) => {
  const bytes = Buffer.from(retry, "base64");
  const decipher = createDecipheriv("aes-256-gcm", retryKey(refreshToken), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(connectionId));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return decodeRetried(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")
  );
};

const newTokens = () => ({
  accessToken: `pwa_${randomToken(32)}`,
  refreshToken: `pwr_${randomToken(32)}`
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Whether connection `c` of person `u` still works: not disconnected, its person active,
  // called (or connected) within 30 days, and made after the person's credentials last ended.
  const live = sql`(c.revoked_at IS NULL AND u.deactivated_at IS NULL
    AND COALESCE(c.last_used_at, c.created_at) > clock_timestamp() - interval '30 days'
    AND (u.credentials_ended_at IS NULL OR u.credentials_ended_at < c.created_at))`;

  // The check and the stamp in one statement: every admitted call is the last use, and a call
  // that lost a race with the idle boundary or an ending matches nothing and stamps nothing.
  const useAccessToken = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ identity: AgentIdentity }),
    execute: (tokenHash) => sql`
      UPDATE agent_connections c SET last_used_at = GREATEST(c.last_used_at, clock_timestamp())
      FROM agent_connection_access_tokens a, users u, companies co
      WHERE a.token_hash = ${tokenHash} AND c.id = a.connection_id AND u.id = c.user_id
        AND co.id = u.company_id AND a.expires_at > clock_timestamp() AND ${live}
      RETURNING json_build_object(
        'user', json_build_object('id', u.id, 'email', u.email, 'name', u.name),
        'company', json_build_object('id', co.id, 'handle', co.handle, 'name', co.name),
        'role', u.role,
        'agentConnection', json_build_object(
          'id', c.id, 'clientName', c.client_name, 'clientSite', c.client_site)
      ) AS identity`
  });

  const liveIdentity = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ identity: AgentIdentity }),
    execute: (connectionId) => sql`
      SELECT json_build_object(
        'user', json_build_object('id', u.id, 'email', u.email, 'name', u.name),
        'company', json_build_object('id', co.id, 'handle', co.handle, 'name', co.name),
        'role', u.role,
        'agentConnection', json_build_object(
          'id', c.id, 'clientName', c.client_name, 'clientSite', c.client_site)
      ) AS identity
      FROM agent_connections c JOIN users u ON u.id = c.user_id JOIN companies co ON co.id = u.company_id
      WHERE c.id = ${connectionId} AND ${live}`
  });

  const chainOwner = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      connectionId: Schema.String,
      userId: Schema.String,
      clientId: Schema.String,
      current: Schema.Boolean
    }),
    execute: (tokenHash) => sql`
      SELECT c.id AS "connectionId", c.user_id AS "userId", c.client_id AS "clientId",
        r.rotated_at IS NULL AS current
      FROM agent_connection_refresh_tokens r JOIN agent_connections c ON c.id = r.connection_id
      WHERE r.token_hash = ${tokenHash}`
  });

  // Read after the locks, so it sees whatever the rotation that held them committed.
  const chainState = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({
      live: Schema.Boolean,
      current: Schema.Boolean,
      retry: Schema.NullOr(Schema.String)
    }),
    execute: (tokenHash) => sql`
      SELECT ${live} AS live, r.rotated_at IS NULL AS current,
        CASE WHEN r.rotated_at > clock_timestamp() - interval '1 minute' THEN r.retry END AS retry
      FROM agent_connection_refresh_tokens r
      JOIN agent_connections c ON c.id = r.connection_id
      JOIN users u ON u.id = c.user_id
      WHERE r.token_hash = ${tokenHash}`
  });

  const liveConnections = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      id: Schema.String,
      clientName: Schema.String,
      clientSite: Schema.String,
      connectedAt: Schema.Date,
      lastUsedAt: Schema.NullOr(Schema.Date),
      endsAt: Schema.Date
    }),
    execute: (userId) => sql`
      SELECT c.id, c.client_name AS "clientName", c.client_site AS "clientSite",
        c.created_at AS "connectedAt", c.last_used_at AS "lastUsedAt",
        COALESCE(c.last_used_at, c.created_at) + interval '30 days' AS "endsAt"
      FROM agent_connections c JOIN users u ON u.id = c.user_id
      WHERE c.user_id = ${userId} AND ${live}
      ORDER BY c.created_at DESC, c.id`
  });

  const secondsLeft = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ seconds: Schema.Int }),
    execute: (tokenHash) => sql`
      SELECT GREATEST(0, floor(EXTRACT(EPOCH FROM expires_at - clock_timestamp())))::int AS seconds
      FROM agent_connection_access_tokens WHERE token_hash = ${tokenHash}`
  });

  const issue = (connectionId: string, tokens: ReturnType<typeof newTokens>) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO agent_connection_access_tokens (token_hash, connection_id, expires_at)
        VALUES (${sha256(tokens.accessToken)}, ${connectionId},
          clock_timestamp() + make_interval(secs => ${ACCESS_SECONDS}))`;
      yield* sql`
        INSERT INTO agent_connection_refresh_tokens (token_hash, connection_id)
        VALUES (${sha256(tokens.refreshToken)}, ${connectionId})`;
      return { ...tokens, expiresIn: ACCESS_SECONDS } satisfies Tokens;
    });

  const create = Effect.fn("AgentConnections.create")(function* (input: {
    readonly userId: string;
    readonly clientId: string;
    readonly clientName: string;
  }) {
    const site = URL.parse(input.clientId)?.host ?? "";
    if (site === "")
      return yield* Effect.die(new Error("An agent connection's client id is a URL."));
    const name = clientName(input.clientName, input.clientId);
    const id = newInternalId("agc");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Created on the database's clock under the lock the endings stamp under: one made
        // before an ending commits is never younger than its stamp.
        const users = yield* sql`
          SELECT id FROM users WHERE id = ${input.userId} AND deactivated_at IS NULL FOR SHARE`;
        if (users.length === 0) return yield* new UserUnavailable({ userId: input.userId });
        yield* sql`
          INSERT INTO agent_connections (id, user_id, client_id, client_name, client_site, created_at)
          VALUES (${id}, ${input.userId}, ${input.clientId}, ${name}, ${site}, clock_timestamp())`;
        const tokens = yield* issue(id, newTokens());
        return {
          connection: { id, clientName: name, clientSite: site },
          tokens
        } satisfies Connected;
      })
    );
  });

  const authenticate = Effect.fn("AgentConnections.authenticate")(function* (accessToken: string) {
    const used = yield* useAccessToken(sha256(accessToken)).pipe(
      Effect.catchTags({ SchemaError: Effect.die })
    );
    return Option.isSome(used) ? used.value.identity : null;
  });

  const current = Effect.fn("AgentConnections.current")(function* (connectionId: string) {
    const found = yield* liveIdentity(connectionId).pipe(
      Effect.catchTags({ SchemaError: Effect.die })
    );
    return Option.isSome(found) ? found.value.identity : null;
  });

  // A connection's client never changes; whether the token is current only feeds a limit.
  const chainOf = Effect.fn("AgentConnections.chainOf")(function* (refreshToken: string) {
    const owner = yield* chainOwner(sha256(refreshToken)).pipe(
      Effect.catchTags({ SchemaError: Effect.die })
    );
    return Option.isSome(owner)
      ? {
          id: owner.value.connectionId,
          clientId: owner.value.clientId,
          current: owner.value.current
        }
      : null;
  });

  const refresh = Effect.fn("AgentConnections.refresh")(function* (refreshToken: string) {
    const tokenHash = sha256(refreshToken);
    // A refusal is a value until the transaction commits, so a reuse's ending lands first.
    const outcome = yield* sql.withTransaction(
      Effect.gen(function* (): Effect.fn.Return<Tokens | RefreshRefused["reason"], SqlError> {
        const owner = yield* chainOwner(tokenHash).pipe(
          Effect.catchTags({ SchemaError: Effect.die })
        );
        if (Option.isNone(owner)) return "unknown";
        const { connectionId, userId } = owner.value;
        yield* sql`SELECT id FROM users WHERE id = ${userId} FOR SHARE`;
        yield* sql`SELECT id FROM agent_connections WHERE id = ${connectionId} FOR UPDATE`;
        const state = yield* chainState(tokenHash).pipe(
          Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die })
        );
        // The revocation check comes before anything is issued or served.
        if (!state.live) return "ended";
        if (state.current) {
          const next = newTokens();
          yield* sql`
            UPDATE agent_connection_refresh_tokens
            SET rotated_at = clock_timestamp(), retry = ${sealRetry(refreshToken, connectionId, next)}
            WHERE token_hash = ${tokenHash}`;
          const issued = yield* issue(connectionId, next);
          yield* sql`
            DELETE FROM agent_connection_access_tokens
            WHERE connection_id = ${connectionId} AND expires_at <= clock_timestamp()`;
          return issued;
        }
        if (state.retry !== null) {
          const retried = openRetry(refreshToken, connectionId, state.retry);
          const { seconds } = yield* secondsLeft(sha256(retried.accessToken)).pipe(
            Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die })
          );
          return { ...retried, expiresIn: seconds };
        }
        yield* sql`
          UPDATE agent_connections SET revoked_at = clock_timestamp()
          WHERE id = ${connectionId} AND revoked_at IS NULL`;
        return "reused";
      })
    );
    if (typeof outcome === "string") return yield* new RefreshRefused({ reason: outcome });
    return outcome;
  });

  // Independent of any connection's traffic, so a copy outlives its minute only until the
  // next pass, whether or not anyone calls again.
  const sweepRetries = Effect.asVoid(
    sql`
    UPDATE agent_connection_refresh_tokens SET retry = NULL
    WHERE retry IS NOT NULL AND rotated_at <= clock_timestamp() - interval '1 minute'`
  ).pipe(Effect.withSpan("AgentConnections.sweepRetries"));

  const list = Effect.fn("AgentConnections.list")(function* (userId: string) {
    const rows = yield* liveConnections(userId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    return rows.map((row): Listed => ({
      ...row,
      connectedAt: row.connectedAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      endsAt: row.endsAt.toISOString()
    }));
  });

  // The UPDATE takes the connection's row, so a refresh rotating it finishes first, or waits and
  // then finds it ended.
  const disconnect = Effect.fn("AgentConnections.disconnect")(function* (input: {
    readonly id: string;
    readonly userId: string;
  }) {
    const rows = yield* sql`
      UPDATE agent_connections SET revoked_at = COALESCE(revoked_at, clock_timestamp())
      WHERE id = ${input.id} AND user_id = ${input.userId} RETURNING id`;
    if (rows.length === 0) return yield* new AgentConnectionNotFound({ id: input.id });
  });

  return AgentConnections.of({
    create,
    authenticate,
    current,
    chainOf,
    refresh,
    sweepRetries,
    list,
    disconnect
  });
});

export const layer = Layer.effect(AgentConnections, make);
