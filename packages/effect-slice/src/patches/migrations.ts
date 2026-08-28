/** Migrations owned by the patches capability. Ids continue the global sequence. */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const patchMigrations = {
  "0003_drafts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        title TEXT NOT NULL,
        current_version_id TEXT,
        last_visited_at TIMESTAMPTZ
      )`;
  }),
  "0004_draft_versions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE draft_versions (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id),
        version_number INTEGER NOT NULL,
        object_key TEXT NOT NULL,
        UNIQUE (draft_id, version_number)
      )`;
  })
};
