import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as GuestGrants from "./GuestGrants.js";

const live = { state: "live", currentVersionId: "ver_current" } as const;
const current = { id: "ver_current", tier: 1 };

it("lets guests open the current version of a live tier 1 patch", () => {
  assert.isTrue(Option.isNone(GuestGrants.unavailable(live, current)));
  assert.isTrue(GuestGrants.admitsGuests(live, current));
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
    GuestGrants.unavailable(live, { tier: 2 }),
    Option.some({ _tag: "Tier", tier: 2 })
  );
});

it("admits guests to the current version only", () => {
  assert.isFalse(GuestGrants.admitsGuests(live, { id: "ver_older", tier: 1 }));
});
