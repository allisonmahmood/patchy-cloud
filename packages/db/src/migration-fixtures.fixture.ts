/**
 * Fixtures the JSON driver's migration tests share: a state file as the code
 * before this mechanism would have left it, and probe migrations that prove a
 * step really ran. Not shipped behavior — only the tests import this module.
 * (Postgres migrates through `@patchy/sql`, whose tests cover the Migrator.)
 */
import { sha256 } from "@patchy/core";
import type { SchemaMigration } from "./migrations.js";

export const LEGACY_ACCOUNT_ID = "acct_legacy";
export const LEGACY_API_TOKEN_ID = "tok_legacy";
export const LEGACY_TOKEN = "legacy-token";
export const LEGACY_DRAFT_ID = "legacydraft1";
export const LEGACY_VERSION_ID = "ver_legacy_one";
export const LEGACY_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/**
 * A JSON state file at the schema deployed before migrations existed: the five
 * row collections, no ledger. `omitDraftField` drops a field the current guards
 * require, standing in for a state written by an earlier schema version.
 */
export function deployedJsonStateFixture(omitDraftField?: string): Record<string, unknown> {
  const draft: Record<string, unknown> = {
    id: LEGACY_DRAFT_ID,
    accountId: LEGACY_ACCOUNT_ID,
    title: "Legacy draft",
    visibility: "unlisted",
    currentVersionId: LEGACY_VERSION_ID,
    repoOrg: null,
    repoName: null,
    createdAt: LEGACY_TIMESTAMP,
    updatedAt: LEGACY_TIMESTAMP,
    deletedAt: null,
    disabledAt: null,
    disabledReason: null
  };
  // No `expiresAt`: a deployed state predates the retention clock, and the
  // backfill in `0003_drafts_expiry_columns` is what makes it readable again.
  if (omitDraftField) delete draft[omitDraftField];

  return {
    accounts: [
      {
        id: LEGACY_ACCOUNT_ID,
        name: "Legacy Account",
        createdAt: LEGACY_TIMESTAMP,
        updatedAt: LEGACY_TIMESTAMP
      }
    ],
    apiTokens: [
      {
        id: LEGACY_API_TOKEN_ID,
        accountId: LEGACY_ACCOUNT_ID,
        name: "Legacy API Token",
        tokenHash: sha256(LEGACY_TOKEN),
        scopes: ["upload"],
        createdAt: LEGACY_TIMESTAMP,
        lastUsedAt: null,
        revokedAt: null
      }
    ],
    drafts: [draft],
    draftVersions: [
      {
        id: LEGACY_VERSION_ID,
        draftId: LEGACY_DRAFT_ID,
        versionNumber: 1,
        objectKey: `drafts/${LEGACY_DRAFT_ID}/versions/${LEGACY_VERSION_ID}.html`,
        contentHash: "sha256:one",
        fileSize: 11,
        createdByApiTokenId: LEGACY_API_TOKEN_ID,
        sourceIp: null,
        userAgent: null,
        cliVersion: null,
        gitBranch: null,
        gitCommitSha: null,
        originalFilename: "legacy.html",
        createdAt: LEGACY_TIMESTAMP
      }
    ],
    uploadEvents: []
  };
}

export const PROBE_ADD_MIGRATION_ID = "9990_probe_add_drafts_review_note";
export const PROBE_REQUIRE_MIGRATION_ID = "9991_probe_require_drafts_review_note";

/** Adds one nullable field. */
export const PROBE_ADD_MIGRATION: SchemaMigration = {
  id: PROBE_ADD_MIGRATION_ID,
  json(state) {
    const drafts = state.drafts;
    if (!Array.isArray(drafts)) return;
    for (const draft of drafts) {
      if (draft && typeof draft === "object" && !("reviewNote" in draft)) {
        (draft as Record<string, unknown>).reviewNote = null;
      }
    }
  }
};

/**
 * Depends on the field the previous probe adds, and fails loudly without it.
 * Running this one alone is how a test proves the earlier step really ran,
 * rather than passing because neither step did anything observable.
 */
export const PROBE_REQUIRE_MIGRATION: SchemaMigration = {
  id: PROBE_REQUIRE_MIGRATION_ID,
  json(state) {
    const drafts = state.drafts;
    if (!Array.isArray(drafts)) return;
    for (const draft of drafts) {
      if (draft && typeof draft === "object" && !("reviewNote" in draft)) {
        throw new Error("Probe migration ran before the field it depends on existed.");
      }
    }
  }
};

/**
 * Backfills a field the current row guards require. A state missing it is only
 * readable because migrations run before the guards.
 */
export const BACKFILL_DISABLED_REASON_MIGRATION: SchemaMigration = {
  id: "9992_probe_backfill_disabled_reason",
  json(state) {
    const drafts = state.drafts;
    if (!Array.isArray(drafts)) return;
    for (const draft of drafts) {
      if (draft && typeof draft === "object" && !("disabledReason" in draft)) {
        (draft as Record<string, unknown>).disabledReason = null;
      }
    }
  }
};
