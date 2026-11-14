import { type GithubAccount } from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as CredentialKeys from "../CredentialKeys.js";
import * as Access from "./Access.js";
import * as Connection from "./Connection.js";
import * as Source from "./Source.js";

/**
 * One admin's sign-in to GitHub while choosing repositories: a platform row holding the company,
 * the admin, a hashed nonce, a PKCE verifier and when it expires, and once GitHub signs them in,
 * who they are there and their token, sealed. Identity comes only from an authorization Patchy
 * started: every request carries a fresh nonce as `state` and an S256 challenge, and its return
 * consumes the nonce once, so a replay on any host finds nothing. Only the return of the row's
 * newest request seals its token there. The token never leaves the row; the row goes when the
 * connection saves or it expires, and the token it held then is revoked at GitHub. A token no row
 * takes is revoked at once.
 */

export type Purpose = "connect" | "add" | "reconnect";

/** An admin's live sign-in: what it's for, and who GitHub says they are once it signed them in. */
export interface Flow {
  readonly id: string;
  readonly purpose: Purpose;
  /** The connection an Add or Reconnect is for; none when connecting a new one. */
  readonly connectionId: string | null;
  readonly signedIn: Option.Option<{
    readonly id: number;
    readonly login: string;
    readonly token: Redacted.Redacted<string>;
  }>;
}

/** One account's installation as the person sees it, with the repositories they administer. */
export interface Listed {
  readonly installationId: number;
  readonly account: GithubAccount;
  readonly suspended: boolean;
  /** Only repositories GitHub says this person administers, exactly. */
  readonly repositories: ReadonlyArray<Source.Repository>;
  /** False when the installation held more than Patchy reads for the picker. */
  readonly complete: boolean;
}

/** What the person administers, by account; `complete` is false when they see more installations than Patchy reads. */
export interface Listing {
  readonly accounts: ReadonlyArray<Listed>;
  readonly complete: boolean;
}

/** The repositories submitted, as GitHub shows them to this person now. */
export interface Verified {
  readonly installationId: number;
  readonly account: GithubAccount;
  readonly repositories: ReadonlyArray<Source.Repository>;
}

/** A flow row's token, sealed, as the statement that deleted or replaced it returned it. */
export interface Held {
  readonly id: string;
  readonly token: string | null;
  readonly keyId: string | null;
}

const FlowRow = Schema.Struct({
  id: Schema.String,
  purpose: Schema.Literals(["connect", "add", "reconnect"]),
  connectionId: Schema.NullOr(Schema.String),
  githubUserId: Schema.NullOr(Schema.Number),
  githubLogin: Schema.NullOr(Schema.String),
  token: Schema.NullOr(Schema.String),
  keyId: Schema.NullOr(Schema.String)
});

export class Flows extends Context.Service<
  Flows,
  {
    /**
     * Continue with GitHub: the admin's new flow, replacing any they had, and where to send their
     * browser. `selectAccount` lets them sign in as another GitHub account.
     */
    readonly start: (input: {
      readonly companyId: string;
      readonly userId: string;
      readonly purpose: Purpose;
      readonly connectionId: string | null;
      readonly redirectUri: string;
      readonly selectAccount: boolean;
    }) => Effect.Effect<
      string,
      Source.NotOffered | Access.StorageFailed | CredentialKeys.CredentialError
    >;
    /**
     * The setup URL's return, which proves nothing and may carry no `state` (shown): a new
     * authorization request on the admin's live flow, or none when they have none.
     */
    readonly restart: (input: {
      readonly companyId: string;
      readonly userId: string;
      readonly redirectUri: string;
    }) => Effect.Effect<Option.Option<string>, Source.NotOffered | Access.StorageFailed>;
    /**
     * The authorization's return: consumes its nonce, only for the admin and company that started
     * it, exchanges the code with the verifier, reads who the token is, and seals it into the flow.
     */
    readonly callback: (input: {
      readonly companyId: string;
      readonly userId: string;
      readonly code: string;
      readonly state: string;
      readonly redirectUri: string;
    }) => Effect.Effect<
      { readonly purpose: Purpose; readonly connectionId: string | null },
      | Connection.SignInRequired
      | Source.SignInFailed
      | Source.SignInEnded
      | Source.SendError
      | Source.RateLimited
      | Source.NotOffered
      | Access.StorageFailed
      | CredentialKeys.CredentialError
    >;
    /** The admin's live flow, its token opened; none when they have none or it expired. */
    readonly current: (input: {
      readonly companyId: string;
      readonly userId: string;
    }) => Effect.Effect<Option.Option<Flow>, Access.StorageFailed>;
    /**
     * The installations of the App the person can see, up to the picker's bound, each with the
     * repositories GitHub says they administer, up to its own. Accounts of another type are left
     * out. Like `verify` and `installationOn`, it holds one of GitHub's host-wide slots and keeps
     * to one integration deadline.
     */
    readonly listing: (
      token: Redacted.Redacted<string>
    ) => Effect.Effect<Listing, Source.UserError | Source.Busy>;
    /**
     * The submitted repositories read again with the person's token now: every one must be in
     * that installation with `admin` exactly true, or the refusal names those that aren't.
     */
    readonly verify: (
      token: Redacted.Redacted<string>,
      request: Connection.Request
    ) => Effect.Effect<
      Verified,
      | Source.UserError
      | Source.Busy
      | Connection.NoRepositories
      | Connection.OneAccount
      | Connection.TooManyRepositories
      | Connection.NotAdmin
      | Connection.AccountType
    >;
    /** The installation of the App on the account with this numeric id that the person can see. */
    readonly installationOn: (
      token: Redacted.Redacted<string>,
      accountId: number
    ) => Effect.Effect<Option.Option<number>, Source.UserError | Source.Busy>;
    /**
     * Revokes the token a flow row held when a save deleted it, as the deleting statement returned
     * it. Best effort: it never fails.
     */
    readonly revoke: (companyId: string, held: Held) => Effect.Effect<void>;
    /** Deletes every expired flow and revokes its token. */
    readonly sweep: Effect.Effect<void, SqlError>;
  }
>()("@patchy/integrations/github/Flows") {}

export const make = Effect.gen(function* () {
  const source = yield* Source.Source;
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* CredentialKeys.CredentialKeys;
  const cryptography = yield* Cryptography.Cryptography;
  const ttl = yield* ContractLimits.get("github.flow.ttl");
  const deadline = yield* ContractLimits.get("integration.deadline");
  const installationsMax = yield* ContractLimits.get("github.picker.installations");
  const pickerMax = yield* ContractLimits.get("github.picker.repositories");
  const repositoriesMax = yield* ContractLimits.get("github.connection.repositories");
  const stored = (cause: SqlError | Schema.SchemaError) =>
    new Access.StorageFailed({ cause: Redacted.make(cause) });
  const sealingOf = (companyId: string, id: string) =>
    ({ companyId, id, integration: "github" }) as const;

  /** A fresh nonce, its hash as stored, a verifier and its S256 challenge. */
  const request = Effect.gen(function* () {
    const state = yield* cryptography.token(32);
    const verifier = yield* cryptography.token(32);
    const challenge = Buffer.from(yield* cryptography.digest("SHA-256", verifier)).toString(
      "base64url"
    );
    return { state, nonceHash: yield* cryptography.sha256(state), verifier, challenge };
  });

  /** A flow row's token, opened; none when it holds none or it can't be opened. */
  const tokenOf = (companyId: string, row: Held) =>
    row.token === null || row.keyId === null
      ? Effect.succeed(Option.none<Redacted.Redacted<string>>())
      : keys
          .decrypt(sealingOf(companyId, row.id), { credentials: row.token, keyId: row.keyId })
          .pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>())
          );
  const revokeAll = (companyId: string, rows: ReadonlyArray<Held>) =>
    Effect.forEach(
      rows,
      (row) =>
        Effect.flatMap(tokenOf(companyId, row), (token) =>
          Option.isSome(token) ? source.revokeUser(token.value) : Effect.void
        ),
      { discard: true }
    );

  const start = Effect.fn("GithubFlows.start")(function* (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly purpose: Purpose;
    readonly connectionId: string | null;
    readonly redirectUri: string;
    readonly selectAccount: boolean;
  }) {
    // Offered or not is known before anything is written.
    yield* source.installUrl;
    const id = yield* cryptography.internalId("ghf");
    const fresh = yield* request;
    const replaced = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const old =
            yield* sql<Held>`DELETE FROM github_flows WHERE company_id = ${input.companyId} AND user_id = ${input.userId}
            RETURNING id, token, key_id AS "keyId"`;
          yield* sql`INSERT INTO github_flows
            (id, company_id, user_id, purpose, connection_id, nonce_hash, verifier, expires_at)
            VALUES (${id}, ${input.companyId}, ${input.userId}, ${input.purpose},
              ${input.connectionId}, ${fresh.nonceHash}, ${fresh.verifier},
              now() + ${`${ttl} milliseconds`}::interval)`;
          return old;
        })
      )
      .pipe(Effect.mapError(stored));
    yield* revokeAll(input.companyId, replaced);
    return yield* source.authorizeUrl({
      state: fresh.state,
      challenge: fresh.challenge,
      redirectUri: input.redirectUri,
      selectAccount: input.selectAccount
    });
  });

  const restart = Effect.fn("GithubFlows.restart")(function* (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly redirectUri: string;
  }) {
    yield* source.installUrl;
    const fresh = yield* request;
    const found = yield* sql<{ readonly id: string }>`UPDATE github_flows SET
        nonce_hash = ${fresh.nonceHash}, verifier = ${fresh.verifier}, nonce_consumed_at = NULL,
        expires_at = now() + ${`${ttl} milliseconds`}::interval
      WHERE company_id = ${input.companyId} AND user_id = ${input.userId} AND expires_at > now()
      RETURNING id`.pipe(Effect.mapError(stored));
    if (found.length === 0) return Option.none<string>();
    // GitHub answers someone who already authorized without asking again (shown).
    return Option.some(
      yield* source.authorizeUrl({
        state: fresh.state,
        challenge: fresh.challenge,
        redirectUri: input.redirectUri,
        selectAccount: false
      })
    );
  });

  const consume = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyId: Schema.String,
      userId: Schema.String,
      nonceHash: Schema.String
    }),
    Result: Schema.Struct({
      id: Schema.String,
      purpose: FlowRow.fields.purpose,
      connectionId: Schema.NullOr(Schema.String),
      verifier: Schema.String
    }),
    // Atomic: of two returns with one nonce, on any hosts, one finds the row and the other nothing.
    execute: ({ companyId, userId, nonceHash }) => sql`UPDATE github_flows
      SET nonce_consumed_at = now()
      WHERE nonce_hash = ${nonceHash} AND nonce_consumed_at IS NULL AND expires_at > now()
        AND company_id = ${companyId} AND user_id = ${userId}
      RETURNING id, purpose, connection_id AS "connectionId", verifier`
  });

  /**
   * Reads who `token` is and seals it into the flow, only while the row's nonce is still the one
   * this return consumed and it hasn't expired: a restart since gave the row a newer request,
   * whose own return is the one that signs in. Refuses otherwise. Gives back the token the row
   * held until now, which an earlier return sealed there, for the caller to revoke.
   */
  const keep = (
    input: { readonly companyId: string; readonly userId: string },
    flowId: string,
    nonceHash: string,
    token: Redacted.Redacted<string>
  ) =>
    Effect.gen(function* () {
      const who = yield* source.user(token);
      const sealed = yield* keys.encrypt(sealingOf(input.companyId, flowId), token);
      const replaced = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [row] = yield* sql<Held>`SELECT id, token, key_id AS "keyId" FROM github_flows
              WHERE id = ${flowId} AND company_id = ${input.companyId} AND user_id = ${input.userId}
                AND nonce_hash = ${nonceHash} AND expires_at > now()
              FOR UPDATE`;
            if (row === undefined) return Option.none<Held>();
            yield* sql`UPDATE github_flows SET
                token = ${sealed.credentials}, key_id = ${sealed.keyId},
                github_user_id = ${who.id}, github_login = ${who.login}
              WHERE id = ${flowId}`;
            return Option.some(row);
          })
        )
        .pipe(Effect.mapError(stored));
      if (Option.isNone(replaced)) return yield* new Connection.SignInRequired({});
      return replaced.value;
    });

  const callback = Effect.fn("GithubFlows.callback")(function* (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly code: string;
    readonly state: string;
    readonly redirectUri: string;
  }) {
    if (input.state === "" || input.code === "") return yield* new Connection.SignInRequired({});
    const nonceHash = yield* cryptography.sha256(input.state);
    const found = yield* consume({
      companyId: input.companyId,
      userId: input.userId,
      nonceHash
    }).pipe(Effect.mapError(stored));
    if (Option.isNone(found)) return yield* new Connection.SignInRequired({});
    const flow = found.value;
    // Once the exchange answers, its token is live at GitHub: every way this return ends but the
    // row holding it, a refusal, a failed write or an interruption, revokes it.
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(
        restore(
          source.exchange({
            code: input.code,
            verifier: flow.verifier,
            redirectUri: input.redirectUri
          })
        ),
        (token) =>
          restore(keep(input, flow.id, nonceHash, token)).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : source.revokeUser(token)
            ),
            // The token an earlier return sealed there, before the setup URL started another request.
            Effect.flatMap((replaced) => revokeAll(input.companyId, [replaced]))
          )
      )
    );
    return { purpose: flow.purpose, connectionId: flow.connectionId };
  });

  const currentRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, userId: Schema.String }),
    Result: FlowRow,
    execute: ({ companyId, userId }) => sql`SELECT id, purpose, connection_id AS "connectionId",
      github_user_id::float8 AS "githubUserId", github_login AS "githubLogin", token, key_id AS "keyId"
      FROM github_flows WHERE company_id = ${companyId} AND user_id = ${userId} AND expires_at > now()`
  });
  const current = Effect.fn("GithubFlows.current")(function* (input: {
    readonly companyId: string;
    readonly userId: string;
  }) {
    const found = yield* currentRow(input).pipe(Effect.mapError(stored));
    if (Option.isNone(found)) return Option.none<Flow>();
    const row = found.value;
    const token = yield* tokenOf(input.companyId, row);
    return Option.some<Flow>({
      id: row.id,
      purpose: row.purpose,
      connectionId: row.connectionId,
      signedIn:
        Option.isSome(token) && row.githubUserId !== null && row.githubLogin !== null
          ? Option.some({ id: row.githubUserId, login: row.githubLogin, token: token.value })
          : Option.none()
    });
  });

  /**
   * Runs reads with the person's token inside GitHub's host-wide slots, within one integration
   * deadline. A limit answer to them is that person's own, so it writes no cooldown.
   */
  const admitted = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => source.withHost(now + deadline)(effect));
  const installationsOf = (token: Redacted.Redacted<string>) =>
    source.userInstallations(token, installationsMax);

  const listing = Effect.fn("GithubFlows.listing")(function* (token: Redacted.Redacted<string>) {
    return yield* admitted(
      Effect.gen(function* () {
        const found = yield* installationsOf(token);
        const accounts: Array<Listed> = [];
        for (const installation of found.installations) {
          // An account of a type Patchy doesn't connect is left out, never taken for a personal one.
          if (Option.isNone(installation.account)) continue;
          const repositories = yield* source.userRepositories(token, installation.id, pickerMax);
          accounts.push({
            installationId: installation.id,
            account: installation.account.value,
            suspended: installation.suspended,
            repositories: repositories.repositories.filter((item) => item.admin),
            complete: repositories.complete
          });
        }
        return { accounts, complete: found.complete } satisfies Listing;
      })
    );
  });

  const verify = Effect.fn("GithubFlows.verify")(function* (
    token: Redacted.Redacted<string>,
    submitted: Connection.Request
  ) {
    const asked = [...new Map(submitted.repositories.map((item) => [item.id, item])).values()];
    if (asked.length === 0) return yield* new Connection.NoRepositories({});
    const installationIds = new Set(asked.map((item) => item.installationId));
    if (installationIds.size > 1) return yield* new Connection.OneAccount({});
    if (asked.length > repositoriesMax)
      return yield* new Connection.TooManyRepositories({ max: repositoriesMax });
    const installationId = asked[0]!.installationId;
    return yield* admitted(
      Effect.gen(function* () {
        const installation = (yield* installationsOf(token)).installations.find(
          (item) => item.id === installationId
        );
        if (installation === undefined)
          return yield* new Connection.NotAdmin({
            repositories: asked.map((item) => `#${item.id}`)
          });
        if (Option.isNone(installation.account)) return yield* new Connection.AccountType({});
        // The listing is the only authority: `admin` exactly true, read now with the person's token.
        const found = yield* source.userRepositories(token, installationId, pickerMax);
        const byId = new Map(found.repositories.map((item) => [item.id, item] as const));
        const refused = asked.filter((item) => byId.get(item.id)?.admin !== true);
        if (refused.length > 0)
          return yield* new Connection.NotAdmin({
            repositories: refused.map((item) => byId.get(item.id)?.name ?? `#${item.id}`)
          });
        return {
          installationId,
          account: installation.account.value,
          repositories: asked.map((item) => byId.get(item.id)!)
        } satisfies Verified;
      })
    );
  });

  const installationOn = Effect.fn("GithubFlows.installationOn")(function* (
    token: Redacted.Redacted<string>,
    accountId: number
  ) {
    const found = (yield* admitted(installationsOf(token))).installations.find(
      (item) => Option.isSome(item.account) && item.account.value.id === accountId
    );
    return Option.fromNullishOr(found?.id);
  });

  const sweep = Effect.gen(function* () {
    const expired = yield* sql<
      Held & { readonly companyId: string }
    >`DELETE FROM github_flows WHERE expires_at <= now()
      RETURNING id, company_id AS "companyId", token, key_id AS "keyId"`;
    yield* Effect.forEach(expired, (row) => revokeAll(row.companyId, [row]), { discard: true });
  });

  return Flows.of({
    start,
    restart,
    callback,
    current,
    listing,
    verify,
    installationOn,
    revoke: (companyId, held) => revokeAll(companyId, [held]),
    sweep
  });
});

export const layer = Layer.effect(Flows, make);
