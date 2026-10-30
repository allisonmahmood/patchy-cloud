import { assert, it } from "@effect/vitest";
import { Analytics } from "@patchy/analytics";
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
      assert.isTrue(
        yield* grants.grant(patch, version, outsider, Fixtures.identities.uploader.user.id)
      );
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
        ["tier two", patch, { ...version, tier: 2 }],
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
      yield* grants.revoke(patchId, outsider);
      assert.isFalse(yield* grants.hasEligibleGrant(patch, version, outsider));
    })
  );
});
