/**
 * Connections for agent clients that can't do OAuth, such as the environment's
 * `worker-codex` and `worker-grok`: `pnpm dev mcp-token` mints the `use` token
 * Patchy's OAuth flow would have, straight into the dev database.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { MachineTokens } from "@patchy/auth";

/** The dev OAuth client registration standing in for `client`: one per name, stable across mints. */
export const devClientId = (client: string) =>
  `ocl_env_${
    client
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "client"
  }`;

/**
 * A `use` token for `userId`, minted through MachineTokens so it is stored, expires and is
 * revoked (on Your machines) exactly like an OAuth connection, and, like reconnecting,
 * replaces the person's earlier live token for the same client. Its name is the client's,
 * which is what handlers see as `ctx.agent.name`.
 */
export const mintAgentToken = Effect.fn("mintAgentToken")(function* (
  userId: string,
  client: string
) {
  const sql = yield* SqlClient.SqlClient;
  const tokens = yield* MachineTokens.MachineTokens;
  const clientId = devClientId(client);
  yield* sql`
    INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
    VALUES (${clientId}, ${client}, '[]'::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
  return yield* tokens.mint({ userId, name: client, oauthClientId: clientId });
});
