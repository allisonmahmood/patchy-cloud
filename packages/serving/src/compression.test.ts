import { describe, expect, it } from "vitest";
import { negotiate } from "./compression.js";

// The route's tests in Pages.test.ts cover ordinary browser headers end to end.
describe("negotiate", () => {
  it.each([
    // Refusing everything still gets identity, never a 406.
    ["*;q=0", "identity"],
    ["identity;q=0", "identity"],
    ["br;q=0, gzip;q=0, identity;q=0", "identity"],
    ["*;q=0, identity", "identity"],
    // A malformed weight drops its entry rather than ranking it.
    ["br;q=2, gzip;q=1", "gzip"],
    ["br;q=0.0001, gzip;q=0", "identity"],
    ["br;q=1e0, gzip;q=0.5", "gzip"],
    ["br;q=1.000, gzip;q=0.999", "br"]
  ] as const)("%s sends %s", (header, coding) => {
    expect(negotiate(header)).toBe(coding);
  });
});
