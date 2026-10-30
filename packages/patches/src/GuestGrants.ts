import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { GuestAccess } from "@patchy/runtime";
import type { Manifest } from "@patchy/api";
import * as Patches from "./Patches.js";

export interface Unavailability {
  readonly source: string;
  readonly reason: string;
  readonly repair: string;
}

/** A grant is usable only on the current private browser version of an active patch. */
export const eligible = (patch: Patches.Patch, version: Patches.PatchVersion): boolean =>
  patch.state === "live" &&
  patch.disabledAt === null &&
  patch.scope === "company" &&
  patch.currentVersionId === version.id &&
  version.patchId === patch.id &&
  version.tier === 1;

export class GuestGrants extends Context.Service<
  GuestGrants,
  {
    readonly unavailability: (
      patch: Patches.Patch,
      version: Patches.PatchVersion
    ) => Effect.Effect<Unavailability | null, SqlError>;
    readonly status: (
      patch: Patches.Patch,
      version: Patches.PatchVersion
    ) => Effect.Effect<Unavailability | null, SqlError>;
    readonly publishStatus: (
      patchId: string,
      companyId: string,
      scope: Patches.Patch["scope"],
      manifest: typeof Manifest.Type
    ) => Effect.Effect<Unavailability | null, SqlError>;
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
  const sourceUnavailability = Effect.fn("GuestGrants.sourceUnavailability")(function* (
    companyId: string,
    manifest: typeof Manifest.Type
  ) {
    for (const [alias, use] of Object.entries(manifest.uses)) {
      if (use.kind === "members")
        return {
          source: `Member directory (${alias})`,
          reason: "is unavailable to guests",
          repair: "Remove the member directory declaration and member columns."
        } satisfies Unavailability;
      if (use.kind === "sharedTable" || use.kind === "sharedStore")
        return {
          source: `${use.kind === "sharedTable" ? "Shared table" : "Shared store"} (${alias})`,
          reason: "is unavailable to guests",
          repair: "Remove this shared source declaration."
        } satisfies Unavailability;
      const rows = yield* sql<{ handle: string; blockGuests: boolean }>`
        SELECT handle, block_guests AS "blockGuests" FROM connections
        WHERE id = ${use.id} AND company_id = ${companyId} AND integration = ${use.kind}`;
      if (rows[0]?.blockGuests)
        return {
          source: rows[0].handle,
          reason: "blocks guests",
          repair: "Ask an admin to unblock it or remove the declaration."
        } satisfies Unavailability;
    }
    return null;
  });
  const unavailability = Effect.fn("GuestGrants.unavailability")(function* (
    patch: Patches.Patch,
    version: Patches.PatchVersion
  ) {
    const source = yield* sourceUnavailability(patch.companyId, version.manifest);
    if (source !== null) return source;
    if (eligible(patch, version)) return null;
    return {
      source: "This patch",
      reason: "is not currently available to guests",
      repair: "Keep it live, private and on a supported guest tier."
    } satisfies Unavailability;
  });
  const hasGrants = Effect.fn("GuestGrants.hasGrants")(function* (patchId: string) {
    const rows = yield* sql`SELECT 1 FROM patch_guest_grants WHERE patch_id = ${patchId} LIMIT 1`;
    return rows.length > 0;
  });
  const status = Effect.fn("GuestGrants.status")(function* (
    patch: Patches.Patch,
    version: Patches.PatchVersion
  ) {
    if (patch.scope !== "company" || patch.state !== "live") return null;
    return (yield* hasGrants(patch.id)) ? yield* unavailability(patch, version) : null;
  });
  const publishStatus = Effect.fn("GuestGrants.publishStatus")(function* (
    patchId: string,
    companyId: string,
    scope: Patches.Patch["scope"],
    manifest: typeof Manifest.Type
  ) {
    if (scope !== "company" || !(yield* hasGrants(patchId))) return null;
    const source = yield* sourceUnavailability(companyId, manifest);
    return (
      source ??
      (manifest.tier === 1
        ? null
        : ({
            source: "This patch",
            reason: "is not currently available to guests",
            repair: "Publish a supported guest tier."
          } satisfies Unavailability))
    );
  });
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
      if ((yield* unavailability(patch, version)) !== null) return false;
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
    if ((yield* unavailability(patch, version)) !== null) return false;
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
  return GuestGrants.of({ unavailability, status, publishStatus, hasEligibleGrant, grant, revoke });
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
