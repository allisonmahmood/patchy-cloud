import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { GuestAccess } from "@patchy/runtime";
import * as Patches from "./Patches.js";

/** A grant is usable only on the current private browser version of an active patch. */
export const eligible = (patch: Patches.Patch, version: Patches.PatchVersion): boolean =>
  patch.state === "live" &&
  patch.disabledAt === null &&
  patch.scope === "company" &&
  patch.currentVersionId === version.id &&
  version.patchId === patch.id &&
  version.tier === 1 &&
  Object.keys(version.manifest.uses).length === 0;

export class GuestGrants extends Context.Service<
  GuestGrants,
  {
    readonly hasEligibleGrant: (
      patch: Patches.Patch,
      version: Patches.PatchVersion,
      userId: string
    ) => Effect.Effect<boolean, SqlError>;
    /** Share-time admission checks the same eligibility as page admission. */
    readonly grant: (
      patch: Patches.Patch,
      version: Patches.PatchVersion,
      userId: string,
      grantedBy: string
    ) => Effect.Effect<boolean, SqlError>;
    readonly revoke: (patchId: string, userId: string) => Effect.Effect<void, SqlError>;
  }
>()("@patchy/patches/GuestGrants") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const grantRows = SqlSchema.findOneOption({
    Request: Schema.Struct({
      patchId: Schema.String,
      companyId: Schema.String,
      userId: Schema.String
    }),
    Result: Schema.Struct({ found: Schema.Boolean }),
    execute: ({ patchId, companyId, userId }) => sql`
      SELECT true AS found FROM patch_guest_grants
      WHERE patch_id = ${patchId} AND company_id = ${companyId} AND user_id = ${userId}`
  });
  const hasEligibleGrant = Effect.fn("GuestGrants.hasEligibleGrant")(
    function* (patch: Patches.Patch, version: Patches.PatchVersion, userId: string) {
      if (!eligible(patch, version)) return false;
      return Option.isSome(
        yield* grantRows({ patchId: patch.id, companyId: patch.companyId, userId })
      );
    },
    Effect.catchTags({ SchemaError: Effect.die })
  );
  const grant = Effect.fn("GuestGrants.grant")(function* (
    patch: Patches.Patch,
    version: Patches.PatchVersion,
    userId: string,
    grantedBy: string
  ) {
    if (!eligible(patch, version)) return false;
    // Existing, active users from a different company are the only recipients.
    const rows = yield* sql`INSERT INTO patch_guest_grants
      (patch_id, company_id, user_id, granted_by)
      SELECT patches.id, patches.company_id, users.id, ${grantedBy}
      FROM patches JOIN users ON users.id = ${userId}
      WHERE patches.id = ${patch.id} AND patches.company_id = ${patch.companyId}
        AND patches.current_version_id = ${version.id}
        AND patches.scope = 'company' AND patches.disabled_at IS NULL
        AND patches.retired_at IS NULL AND patches.deleted_at IS NULL
        AND users.company_id <> patches.company_id AND users.deactivated_at IS NULL
      ON CONFLICT (patch_id, user_id) DO NOTHING RETURNING user_id`;
    return rows.length > 0;
  });
  const revoke = Effect.fn("GuestGrants.revoke")(function* (patchId: string, userId: string) {
    yield* sql`DELETE FROM patch_guest_grants WHERE patch_id = ${patchId} AND user_id = ${userId}`;
  });
  return GuestGrants.of({ hasEligibleGrant, grant, revoke });
});

export const layer = Layer.effect(GuestGrants, make);

/** Runtime keeps a narrow port and never imports Patches. */
export const runtimeLayer = Layer.effect(
  GuestAccess.GuestAccess,
  Effect.gen(function* () {
    const patches = yield* Patches.Patches;
    const grants = yield* GuestGrants;
    return GuestAccess.GuestAccess.of({
      admit: Effect.fn("GuestGrants.runtimeAdmit")(function* (
        loaded: Parameters<GuestAccess.GuestAccess["Service"]["admit"]>[0],
        userId: string
      ) {
        const found = yield* patches.find(loaded.patchId, undefined, loaded.versionId);
        if (Option.isNone(found) || found.value.patch.companyId !== loaded.companyId) return false;
        return yield* grants.hasEligibleGrant(found.value.patch, found.value.version, userId);
      })
    });
  })
);
