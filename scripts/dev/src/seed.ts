/**
 * The dev seed: one company and one working token, as SQL fixtures. The dev
 * runner applies it to a fresh instance and `test/postgres.ts` applies it to
 * the vitest template database, so a test and `pnpm dev` see the same rows.
 *
 * Plain Promises on purpose: vitest's globalSetup is not Effect code, and
 * the runner wraps this at its seam.
 */
import pg from "pg";
import { sha256 } from "@patchy/core";
import { DEV_TOKEN } from "./plan.js";

export const DEV_SEED = {
  accountId: "acct_dev",
  accountName: "Patchy Dev",
  tokenId: "tok_dev",
  tokenName: "Dev Token",
  token: DEV_TOKEN
} as const;

/** Idempotent: re-running restores the token if it was rotated or revoked. */
const DEV_SEED_SQL: ReadonlyArray<{
  readonly text: string;
  readonly values: ReadonlyArray<string>;
}> = [
  {
    text: `
        INSERT INTO accounts (id, name)
        VALUES ($1, $2)
        ON CONFLICT (id) DO NOTHING
      `,
    values: [DEV_SEED.accountId, DEV_SEED.accountName]
  },
  {
    text: `
        INSERT INTO api_tokens (id, account_id, name, token_hash, scopes)
        VALUES ($1, $2, $3, $4, '["admin", "upload"]'::jsonb)
        ON CONFLICT (id) DO UPDATE
          SET token_hash = EXCLUDED.token_hash,
              scopes = EXCLUDED.scopes,
              revoked_at = NULL
      `,
    values: [DEV_SEED.tokenId, DEV_SEED.accountId, DEV_SEED.tokenName, sha256(DEV_SEED.token)]
  }
];

/** Applies the seed to an already migrated database. */
export async function applyDevSeed(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const statement of DEV_SEED_SQL) {
      await client.query(statement.text, [...statement.values]);
    }
  } finally {
    await client.end();
  }
}
