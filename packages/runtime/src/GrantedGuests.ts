import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RuntimeMe } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";

type Viewer = NonNullable<RuntimeMe>;

/** Hosting supplies Patches' audience and guest decisions; Runtime owns no grant policy. */
export class GrantedGuests extends Context.Service<
  GrantedGuests,
  {
    /** Current same-company audience admission, supplied by Hosting. */
    readonly member: (
      loaded: LoadedVersions.LoadedVersion,
      userId: string
    ) => Effect.Effect<boolean, Runtime.SourceUnavailable>;
    /** Hosts with durable member authority can reuse an invocation's unchanged admission. */
    readonly memberAuthority?: (
      loaded: LoadedVersions.LoadedVersion
    ) => Effect.Effect<string, Runtime.SourceUnavailable>;
    /**
     * The patch's company, while this person holds an active grant to the patch and its guests
     * can open this version: its current one when `loaded` was read, with nothing it declares
     * keeping guests out.
     */
    readonly host: (
      loaded: LoadedVersions.LoadedVersion,
      userId: string
    ) => Effect.Effect<Option.Option<Viewer["company"]>, Runtime.SourceUnavailable>;
  }
>()("@patchy/runtime/GrantedGuests") {}

/**
 * Who a signed-in person is to one loaded version: an entitled member of its company; the patch's guest,
 * as themselves in the patch's company and never its admin, while `host` admits them; or nobody.
 * The browser doors admit with it and ask again with `recheck`.
 */
export const viewerOf = Effect.fnUntraced(function* (
  loaded: LoadedVersions.LoadedVersion,
  person: RequireSession.Viewer["Service"]
): Effect.fn.Return<Option.Option<Viewer>, Runtime.SourceUnavailable, GrantedGuests> {
  if (person.company.id === loaded.companyId) {
    if (!(yield* (yield* GrantedGuests).member(loaded, person.user.id))) return Option.none();
    return Option.some({
      user: person.user,
      company: person.company,
      admin: person.role !== "member"
    });
  }
  const host = yield* (yield* GrantedGuests).host(loaded, person.user.id);
  return Option.map(host, (company) => ({
    user: person.user,
    company,
    admin: false,
    guest: true as const
  }));
});

/**
 * Reauthorize against current grants. Members keep the loaded version and satisfy the
 * patch's current audience. Guests follow the current version and its guest restrictions.
 */
export const recheck = Effect.fnUntraced(function* (
  loaded: LoadedVersions.LoadedVersion,
  admitted: Viewer,
  person: RequireSession.Viewer["Service"]
): Effect.fn.Return<
  Option.Option<Viewer>,
  Runtime.SourceUnavailable,
  GrantedGuests | LoadedVersions.LoadedVersions
> {
  if (admitted.guest !== true) return yield* viewerOf(loaded, person);
  const current = yield* (yield* LoadedVersions.LoadedVersions)
    .find(loaded.patchId)
    .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
  return Option.isNone(current) ? Option.none() : yield* viewerOf(current.value, person);
});
