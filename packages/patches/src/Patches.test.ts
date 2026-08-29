import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const { admin, sibling, uploader } = Fixtures.identities;
const patches = Effect.flatMap(Patches.Patches, Effect.succeed);

let counter = 0;
/** Records a first version for a fresh patch held by `identity`. */
const create = (identity = uploader, title = "Page") =>
  Effect.gen(function* () {
    const id = `p${String(++counter).padStart(11, "0")}`;
    yield* (yield* patches).record({
      intent: "create",
      patchId: id,
      accountId: identity.accountId,
      versionId: `ver_${id}_1`,
      apiTokenId: identity.apiTokenId,
      title,
      objectKey: `patches/${id}/versions/1.html`,
      contentHash: "sha256:x",
      fileSize: 1,
      filename: null,
      repoOrg: null,
      repoName: null,
      cliVersion: null,
      gitBranch: null,
      gitCommitSha: null,
      sourceIp: null,
      userAgent: null
    });
    return id;
  });

const update = (patchId: string, identity = uploader) =>
  Effect.flatMap(patches, (service) =>
    service.record({
      intent: "update",
      patchId,
      accountId: identity.accountId,
      versionId: `ver_${patchId}_${++counter}`,
      apiTokenId: identity.apiTokenId,
      title: "Updated",
      objectKey: `patches/${patchId}/versions/${counter}.html`,
      contentHash: "sha256:y",
      fileSize: 1,
      filename: null,
      repoOrg: null,
      repoName: null,
      cliVersion: null,
      gitBranch: null,
      gitCommitSha: null,
      sourceIp: null,
      userAgent: null
    })
  );

/** Takes every patch the sweep could, so a test's own listing is what it asserts on. */
const drain = Effect.gen(function* () {
  const service = yield* patches;
  for (const patchId of yield* service.listExpired(1_000)) yield* service.deleteExpired(patchId);
});

const isServed = (patchId: string, versionNumber?: number) =>
  Effect.map(
    Effect.flatMap(patches, (service) => service.find(patchId, versionNumber)),
    Option.isSome
  );

it.layer(Patches.layer.pipe(Layer.provideMerge(Fixtures.database)))("Patches", (it) => {
  it.effect("refuses the update targets a caller cannot write, all the same way", () =>
    Effect.gen(function* () {
      const service = yield* patches;
      const owned = yield* create();
      const foreign = yield* create(admin);
      const disabled = yield* create();
      yield* service.disable(disabled, uploader.accountId, "off", {
        canModerateAnyPrincipal: false
      });
      const deleted = yield* create();
      yield* service.delete(deleted, uploader.accountId, { canModerateAnyPrincipal: false });

      const versioned = yield* update(owned);
      assert.strictEqual(versioned.versionNumber, 2);
      // The sibling token shares the principal, so it may write the patch too.
      assert.strictEqual((yield* update(owned, sibling)).versionNumber, 3);
      for (const patchId of ["nope", foreign, disabled, deleted]) {
        const refused = yield* update(patchId).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "PatchUnavailable", patchId);
        assert.strictEqual(
          (yield* service
            .checkTarget({ intent: "update", patchId, accountId: uploader.accountId })
            .pipe(Effect.flip))._tag,
          "PatchUnavailable"
        );
      }
      assert.strictEqual(
        (yield* service
          .checkTarget({ intent: "create", patchId: owned, accountId: uploader.accountId })
          .pipe(Effect.flip))._tag,
        "PatchConflict"
      );
    })
  );

  it.effect("serialises concurrent updates of one patch into distinct versions", () =>
    Effect.gen(function* () {
      const patchId = yield* create();
      const numbers = yield* Effect.all([update(patchId), update(patchId), update(patchId)], {
        concurrency: "unbounded"
      }).pipe(Effect.map((results) => results.map((result) => result.versionNumber).sort()));
      assert.deepStrictEqual(numbers, [2, 3, 4]);
    })
  );

  it.effect(
    "counts a token's live patches by who created them, releasing the taken-down ones",
    () =>
      Effect.gen(function* () {
        const service = yield* patches;
        const before = yield* service.countLive(uploader.apiTokenId);
        const kept = yield* create();
        const disabled = yield* create();
        const deleted = yield* create();
        // Updated by another token: still the creator's.
        yield* update(kept, sibling);
        assert.strictEqual(yield* service.countLive(uploader.apiTokenId), before + 3);
        assert.strictEqual(yield* service.countLive(sibling.apiTokenId), 0);
        yield* service.disable(disabled, uploader.accountId, "off", {
          canModerateAnyPrincipal: false
        });
        yield* service.delete(deleted, uploader.accountId, { canModerateAnyPrincipal: false });
        assert.strictEqual(yield* service.countLive(uploader.apiTokenId), before + 1);
      })
  );

  it.effect(
    "runs the retention clock: expiry at the anchor, a visit tops up, an upload restarts",
    () =>
      Effect.gen(function* () {
        const service = yield* patches;
        yield* TestClock.setTime(Date.UTC(2026, 0, 1));
        const patchId = yield* create();

        // Served at the exact instant the clock reads out, and not past it.
        yield* TestClock.adjust(90 * DAY);
        assert.isTrue(yield* isServed(patchId));
        yield* TestClock.adjust(1);
        assert.isFalse(yield* isServed(patchId));
        // Expired: refused as an update target, and a visit cannot bring it back.
        assert.strictEqual((yield* update(patchId).pipe(Effect.flip))._tag, "PatchUnavailable");
        yield* service.recordVisit(patchId);
        assert.isFalse(yield* isServed(patchId));

        // A visit with more than the visit window left changes nothing; with
        // less, it tops the clock up to exactly that window.
        const visited = yield* create();
        yield* TestClock.adjust(10 * DAY);
        yield* service.recordVisit(visited);
        yield* TestClock.adjust(80 * DAY + 1);
        assert.isFalse(yield* isServed(visited), "an early visit did not extend");
        const kept = yield* create();
        yield* TestClock.adjust(70 * DAY);
        yield* service.recordVisit(kept);
        yield* TestClock.adjust(29 * DAY);
        assert.isTrue(yield* isServed(kept), "a late visit topped up to thirty days");
        yield* TestClock.adjust(DAY + 1);
        assert.isFalse(yield* isServed(kept));

        // A new version restarts the whole window.
        const republished = yield* create();
        yield* TestClock.adjust(80 * DAY);
        yield* update(republished);
        yield* TestClock.adjust(89 * DAY);
        assert.isTrue(yield* isServed(republished));
      })
  );

  it.effect("freezes visit top-ups once the creating token is revoked", () =>
    Effect.gen(function* () {
      const service = yield* patches;
      yield* TestClock.setTime(Date.UTC(2027, 0, 1));
      const patchId = yield* create(Fixtures.identities.reader);
      yield* Fixtures.revoke(Fixtures.identities.reader.apiTokenId);
      yield* TestClock.adjust(85 * DAY);
      yield* service.recordVisit(patchId);
      yield* TestClock.adjust(5 * DAY + 1);
      assert.isFalse(yield* isServed(patchId));
    })
  );

  it.effect(
    "holds a pinned patch out of expiry, pins only one in service, and ends the pin on takedown",
    () =>
      Effect.gen(function* () {
        const service = yield* patches;
        yield* TestClock.setTime(Date.UTC(2028, 0, 1));
        const pinned = yield* create();
        assert.isTrue(yield* service.setPinned(pinned, true));
        yield* TestClock.adjust(400 * DAY);
        yield* drain;
        assert.isTrue(yield* isServed(pinned));
        assert.deepStrictEqual(yield* service.listExpired(10), []);
        // Unpinning hands it back to the clock, which has long run out.
        assert.isTrue(yield* service.setPinned(pinned, false));
        assert.isFalse(yield* isServed(pinned));
        assert.deepStrictEqual(yield* service.listExpired(10), [pinned]);
        yield* drain;

        const taken = yield* create();
        yield* service.setPinned(taken, true);
        yield* service.disable(taken, uploader.accountId, "off", {
          canModerateAnyPrincipal: false
        });
        assert.isNull(Option.getOrThrow(yield* service.findForModeration(taken)).pinnedAt);
        assert.isFalse(yield* service.setPinned(taken, true));
        assert.isTrue(yield* service.setPinned(taken, false));
        assert.isFalse(yield* service.setPinned("nope", true));
      })
  );

  it.effect(
    "hard-deletes an expired patch with its versions, longest-expired first, and never a live one",
    () =>
      Effect.gen(function* () {
        const service = yield* patches;
        yield* TestClock.setTime(Date.UTC(2029, 0, 1));
        yield* drain;
        const older = yield* create();
        yield* update(older);
        yield* TestClock.adjust(DAY);
        const newer = yield* create();
        yield* TestClock.adjust(91 * DAY);
        const live = yield* create();

        assert.deepStrictEqual(yield* service.listExpired(1), [older]);
        assert.deepStrictEqual(yield* service.listExpired(10), [older, newer]);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* service.deleteExpired(older)).toSorted(),
          [
            `patches/${older}/versions/1.html`,
            `patches/${older}/versions/${counter - 2}.html`
          ].toSorted()
        );
        assert.isTrue(Option.isNone(yield* service.deleteExpired(older)));
        assert.isTrue(Option.isNone(yield* service.deleteExpired(live)));
        assert.isTrue(Option.isNone(yield* service.findForModeration(older)));
        assert.isTrue(Option.isSome(yield* service.findForModeration(newer)));
      })
  );

  it.effect(
    "answers moderation reads for patches that are off, and lists a principal's without the deleted",
    () =>
      Effect.gen(function* () {
        const service = yield* patches;
        const first = yield* create(admin, "First");
        const second = yield* create(admin, "Second");
        const deleted = yield* create(admin, "Deleted");
        yield* update(second, sibling).pipe(Effect.ignore);
        yield* service.disable(first, admin.accountId, "policy", { canModerateAnyPrincipal: true });
        yield* service.delete(deleted, admin.accountId, { canModerateAnyPrincipal: false });

        const moderated = Option.getOrThrow(yield* service.findForModeration(first));
        assert.strictEqual(moderated.createdByApiTokenId, admin.apiTokenId);
        assert.strictEqual(moderated.disabledReason, "policy");
        assert.isTrue(Option.isSome(yield* service.findForModeration(deleted)));
        assert.isTrue(Option.isNone(yield* service.find(first)));

        const listing = yield* service.listByPrincipal(admin.accountId, 1);
        assert.strictEqual(listing.truncated, true);
        assert.deepStrictEqual(
          listing.patches.map((patch) => patch.id),
          [second]
        );
        const whole = yield* service.listByPrincipal(admin.accountId, 10);
        assert.isFalse(whole.patches.some((patch) => patch.id === deleted));

        // Only an admin reaches another principal's patch.
        assert.isFalse(
          yield* service.delete(second, uploader.accountId, { canModerateAnyPrincipal: false })
        );
        assert.isTrue(
          yield* service.delete(second, uploader.accountId, { canModerateAnyPrincipal: true })
        );
      })
  );
});
