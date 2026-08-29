import { describe, expect, it } from "vitest";
import * as Bearer from "./Bearer.js";

describe("Bearer.parse", () => {
  it("classifies only an absent Authorization header as missing", () => {
    const longPadding = " \t".repeat(64);
    expect(Bearer.parse(undefined)).toEqual({ kind: "missing" });
    expect(Bearer.parse("")).toEqual({ kind: "invalid" });
    expect(Bearer.parse("   ")).toEqual({ kind: "invalid" });
    expect(Bearer.parse("Bearer   ")).toEqual({ kind: "invalid" });
    expect(Bearer.parse("Bearer dev-token second-token")).toEqual({ kind: "invalid" });
    expect(Bearer.parse("Bearer dev-token")).toEqual({ kind: "bearer", token: "dev-token" });
    expect(Bearer.parse(`bEaReR${longPadding}dev-token${longPadding}`)).toEqual({
      kind: "bearer",
      token: "dev-token"
    });
  });
});
