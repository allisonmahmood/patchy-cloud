import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Tokens } from "@patchy/auth";
import { newDraftId, newInternalId, randomToken } from "@patchy/core";
import { layerFromUrl } from "@patchy/sql";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { DEV_SEED } from "../../../scripts/dev/src/seed.js";
import { JsonFilePatchyDb } from "./json-db.js";
import {
  deployedJsonStateFixture,
  LEGACY_ACCOUNT_ID,
  LEGACY_DRAFT_ID,
  LEGACY_TOKEN,
  PROBE_ADD_MIGRATION,
  PROBE_ADD_MIGRATION_ID,
  PROBE_REQUIRE_MIGRATION,
  PROBE_REQUIRE_MIGRATION_ID
} from "./migration-fixtures.fixture.js";
import { SCHEMA_MIGRATION_IDS, SCHEMA_MIGRATIONS } from "./migrations.js";
import { PostgresPatchyDb } from "./postgres-db.js";
import { isUploadTargetError } from "./types.js";
import { createPostgresTestDatabase } from "../../../test/postgres.js";
import type {
  ApiTokenAuth,
  DbDriverOptions,
  PatchyDb,
  RecordUploadInput,
  RecordUploadResult
} from "./types.js";

type UploadIntent = "create" | "update";
type IntendedRecordUploadInput = RecordUploadInput & { intent: UploadIntent };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Where the retention tests start their clock. Any fixed instant would do. */
const RETENTION_EPOCH = Date.UTC(2026, 0, 1);

/** The token a contract case uploads as: what `RecordUploadInput` needs of it. */
type UploadAuth = Pick<ApiTokenAuth, "id" | "accountId">;

interface ContractHarness {
  db: PatchyDb;
  peerDb: PatchyDb;
  auth: UploadAuth;
  /**
   * Tokens over the same store: `@patchy/auth` on Postgres, the JSON driver's
   * own on JSON. The contract cases only need to mint, issue and revoke.
   */
  createToken(name: string): Promise<UploadAuth>;
  mint(sourceIp: string): Promise<UploadAuth>;
  revoke(apiTokenId: string): Promise<{ alreadyRevoked: boolean } | null>;
  /** Another handle on the same store, optionally on a different clock. */
  openDb(options?: DbDriverOptions): PatchyDb;
  close(): Promise<void>;
}

/** The JSON harness also drives the driver's own migration ledger. */
interface JsonMigrationHarness extends ContractHarness {
  db: JsonFilePatchyDb;
  /** Another handle on the same state file, optionally running a different schema. */
  openDb(options?: DbDriverOptions): JsonFilePatchyDb;
  /** Rewrites the state file exactly as the code before this mechanism left it. */
  resetToDeployedSchema(): Promise<void>;
  /** Rewrites the ledger, to resume from a prefix of the migration list. */
  setAppliedLedger(ids: readonly string[]): Promise<void>;
}

function shippedLedgerEntries(applied: string[]): string[] {
  return applied.filter((id) => SCHEMA_MIGRATION_IDS.includes(id));
}

async function captureInitializeError(db: JsonFilePatchyDb): Promise<unknown> {
  return db.initialize(null).then(
    () => null,
    (error: unknown) => error
  );
}

type ContractHarnessFactory = () => Promise<ContractHarness>;

function describeUploadContract(driverName: string, createHarness: ContractHarnessFactory): void {
  describe(`${driverName} draft upload contract`, () => {
    it("moderates a draft for its owning principal or an authorized moderator", async () => {
      const harness = await createHarness();
      // Every draft is created by the harness principal, which is a real row:
      // `drafts.account_id` carries a foreign key, so an invented owner would
      // fail to insert on Postgres while passing on the key-less JSON driver.
      // A non-owner is expressed by the *acting* principal instead, which is
      // only ever compared, never inserted.
      const otherPrincipalId = `${harness.auth.accountId}_not`;
      const ownerDisabledDraftId = newDraftId();
      const ownerDeletedDraftId = newDraftId();
      const moderatedDisabledDraftId = newDraftId();
      const moderatedDeletedDraftId = newDraftId();

      try {
        for (const draftId of [
          ownerDisabledDraftId,
          ownerDeletedDraftId,
          moderatedDisabledDraftId,
          moderatedDeletedDraftId
        ]) {
          await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        }

        // Ordinary reach is ownership alone.
        await expect(
          harness.db.disableDraft(ownerDisabledDraftId, otherPrincipalId, "not the owner")
        ).resolves.toBe(false);
        await expect(harness.db.deleteDraft(ownerDeletedDraftId, otherPrincipalId)).resolves.toBe(
          false
        );

        await expect(
          harness.db.disableDraft(ownerDisabledDraftId, harness.auth.accountId, "owner policy")
        ).resolves.toBe(true);
        await expect(
          harness.db.deleteDraft(ownerDeletedDraftId, harness.auth.accountId)
        ).resolves.toBe(true);

        // An authorized moderator reaches a draft it does not own. This is the
        // operator's takedown path, keyed on nothing but the granted capability.
        await expect(
          harness.db.disableDraft(moderatedDisabledDraftId, otherPrincipalId, "operator policy", {
            canModerateAnyPrincipal: true
          })
        ).resolves.toBe(true);
        await expect(
          harness.db.deleteDraft(moderatedDeletedDraftId, otherPrincipalId, {
            canModerateAnyPrincipal: true
          })
        ).resolves.toBe(true);

        // Moderation still cannot resurrect an already-deleted draft.
        await expect(
          harness.db.deleteDraft(moderatedDeletedDraftId, otherPrincipalId, {
            canModerateAnyPrincipal: true
          })
        ).resolves.toBe(false);
      } finally {
        await harness.close();
      }
    });

    it("rejects an update for an unknown draft without creating it", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        await expect(
          harness.db.assertUploadTarget(uploadInput("update", draftId, harness.auth))
        ).rejects.toMatchObject({
          message: "Draft not found.",
          statusCode: 404
        });

        await expect(
          harness.db.recordUpload(uploadInput("update", draftId, harness.auth))
        ).rejects.toMatchObject({
          message: "Draft not found.",
          statusCode: 404
        });

        expect(await harness.db.findDraftVersion(draftId)).toEqual({
          draft: null,
          version: null
        });

        const created = await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        expect(created.versionNumber).toBe(1);
      } finally {
        await harness.close();
      }
    });

    it("adds a new version when the owning account updates an active draft", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      const createInput = uploadInput("create", draftId, harness.auth, {
        title: "Original title"
      });
      const updateInput = uploadInput("update", draftId, harness.auth, {
        title: "Updated title"
      });

      try {
        const created = await harness.db.recordUpload(createInput);
        const updated = await harness.db.recordUpload(updateInput);

        expect(created.versionNumber).toBe(1);
        expect(updated).toMatchObject({
          draftId,
          versionId: updateInput.versionId,
          versionNumber: 2,
          title: "Updated title"
        });

        const current = await harness.db.findDraftVersion(draftId);
        const original = await harness.db.findDraftVersion(draftId, 1);
        expect(current.draft?.accountId).toBe(harness.auth.accountId);
        expect(current.draft?.title).toBe("Updated title");
        expect(current.version?.id).toBe(updateInput.versionId);
        expect(original.version?.id).toBe(createInput.versionId);
      } finally {
        await harness.close();
      }
    });

    it("atomically rechecks ownership and status after preflight", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      const updateInput = uploadInput("update", draftId, harness.auth);

      try {
        await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        await expect(harness.db.assertUploadTarget(updateInput)).resolves.toBeUndefined();
        await harness.db.disableDraft(draftId, harness.auth.accountId, "policy race");

        await expect(harness.db.recordUpload(updateInput)).rejects.toMatchObject({
          message: "Draft not found.",
          statusCode: 404
        });
      } finally {
        await harness.close();
      }
    });

    it("rejects unknown, foreign, deleted, and disabled update targets identically", async () => {
      const harness = await createHarness();
      const unknownDraftId = newDraftId();
      const foreignDraftId = newDraftId();
      const deletedDraftId = newDraftId();
      const disabledDraftId = newDraftId();

      try {
        for (const draftId of [foreignDraftId, deletedDraftId, disabledDraftId]) {
          await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        }
        await harness.db.deleteDraft(deletedDraftId, harness.auth.accountId);
        await harness.db.disableDraft(disabledDraftId, harness.auth.accountId, "policy");

        const errors = await Promise.all([
          captureError(
            harness.db.recordUpload(uploadInput("update", unknownDraftId, harness.auth))
          ),
          captureError(
            harness.db.recordUpload(
              uploadInput("update", foreignDraftId, harness.auth, {
                accountId: "acct_another"
              })
            )
          ),
          captureError(
            harness.db.recordUpload(uploadInput("update", deletedDraftId, harness.auth))
          ),
          captureError(
            harness.db.recordUpload(uploadInput("update", disabledDraftId, harness.auth))
          )
        ]);

        for (const error of errors) {
          expect(error).toMatchObject({
            message: "Draft not found.",
            statusCode: 404
          });
        }
        expect(errors.map(String)).toEqual(Array(4).fill("Error: Draft not found."));
        for (const draftId of [unknownDraftId, foreignDraftId, deletedDraftId, disabledDraftId]) {
          expect(errors.map(String).join("\n")).not.toContain(draftId);
        }
      } finally {
        await harness.close();
      }
    });

    it("allows only one concurrent create for the same server-generated ID", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      const firstInput = uploadInput("create", draftId, harness.auth);
      const secondInput = uploadInput("create", draftId, harness.auth);

      try {
        const outcomes = await Promise.allSettled([
          harness.db.recordUpload(firstInput),
          harness.peerDb.recordUpload(secondInput)
        ]);
        const fulfilled = outcomes.filter(
          (outcome): outcome is PromiseFulfilledResult<RecordUploadResult> =>
            outcome.status === "fulfilled"
        );
        const rejected = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
        );

        expect(fulfilled).toHaveLength(1);
        expect(fulfilled[0]?.value.versionNumber).toBe(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toMatchObject({
          message: "Draft already exists.",
          statusCode: 409
        });

        const current = await harness.db.findDraftVersion(draftId);
        const unexpectedSecondVersion = await harness.db.findDraftVersion(draftId, 2);
        expect([firstInput.versionId, secondInput.versionId]).toContain(current.version?.id);
        expect(unexpectedSecondVersion.version).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("counts a token's live drafts, excluding deleted and disabled ones", async () => {
      const harness = await createHarness();
      const kept = newDraftId();
      const deleted = newDraftId();
      const disabled = newDraftId();
      const foreign = newDraftId();

      try {
        const creator = await harness.createToken("Quota creator token");
        const other = await harness.createToken("Quota other token");

        expect(await harness.db.countLiveDraftsByCreatorApiToken(creator.id)).toBe(0);

        for (const draftId of [kept, deleted, disabled]) {
          await harness.db.recordUpload(uploadInput("create", draftId, creator));
        }
        await harness.db.recordUpload(uploadInput("create", foreign, other));

        expect(await harness.db.countLiveDraftsByCreatorApiToken(creator.id)).toBe(3);
        expect(await harness.db.countLiveDraftsByCreatorApiToken(other.id)).toBe(1);

        await harness.db.deleteDraft(deleted, creator.accountId);
        await harness.db.disableDraft(disabled, creator.accountId, "policy");

        expect(await harness.db.countLiveDraftsByCreatorApiToken(creator.id)).toBe(1);
        expect(await harness.db.countLiveDraftsByCreatorApiToken(other.id)).toBe(1);
        expect(await harness.db.countLiveDraftsByCreatorApiToken("tok_never_used")).toBe(0);
      } finally {
        await harness.close();
      }
    });

    it("keeps a draft in its creator's tally when another token updates it", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        const creator = await harness.createToken("Quota update creator token");
        const editor = await harness.createToken("Quota update editor token");

        await harness.db.recordUpload(uploadInput("create", draftId, creator));
        const updated = await harness.db.recordUpload(uploadInput("update", draftId, editor));

        expect(updated.versionNumber).toBe(2);
        expect(await harness.db.countLiveDraftsByCreatorApiToken(creator.id)).toBe(1);
        expect(await harness.db.countLiveDraftsByCreatorApiToken(editor.id)).toBe(0);
      } finally {
        await harness.close();
      }
    });

    it("owns exactly the drafts a minted principal creates", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();

      try {
        const minted = await harness.mint(uniqueSourceIp());

        await harness.db.recordUpload(uploadInput("create", draftId, minted));
        const own = await harness.db.recordUpload(uploadInput("update", draftId, minted));
        expect(own.versionNumber).toBe(2);

        // Ownership is the existing account-scoped check, reused unchanged: the
        // operator's principal is simply a different account, so its update is
        // refused exactly as any other stranger's would be.
        const foreign = await captureError(
          harness.db.recordUpload(uploadInput("update", draftId, harness.auth))
        );
        expect(isUploadTargetError(foreign)).toBe(true);
        expect(foreign).toMatchObject({ code: "draft_unavailable" });

        expect(await harness.db.countLiveDraftsByCreatorApiToken(minted.id)).toBe(1);
        expect(await harness.db.deleteDraft(draftId, harness.auth.accountId)).toBe(false);
        expect(await harness.db.deleteDraft(draftId, minted.accountId)).toBe(true);
      } finally {
        await harness.close();
      }
    });

    it("serializes concurrent owned updates into distinct sequential versions", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      const firstUpdate = uploadInput("update", draftId, harness.auth);
      const secondUpdate = uploadInput("update", draftId, harness.auth);

      try {
        await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));

        const updates = await Promise.all([
          harness.db.recordUpload(firstUpdate),
          harness.peerDb.recordUpload(secondUpdate)
        ]);

        expect(updates.map((update) => update.versionNumber).sort()).toEqual([2, 3]);
        const secondVersion = await harness.db.findDraftVersion(draftId, 2);
        const thirdVersion = await harness.db.findDraftVersion(draftId, 3);
        expect([secondVersion.version?.id, thirdVersion.version?.id].sort()).toEqual(
          [firstUpdate.versionId, secondUpdate.versionId].sort()
        );
      } finally {
        await harness.close();
      }
    });

    it("starts a full retention window on create and restarts it on every new version", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 80 * DAY_MS;
        await clocked.recordUpload(uploadInput("update", draftId, harness.auth));

        // Past the window the create opened, inside the one the update opened.
        now = RETENTION_EPOCH + 100 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now = RETENTION_EPOCH + 171 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("stops serving an expired draft and refuses it as an update target", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 90 * DAY_MS - 1;
        expect((await clocked.findDraftVersion(draftId)).version?.versionNumber).toBe(1);

        now = RETENTION_EPOCH + 90 * DAY_MS + 1;
        expect(await clocked.findDraftVersion(draftId)).toEqual({
          draft: null,
          version: null
        });
        expect(await clocked.findDraftVersion(draftId, 1)).toEqual({
          draft: null,
          version: null
        });

        const target = clocked.assertUploadTarget({
          intent: "update",
          draftId,
          accountId: harness.auth.accountId
        });
        await expect(target).rejects.toMatchObject({
          code: "draft_unavailable",
          statusCode: 404
        });

        const update = await captureError(
          clocked.recordUpload(uploadInput("update", draftId, harness.auth))
        );
        expect(isUploadTargetError(update)).toBe(true);
        expect(update).toMatchObject({ code: "draft_unavailable", statusCode: 404 });

        // Out of view is not out of the store — only the sweep frees the ID,
        // so a create still collides with the row until then.
        const recreated = await captureError(
          clocked.recordUpload(uploadInput("create", draftId, harness.auth))
        );
        expect(recreated).toMatchObject({ code: "draft_conflict", statusCode: 409 });
      } finally {
        await harness.close();
      }
    });

    it("serves a draft at the exact instant its clock reads out, and not past it", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        // The rule is `expiresAt < now`, so the anchor instant itself is still
        // inside the window. A `<=` anywhere in either driver fails here.
        now = RETENTION_EPOCH + 90 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now += 1;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("leaves the clock alone for a visit with exactly the visit window left", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        // Exactly the visit window remains. "Fewer than" is not met, so this is
        // a no-op — and because a top-up here would land on the value already
        // stored, the boundary is only visible as the write that never happens.
        now = RETENTION_EPOCH + 60 * DAY_MS;
        await clocked.recordDraftVisit(draftId);

        now = RETENTION_EPOCH + 90 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now += 1;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("tops a visited draft up to the visit window when less than it remains", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 70 * DAY_MS; // twenty days left
        await clocked.recordDraftVisit(draftId);

        now = RETENTION_EPOCH + 99 * DAY_MS; // past the window the upload opened
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now = RETENTION_EPOCH + 101 * DAY_MS; // past the topped-up one
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("leaves the clock untouched for a visit with more than the visit window left", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 10 * DAY_MS; // eighty days left
        await clocked.recordDraftVisit(draftId);

        // Not shortened to the visit window...
        now = RETENTION_EPOCH + 89 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        // ...and not extended past the window the upload opened either.
        now = RETENTION_EPOCH + 91 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("never revives an expired draft on a visit", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 91 * DAY_MS;
        await clocked.recordDraftVisit(draftId);
        await clocked.recordDraftVisit(draftId);

        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
        now = RETENTION_EPOCH + 92 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("accepts a visit to a draft nobody can be served as a no-op", async () => {
      const harness = await createHarness();
      const deletedDraftId = newDraftId();
      const disabledDraftId = newDraftId();

      try {
        for (const draftId of [deletedDraftId, disabledDraftId]) {
          await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
        }
        await harness.db.deleteDraft(deletedDraftId, harness.auth.accountId);
        await harness.db.disableDraft(disabledDraftId, harness.auth.accountId, "policy");

        for (const draftId of [deletedDraftId, disabledDraftId, newDraftId()]) {
          await expect(harness.db.recordDraftVisit(draftId)).resolves.toBeUndefined();
          expect((await harness.db.findDraftVersion(draftId)).draft).toBeNull();
        }
      } finally {
        await harness.close();
      }
    });

    it("hard-deletes an expired draft with every version it held, freeing its ID", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        const created = uploadInput("create", draftId, harness.auth);
        const updated = uploadInput("update", draftId, harness.auth);
        await clocked.recordUpload(created);
        await clocked.recordUpload(updated);

        now = RETENTION_EPOCH + 91 * DAY_MS;
        expect(await clocked.listExpiredDraftIds(1_000)).toContain(draftId);

        // Every version's object comes back, because every version's row goes.
        const objectKeys = await clocked.deleteExpiredDraft(draftId);
        expect([...(objectKeys ?? [])].sort()).toEqual(
          [created.objectKey, updated.objectKey].sort()
        );

        expect(await clocked.findDraftVersion(draftId)).toEqual({
          draft: null,
          version: null
        });
        expect(await clocked.listExpiredDraftIds(1_000)).not.toContain(draftId);
        // Sweeping twice is one sweep: there is nothing left to take.
        expect(await clocked.deleteExpiredDraft(draftId)).toBeNull();

        // The ID is free again. Version one is available only because the old
        // versions went with the draft — republishing is the way back.
        const republished = await clocked.recordUpload(
          uploadInput("create", draftId, harness.auth)
        );
        expect(republished.versionNumber).toBe(1);
      } finally {
        await harness.close();
      }
    });

    it("offers nothing to sweep while a draft's clock still runs", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));

        now = RETENTION_EPOCH + 90 * DAY_MS;
        expect(await clocked.listExpiredDraftIds(1_000)).not.toContain(draftId);
        expect(await clocked.deleteExpiredDraft(draftId)).toBeNull();
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now += 1;
        expect(await clocked.listExpiredDraftIds(1_000)).toContain(draftId);
        // A caller asking for no drafts is asked for no drafts.
        expect(await clocked.listExpiredDraftIds(0)).toEqual([]);
        expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("offers the longest-expired drafts first", async () => {
      const harness = await createHarness();
      const older = newDraftId();
      const newer = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", older, harness.auth));
        now = RETENTION_EPOCH + 10 * DAY_MS;
        await clocked.recordUpload(uploadInput("create", newer, harness.auth));

        now = RETENTION_EPOCH + 101 * DAY_MS;
        const listed = await clocked.listExpiredDraftIds(1_000);
        // Other drafts may be waiting too; only the relative order is the rule.
        expect(listed.filter((id) => id === older || id === newer)).toEqual([older, newer]);

        for (const draftId of [older, newer]) {
          expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
        }
      } finally {
        await harness.close();
      }
    });

    it("sweeps deleted and disabled drafts once their clock runs out", async () => {
      const harness = await createHarness();
      const deletedDraftId = newDraftId();
      const disabledDraftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        for (const draftId of [deletedDraftId, disabledDraftId]) {
          await clocked.recordUpload(uploadInput("create", draftId, harness.auth));
        }
        await clocked.deleteDraft(deletedDraftId, harness.auth.accountId);
        await clocked.disableDraft(disabledDraftId, harness.auth.accountId, "policy");

        // Out of sight is not out of storage: their clocks run out like any
        // other draft's, and the sweep is what finally frees what they hold.
        now = RETENTION_EPOCH + 91 * DAY_MS;
        const listed = await clocked.listExpiredDraftIds(1_000);
        for (const draftId of [deletedDraftId, disabledDraftId]) {
          expect(listed).toContain(draftId);
          expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
        }
      } finally {
        await harness.close();
      }
    });

    it("returns a swept draft's slot to its creator's live tally", async () => {
      const harness = await createHarness();
      const draftIds = [newDraftId(), newDraftId()];
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        const creator = await harness.createToken("Expiry sweep quota token");
        for (const draftId of draftIds) {
          await clocked.recordUpload(uploadInput("create", draftId, creator));
        }
        expect(await clocked.countLiveDraftsByCreatorApiToken(creator.id)).toBe(2);

        // An expired draft still counts: its row and its content are both there.
        now = RETENTION_EPOCH + 91 * DAY_MS;
        expect(await clocked.countLiveDraftsByCreatorApiToken(creator.id)).toBe(2);

        for (const draftId of draftIds) {
          expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
        }
        expect(await clocked.countLiveDraftsByCreatorApiToken(creator.id)).toBe(0);
      } finally {
        await harness.close();
      }
    });

    it("holds a pinned draft out of expiry, and hands it back on unpin", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));
        expect(await clocked.setDraftPinned(draftId, true)).toBe(true);

        // Long past the window an upload opens, and none of it applies.
        now = RETENTION_EPOCH + 200 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.pinnedAt).toEqual(
          expect.any(String)
        );
        expect(await clocked.listExpiredDraftIds(1_000)).not.toContain(draftId);
        expect(await clocked.deleteExpiredDraft(draftId)).toBeNull();

        // Ordinary in every other respect: its owner still updates it.
        const updated = await clocked.recordUpload(uploadInput("update", draftId, harness.auth));
        expect(updated.versionNumber).toBe(2);

        now = RETENTION_EPOCH + 400 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        // Unpinning hands the draft back to the clock it was always carrying.
        expect(await clocked.setDraftPinned(draftId, false)).toBe(true);
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
        expect(await clocked.listExpiredDraftIds(1_000)).toContain(draftId);
        expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("keeps a pinned draft's clock moving, so unpinning a read page leaves it a window", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        await clocked.recordUpload(uploadInput("create", draftId, harness.auth));
        expect(await clocked.setDraftPinned(draftId, true)).toBe(true);

        // A visit long past the anchor still tops up, because a pinned draft is
        // not expired and topping it up therefore revives nothing.
        now = RETENTION_EPOCH + 200 * DAY_MS;
        await clocked.recordDraftVisit(draftId);
        expect(await clocked.setDraftPinned(draftId, false)).toBe(true);

        now = RETENTION_EPOCH + 229 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now = RETENTION_EPOCH + 231 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
        expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("pins only a draft in service, and unpins whatever row is left", async () => {
      const harness = await createHarness();
      const deletedDraftId = newDraftId();
      const disabledDraftId = newDraftId();

      try {
        expect(await harness.db.setDraftPinned(newDraftId(), true)).toBe(false);

        await harness.db.recordUpload(uploadInput("create", deletedDraftId, harness.auth));
        await harness.db.recordUpload(uploadInput("create", disabledDraftId, harness.auth));
        await harness.db.deleteDraft(deletedDraftId, harness.auth.accountId);
        await harness.db.disableDraft(disabledDraftId, harness.auth.accountId, "policy");

        // A pin is a statement about a live page, so there is nothing here to
        // exempt — pinning one of these would exempt unreachable storage.
        expect(await harness.db.setDraftPinned(deletedDraftId, true)).toBe(false);
        expect(await harness.db.setDraftPinned(disabledDraftId, true)).toBe(false);

        // Unpinning is the other way round: it takes any row still there, so a
        // pin can never be stuck on a draft the operator has since taken down.
        expect(await harness.db.setDraftPinned(deletedDraftId, false)).toBe(true);
        expect(await harness.db.setDraftPinned(disabledDraftId, false)).toBe(true);
        expect(await harness.db.setDraftPinned(newDraftId(), false)).toBe(false);
      } finally {
        await harness.close();
      }
    });

    it("ends a pin when a draft is taken out of service, so its storage still frees", async () => {
      const harness = await createHarness();
      const deletedDraftId = newDraftId();
      const disabledDraftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        for (const draftId of [deletedDraftId, disabledDraftId]) {
          await clocked.recordUpload(uploadInput("create", draftId, harness.auth));
          expect(await clocked.setDraftPinned(draftId, true)).toBe(true);
        }

        // Taking a draft down outranks its pin. Without that, the row would be
        // exempt from the sweep with no way to unpin it back into reach.
        await clocked.deleteDraft(deletedDraftId, harness.auth.accountId);
        await clocked.disableDraft(disabledDraftId, harness.auth.accountId, "policy");

        now = RETENTION_EPOCH + 91 * DAY_MS;
        const listed = await clocked.listExpiredDraftIds(1_000);
        for (const draftId of [deletedDraftId, disabledDraftId]) {
          expect(listed).toContain(draftId);
          expect(await clocked.deleteExpiredDraft(draftId)).not.toBeNull();
        }
      } finally {
        await harness.close();
      }
    });

    it("answers a moderation read with the principal and token behind the draft", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        const creator = await harness.createToken("Moderation read creator token");
        const editor = await harness.createToken("Moderation read editor token");
        await clocked.recordUpload(uploadInput("create", draftId, creator));

        expect(await clocked.findDraftForModeration(draftId)).toMatchObject({
          id: draftId,
          accountId: harness.auth.accountId,
          createdByApiTokenId: creator.id,
          deletedAt: null,
          disabledAt: null
        });

        // The culprit is fixed at creation: a later editor never becomes it.
        await clocked.recordUpload(uploadInput("update", draftId, editor));
        expect((await clocked.findDraftForModeration(draftId))?.createdByApiTokenId).toBe(
          creator.id
        );

        // Unlike the serving read, moderation answers for a draft that is
        // already off — the operator is asked about those most of all.
        await clocked.disableDraft(draftId, harness.auth.accountId, "operator policy");
        const disabled = await clocked.findDraftForModeration(draftId);
        expect(disabled?.createdByApiTokenId).toBe(creator.id);
        expect(disabled?.disabledAt).toEqual(expect.any(String));

        await clocked.deleteDraft(draftId, harness.auth.accountId);
        expect((await clocked.findDraftForModeration(draftId))?.deletedAt).toEqual(
          expect.any(String)
        );

        // And for one whose clock ran out, which serving has stopped answering.
        now = RETENTION_EPOCH + 200 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
        expect((await clocked.findDraftForModeration(draftId))?.id).toBe(draftId);

        expect(await clocked.findDraftForModeration(newDraftId())).toBeNull();
      } finally {
        await harness.close();
      }
    });

    it("lists a principal's drafts newest first, without the ones it deleted", async () => {
      const harness = await createHarness();
      const [oldest, middle, newest] = [newDraftId(), newDraftId(), newDraftId()];
      const deleted = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        const creator = await harness.createToken("Principal listing creator token");
        for (const draftId of [deleted, oldest, middle, newest]) {
          await clocked.recordUpload(uploadInput("create", draftId, creator));
          now += DAY_MS;
        }
        await clocked.deleteDraft(deleted, harness.auth.accountId);

        // Small enough to truncate on purpose: the answer says so rather than
        // pretending to be whole.
        const page = await clocked.listDraftsByPrincipal(harness.auth.accountId, 2);
        expect(page.drafts.map((draft) => draft.id)).toEqual([newest, middle]);
        expect(page.truncated).toBe(true);
        expect(page.drafts[0]?.createdByApiTokenId).toBe(creator.id);

        const roomy = await clocked.listDraftsByPrincipal(harness.auth.accountId, 4);
        expect(roomy.drafts.map((draft) => draft.id).slice(0, 3)).toEqual([newest, middle, oldest]);
        expect(roomy.drafts.map((draft) => draft.id)).not.toContain(deleted);

        // A principal holding nothing is an empty answer, not a truncated one.
        expect(await clocked.listDraftsByPrincipal("acct_holds_nothing", 10)).toEqual({
          drafts: [],
          truncated: false
        });
      } finally {
        await harness.close();
      }
    });

    it("freezes visit top-ups from the moment a draft's creating token is revoked", async () => {
      const harness = await createHarness();
      const draftId = newDraftId();
      let now = RETENTION_EPOCH;
      const clocked = harness.openDb({ clock: () => now });

      try {
        const creator = await harness.createToken("Revocation freeze creator token");
        await clocked.recordUpload(uploadInput("create", draftId, creator));

        // Day 70, twenty days left: this visit lands before the revocation and
        // tops the clock up to day 100, and that extension survives.
        now = RETENTION_EPOCH + 70 * DAY_MS;
        await clocked.recordDraftVisit(draftId);

        now = RETENTION_EPOCH + 71 * DAY_MS;
        expect((await harness.revoke(creator.id))?.alreadyRevoked).toBe(false);

        // Revocation is not a takedown: the page is still served.
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        // Day 95, five days left — before the freeze this visit would have
        // bought another thirty. Now it buys nothing.
        now = RETENTION_EPOCH + 95 * DAY_MS;
        await clocked.recordDraftVisit(draftId);

        now = RETENTION_EPOCH + 99 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft?.id).toBe(draftId);

        now = RETENTION_EPOCH + 101 * DAY_MS;
        expect((await clocked.findDraftVersion(draftId)).draft).toBeNull();
      } finally {
        await harness.close();
      }
    });
  });
}

/**
 * The JSON driver migrates its own state file, so its ledger mechanism is
 * held here. Postgres migrates through `@patchy/sql`, whose tests cover the
 * Migrator; a Postgres test database arrives already migrated.
 */
describe("JSON schema migrations", () => {
  const createHarness = createJsonHarness;

  it("records every shipped migration once, in order, and re-migrates as a no-op", async () => {
    const harness = await createHarness();
    const draftId = newDraftId();

    try {
      const applied = await harness.db.listAppliedMigrations();
      expect(shippedLedgerEntries(applied)).toEqual([...SCHEMA_MIGRATION_IDS]);
      expect(new Set(applied).size).toBe(applied.length);

      await harness.db.initialize(null);
      await harness.peerDb.initialize(null);

      expect(await harness.db.listAppliedMigrations()).toEqual(applied);
      const created = await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));
      expect(created.versionNumber).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("resumes from a partly applied ledger without repeating a recorded step", async () => {
    const harness = await createHarness();
    const draftId = newDraftId();

    try {
      await harness.setAppliedLedger(SCHEMA_MIGRATION_IDS.slice(0, 1));

      const resumed = harness.openDb();
      await resumed.initialize(null);

      const applied = await resumed.listAppliedMigrations();
      expect(shippedLedgerEntries(applied)).toEqual([...SCHEMA_MIGRATION_IDS]);
      expect(new Set(applied).size).toBe(applied.length);

      const created = await resumed.recordUpload(uploadInput("create", draftId, harness.auth));
      expect(created.versionNumber).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("adopts a database created before this mechanism existed", async () => {
    const harness = await createHarness();

    try {
      await harness.resetToDeployedSchema();

      const adopted = harness.openDb();
      await adopted.initialize(null);

      expect(shippedLedgerEntries(await adopted.listAppliedMigrations())).toEqual([
        ...SCHEMA_MIGRATION_IDS
      ]);

      const legacyAuth = await adopted.findApiTokenByToken(LEGACY_TOKEN);
      expect(legacyAuth?.accountId).toBe(LEGACY_ACCOUNT_ID);
      const preserved = await adopted.findDraftVersion(LEGACY_DRAFT_ID);
      expect(preserved.draft?.title).toBe("Legacy draft");
      expect(preserved.version?.versionNumber).toBe(1);

      const updated = await adopted.recordUpload(
        uploadInput("update", LEGACY_DRAFT_ID, legacyAuth!)
      );
      expect(updated.versionNumber).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("applies an additive migration to an already-migrated database", async () => {
    const harness = await createHarness();
    const draftId = newDraftId();

    try {
      await harness.db.recordUpload(uploadInput("create", draftId, harness.auth));

      const upgraded = harness.openDb({
        migrations: [...SCHEMA_MIGRATIONS, PROBE_ADD_MIGRATION, PROBE_REQUIRE_MIGRATION]
      });
      await upgraded.initialize(null);

      const applied = await upgraded.listAppliedMigrations();
      expect(shippedLedgerEntries(applied)).toEqual([...SCHEMA_MIGRATION_IDS]);
      expect(applied.slice(-2)).toEqual([PROBE_ADD_MIGRATION_ID, PROBE_REQUIRE_MIGRATION_ID]);

      const preserved = await upgraded.findDraftVersion(draftId);
      expect(preserved.draft?.id).toBe(draftId);
      const updated = await upgraded.recordUpload(uploadInput("update", draftId, harness.auth));
      expect(updated.versionNumber).toBe(2);

      await upgraded.initialize(null);
      expect(await upgraded.listAppliedMigrations()).toEqual(applied);

      // A handle still running the older schema keeps reading migrated rows.
      expect((await harness.db.findDraftVersion(draftId)).draft?.id).toBe(draftId);
    } finally {
      await harness.close();
    }
  });

  it("fails an additive migration whose predecessor never ran", async () => {
    const harness = await createHarness();

    try {
      await harness.db.recordUpload(uploadInput("create", newDraftId(), harness.auth));

      // The dependent probe alone: if the step that adds the field were a
      // no-op, this would pass, so the failure is what proves it ran above.
      const incomplete = harness.openDb({
        migrations: [...SCHEMA_MIGRATIONS, PROBE_REQUIRE_MIGRATION]
      });

      const error = await captureInitializeError(incomplete);
      expect(error).toBeInstanceOf(Error);
      expect(shippedLedgerEntries(await harness.db.listAppliedMigrations())).toEqual([
        ...SCHEMA_MIGRATION_IDS
      ]);
      expect(await harness.db.listAppliedMigrations()).not.toContain(PROBE_REQUIRE_MIGRATION_ID);
    } finally {
      await harness.close();
    }
  });

  it("leaves a draft migrated from before the retention clock a full window", async () => {
    const harness = await createHarness();

    try {
      await harness.resetToDeployedSchema();

      const migratedAt = Date.now();
      const adopted = harness.openDb();
      await adopted.initialize(null);

      // The deploy expires nothing: a row written long before the clock
      // existed still serves the moment the migration lands.
      expect((await adopted.findDraftVersion(LEGACY_DRAFT_ID)).draft?.title).toBe("Legacy draft");

      // And what it has ahead of it is a whole window, anchored at the
      // migration rather than at whenever the row was last written.
      let now = migratedAt;
      const clocked = harness.openDb({ clock: () => now });
      now = migratedAt + 89 * DAY_MS;
      expect((await clocked.findDraftVersion(LEGACY_DRAFT_ID)).draft?.id).toBe(LEGACY_DRAFT_ID);
      now = migratedAt + 91 * DAY_MS;
      expect((await clocked.findDraftVersion(LEGACY_DRAFT_ID)).draft).toBeNull();
    } finally {
      await harness.close();
    }
  });
});

describeUploadContract("JSON", createJsonHarness);

describeUploadContract("Postgres", createPostgresHarness);

describe("Postgres rollback error handling", () => {
  it("preserves a typed final rejection when rollback also fails", async () => {
    const harness = await createPostgresHarness();
    const db = harness.db as PostgresPatchyDb;
    const draftId = newDraftId();
    const updateInput = uploadInput("update", draftId, harness.auth);

    try {
      await db.recordUpload(uploadInput("create", draftId, harness.auth));
      await db.assertUploadTarget(updateInput);
      await db.disableDraft(draftId, harness.auth.accountId, "policy race");
      failRollbackAfterExecution(db);

      const error = await captureError(db.recordUpload(updateInput));
      expect(isUploadTargetError(error)).toBe(true);
      expect(error).toMatchObject({
        code: "draft_unavailable",
        message: "Draft not found.",
        statusCode: 404
      });
    } finally {
      await harness.close();
    }
  });
});

async function createJsonHarness(): Promise<JsonMigrationHarness> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "patchy-upload-contract-"));
  const filePath = path.join(tempDir, "db.json");
  const opened: JsonFilePatchyDb[] = [];
  const openDb = (options: DbDriverOptions = {}): JsonFilePatchyDb => {
    const opening = new JsonFilePatchyDb(filePath, options);
    opened.push(opening);
    return opening;
  };

  const db = openDb();
  const peerDb = openDb();
  const token = randomToken();
  await db.initialize(token);
  const auth = await db.findApiTokenByToken(token);
  if (!auth) throw new Error("Expected bootstrap authentication.");

  const authenticate = async (token: string): Promise<UploadAuth> => {
    const found = await db.findApiTokenByToken(token);
    if (!found) throw new Error("Expected authentication for a fresh token.");
    return found;
  };

  return {
    db,
    peerDb,
    auth,
    async createToken(name) {
      const token = randomToken();
      await db.createApiToken({ accountId: auth.accountId, name, token, scopes: ["upload"] });
      return authenticate(token);
    },
    async mint(sourceIp) {
      const token = randomToken();
      await db.mintSelfServiceToken({ token, name: "Self-service token 2026-01-01", sourceIp });
      return authenticate(token);
    },
    revoke: (apiTokenId) => db.revokeApiToken(apiTokenId),
    openDb,
    async resetToDeployedSchema() {
      await writeFile(filePath, `${JSON.stringify(deployedJsonStateFixture(), null, 2)}\n`, "utf8");
    },
    async setAppliedLedger(ids) {
      const stored = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      stored.schemaMigrations = [...ids];
      await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    },
    async close() {
      await Promise.all(opened.map((opening) => opening.close()));
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function createPostgresHarness(): Promise<ContractHarness> {
  const testDatabase = await createPostgresTestDatabase();
  const connectionString = testDatabase.connectionString;
  const opened: PatchyDb[] = [];
  const openDb = (options: DbDriverOptions = {}): PatchyDb => {
    const opening = new PostgresPatchyDb(connectionString, options);
    opened.push(opening);
    return opening;
  };

  const db = openDb();
  const peerDb = openDb();
  // Tokens are `@patchy/auth`'s on Postgres; the template database already
  // holds the dev seed's principal, which is the one the cases upload as.
  const runtime = ManagedRuntime.make(
    Tokens.layer.pipe(Layer.provide(layerFromUrl(Redacted.make(connectionString))))
  );
  const tokens = await runtime.runPromise(Effect.flatMap(Tokens.Tokens, Effect.succeed));
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(Effect.orDie(effect));

  return {
    db,
    peerDb,
    auth: { id: DEV_SEED.tokenId, accountId: DEV_SEED.accountId },
    async createToken(name) {
      const created = await run(
        tokens.create({
          accountId: DEV_SEED.accountId,
          name,
          scopes: ["upload"],
          token: randomToken()
        })
      );
      return { id: created.id, accountId: DEV_SEED.accountId };
    },
    async mint(sourceIp) {
      const minted = await run(
        tokens.mint({
          sourceIp,
          quota: 1,
          name: "Self-service token 2026-01-01",
          token: randomToken()
        })
      );
      return { id: minted.apiTokenId, accountId: minted.accountId };
    },
    revoke: (apiTokenId) => run(tokens.revoke(apiTokenId)).then(Option.getOrNull),
    openDb,
    async close() {
      await Promise.all(opened.map((opening) => opening.close()));
      await runtime.dispose();
      await testDatabase.drop();
    }
  };
}

/**
 * A token nobody else in the test shares, so its tally starts from zero.
 */
function uniqueSourceIp(): string {
  return `2001:db8::${randomUUID().slice(0, 8)}`;
}

function uploadInput(
  intent: UploadIntent,
  draftId: string,
  auth: UploadAuth,
  overrides: Partial<IntendedRecordUploadInput> = {}
): IntendedRecordUploadInput {
  const versionId = newInternalId("ver");
  return {
    intent,
    draftId,
    versionId,
    accountId: auth.accountId,
    apiTokenId: auth.id,
    title: `${intent} draft`,
    objectKey: `drafts/${draftId}/versions/${versionId}.html`,
    contentHash: `sha256:${versionId}`,
    fileSize: 1,
    filename: "plan.html",
    metadata: { cliVersion: "contract-test" },
    sourceIp: "127.0.0.1",
    userAgent: "vitest",
    ...overrides
  };
}

interface TestPoolClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}

function failRollbackAfterExecution(db: PostgresPatchyDb): void {
  const pool = (
    db as unknown as {
      pool: { connect(): Promise<TestPoolClient> };
    }
  ).pool;
  const connect = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await connect();
    return {
      async query(text, values) {
        const result =
          values === undefined ? await client.query(text) : await client.query(text, values);
        if (text === "ROLLBACK") {
          throw new Error("Forced rollback failure after server execution.");
        }
        return result;
      },
      release() {
        client.release();
      }
    };
  };
}

async function captureError(promise: Promise<RecordUploadResult>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}
