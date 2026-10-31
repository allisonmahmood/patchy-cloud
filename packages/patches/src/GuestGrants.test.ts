import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Analytics } from "@patchy/analytics";
import { Companies, Users } from "@patchy/companies";
import * as GuestGrants from "./GuestGrants.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const live = { state: "live", current: true } as const;
const current = { tier: 1, manifest: { uses: {} } };
const handlers = {
  ...current,
  tier: 2,
  manifest: { uses: { members: { kind: "members" } } }
} as const;
const source = { patchId: "abcdefghijkl", id: "src", revision: 1 } as const;
const warehouse = {
  kind: "postgres",
  handle: "warehouse",
  id: "con_warehouse",
  revision: 1
} as const;
const none = new Set<string>();

it("lets guests open the current version of a live tier 1 or tier 2 patch", () => {
  assert.isTrue(Option.isNone(GuestGrants.unavailable(live, current, none)));
  assert.isTrue(GuestGrants.admitsGuests(live, current, none));
  // The member directory is a guest's as it is a member's.
  assert.isTrue(GuestGrants.admitsGuests(live, handlers, none));
});

it("says why guests can't open a patch", () => {
  assert.deepStrictEqual(
    GuestGrants.unavailable({ state: "retired" }, current, none),
    Option.some({ code: "retired" })
  );
  assert.deepStrictEqual(
    GuestGrants.unavailable({ state: "deleted" }, current, none),
    Option.some({ code: "deleted" })
  );
  assert.deepStrictEqual(
    GuestGrants.unavailable(live, { ...current, tier: 0 }, none),
    Option.some({ code: "tier", tier: 0 })
  );
  assert.deepStrictEqual(
    GuestGrants.unavailable(
      live,
      {
        ...handlers,
        manifest: { uses: { deals: { kind: "sharedTable", table: "deals", ...source } } }
      },
      none
    ),
    Option.some({ code: "shared_source", kind: "table", alias: "deals" })
  );
  assert.deepStrictEqual(
    GuestGrants.unavailable(
      live,
      {
        ...handlers,
        manifest: { uses: { receipts: { kind: "sharedStore", store: "receipts", ...source } } }
      },
      none
    ),
    Option.some({ code: "shared_source", kind: "store", alias: "receipts" })
  );
});

it("turns guests away from a version using a connection that blocks them, and only then", () => {
  const sales = { ...handlers, manifest: { uses: { sales: warehouse } } };
  assert.isTrue(Option.isNone(GuestGrants.unavailable(live, sales, none)));
  assert.deepStrictEqual(
    GuestGrants.unavailable(live, sales, new Set([warehouse.id])),
    Option.some({ code: "connection_blocked", integration: "postgres", handle: "warehouse" })
  );
});

it("admits guests to the current version only", () => {
  assert.isFalse(GuestGrants.admitsGuests({ ...live, current: false }, current, none));
});

it.layer(
  GuestGrants.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Patches.layer, Users.layer, Companies.layer)),
    Layer.provideMerge(Analytics.layerNoop),
    Layer.provideMerge(Fixtures.database)
  )
)("GuestGrants", (it) => {
  it.effect(
    "judges the version its caller loaded, though a publish lands before the grant's read",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const grants = yield* GuestGrants.GuestGrants;
        const { uploader } = Fixtures.identities;
        const request = Fixtures.recordInput(uploader);
        yield* patches.preflight(request);
        const { patchId } = yield* Fixtures.record(request);
        const guest = yield* (yield* Companies.Companies).create({
          handle: "guest-recheck",
          name: "Guest Recheck",
          clerkUserId: "user_guest_recheck",
          email: "gina@guest-recheck.example",
          userName: "Gina"
        });
        yield* grants.grant({ patchId, userId: guest.user.id, grantedBy: uploader.user.id });

        // A guest's stream recheck loads the current version, then a publish lands.
        const { patch, version } = Option.getOrThrow(yield* patches.find(patchId));
        yield* Fixtures.record(Fixtures.recordInput(uploader, { intent: "update", patchId }));

        const host = yield* grants.host({
          patchId,
          userId: guest.user.id,
          state: patch.state,
          current: patch.currentVersionId === version.id,
          version
        });
        assert.isTrue(Option.isSome(host));
      })
  );
});
