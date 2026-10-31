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
    Option.some({ _tag: "Retired" })
  );
  assert.deepStrictEqual(
    GuestGrants.unavailable({ state: "deleted" }, current, none),
    Option.some({ _tag: "Deleted" })
  );
  assert.deepStrictEqual(
    GuestGrants.unavailable(live, { ...current, tier: 0 }, none),
    Option.some({ _tag: "Tier", tier: 0 })
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
    Option.some({ _tag: "SharedSource", kind: "table", alias: "deals" })
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
    Option.some({ _tag: "SharedSource", kind: "store", alias: "receipts" })
  );
});

it("turns guests away from a version using a connection that blocks them, and only then", () => {
  const sales = { ...handlers, manifest: { uses: { sales: warehouse } } };
  assert.isTrue(Option.isNone(GuestGrants.unavailable(live, sales, none)));
  assert.deepStrictEqual(
    GuestGrants.unavailable(live, sales, new Set([warehouse.id])),
    Option.some({ _tag: "ConnectionBlocked", integration: "postgres", handle: "warehouse" })
  );
});

it("admits guests to the current version only", () => {
  assert.isFalse(GuestGrants.admitsGuests(live, { ...current, id: "ver_older" }, none));
});
