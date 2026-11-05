import { assert, describe, it } from "@effect/vitest";
import { sequenceSet, uidRange, uidSet } from "./Refs.js";

describe("UID sets", () => {
  it("names explicit, non-empty ranges only", () => {
    assert.strictEqual(sequenceSet(uidRange(3, 9)!), "3:9");
    assert.strictEqual(sequenceSet(uidRange(-5, 1)!), "1");
    assert.strictEqual(
      sequenceSet(uidRange(4_294_967_290, 5_000_000_000)!),
      "4294967290:4294967295"
    );
    assert.isUndefined(uidRange(9, 3));
  });

  it("compacts UIDs into ascending runs", () => {
    assert.strictEqual(uidSet([9, 3, 4, 5, 5, 12, 11]), "3:5,9,11:12");
    assert.strictEqual(uidSet([7]), "7");
    assert.isUndefined(uidSet([]));
    assert.isUndefined(uidSet([0, -1, 1.5, 4_294_967_296]));
  });
});
