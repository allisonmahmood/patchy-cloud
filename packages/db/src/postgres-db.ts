import pg from "pg";
import { newInternalId } from "@patchy/core";
import { DRAFT_VISIT_EXTENSION_WINDOW_MS, expiryAfterUpload } from "./retention.js";
import { UploadTargetError } from "./types.js";
import type {
  DbDriverOptions,
  DraftRecord,
  DraftModerationOptions,
  DraftVersionLookup,
  DraftVersionRecord,
  ModeratedDraftRecord,
  PatchyDb,
  PrincipalDraftListing,
  RecordUploadInput,
  RecordUploadResult,
  UploadTargetInput
} from "./types.js";

const { Pool } = pg;

/**
 * "Not expired" as one SQL predicate, restating `isExpired` from `retention.ts`:
 * a pin exempts the draft outright, and otherwise the anchor must not be past.
 * The argument names the placeholder carrying the clock's reading, which every
 * query using this must bind — and the contract suite is what holds this
 * predicate and the TypeScript rule to the same answers.
 */
function notExpired(clockParameter: number): string {
  return `(drafts.pinned_at IS NOT NULL OR drafts.expires_at >= $${clockParameter}::timestamptz)`;
}

/** A draft's creating token is the one recorded on its first version. */
const FIRST_VERSION_NUMBER = 1;
interface DraftRow extends pg.QueryResultRow {
  id: string;
  account_id: string;
  title: string;
  visibility: DraftRecord["visibility"];
  current_version_id: string | null;
  repo_org: string | null;
  repo_name: string | null;
  created_at: unknown;
  updated_at: unknown;
  expires_at: unknown;
  pinned_at: unknown | null;
  deleted_at: unknown | null;
  disabled_at: unknown | null;
  disabled_reason: string | null;
}

interface ModeratedDraftRow extends DraftRow {
  created_by_api_token_id: string | null;
}

interface DraftVersionRow extends pg.QueryResultRow {
  id: string;
  draft_id: string;
  version_number: string | number;
  object_key: string;
  content_hash: string;
  file_size: string | number;
  created_by_api_token_id: string;
  source_ip: string | null;
  user_agent: string | null;
  cli_version: string | null;
  git_branch: string | null;
  git_commit_sha: string | null;
  original_filename: string | null;
  created_at: unknown;
}

/**
 * A draft with the token that created it, for the moderation loop. `$2` is the
 * first version number; the join is outer so a draft always answers, even when
 * its first version is somehow missing.
 */
const MODERATED_DRAFT_SELECT = `
  SELECT drafts.*, first_version.created_by_api_token_id
  FROM drafts
  LEFT JOIN draft_versions AS first_version
    ON first_version.draft_id = drafts.id
    AND first_version.version_number = $2
`;

export class PostgresPatchyDb implements PatchyDb {
  private readonly pool: pg.Pool;
  private readonly clock: () => number;

  constructor(connectionString: string, options: DbDriverOptions = {}) {
    this.pool = new Pool({ connectionString });
    this.clock = options.clock ?? Date.now;
  }

  /**
   * The retention clock's reading, as a value Postgres compares against
   * `expires_at`. Deliberately not SQL `now()`: the clock is injectable, and
   * `now()` would make the window untestable and drift from the JSON driver.
   *
   * `expires_at` is on this clock here because it is the anchor retention is
   * measured from (`@patchy/auth` keeps `token_mints.created_at`, the mint
   * quota's anchor, on the Effect clock for the same reason). Every other
   * stamp in this driver (`created_at` columns, `disabled_at`, `deleted_at`)
   * stays on SQL `now()`, where it is a column default or a `SET x = now()`
   * clause, while the JSON driver puts all of its stamps on the injected
   * clock. See the note on `JsonFilePatchyDb.nowIso` — the drivers agree on
   * the retention anchor and drift on the rest under a wound-forward clock,
   * which is deliberate. Do not "fix" one driver's non-retention stamps
   * without the other's.
   */
  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  async countLiveDraftsByCreatorApiToken(apiTokenId: string): Promise<number> {
    const result = await this.pool.query(
      `
        SELECT count(*) AS live
        FROM drafts
        JOIN draft_versions ON draft_versions.draft_id = drafts.id
          AND draft_versions.version_number = $2
        WHERE draft_versions.created_by_api_token_id = $1
          AND drafts.deleted_at IS NULL
          AND drafts.disabled_at IS NULL
      `,
      [apiTokenId, FIRST_VERSION_NUMBER]
    );
    return Number(result.rows[0]?.live ?? 0);
  }

  async assertUploadTarget(input: UploadTargetInput): Promise<void> {
    const result =
      input.intent === "update"
        ? await this.pool.query(
            `
              SELECT 1
              FROM drafts
              WHERE id = $1
                AND account_id = $2
                AND deleted_at IS NULL
                AND disabled_at IS NULL
                AND ${notExpired(3)}
            `,
            [input.draftId, input.accountId, this.nowIso()]
          )
        : await this.pool.query("SELECT 1 FROM drafts WHERE id = $1", [input.draftId]);

    if (input.intent === "update" ? !result.rowCount : Boolean(result.rowCount)) {
      throw new UploadTargetError(
        input.intent === "update" ? "draft_unavailable" : "draft_conflict"
      );
    }
  }

  async recordUpload(input: RecordUploadInput): Promise<RecordUploadResult> {
    const client = await this.pool.connect();
    let commitAttempted = false;
    try {
      await client.query("BEGIN");

      const repoOrg = cleanText(input.metadata.repoOrg);
      const repoName = cleanText(input.metadata.repoName);
      // An upload — first version or fifth — restarts the whole window.
      const expiresAt = expiryAfterUpload(this.clock());
      let title: string;
      let versionNumber: number;

      if (input.intent === "update") {
        const existingResult = await client.query(
          `
            SELECT *
            FROM drafts
            WHERE id = $1
              AND account_id = $2
              AND deleted_at IS NULL
              AND disabled_at IS NULL
              AND ${notExpired(3)}
            FOR UPDATE
          `,
          [input.draftId, input.accountId, this.nowIso()]
        );
        const existingDraft = existingResult.rows[0] || null;
        if (!existingDraft) {
          throw new UploadTargetError("draft_unavailable");
        }

        // Allocate after acquiring the draft row lock. A concurrent update for
        // the same draft waits above, then this query sees the committed version.
        const versionResult = await client.query(
          `
            SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
            FROM draft_versions
            WHERE draft_id = $1
          `,
          [input.draftId]
        );
        versionNumber = Number(versionResult.rows[0].next_version);
        title = input.title || existingDraft.title || input.filename || "Untitled Draft";
      } else {
        title = input.title || input.filename || "Untitled Draft";
        versionNumber = 1;
        const createdDraft = await client.query(
          `
            INSERT INTO drafts (
              id, account_id, title, visibility, current_version_id, repo_org, repo_name,
              expires_at
            )
            VALUES ($1, $2, $3, 'unlisted', $4, $5, $6, $7::timestamptz)
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          `,
          [input.draftId, input.accountId, title, input.versionId, repoOrg, repoName, expiresAt]
        );
        if (!createdDraft.rowCount) {
          throw new UploadTargetError("draft_conflict");
        }
      }

      await client.query(
        `
          INSERT INTO draft_versions (
            id, draft_id, version_number, object_key, content_hash, file_size,
            created_by_api_token_id, source_ip, user_agent, cli_version,
            git_branch, git_commit_sha, original_filename
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `,
        [
          input.versionId,
          input.draftId,
          versionNumber,
          input.objectKey,
          input.contentHash,
          input.fileSize,
          input.apiTokenId,
          input.sourceIp,
          input.userAgent,
          cleanText(input.metadata.cliVersion),
          cleanText(input.metadata.gitBranch),
          cleanText(input.metadata.gitCommitSha),
          input.filename
        ]
      );

      await client.query(
        `
          UPDATE drafts
          SET current_version_id = $1,
              title = $2,
              repo_org = COALESCE($3, repo_org),
              repo_name = COALESCE($4, repo_name),
              updated_at = now(),
              expires_at = $6::timestamptz
          WHERE id = $5
        `,
        [input.versionId, title, repoOrg, repoName, input.draftId, expiresAt]
      );

      await client.query(
        `
          INSERT INTO upload_events (
            id, draft_id, draft_version_id, api_token_id, event_type,
            source_ip, user_agent, metadata_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `,
        [
          newInternalId("evt"),
          input.draftId,
          input.versionId,
          input.apiTokenId,
          input.intent === "update" ? "draft.updated" : "draft.created",
          input.sourceIp,
          input.userAgent,
          JSON.stringify(input.metadata)
        ]
      );

      commitAttempted = true;
      await client.query("COMMIT");
      return { draftId: input.draftId, versionId: input.versionId, versionNumber, title };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // A definitive target rejection happened before COMMIT, so preserve it
        // for the server's object-compensation path even if cleanup also fails.
        if (!commitAttempted && error instanceof UploadTargetError) {
          throw error;
        }
        throw rollbackError;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async findDraftVersion(draftId: string, versionNumber?: number): Promise<DraftVersionLookup> {
    const draftResult = await this.pool.query<DraftRow>(
      `
        SELECT *
        FROM drafts
        WHERE id = $1
          AND deleted_at IS NULL
          AND disabled_at IS NULL
          AND ${notExpired(2)}
        LIMIT 1
      `,
      [draftId, this.nowIso()]
    );
    const draft = draftResult.rows[0] ? mapDraft(draftResult.rows[0]) : null;
    if (!draft) return { draft: null, version: null };

    const versionResult = versionNumber
      ? await this.pool.query<DraftVersionRow>(
          `
            SELECT *
            FROM draft_versions
            WHERE draft_id = $1 AND version_number = $2
            LIMIT 1
          `,
          [draft.id, versionNumber]
        )
      : await this.pool.query<DraftVersionRow>(
          "SELECT * FROM draft_versions WHERE id = $1 LIMIT 1",
          [draft.currentVersionId]
        );

    return {
      draft,
      version: versionResult.rows[0] ? mapDraftVersion(versionResult.rows[0]) : null
    };
  }

  async findDraftForModeration(draftId: string): Promise<ModeratedDraftRecord | null> {
    const result = await this.pool.query<ModeratedDraftRow>(
      `
        ${MODERATED_DRAFT_SELECT}
        WHERE drafts.id = $1
        LIMIT 1
      `,
      [draftId, FIRST_VERSION_NUMBER]
    );
    return result.rows[0] ? mapModeratedDraft(result.rows[0]) : null;
  }

  async listDraftsByPrincipal(principalId: string, limit: number): Promise<PrincipalDraftListing> {
    const capped = Math.max(0, limit);
    // One row past the limit is how truncation is detected without a count.
    const result = await this.pool.query<ModeratedDraftRow>(
      `
        ${MODERATED_DRAFT_SELECT}
        WHERE drafts.account_id = $1
          AND drafts.deleted_at IS NULL
        ORDER BY drafts.created_at DESC, drafts.id DESC
        LIMIT $3
      `,
      [principalId, FIRST_VERSION_NUMBER, capped + 1]
    );

    return {
      drafts: result.rows.slice(0, capped).map(mapModeratedDraft),
      truncated: result.rows.length > capped
    };
  }

  async recordDraftVisit(draftId: string): Promise<void> {
    const now = this.clock();
    // One predicate says both halves of the visit rule: `expires_at` below the
    // topped-up anchor is exactly "less than the visit-extension window
    // remains", and it is also exactly "this move does not shorten the clock".
    // The not-expired term keeps a visit from reviving an expired draft — and,
    // because a pin means not expired, keeps topping a pinned draft up. The
    // NOT EXISTS is the revocation freeze: once the draft's creating token is
    // revoked, its clock only runs down.
    await this.pool.query(
      `
        UPDATE drafts
        SET expires_at = $2::timestamptz
        WHERE id = $1
          AND deleted_at IS NULL
          AND disabled_at IS NULL
          AND ${notExpired(3)}
          AND expires_at < $2::timestamptz
          AND NOT EXISTS (
            SELECT 1
            FROM draft_versions
            JOIN api_tokens ON api_tokens.id = draft_versions.created_by_api_token_id
            WHERE draft_versions.draft_id = drafts.id
              AND draft_versions.version_number = $4
              AND api_tokens.revoked_at IS NOT NULL
          )
      `,
      [
        draftId,
        new Date(now + DRAFT_VISIT_EXTENSION_WINDOW_MS).toISOString(),
        new Date(now).toISOString(),
        FIRST_VERSION_NUMBER
      ]
    );
  }

  async setDraftPinned(draftId: string, pinned: boolean): Promise<boolean> {
    // Two statements rather than one predicate carrying a boolean: pinning
    // needs a draft in service, and unpinning takes whatever row is left, so a
    // pin can never be stuck on a draft that has since been taken down.
    const result = pinned
      ? await this.pool.query(
          `
            UPDATE drafts
            SET pinned_at = $2::timestamptz
            WHERE id = $1
              AND deleted_at IS NULL
              AND disabled_at IS NULL
            RETURNING id
          `,
          [draftId, this.nowIso()]
        )
      : await this.pool.query("UPDATE drafts SET pinned_at = NULL WHERE id = $1 RETURNING id", [
          draftId
        ]);
    return Boolean(result.rowCount);
  }

  async listExpiredDraftIds(limit: number): Promise<string[]> {
    if (limit <= 0) return [];

    const result = await this.pool.query(
      `
        SELECT id
        FROM drafts
        WHERE NOT ${notExpired(1)}
        ORDER BY expires_at ASC
        LIMIT $2
      `,
      [this.nowIso(), limit]
    );
    return result.rows.map((row) => String(row.id));
  }

  async deleteExpiredDraft(draftId: string): Promise<string[] | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // The row lock plus the re-check is what makes a concurrent pin safe: a
      // pin either lands before this and the draft is no longer expired, or it
      // waits here and finds nothing left to pin.
      const target = await client.query(
        `
          SELECT id
          FROM drafts
          WHERE id = $1
            AND NOT ${notExpired(2)}
          FOR UPDATE
        `,
        [draftId, this.nowIso()]
      );
      if (!target.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }

      const versions = await client.query(
        "SELECT object_key FROM draft_versions WHERE draft_id = $1",
        [draftId]
      );

      // Foreign keys decide the order: upload events name both the draft and
      // its versions, versions name the draft, and the draft goes last.
      await client.query("DELETE FROM upload_events WHERE draft_id = $1", [draftId]);
      await client.query("DELETE FROM draft_versions WHERE draft_id = $1", [draftId]);
      await client.query("DELETE FROM drafts WHERE id = $1", [draftId]);

      await client.query("COMMIT");
      return versions.rows.map((row) => String(row.object_key));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async disableDraft(
    draftId: string,
    accountId: string,
    reason: string,
    options: DraftModerationOptions = {}
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE drafts
        SET disabled_at = now(), disabled_reason = $3, updated_at = now(),
            -- Out of service, so out of pin: moderation outranks an exemption.
            pinned_at = NULL
        WHERE id = $1
          AND (account_id = $2 OR $4)
          AND deleted_at IS NULL
        RETURNING id
      `,
      [draftId, accountId, reason, options.canModerateAnyPrincipal === true]
    );
    return Boolean(result.rowCount);
  }

  async deleteDraft(
    draftId: string,
    accountId: string,
    options: DraftModerationOptions = {}
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE drafts
        SET deleted_at = now(), updated_at = now(),
            -- A deleted draft keeps no pin, so its storage still ages out.
            pinned_at = NULL
        WHERE id = $1
          AND (account_id = $2 OR $3)
          AND deleted_at IS NULL
        RETURNING id
      `,
      [draftId, accountId, options.canModerateAnyPrincipal === true]
    );
    return Boolean(result.rowCount);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function mapDraft(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    visibility: row.visibility,
    currentVersionId: row.current_version_id,
    repoOrg: row.repo_org,
    repoName: row.repo_name,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    expiresAt: toIso(row.expires_at),
    pinnedAt: row.pinned_at ? toIso(row.pinned_at) : null,
    deletedAt: row.deleted_at ? toIso(row.deleted_at) : null,
    disabledAt: row.disabled_at ? toIso(row.disabled_at) : null,
    disabledReason: row.disabled_reason
  };
}

function mapModeratedDraft(row: ModeratedDraftRow): ModeratedDraftRecord {
  return { ...mapDraft(row), createdByApiTokenId: row.created_by_api_token_id ?? null };
}

function mapDraftVersion(row: DraftVersionRow): DraftVersionRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    versionNumber: Number(row.version_number),
    objectKey: row.object_key,
    contentHash: row.content_hash,
    fileSize: Number(row.file_size),
    createdByApiTokenId: row.created_by_api_token_id,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    cliVersion: row.cli_version,
    gitBranch: row.git_branch,
    gitCommitSha: row.git_commit_sha,
    originalFilename: row.original_filename,
    createdAt: toIso(row.created_at)
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
}
