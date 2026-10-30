import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as GuestGrants from "./GuestGrants.js";

const live = { state: "live", currentVersionId: "ver_current" } as const;
const current = { id: "ver_current", tier: 1, manifest: { uses: {} } };
const handlers = {
  ...current,
  tier: 2,
  manifest: { uses: { members: { kind: "members" } } }
} as const;
const source = { patchId: "abcdefghijkl", id: "src", revision: 1 } as const;

it("lets guests open the current version of a live tier 1 or tier 2 patch", () => {
  assert.isTrue(Option.isNone(GuestGrants.unavailable(live, current)));
  assert.isTrue(GuestGrants.admitsGuests(live, current));
  // The member directory is a guest's as it is a member's.
  assert.isTrue(GuestGrants.admitsGuests(live, handlers));
});

it("says why guests can't open a patch", () => {
  assert.deepStrictEqual(
    GuestGrants.unavailable({ state: "retired" }, current),
    Option.some({ _tag: "Retired" })
  );
  assert.deepStrictEqual(
    GuestGrants.unavailable({ state: "deleted" }, current),
    Option.some({ _tag: "Deleted" })
  );
  assert.deepStrictEqual(
    GuestGrants.unavailable(live, { ...current, tier: 0 }),
    Option.some({ _tag: "Tier", tier: 0 })
  );
  assert.deepStrictEqual(
    GuestGrants.unavailable(live, {
      ...handlers,
      manifest: { uses: { deals: { kind: "sharedTable", table: "deals", ...source } } }
    }),
    Option.some({ _tag: "SharedSource", kind: "table", alias: "deals" })
  );
  assert.deepStrictEqual(
    GuestGrants.unavailable(live, {
      ...handlers,
      manifest: { uses: { receipts: { kind: "sharedStore", store: "receipts", ...source } } }
    }),
    Option.some({ _tag: "SharedSource", kind: "store", alias: "receipts" })
  );
});

it("admits guests to the current version only", () => {
  assert.isFalse(GuestGrants.admitsGuests(live, { ...current, id: "ver_older" }));
});
