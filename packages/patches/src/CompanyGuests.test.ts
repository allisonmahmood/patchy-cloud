import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import { Analytics } from "@patchy/analytics";
import { Guests } from "@patchy/companies";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const { uploader } = Fixtures.identities;
const owner = { userId: uploader.user.id, admin: false };
const companyId = uploader.company.id;
const analytics = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: () => Effect.void })
);
const publish = (name: string) =>
  Fixtures.record(Fixtures.recordInput(uploader, { manifest: { ...Fixtures.manifest, name } }));

it.layer(Patches.layer.pipe(Layer.provideMerge(analytics), Layer.provideMerge(Fixtures.database)))(
  "company guest list",
  (it) => {
    it.effect("isolates identities and grants by company, including guests with no grants", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_roster', 'roster', 'Other')`;
        yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
          VALUES ('usr_roster', 'clerk_roster_owner', 'cmp_roster', 'owner@roster.test', 'Owner', 'admin')`;
        yield* sql`INSERT INTO machine_tokens
          (id, user_id, name, token_hash, created_at, expires_at, last_used_at)
          VALUES ('tok_roster', 'usr_roster', 'Machine', 'roster-hash', now(),
            now() + interval '90 days', now())`;
        const identity = { clerkUserId: "clerk_roster", email: "guest@roster.test", name: "Guest" };
        const here = yield* Guests.create({ ...identity, companyId });
        const there = yield* Guests.create({ ...identity, companyId: "cmp_roster" });
        const empty = yield* Guests.create({
          companyId,
          clerkUserId: "clerk_roster_empty",
          email: "empty@roster.test",
          name: "Empty"
        });
        const suspended = yield* Guests.setDeactivated({ ...empty, deactivated: true });
        const local = yield* publish("roster-local");
        const foreign = yield* Fixtures.record(
          Fixtures.recordInput(uploader, {
            companyId: "cmp_roster",
            ownerUserId: "usr_roster",
            machineTokenId: "tok_roster",
            manifest: { ...Fixtures.manifest, name: "roster-local" },
            title: "Other company's title"
          })
        );
        const localGrant = yield* patches.grantGuest(local.patchId, here.id, owner);
        const foreignGrant = yield* patches.grantGuest(foreign.patchId, there.id, {
          userId: "usr_roster",
          admin: true
        });
        const membersBefore = yield* sql`SELECT * FROM users ORDER BY id`;
        assert.deepStrictEqual(yield* patches.companyGuests(companyId), [
          {
            guest: suspended!,
            grants: []
          },
          {
            guest: here,
            grants: [
              {
                grant: localGrant,
                access: "active",
                name: local.name,
                title: "Fixture patch",
                manageable: true
              }
            ]
          }
        ]);
        assert.deepStrictEqual(yield* patches.companyGuests("cmp_roster"), [
          {
            guest: there,
            grants: [
              {
                grant: foreignGrant,
                access: "active",
                name: foreign.name,
                title: "Other company's title",
                manageable: true
              }
            ]
          }
        ]);
        assert.deepStrictEqual(yield* patches.companyGuests("unknown-company"), []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM users ORDER BY id`, membersBefore);
      })
    );

    it.effect(
      "reports current access and only the latest grant through suspension, ending and re-sharing",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const patches = yield* Patches.Patches;
          const guest = yield* Guests.create({
            companyId,
            clerkUserId: "clerk_roster_states",
            email: "states@roster.test",
            name: "States"
          });
          const patch = yield* publish("roster-states");
          const untouched = yield* publish("roster-untouched");
          const first = yield* patches.grantGuest(patch.patchId, guest.id, owner);
          const other = yield* patches.grantGuest(untouched.patchId, guest.id, owner);
          const read = () =>
            patches
              .companyGuests(companyId)
              .pipe(Effect.map((rows) => rows.find((row) => row.guest.id === guest.id)!));
          const selected = () =>
            read().pipe(
              Effect.map((row) =>
                row.grants.find((entry) => entry.grant.patchId === patch.patchId)!
              )
            );
          assert.strictEqual((yield* selected()).access, "active");
          for (const tier of [1, 2, 0]) {
            yield* sql`UPDATE patch_versions SET tier = ${tier} WHERE id = ${patch.versionId}`;
            assert.strictEqual((yield* selected()).access, tier === 0 ? "active" : "unavailable");
          }
          yield* sql`UPDATE patches SET current_version_id = NULL WHERE id = ${patch.patchId}`;
          assert.strictEqual((yield* selected()).access, "unavailable");
          yield* sql`UPDATE patches SET current_version_id = ${patch.versionId} WHERE id = ${patch.patchId}`;
          yield* Guests.setDeactivated({ ...guest, deactivated: true });
          assert.instanceOf((yield* read()).guest.deactivatedAt, Date);
          assert.strictEqual((yield* selected()).access, "deactivated");
          yield* patches.revokeGuest(patch.patchId, guest.id, owner);
          assert.strictEqual((yield* selected()).access, "revoked");
          yield* Guests.setDeactivated({ ...guest, deactivated: false });
          assert.strictEqual((yield* selected()).access, "revoked");
          const second = yield* patches.grantGuest(patch.patchId, guest.id, owner);
          assert.notStrictEqual(second.id, first.id);
          assert.strictEqual((yield* selected()).grant.id, second.id);
          assert.strictEqual((yield* selected()).access, "active");
          yield* Guests.end(guest);
          assert.instanceOf((yield* read()).guest.endedAt, Date);
          assert.strictEqual((yield* selected()).access, "ended");
          // Explicit share reopens this identity and grants only the selected patch.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT companies_guest_member_lock(${companyId}, ${guest.clerkUserId})`;
              yield* Guests.reopenForShare(guest);
              yield* patches.grantGuest(patch.patchId, guest.id, owner);
            })
          );
          const reopened = yield* read();
          assert.isNull(reopened.guest.endedAt);
          assert.lengthOf(reopened.grants, 2);
          assert.strictEqual((yield* selected()).access, "active");
          assert.notStrictEqual((yield* selected()).grant.id, second.id);
          assert.strictEqual(
            reopened.grants.find((entry) => entry.grant.id === other.id)?.access,
            "ended"
          );
          yield* patches.retire(patch.patchId, owner);
          assert.strictEqual((yield* selected()).access, "unavailable");
          assert.isTrue((yield* selected()).manageable);
          yield* patches.restore(patch.patchId, owner);
          assert.strictEqual((yield* selected()).access, "active");
          yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${patch.patchId}`;
          assert.strictEqual((yield* selected()).access, "unavailable");
          assert.isFalse((yield* selected()).manageable);
          yield* sql`UPDATE patches SET disabled_at = NULL WHERE id = ${patch.patchId}`;
          yield* patches.setScope(patch.patchId, owner, "public");
          assert.strictEqual((yield* selected()).access, "ended");
          yield* patches.setScope(patch.patchId, owner, "company");
          assert.strictEqual((yield* selected()).access, "ended");
          yield* patches.grantGuest(patch.patchId, guest.id, owner);
          yield* patches.delete(patch.patchId, owner);
          assert.strictEqual((yield* selected()).access, "unavailable");
          yield* TestClock.adjust(30 * 24 * 60 * 60 * 1000);
          yield* patches.purgeDeleted(patch.patchId);
          const reclaimed = yield* selected();
          assert.strictEqual(reclaimed.access, "ended");
          assert.strictEqual(reclaimed.grant.endReason, "reclaimed");
          assert.isNull(reclaimed.name);
          assert.isNull(reclaimed.title);
          assert.isFalse(reclaimed.manageable);
          yield* publish(patch.name);
          assert.lengthOf((yield* read()).grants, 2);
          assert.isNull((yield* selected()).name);
          const history =
            yield* sql`SELECT id, end_reason FROM patch_guest_grants WHERE id IN (${first.id}, ${second.id}) ORDER BY grant_number`;
          assert.deepStrictEqual(history, [
            { id: first.id, end_reason: "revoked" },
            { id: second.id, end_reason: "guest_ended" }
          ]);
        })
    );
  }
);
