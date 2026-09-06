/** The runner, test template and packed CLI all publish as this one development user. */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { sha256 } from "@patchy/core";
import * as Sql from "@patchy/sql";

export const DEV_SEED = {
  companyId: "cmp_dev",
  companyHandle: "patchy-dev",
  companyName: "Patchy Dev",
  userId: "usr_dev",
  clerkUserId: "user_dev",
  email: "dev@patchy.local",
  userName: "Patchy Dev",
  role: "admin",
  tokenId: "tok_dev",
  tokenName: "Dev Machine",
  token: "patchy-dev-token"
} as const;

/** Seeds a migrated dev database atomically; the runner and live browser tier can bind a Clerk user. */
export async function applyDevSeed(
  connectionString: string,
  clerkUserId: string = DEV_SEED.clerkUserId
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
        INSERT INTO companies (id, handle, name, created_at)
        VALUES (${DEV_SEED.companyId}, ${DEV_SEED.companyHandle}, ${DEV_SEED.companyName}, now())
        ON CONFLICT (id) DO UPDATE SET handle = EXCLUDED.handle,
          name = EXCLUDED.name, created_at = EXCLUDED.created_at`;
          yield* sql`
        INSERT INTO users (id, clerk_user_id, company_id, email, name, role, created_at)
        VALUES (${DEV_SEED.userId}, ${clerkUserId}, ${DEV_SEED.companyId},
          ${DEV_SEED.email}, ${DEV_SEED.userName}, ${DEV_SEED.role}, now())
        ON CONFLICT (id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id,
          company_id = EXCLUDED.company_id, email = EXCLUDED.email, name = EXCLUDED.name,
          role = EXCLUDED.role, created_at = EXCLUDED.created_at, deactivated_at = NULL`;
          yield* sql`
        INSERT INTO machine_tokens (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
        VALUES (${DEV_SEED.tokenId}, ${DEV_SEED.userId}, ${DEV_SEED.tokenName},
          ${sha256(DEV_SEED.token)}, now(), now() + interval '90 days', now())
        ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name,
          token_hash = EXCLUDED.token_hash, created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at, last_used_at = EXCLUDED.last_used_at, revoked_at = NULL`;
        })
      );
    }).pipe(Effect.provide(Sql.layerFromUrl(Redacted.make(connectionString))))
  );
}
