import * as Effect from "effect/Effect";
import { RequireSession } from "@patchy/auth";
import { Companies } from "@patchy/companies";
import type { RuntimeMe } from "@patchy/api";
import * as GuestAccess from "./GuestAccess.js";
import type { LoadedVersion } from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";

/** Turn an authenticated home member into this loaded patch's viewer. */
export const resolve = Effect.fn("PatchViewer.resolve")(function* (
  loaded: LoadedVersion & { readonly patchTier: number },
  viewer: RequireSession.Viewer["Service"]
): Effect.fn.Return<
  NonNullable<RuntimeMe>,
  Runtime.RuntimeError,
  Companies.Companies | GuestAccess.GuestAccess
> {
  const guest = viewer.company.id !== loaded.companyId;
  if (guest) {
    const access = yield* GuestAccess.GuestAccess;
    if (
      !(yield* access
        .admit(loaded, viewer.user.id)
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause }))))
    )
      return yield* new Runtime.AccessDenied({});
  }
  const company = guest
    ? yield* (yield* Companies.Companies)
        .findById(loaded.companyId)
        .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })))
    : viewer.company;
  if (company === null) return yield* new Runtime.AccessDenied({});
  return {
    user: viewer.user,
    company: { id: company.id, handle: company.handle, name: company.name },
    admin: !guest && viewer.role === "admin",
    guest
  };
});
