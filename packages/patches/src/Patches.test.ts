import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const { admin, sibling, uploader } = Fixtures.identities;
const patches = Effect.flatMap(Patches.Patches, Effect.succeed);

let counter = 0;
/** Records a first version for a fresh patch held by `identity`. */
const create = (identity = uploader, title = "Page", scope?: Patches.Patch["scope"]) =>
  Effect.gen(function* () {
    const id = `p${String(++counter).padStart(11, "0")}`;
    yield* (yield* patches).record({
      intent: "create",
      patchId: id,
      companyId: identity.company.id,
      ownerUserId: identity.user.id,
      versionId: `ver_${id}_1`,
      machineTokenId: identity.machine.id,
      scope,
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

const update = (patchId: string, identity = uploader, scope?: Patches.Patch["scope"]) =>
  Effect.flatMap(patches, (service) =>
    service.record({
      intent: "update",
      patchId,
      companyId: identity.company.id,
      ownerUserId: identity.user.id,
      versionId: `ver_${patchId}_${++counter}`,
      machineTokenId: identity.machine.id,
      scope,
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
  it.effect("allows only owner writes and refuses unavailable update targets uniformly", () =>
    Effect.gen(function* () {
      const service = yield* patches;
      const owned = yield* create();
      const foreign = yield* create(admin);
      const disabled = yield* create();
      // Operators can still take a patch out of service directly in SQL.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET disabled_at = now(), disabled_reason = 'off' WHERE id = ${disabled}`;
      const deleted = yield* create();
      yield* service.delete(deleted, uploader.user.id);

      const versioned = yield* update(owned);
      assert.strictEqual(versioned.versionNumber, 2);
      // A different machine acts as the same owner user.
      assert.strictEqual((yield* update(owned, sibling)).versionNumber, 3);
      const latest = Option.getOrThrow(yield* service.find(owned));
      assert.strictEqual(latest.version.createdByMachineTokenId, sibling.machine.id);
      assert.strictEqual(
        Option.getOrThrow(yield* service.find(owned, 1)).version.createdByMachineTokenId,
        uploader.machine.id
      );
      for (const patchId of ["nope", foreign, disabled, deleted]) {
        const refused = yield* update(patchId).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "PatchUnavailable", patchId);
        assert.strictEqual(
          (yield* service
            .checkTarget({ intent: "update", patchId, ownerUserId: uploader.user.id })
            .pipe(Effect.flip))._tag,
          "PatchUnavailable"
        );
      }
      assert.strictEqual(
        (yield* service
          .checkTarget({ intent: "create", patchId: owned, ownerUserId: uploader.user.id })
          .pipe(Effect.flip))._tag,
        "PatchConflict"
      );
      assert.isFalse(yield* service.delete(foreign, uploader.user.id));
      assert.isTrue(yield* isServed(foreign));
      assert.isTrue(yield* service.delete(owned, sibling.user.id));
      assert.isFalse(yield* isServed(owned));
      assert.isFalse(yield* isServed(owned, 1));
      assert.isFalse(yield* service.delete(owned, uploader.user.id));
    })
  );

  it.effect(
    "defaults creates to company and preserves or explicitly changes scope on updates",
    () =>
      Effect.gen(function* () {
        const service = yield* patches;
        const company = yield* create();
        assert.strictEqual(Option.getOrThrow(yield* service.find(company)).patch.scope, "company");
        assert.strictEqual((yield* update(company)).scope, "company");

        const published = yield* create(uploader, "Public", "public");
        assert.strictEqual(Option.getOrThrow(yield* service.find(published)).patch.scope, "public");
        assert.strictEqual((yield* update(published, sibling)).scope, "public");
        assert.strictEqual(Option.getOrThrow(yield* service.find(published)).patch.scope, "public");
        assert.strictEqual((yield* update(published, sibling, "company")).scope, "company");
        assert.strictEqual(
          Option.getOrThrow(yield* service.find(published)).patch.scope,
          "company"
        );
        assert.strictEqual((yield* update(published, uploader, "public")).scope, "public");
        assert.strictEqual(Option.getOrThrow(yield* service.find(published)).patch.scope, "public");
      })
  );

  it.effect("shares only an owner's available patch, without a version or retention reset", () =>
    Effect.gen(function* () {
      const service = yield* patches;
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const owned = yield* create();
      const foreign = yield* create(admin);
      const disabled = yield* create();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET disabled_at = now(), disabled_reason = 'off' WHERE id = ${disabled}`;
      const deleted = yield* create();
      yield* service.delete(deleted, uploader.user.id);
      const before = Option.getOrThrow(yield* service.find(owned));

      yield* TestClock.adjust(DAY);
      assert.strictEqual(yield* service.setScope(owned, sibling.user.id, "public"), "public");
      const published = Option.getOrThrow(yield* service.find(owned));
      assert.strictEqual(published.patch.scope, "public");
      assert.strictEqual(published.patch.expiresAt, before.patch.expiresAt);
      assert.deepStrictEqual(published.version, before.version);
      assert.isTrue(Option.isNone(yield* service.find(owned, 2)));

      assert.strictEqual(yield* service.setScope(owned, uploader.user.id, "company"), "company");
      const restricted = Option.getOrThrow(yield* service.find(owned));
      assert.strictEqual(restricted.patch.scope, "company");
      assert.strictEqual(restricted.patch.expiresAt, before.patch.expiresAt);
      assert.deepStrictEqual(restricted.version, before.version);
      for (const patchId of ["nope", foreign, disabled, deleted]) {
        assert.strictEqual(
          (yield* service.setScope(patchId, uploader.user.id, "public").pipe(Effect.flip))._tag,
          "PatchUnavailable",
          patchId
        );
      }
      assert.strictEqual(Option.getOrThrow(yield* service.find(foreign)).patch.scope, "company");

      yield* TestClock.adjust(89 * DAY + 1);
      assert.isFalse(yield* isServed(owned));
      assert.strictEqual(
        (yield* service.setScope(owned, uploader.user.id, "public").pipe(Effect.flip))._tag,
        "PatchUnavailable"
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

  it.effect("counts live patches per owner across machines, releasing the taken-down ones", () =>
    Effect.gen(function* () {
      const service = yield* patches;
      const before = yield* service.countLive(uploader.user.id);
      const kept = yield* create(sibling);
      const disabled = yield* create();
      const deleted = yield* create();
      // Creating and updating on another machine cannot reset the owner's quota.
      yield* update(kept);
      assert.strictEqual(yield* service.countLive(uploader.user.id), before + 3);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET disabled_at = now(), disabled_reason = 'off' WHERE id = ${disabled}`;
      yield* service.delete(deleted, uploader.user.id);
      assert.strictEqual(yield* service.countLive(uploader.user.id), before + 1);
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

  it.effect("tops up visits even after the creating machine token is revoked", () =>
    Effect.gen(function* () {
      const service = yield* patches;
      yield* TestClock.setTime(Date.UTC(2027, 0, 1));
      const patchId = yield* create(Fixtures.identities.reader);
      yield* Fixtures.revoke(Fixtures.identities.reader.machine.id);
      yield* TestClock.adjust(85 * DAY);
      yield* service.recordVisit(patchId);
      yield* TestClock.adjust(5 * DAY + 1);
      assert.isTrue(yield* isServed(patchId));
      yield* TestClock.adjust(25 * DAY);
      assert.isFalse(yield* isServed(patchId));
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
        assert.deepStrictEqual(yield* service.listExpired(10), [newer]);
        assert.isTrue(yield* isServed(live));
      })
  );
});
