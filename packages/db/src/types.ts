import type { DraftVisibility, UploadMetadata } from "@patchy/core";
import type { SchemaMigration } from "./migrations.js";

/*
 * The token, mint and revocation shapes below belong to the JSON driver alone:
 * `@patchy/auth` owns them on Postgres, and the JSON driver goes with the
 * `patches` port. The `PatchyDb` port no longer names them.
 */
export interface ApiTokenAuth {
  id: string;
  accountId: string;
  accountName: string;
  name: string;
  scopes: string[];
  /**
   * Whether this token's principal came from a self-service mint — the
   * provenance mark, read back on the path every API request already takes so
   * a guardrail can key on it without a second query. Operator-created tokens
   * are false, including every token that predates self-service minting.
   */
  selfService: boolean;
}

export interface DraftRecord {
  id: string;
  accountId: string;
  title: string;
  visibility: DraftVisibility;
  currentVersionId: string | null;
  repoOrg: string | null;
  repoName: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The retention clock's anchor: the draft is expired once this is past,
   * unless `pinnedAt` holds it.
   */
  expiresAt: string;
  /**
   * When an operator pinned this draft, or `null` for an ordinary one. A pinned
   * draft is exempt from expiry — it keeps serving and the sweep never takes
   * it — and is ordinary in every other respect.
   */
  pinnedAt: string | null;
  deletedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
}

export interface DraftVersionRecord {
  id: string;
  draftId: string;
  versionNumber: number;
  objectKey: string;
  contentHash: string;
  fileSize: number;
  createdByApiTokenId: string;
  sourceIp: string | null;
  userAgent: string | null;
  cliVersion: string | null;
  gitBranch: string | null;
  gitCommitSha: string | null;
  originalFilename: string | null;
  createdAt: string;
}

export interface CreateApiTokenInput {
  accountId: string;
  name: string;
  token: string;
  scopes: string[];
}

export interface MintSelfServiceTokenInput {
  /** The plaintext token. Only its hash is stored, exactly as elsewhere. */
  token: string;
  /**
   * The internal name for both the new principal and its token. The server
   * derives it from the mint date; it exists for admin legibility and is never
   * chosen by the client, because the mint operation takes no input at all.
   */
  name: string;
  /** The mint's source address, or null when the request has no usable one. */
  sourceIp: string | null;
}

export interface MintSelfServiceTokenResult {
  accountId: string;
  apiTokenId: string;
  apiTokenName: string;
}

/**
 * A draft as the moderation loop sees it: the ordinary record plus the token
 * that created it, which is the thing revocation acts on. The creating token is
 * fixed at the draft's first version, so a later update by another token never
 * changes who a takedown resolves to.
 *
 * `createdByApiTokenId` is nullable because a draft row can outlive knowledge of
 * its first version only in a corrupt store; the loop reports what it found
 * rather than inventing a culprit.
 */
export interface ModeratedDraftRecord extends DraftRecord {
  createdByApiTokenId: string | null;
}

/** One principal's drafts, as the operator's list read returns them. */
export interface PrincipalDraftListing {
  /** Newest first, deleted drafts excluded. */
  drafts: ModeratedDraftRecord[];
  /** True when the principal holds more than the requested limit. */
  truncated: boolean;
}

/**
 * The outcome of revoking a token. Revoked is a state, never a deletion: the
 * row survives with its mint provenance, and `revokedAt` is the moment the
 * freeze began.
 */
export interface ApiTokenRevocation {
  id: string;
  /** The owning principal — the same row `/api/me` calls the account. */
  accountId: string;
  name: string;
  revokedAt: string;
  /**
   * True when the token was already revoked and this call changed nothing. The
   * first revocation's timestamp stands: it is when top-ups froze, and moving
   * it would rewrite that history.
   */
  alreadyRevoked: boolean;
}

export interface UploadTargetInput {
  intent: "create" | "update";
  draftId: string;
  accountId: string;
}

export interface RecordUploadInput extends UploadTargetInput {
  versionId: string;
  apiTokenId: string;
  title: string;
  objectKey: string;
  contentHash: string;
  fileSize: number;
  filename: string | null;
  metadata: UploadMetadata;
  sourceIp: string | null;
  userAgent: string | null;
}

export type UploadTargetErrorCode = "draft_unavailable" | "draft_conflict";

export class UploadTargetError extends Error {
  readonly statusCode: 404 | 409;

  constructor(readonly code: UploadTargetErrorCode) {
    super(code === "draft_unavailable" ? "Draft not found." : "Draft already exists.");
    this.statusCode = code === "draft_unavailable" ? 404 : 409;
  }
}

export function isUploadTargetError(error: unknown): error is UploadTargetError {
  return error instanceof UploadTargetError;
}

export interface RecordUploadResult {
  draftId: string;
  versionId: string;
  versionNumber: number;
  title: string;
}

export interface DraftVersionLookup {
  draft: DraftRecord | null;
  version: DraftVersionRecord | null;
}

export interface DraftModerationOptions {
  /**
   * Lets the caller moderate a draft owned by any principal, not just its own.
   * This is the operator's moderation reach, granted by the `admin` scope; it is
   * keyed on nothing but that scope. (It replaces a carve-out that reached only
   * the retired anonymous sentinel account.)
   */
  canModerateAnyPrincipal?: boolean;
}

export interface DbDriverOptions {
  /**
   * The ordered migration list the JSON driver runs. Defaults to the shipped
   * `SCHEMA_MIGRATIONS`; overridden to exercise a migration end to end. The
   * Postgres driver ignores it: its schema is migrated ahead of time through
   * `migrateDatabase` (`migrate.ts`).
   */
  migrations?: readonly SchemaMigration[];
  /**
   * Epoch milliseconds, `Date.now` by default — the same shape the server and
   * the rate limiters take. The retention clock reads it, so a driver and the
   * app in front of it want the *same* function: give `createApp` one clock and
   * its database another and expiry will not move when the app's clock does.
   */
  clock?: () => number;
}

export interface PatchyDb {
  /**
   * How many drafts this token created that are still live — neither deleted
   * nor disabled. The creating token is the one on a draft's first version, so
   * a later update by another token never moves a draft between tallies. This
   * is the durable half of the per-token quota: it is recounted from the
   * database on every create, so a restart cannot reset it.
   */
  countLiveDraftsByCreatorApiToken(apiTokenId: string): Promise<number>;
  assertUploadTarget(input: UploadTargetInput): Promise<void>;
  recordUpload(input: RecordUploadInput): Promise<RecordUploadResult>;
  /** Expired drafts are absent here, exactly as deleted and disabled ones are. */
  findDraftVersion(draftId: string, versionNumber?: number): Promise<DraftVersionLookup>;
  /**
   * A draft's owning principal and creating token — the first step of
   * the moderation loop, the one that turns a URL into a culprit.
   *
   * Deliberately unlike `findDraftVersion`: a disabled, deleted, or expired
   * draft is still answered here. The operator is asked about pages that are
   * already off, and hiding the row would hide the principal behind them.
   */
  findDraftForModeration(draftId: string): Promise<ModeratedDraftRecord | null>;
  /**
   * The second step: everything else that principal is holding. Newest first,
   * at most `limit` rows, deleted drafts excluded — a deleted draft is a
   * resolved one, and excluding it is what lets the list drain as the operator
   * works it rather than filling up with history it can never act on again.
   */
  listDraftsByPrincipal(principalId: string, limit: number): Promise<PrincipalDraftListing>;
  /**
   * Tops a served draft's retention clock up to the visit-extension window when
   * less than that remains. A no-op otherwise, including for a draft that is
   * already expired, deleted, or disabled — a visit never shortens the clock
   * and never brings a draft back.
   *
   * Also a no-op once the draft's creating token is revoked: from that moment
   * the clock only runs down, so abuse ages out on whatever window it had left
   * instead of being kept alive by the traffic it attracts.
   */
  recordDraftVisit(draftId: string): Promise<void>;
  /**
   * Pins or unpins a draft, exempting it from expiry or handing it back to the
   * clock. An operator's act and admin-only above this port, so no ownership
   * narrows it: the instance's own pages may sit on any account.
   *
   * A pin is a statement about a page that is *live*, and the two directions
   * are deliberately not symmetric. Pinning answers `false` unless the draft is
   * in service — neither deleted nor disabled — because a pin on a taken-down
   * draft would exempt storage nobody can reach from the sweep. Unpinning
   * answers `true` for any row that is still there, so a pin can never become
   * stuck on a draft the operator has since taken down.
   *
   * Pinning is idempotent in effect but not in stamp — re-pinning restamps
   * `pinnedAt` — and unpinning restores the ordinary clock, which for a draft
   * pinned long past its anchor means it expires immediately.
   */
  setDraftPinned(draftId: string, pinned: boolean): Promise<boolean>;
  /**
   * IDs the expiry sweep may take right now — expired and unpinned, the
   * longest-expired first — capped at `limit`. Deleted and disabled drafts are
   * included: they are out of sight already, and the sweep is what finally
   * frees their storage.
   */
  listExpiredDraftIds(limit: number): Promise<string[]>;
  /**
   * Hard-deletes one expired draft — its upload events, its versions, and the
   * draft row — and answers with the storage keys those versions held, so the
   * caller can delete the content behind them. Answers `null` when the draft is
   * no longer the sweep's to take: already gone, or pinned since it was listed.
   *
   * The record goes first on purpose. Once the row is gone its objects are
   * unreachable, so a crash before the caller deletes them leaks storage — the
   * other order risks a live draft whose content vanished, which is worse.
   */
  deleteExpiredDraft(draftId: string): Promise<string[] | null>;
  /**
   * Taking a draft out of service ends any pin on it, here and in
   * `deleteDraft`. A pinned draft is otherwise ordinary, and that includes
   * this: moderation and deletion outrank a pin, so neither can leave content
   * the sweep may never take.
   */
  disableDraft(
    draftId: string,
    accountId: string,
    reason: string,
    options?: DraftModerationOptions
  ): Promise<boolean>;
  deleteDraft(
    draftId: string,
    accountId: string,
    options?: DraftModerationOptions
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface DbFactoryOptions {
  driver: "postgres" | "json";
  databaseUrl: string | null;
  jsonDbFile: string;
}
