import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Connection from "./Connection.js";

/**
 * Which Patchy company holds an organization's installation of the App: (installation, company)
 * rows under the installation's parent row. One company per installation is the check in
 * `claim`, not a key, so admitting a second later is an owner's approval, not a migration.
 *
 * Every claim, release, Resume and Reconnect creates or locks the parent row first, in one lock
 * order everywhere: the company (the admin check), then the flow record, then installation rows
 * in ascending id, then the connection. Each runs inside its caller's transaction.
 */

/** Creates the installation's parent row if it has none, then locks it. */
export const lock = Effect.fn("GithubClaims.lock")(function* (installationId: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO github_installations (installation_id) VALUES (${installationId})
    ON CONFLICT DO NOTHING`;
  yield* sql`SELECT installation_id FROM github_installations
    WHERE installation_id = ${installationId} FOR UPDATE`;
});

/**
 * Claims the installation for the company, or confirms it already holds it. Another company's
 * claim refuses, unless `exempt`: a personal account's installation connected by its own user.
 * The parent row must be locked first.
 */
export const claim = Effect.fn("GithubClaims.claim")(function* (input: {
  readonly installationId: number;
  readonly companyId: string;
  readonly account: string;
  readonly exempt: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  if (!input.exempt) {
    const others = yield* sql`SELECT 1 FROM github_installation_claims
      WHERE installation_id = ${input.installationId} AND company_id <> ${input.companyId} LIMIT 1`;
    if (others.length > 0)
      return yield* new Connection.InstallationClaimed({ account: input.account });
  }
  yield* sql`INSERT INTO github_installation_claims (installation_id, company_id)
    VALUES (${input.installationId}, ${input.companyId}) ON CONFLICT DO NOTHING`;
});

/**
 * Drops the company's claim once no connection of its but `except` reads from the installation:
 * a claim lasts through Pause and every state that needs attention, and ends only when the last
 * one is Disconnected or moves to another installation. The parent row must be locked first.
 */
export const release = Effect.fn("GithubClaims.release")(function* (input: {
  readonly installationId: number;
  readonly companyId: string;
  readonly except: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const others = yield* sql`SELECT 1 FROM connections
    WHERE company_id = ${input.companyId} AND integration = 'github' AND id <> ${input.except}
      AND (display->>'installationId')::bigint = ${input.installationId} LIMIT 1`;
  if (others.length === 0)
    yield* sql`DELETE FROM github_installation_claims
      WHERE installation_id = ${input.installationId} AND company_id = ${input.companyId}`;
});

/**
 * Consumes the admin's flow record with the save it was for: only while it's still theirs, the
 * company's, signed in and unexpired. Refuses otherwise, and the save with it.
 */
export const consumeFlow = Effect.fn("GithubClaims.consumeFlow")(function* (input: {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const consumed = yield* sql`DELETE FROM github_flows
    WHERE id = ${input.id} AND company_id = ${input.companyId} AND user_id = ${input.userId}
      AND expires_at > now() AND token IS NOT NULL
    RETURNING id`;
  if (consumed.length === 0) return yield* new Connection.SignInRequired({});
});
