import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CURRENT_RELEASE, WIRE_VERSION } from "@patchy/api";
import * as GrantedGuests from "./GrantedGuests.js";
import * as LoadedVersions from "./LoadedVersions.js";

it.effect("rechecks current audience for owners and admins on an already loaded version", () =>
  Effect.gen(function* () {
    const loaded: LoadedVersions.LoadedVersion = {
      companyId: "company",
      patchId: "patch",
      versionId: "version",
      wireVersion: WIRE_VERSION,
      scope: "company",
      manifest: {
        manifestVersion: 1,
        release: CURRENT_RELEASE,
        tier: 1,
        tables: {},
        files: {},
        uses: {}
      }
    };
    const person = {
      user: { id: "owner", name: "Owner", email: "owner@example.com" },
      company: { id: "company", name: "Company", handle: "company" },
      whatsNewSeen: 0,
      role: "super_admin" as const
    };
    let eligible = true;
    const port = GrantedGuests.GrantedGuests.of({
      member: () => Effect.sync(() => eligible),
      host: () => Effect.die("A company viewer cannot fall through to guest admission")
    });
    const admitted = yield* GrantedGuests.viewerOf(loaded, person).pipe(
      Effect.provideService(GrantedGuests.GrantedGuests, port)
    );
    assert.isTrue(Option.isSome(admitted));
    if (Option.isNone(admitted)) return;
    const recheck = GrantedGuests.recheck(loaded, admitted.value, person).pipe(
      Effect.provideService(GrantedGuests.GrantedGuests, port),
      Effect.provideService(LoadedVersions.LoadedVersions, {
        findForViewer(this: LoadedVersions.LoadedVersions["Service"], patchId) {
          return this.find(patchId);
        },
        find: () => Effect.succeed(Option.none())
      })
    );
    eligible = false;
    assert.isTrue(Option.isNone(yield* recheck));
    assert.isTrue(
      Option.isNone(
        yield* GrantedGuests.viewerOf(loaded, person).pipe(
          Effect.provideService(GrantedGuests.GrantedGuests, port)
        )
      )
    );
    eligible = true;
    assert.isTrue(Option.isSome(yield* recheck));
  })
);
