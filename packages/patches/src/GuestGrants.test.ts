import { assert, it } from "@effect/vitest";
import { Analytics } from "@patchy/analytics";
import { Users } from "@patchy/companies";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as GuestGrants from "./GuestGrants.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

let sequence = 0;
const outsider = "usr_guest_other_company";

it.layer(
  GuestGrants.layer.pipe(
    Layer.provideMerge(Patches.layer),
    Layer.provideMerge(Users.layer),
    Layer.provideMerge(Fixtures.database),
    Layer.provideMerge(
      Layer.succeed(Analytics.Analytics, Analytics.Analytics.of({ track: () => Effect.void }))
    )
  )
)("patch guest grants", (it) => {
  it.effect("admits only a granted outsider to the current eligible private version", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const patches = yield* Patches.Patches;
      const grants = yield* GuestGrants.GuestGrants;
      const ordinal = ++sequence;
      const patchId = `pguest${String(ordinal).padStart(6, "0")}`;
      yield* sql`INSERT INTO companies (id, handle, name)
        VALUES ('cmp_guest_other', 'guest-other', 'Other company') ON CONFLICT DO NOTHING`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES (${outsider}, 'clerk_guest_other', 'cmp_guest_other',
          'guest-other@patchy.local', 'Other member', 'member') ON CONFLICT DO NOTHING`;
      const input = Fixtures.recordInput(Fixtures.identities.uploader, {
        patchId,
        versionId: `ver_${patchId}`,
        title: `Guest test ${ordinal}`
      });
      yield* Fixtures.record(input);
      const found = yield* patches.find(patchId);
      assert.isTrue(Option.isSome(found));
      if (Option.isNone(found)) return;
      const { patch, version } = found.value;
      assert.isFalse(yield* grants.hasEligibleGrant(patch, version, outsider));
      const first = yield* grants.share(
        patch,
        version,
        "guest-other@patchy.local",
        Fixtures.identities.uploader.user.id
      );
      const again = yield* grants.share(
        patch,
        version,
        "guest-other@patchy.local",
        Fixtures.identities.uploader.user.id
      );
      assert.deepStrictEqual(again, first);
      assert.strictEqual(first.userId, outsider);
      assert.deepStrictEqual(yield* grants.list(patchId), [first]);
      assert.strictEqual((yield* grants.sharedWith(outsider))[0]?.patchId, patchId);
      assert.isTrue(yield* grants.hasEligibleGrant(patch, version, outsider));
      yield* patches.setScope(
        patchId,
        { userId: Fixtures.identities.uploader.user.id, admin: false },
        "public"
      );
      const publicPatch = Option.getOrThrow(yield* patches.find(patchId)).patch;
      assert.isFalse(yield* grants.hasEligibleGrant(publicPatch, version, outsider));
      yield* patches.setScope(
        patchId,
        { userId: Fixtures.identities.uploader.user.id, admin: false },
        "company"
      );
      const privatePatch = Option.getOrThrow(yield* patches.find(patchId)).patch;
      assert.isTrue(yield* grants.hasEligibleGrant(privatePatch, version, outsider));
      assert.isFalse(
        yield* grants.hasEligibleGrant(patch, version, Fixtures.identities.reader.user.id)
      );
      for (const [caseName, candidatePatch, candidateVersion] of [
        ["public", { ...patch, scope: "public" as const }, version],
        ["disabled", { ...patch, disabledAt: new Date().toISOString() }, version],
        ["retired", { ...patch, state: "retired" as const }, version],
        ["old version", { ...patch, currentVersionId: "old" }, version],
        ["wrong patch", { ...patch, id: "another-patch" }, version],
        ["wrong company", { ...patch, companyId: "another-company" }, version],
        ["unsupported tier", patch, { ...version, tier: 3 }],
        [
          "declared source",
          patch,
          {
            ...version,
            manifest: { ...version.manifest, uses: { source: { kind: "members" as const } } }
          }
        ]
      ] as const) {
        assert.isFalse(
          yield* grants.hasEligibleGrant(candidatePatch, candidateVersion, outsider),
          caseName
        );
      }
      const tierTwo = {
        ...version,
        tier: 2,
        manifest: { ...version.manifest, tier: 2 as const }
      } as Patches.PatchVersion;
      assert.isTrue(yield* grants.hasEligibleGrant(patch, tierTwo, outsider));
      const memberVersion = {
        ...version,
        manifest: { ...version.manifest, uses: { members: { kind: "members" as const } } }
      };
      assert.deepStrictEqual(yield* grants.unavailability(patch, memberVersion), {
        source: "Member directory (members)",
        reason: "is unavailable to guests",
        repair: "Remove the member directory declaration and member columns."
      });
      yield* sql`INSERT INTO connections
        (id, company_id, integration, handle, description, mode, status, display,
         credentials, key_id, credential_revision, metadata_revision, created_by, block_guests)
        VALUES ('conn_guest_block', ${patch.companyId}, 'postgres', 'warehouse', '', 'company',
          'connected', '{}'::jsonb, '', '', 1, 1, ${Fixtures.identities.uploader.user.id}, true)`;
      const connectionVersion = {
        ...version,
        tier: 2,
        manifest: {
          ...version.manifest,
          tier: 2,
          uses: {
            sales: {
              kind: "postgres" as const,
              handle: "warehouse",
              id: "conn_guest_block",
              revision: 1
            }
          }
        }
      } as Patches.PatchVersion;
      assert.deepStrictEqual(yield* grants.unavailability(patch, connectionVersion), {
        source: "warehouse",
        reason: "blocks guests",
        repair: "Ask an admin to unblock it or remove the declaration."
      });
      yield* sql`UPDATE connections SET block_guests = false WHERE id = 'conn_guest_block'`;
      assert.isNull(yield* grants.unavailability(patch, version));
      assert.isTrue(yield* grants.revoke(patchId, outsider));
      assert.isFalse(yield* grants.revoke(patchId, outsider));
      assert.isFalse(yield* grants.hasEligibleGrant(patch, version, outsider));
    })
  );
});
