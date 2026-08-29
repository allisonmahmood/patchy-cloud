/**
 * The ordered schema-migration list both drivers share, the draft tables'
 * half of the schema: `@patchy/auth` owns migrations 1 and 2.
 *
 * A migration is one additive schema step with an optional part per driver:
 * `postgres` is a DDL string, `json` is an idempotent transform that
 * default-fills the new fields on rows written by any earlier schema version.
 * A step may be omitted when a driver has nothing to do — a Postgres index has
 * no JSON analogue, and a JSON default-fill is a Postgres column default.
 *
 * Postgres steps run through Effect's Migrator (`@patchy/sql`, via
 * `migrate.ts`): the `schema_migrations` ledger is the guard, so a step is
 * plain DDL with no `IF NOT EXISTS`, and every pending step runs in one
 * transaction. The JSON driver keeps its own ledger (the `schemaMigrations`
 * array) and runs the `json` steps itself.
 *
 * See `packages/db/README.md` for how to add one.
 */
export interface SchemaMigration {
  /**
   * `<id>_<name>`, immutable once merged. The Migrator parses the leading
   * integer as the migration id — one global sequence, so apply order is id
   * order and a duplicate id fails the run.
   */
  readonly id: string;
  /** DDL, possibly several statements. Omit when the migration does not touch Postgres. */
  readonly postgres?: string;
  /**
   * Idempotent in-place transform of the parsed JSON state. Runs before the
   * row guards, so it is what teaches them a row shape they don't know yet.
   * Omit when the migration does not touch the JSON driver.
   */
  readonly json?: (state: JsonMigrationState) => void;
}

/**
 * The JSON state as a migration sees it: parsed but not yet guarded, so every
 * field is untrusted. Migrations read defensively and write concrete values.
 */
export type JsonMigrationState = Record<string, unknown>;

/** The name of the JSON state's migration ledger. */
export const JSON_MIGRATION_LEDGER_KEY = "schemaMigrations";

const JSON_ROW_COLLECTIONS = [
  "accounts",
  "apiTokens",
  "drafts",
  "draftVersions",
  "uploadEvents"
] as const;

/** The JSON collection `0007_self_service_mint_records` introduces. */
const JSON_TOKEN_MINTS_COLLECTION = "tokenMints";

/**
 * The retention window as of `0005_drafts_expiry_columns`, frozen here on
 * purpose. A merged migration's behavior must not follow a later retuning of
 * the live policy, so this deliberately does not read `retention.ts` — and the
 * Postgres step spells the same 90 days out in SQL.
 */
const MIGRATION_0005_BACKFILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    // Ids 1 and 2 are `@patchy/auth`'s (`accounts`, `api_tokens`,
    // `token_mints`); the draft tables start at 3. The JSON step still
    // initialises every collection, tokens included: the JSON driver keeps
    // its own token store until the `patches` port deletes it.
    id: "0003_drafts_baseline",
    postgres: `
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        title TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'unlisted',
        current_version_id TEXT,
        repo_org TEXT,
        repo_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ,
        disabled_at TIMESTAMPTZ,
        disabled_reason TEXT
      );

      CREATE TABLE draft_versions (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id),
        version_number INTEGER NOT NULL,
        object_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by_api_token_id TEXT NOT NULL REFERENCES api_tokens(id),
        source_ip TEXT,
        user_agent TEXT,
        cli_version TEXT,
        git_branch TEXT,
        git_commit_sha TEXT,
        original_filename TEXT,
        UNIQUE (draft_id, version_number)
      );

      CREATE TABLE upload_events (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id),
        draft_version_id TEXT REFERENCES draft_versions(id),
        api_token_id TEXT NOT NULL REFERENCES api_tokens(id),
        event_type TEXT NOT NULL,
        source_ip TEXT,
        user_agent TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX draft_versions_draft_id_idx ON draft_versions(draft_id);
      CREATE INDEX upload_events_draft_id_idx ON upload_events(draft_id);
    `,
    json(state) {
      for (const collection of JSON_ROW_COLLECTIONS) {
        if (!Array.isArray(state[collection])) state[collection] = [];
      }
    }
  },
  {
    id: "0004_drafts_account_id_index",
    // Ownership lookups (a principal's live drafts) scan by account today.
    // JSON has no index concept, so this migration has no JSON step.
    postgres: `CREATE INDEX drafts_account_id_idx ON drafts(account_id);`
  },
  {
    id: "0005_drafts_expiry_columns",
    // The retention clock's anchor. Backfilling to migration time + the full
    // window is what keeps the deploy itself from expiring anything: every
    // pre-existing draft leaves this step with a whole window ahead of it.
    // The default is a floor, not the path — the drivers write the anchor from
    // their injected clock so a test can move it.
    postgres: `
      ALTER TABLE drafts ADD COLUMN expires_at TIMESTAMPTZ;
      UPDATE drafts SET expires_at = now() + interval '90 days' WHERE expires_at IS NULL;
      ALTER TABLE drafts ALTER COLUMN expires_at SET NOT NULL;
      ALTER TABLE drafts ALTER COLUMN expires_at SET DEFAULT now() + interval '90 days';
      CREATE INDEX drafts_expires_at_idx ON drafts(expires_at);
    `,
    json(state) {
      const drafts = state.drafts;
      if (!Array.isArray(drafts)) return;

      const backfill = new Date(Date.now() + MIGRATION_0005_BACKFILL_WINDOW_MS).toISOString();
      for (const draft of drafts) {
        if (!draft || typeof draft !== "object") continue;
        const row = draft as Record<string, unknown>;
        if (typeof row.expiresAt !== "string") row.expiresAt = backfill;
      }
    }
  },
  {
    id: "0006_drafts_pinned_at",
    // The pin: when an operator exempted this draft from expiry, or NULL for an
    // ordinary one. Nullable with no backfill on purpose — "unpinned" is the
    // absence of a pin, so every pre-existing draft is already correct, and the
    // spec's "nothing pre-existing is pinned" needs no work to hold.
    //
    // The partial index is the sweep's: it scans by anchor over unpinned rows
    // only, which is exactly the set the sweep may take.
    postgres: `
      ALTER TABLE drafts ADD COLUMN pinned_at TIMESTAMPTZ;
      CREATE INDEX drafts_expiry_sweep_idx
        ON drafts(expires_at) WHERE pinned_at IS NULL;
    `,
    json(state) {
      const drafts = state.drafts;
      if (!Array.isArray(drafts)) return;

      for (const draft of drafts) {
        if (!draft || typeof draft !== "object") continue;
        const row = draft as Record<string, unknown>;
        // The guard requires the key, and a Postgres NULL is a JSON null.
        if (typeof row.pinnedAt !== "string" && row.pinnedAt !== null) {
          row.pinnedAt = null;
        }
      }
    }
  },
  {
    id: "0007_self_service_mint_records",
    // The JSON driver's mint records and its provenance mark on the principal.
    // On Postgres both are `@patchy/auth`'s (`token_mints`, migration 2), so
    // this step has no Postgres part.
    json(state) {
      if (!Array.isArray(state[JSON_TOKEN_MINTS_COLLECTION])) {
        state[JSON_TOKEN_MINTS_COLLECTION] = [];
      }

      const accounts = state.accounts;
      if (!Array.isArray(accounts)) return;
      for (const account of accounts) {
        if (!account || typeof account !== "object") continue;
        const row = account as Record<string, unknown>;
        if (typeof row.selfServiceMintedAt !== "string") row.selfServiceMintedAt = null;
      }
    }
  }
];

/** Every shipped migration ID, in apply order. */
export const SCHEMA_MIGRATION_IDS: readonly string[] = SCHEMA_MIGRATIONS.map(
  (migration) => migration.id
);

export interface JsonMigrationResult {
  state: JsonMigrationState;
  changed: boolean;
}

/**
 * Brings a parsed JSON state up to the current schema in place, recording each
 * applied migration in the ledger. Runs before the row guards: a state written
 * by an earlier schema version becomes guard-valid here or not at all.
 */
export function applyJsonMigrations(
  state: JsonMigrationState,
  migrations: readonly SchemaMigration[] = SCHEMA_MIGRATIONS
): JsonMigrationResult {
  const persistedLedger = state[JSON_MIGRATION_LEDGER_KEY];
  const ledger = readJsonLedger(state);
  const applied = new Set(ledger);
  // A missing or partly unreadable ledger is itself a change worth persisting.
  let changed = !Array.isArray(persistedLedger) || persistedLedger.length !== ledger.length;

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    migration.json?.(state);
    ledger.push(migration.id);
    applied.add(migration.id);
    changed = true;
  }

  state[JSON_MIGRATION_LEDGER_KEY] = ledger;
  return { state, changed };
}

function readJsonLedger(state: JsonMigrationState): string[] {
  const ledger = state[JSON_MIGRATION_LEDGER_KEY];
  if (!Array.isArray(ledger)) return [];
  return ledger.filter((id): id is string => typeof id === "string");
}
