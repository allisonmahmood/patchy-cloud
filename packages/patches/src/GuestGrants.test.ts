import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { Guests, Users } from "@patchy/companies";
import { newPatchId } from "@patchy/core";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const { uploader, admin, reader } = Fixtures.identities;
const owner = { userId: uploader.user.id, admin: false };
const administrator = { userId: admin.user.id, admin: true };
let ordinal = 0;
const publish = (overrides: Partial<Patches.RecordInput> = {}) => {
  const id = ++ordinal;
  return Fixtures.record(
    Fixtures.recordInput(uploader, {
      patchId: newPatchId(),
      versionId: `v_guest_${id}`,
      manifest: { ...Fixtures.manifest, name: `guest-${id}` },
      ...overrides
    })
  );
};

const analytics = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: () => Effect.void })
);

it.layer(Patches.layer.pipe(Layer.provideMerge(analytics), Layer.provideMerge(Fixtures.database)))(
  "patch guest grants",
  (it) => {
    it.effect(
      "keeps B and C independent for one Clerk account and suspends without reviving revocations",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const patches = yield* Patches.Patches;
          const b = yield* publish();
          yield* sql`INSERT INTO companies (id, handle, name) VALUES
        ('cmp_guest_a', 'guest-a', 'A'), ('cmp_guest_c', 'guest-c', 'C')`;
          yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('usr_guest_a', 'clerk_guest', 'cmp_guest_a', 'guest@example.com', 'Guest', 'member'),
               ('usr_guest_c', 'clerk_owner_c', 'cmp_guest_c', 'owner-c@example.com', 'Owner C', 'member')`;
          yield* sql`INSERT INTO machine_tokens
        (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
        VALUES ('tok_guest_c', 'usr_guest_c', 'C machine', 'hash:c', now(),
          now() + interval '90 days', now())`;
          const c = yield* publish({
            companyId: "cmp_guest_c",
            ownerUserId: "usr_guest_c",
            machineTokenId: "tok_guest_c"
          });
          const bGuest = yield* Guests.create({
            companyId: uploader.company.id,
            clerkUserId: "clerk_guest",
            email: "guest@example.com",
            name: "Guest"
          });
          const cGuest = yield* Guests.create({
            companyId: "cmp_guest_c",
            clerkUserId: "clerk_guest",
            email: "guest@example.com",
            name: "Guest"
          });
          const shared = () => patches.sharedWithGuest("clerk_guest", "https://patchy.example/");
          assert.deepStrictEqual(yield* shared(), []);
          const otherGuest = yield* Guests.create({
            companyId: uploader.company.id,
            clerkUserId: "another-account",
            email: "guest@example.com",
            name: "Another account"
          });
          const unrelated = yield* publish();
          yield* patches.grantGuest(unrelated.patchId, otherGuest.id, owner);
          const bAccess = () => patches.guestGrant(uploader.company.id, b.patchId, bGuest.id);
          const cAccess = () => patches.guestGrant("cmp_guest_c", c.patchId, cGuest.id);
          assert.isNull(yield* bAccess());
          assert.isNull(yield* cAccess());
          const first = yield* patches.grantGuest(b.patchId, bGuest.id, owner);
          yield* patches.grantGuest(c.patchId, cGuest.id, { userId: "usr_guest_c", admin: false });
          assert.deepStrictEqual(yield* shared(), [
            {
              patchId: c.patchId,
              name: c.name,
              title: "Fixture patch",
              companyId: "cmp_guest_c",
              companyName: "C",
              companyHandle: "guest-c",
              address: `https://patchy.example/guest-c/${c.name}`
            },
            {
              patchId: b.patchId,
              name: b.name,
              title: "Fixture patch",
              companyId: uploader.company.id,
              companyName: uploader.company.name,
              companyHandle: uploader.company.handle,
              address: `https://patchy.example/${uploader.company.handle}/${b.name}`
            }
          ]);
          assert.deepStrictEqual(
            yield* patches.sharedWithGuest("unknown-account", "https://patchy.example"),
            []
          );
          // Membership deactivation elsewhere cannot hide independent B/C shares.
          yield* sql`UPDATE users SET deactivated_at = now() WHERE id = 'usr_guest_a'`;
          assert.strictEqual((yield* shared()).length, 2);
          assert.strictEqual((yield* bAccess())?.access, "active");
          assert.strictEqual((yield* cAccess())?.access, "active");
          assert.isNull(yield* patches.guestGrant("cmp_guest_c", b.patchId, bGuest.id));
          assert.isNull(yield* patches.guestGrant(uploader.company.id, b.patchId, cGuest.id));
          assert.strictEqual(
            (yield* patches.grantGuest(b.patchId, bGuest.id, owner).pipe(Effect.flip))._tag,
            "AlreadyGranted"
          );
          yield* Guests.setDeactivated({
            companyId: uploader.company.id,
            clerkUserId: "clerk_guest",
            deactivated: true
          });
          assert.deepStrictEqual(
            (yield* shared()).map((p) => p.patchId),
            [c.patchId]
          );
          assert.strictEqual((yield* bAccess())?.access, "deactivated");
          assert.strictEqual((yield* cAccess())?.access, "active");
          assert.strictEqual(
            (yield* patches.grantGuest(b.patchId, bGuest.id, owner).pipe(Effect.flip))._tag,
            "GrantGuestDeactivated"
          );
          yield* patches.revokeGuest(b.patchId, bGuest.id, administrator);
          yield* Guests.setDeactivated({
            companyId: uploader.company.id,
            clerkUserId: "clerk_guest",
            deactivated: false
          });
          assert.deepStrictEqual(
            (yield* shared()).map((p) => p.patchId),
            [c.patchId]
          );
          assert.strictEqual((yield* bAccess())?.access, "revoked");
          assert.strictEqual((yield* cAccess())?.access, "active");
          const reopened = yield* Effect.exit(sql`UPDATE patch_guest_grants
            SET ended_at = NULL, end_reason = NULL WHERE id = ${first.id}`);
          assert.isTrue(Exit.isFailure(reopened));
          const second = yield* patches.grantGuest(b.patchId, bGuest.id, owner);
          assert.strictEqual((yield* shared()).length, 2);
          assert.notStrictEqual(second.id, first.id);
          assert.strictEqual((yield* bAccess())?.grant.id, second.id);
          assert.strictEqual((yield* bAccess())?.access, "active");
          yield* Guests.end({ companyId: uploader.company.id, clerkUserId: "clerk_guest" });
          assert.deepStrictEqual(
            (yield* shared()).map((p) => p.patchId),
            [c.patchId]
          );
          assert.strictEqual((yield* bAccess())?.grant.endReason, "guest_ended");
          assert.strictEqual((yield* bAccess())?.access, "ended");
          assert.strictEqual((yield* cAccess())?.access, "active");
          assert.strictEqual((yield* Guests.findById(bGuest.id))?.clerkUserId, "clerk_guest");
        })
    );

    it.effect("lists only explicit eligible shares for a deactivated same-company member", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        const subject = `clerk_${reader.user.id}`;
        const shared = () => patches.sharedWithGuest(subject, "https://patchy.example");
        const first = yield* publish();
        const second = yield* publish();
        yield* publish(); // An unrelated same-company patch is never listed.
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${reader.user.id}`;
        assert.deepStrictEqual(yield* shared(), []);
        const share = (patchId: string) =>
          patches.shareGuest(patchId, reader.user.email, owner).pipe(Effect.provide(Users.layer));
        yield* share(first.patchId);
        yield* share(second.patchId);
        assert.strictEqual((yield* shared()).length, 2);
        yield* Guests.end({ companyId: uploader.company.id, clerkUserId: subject });
        assert.deepStrictEqual(yield* shared(), []);
        yield* share(first.patchId);
        assert.deepStrictEqual(
          (yield* shared()).map((p) => p.patchId),
          [first.patchId]
        );
        for (const tier of [1, 2, 0]) {
          // Exercise current-version metadata for both scripted tiers.
          yield* sql`UPDATE patch_versions SET tier = ${tier}
            WHERE id = (SELECT current_version_id FROM patches WHERE id = ${first.patchId})`;
          assert.strictEqual((yield* shared()).length, tier === 0 || tier === 1 ? 1 : 0);
        }
        yield* patches.retire(first.patchId, owner);
        assert.deepStrictEqual(yield* shared(), []);
        yield* patches.restore(first.patchId, owner);
        assert.strictEqual((yield* shared()).length, 1);
        yield* patches.delete(first.patchId, owner);
        assert.deepStrictEqual(yield* shared(), []);
        yield* patches.restore(first.patchId, owner);
        yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${first.patchId}`;
        assert.deepStrictEqual(yield* shared(), []);
        yield* sql`UPDATE patches SET disabled_at = NULL WHERE id = ${first.patchId}`;
        yield* sql`UPDATE patches SET current_version_id = NULL WHERE id = ${first.patchId}`;
        assert.deepStrictEqual(yield* shared(), []);
        yield* sql`UPDATE patches SET current_version_id = ${first.versionId} WHERE id = ${first.patchId}`;
        assert.strictEqual((yield* shared()).length, 1);
        yield* patches.setScope(first.patchId, owner, "public");
        assert.deepStrictEqual(yield* shared(), []);
        yield* patches.setScope(first.patchId, owner, "company");
        assert.deepStrictEqual(yield* shared(), []);
        yield* share(first.patchId);
        assert.deepStrictEqual(
          (yield* shared()).map((p) => p.patchId),
          [first.patchId]
        );
        const member = yield* sql`SELECT deactivated_at FROM users WHERE id = ${reader.user.id}`;
        assert.instanceOf(member[0]!.deactivated_at, Date);
      })
    );

    it.effect(
      "ends grants atomically on both sharing paths and never restores them on private return",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const patches = yield* Patches.Patches;
          const patch = yield* publish();
          const guest = yield* Guests.create({
            companyId: uploader.company.id,
            clerkUserId: `clerk_public_${patch.patchId}`,
            email: "public@example.com",
            name: "Public Test"
          });
          const access = () => patches.guestGrant(uploader.company.id, patch.patchId, guest.id);
          yield* patches.grantGuest(patch.patchId, guest.id, owner);
          yield* Effect.flip(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* patches.setScope(patch.patchId, owner, "public");
                return yield* Effect.fail("roll back scope" as const);
              })
            )
          );
          assert.strictEqual((yield* access())?.access, "active");
          yield* patches.setScope(patch.patchId, owner, "public");
          assert.strictEqual((yield* access())?.grant.endReason, "public");
          yield* patches.setScope(patch.patchId, owner, "company");
          assert.strictEqual((yield* access())?.access, "ended");
          const fresh = yield* patches.grantGuest(patch.patchId, guest.id, owner);
          assert.strictEqual((yield* access())?.grant.id, fresh.id);
          yield* publish({ intent: "update", patchId: patch.patchId, scope: "public" });
          assert.strictEqual((yield* access())?.grant.endReason, "public");
          yield* publish({ intent: "update", patchId: patch.patchId, scope: "company" });
          assert.strictEqual((yield* access())?.access, "ended");
        })
    );

    it.effect("retains grants across temporary retirement but ends them on reclamation", () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const patch = yield* publish();
        const guest = yield* Guests.create({
          companyId: uploader.company.id,
          clerkUserId: `clerk_reclaim_${patch.patchId}`,
          email: "reclaim@example.com",
          name: "Reclaim Test"
        });
        const access = () => patches.guestGrant(uploader.company.id, patch.patchId, guest.id);
        yield* patches.grantGuest(patch.patchId, guest.id, owner);
        yield* patches.retire(patch.patchId, owner);
        assert.strictEqual((yield* access())?.access, "unavailable");
        yield* patches.restore(patch.patchId, owner);
        assert.strictEqual((yield* access())?.access, "active");
        yield* patches.delete(patch.patchId, owner);
        yield* TestClock.adjust(30 * 24 * 60 * 60 * 1000);
        yield* patches.purgeDeleted(patch.patchId);
        assert.strictEqual((yield* access())?.grant.endReason, "reclaimed");
        assert.strictEqual((yield* access())?.access, "ended");
        const replacement = yield* publish({
          manifest: { ...Fixtures.manifest, name: `guest-${ordinal}` }
        });
        assert.notStrictEqual(replacement.patchId, patch.patchId);
        assert.isNull(
          yield* patches.guestGrant(uploader.company.id, replacement.patchId, guest.id)
        );
        assert.strictEqual(
          (yield* Guests.findById(guest.id))?.clerkUserId,
          `clerk_reclaim_${patch.patchId}`
        );
      })
    );

    it.effect("requires patch ownership and a live private current patch to grant", () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const patch = yield* publish();
        const guest = yield* Guests.create({
          companyId: uploader.company.id,
          clerkUserId: `clerk_authority_${patch.patchId}`,
          email: "authority@example.com",
          name: "Authority Test"
        });
        assert.strictEqual(
          (yield* patches
            .grantGuest(patch.patchId, guest.id, { userId: reader.user.id, admin: false })
            .pipe(Effect.flip))._tag,
          "NotOwner"
        );
        yield* patches.setScope(patch.patchId, owner, "public");
        assert.strictEqual(
          (yield* patches.grantGuest(patch.patchId, guest.id, owner).pipe(Effect.flip))._tag,
          "PatchUnavailable"
        );
        yield* patches.setScope(patch.patchId, owner, "company");
        yield* patches.grantGuest(patch.patchId, guest.id, owner);
        yield* patches.retire(patch.patchId, owner);
        assert.strictEqual(
          (yield* patches.grantGuest(patch.patchId, guest.id, owner).pipe(Effect.flip))._tag,
          "WrongState"
        );
      })
    );

    it.effect("ends grants when a guest joins the sharing company as a member", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        const patch = yield* publish();
        const clerkUserId = `clerk_join_${patch.patchId}`;
        const guest = yield* Guests.create({
          companyId: uploader.company.id,
          clerkUserId,
          email: "join@example.com",
          name: "Join Test"
        });
        yield* patches.grantGuest(patch.patchId, guest.id, owner);
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES (${`usr_join_${patch.patchId}`}, ${clerkUserId}, ${uploader.company.id},
          'join@example.com', 'Join Test', 'member')`;
        const result = yield* patches.guestGrant(uploader.company.id, patch.patchId, guest.id);
        assert.strictEqual(result?.access, "ended");
        assert.strictEqual(result?.grant.endReason, "guest_ended");
        assert.instanceOf((yield* Guests.findById(guest.id))?.endedAt, Date);
      })
    );
  }
);
