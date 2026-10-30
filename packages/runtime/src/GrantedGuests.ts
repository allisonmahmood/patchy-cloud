import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";
import type { RuntimeMe } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import * as LoadedVersions from "./LoadedVersions.js";

type Viewer = NonNullable<RuntimeMe>;

/** Patches supplies this port; Runtime never reads grants itself. */
export class GrantedGuests extends Context.Service<
  GrantedGuests,
  {
    /** The patch's company, while this person holds an active grant to the patch. */
    readonly host: (input: {
      readonly patchId: string;
      readonly companyId: string;
      readonly userId: string;
    }) => Effect.Effect<Option.Option<Viewer["company"]>, SqlError>;
  }
>()("@patchy/runtime/GrantedGuests") {}

/**
 * Who a signed-in person is to one loaded version: a member of its company; the patch's guest,
 * as themselves in the patch's company and never its admin, while the version admits guests and
 * their grant is active; or nobody. The browser doors admit with it and ask again with `recheck`.
 */
export const viewerOf = Effect.fnUntraced(function* (
  loaded: LoadedVersions.LoadedVersion,
  person: RequireSession.Viewer["Service"]
): Effect.fn.Return<Option.Option<Viewer>, SqlError, GrantedGuests> {
  if (person.company.id === loaded.companyId)
    return Option.some({
      user: person.user,
      company: person.company,
      admin: person.role === "admin"
    });
  if (loaded.admitsGuests !== true) return Option.none();
  const host = yield* (yield* GrantedGuests).host({
    patchId: loaded.patchId,
    companyId: loaded.companyId,
    userId: person.user.id
  });
  return Option.map(host, (company) => ({
    user: person.user,
    company,
    admin: false,
    guest: true as const
  }));
});

/**
 * `viewerOf` once more for a viewer admitted to `loaded`. A member's answer stays with that
 * version; a guest's follows the patch's current one, so a publish carries them on as it does
 * members, and a patch guests can no longer open leaves them out.
 */
export const recheck = Effect.fnUntraced(function* (
  loaded: LoadedVersions.LoadedVersion,
  admitted: Viewer,
  person: RequireSession.Viewer["Service"]
): Effect.fn.Return<
  Option.Option<Viewer>,
  SqlError,
  GrantedGuests | LoadedVersions.LoadedVersions
> {
  if (admitted.guest !== true) return yield* viewerOf(loaded, person);
  const current = yield* (yield* LoadedVersions.LoadedVersions).find(loaded.patchId);
  return Option.isNone(current) ? Option.none() : yield* viewerOf(current.value, person);
});
