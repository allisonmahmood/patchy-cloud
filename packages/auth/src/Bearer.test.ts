import { describe, expect, it } from "vitest";
import * as Bearer from "./Bearer.js";
import { DEV_SEED } from "./seed.js";

describe("Bearer.parse", () => {
  it("classifies only an absent Authorization header as missing", () => {
    const longPadding = " \t".repeat(64);
    expect(Bearer.parse(undefined)).toEqual({ kind: "missing" });
    expect(Bearer.parse("")).toEqual({ kind: "invalid" });
    expect(Bearer.parse("   ")).toEqual({ kind: "invalid" });
    expect(Bearer.parse("Bearer   ")).toEqual({ kind: "invalid" });
    expect(Bearer.parse(`Bearer ${DEV_SEED.token} second-token`)).toEqual({ kind: "invalid" });
    expect(Bearer.parse(`Bearer ${DEV_SEED.token}`)).toEqual({
      kind: "bearer",
      token: DEV_SEED.token
    });
    expect(Bearer.parse(`bEaReR${longPadding}${DEV_SEED.token}${longPadding}`)).toEqual({
      kind: "bearer",
      token: DEV_SEED.token
    });
  });
});
