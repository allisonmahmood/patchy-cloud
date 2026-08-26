import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("workspace development exports", () => {
  it("resolves a dependency's source entrypoint under Vitest", () => {
    const resolved = fileURLToPath(import.meta.resolve("@patchy/core"));
    const sourceEntrypoint = path.resolve(
      import.meta.dirname,
      "../../../packages/core/src/index.ts"
    );

    expect(resolved).toBe(sourceEntrypoint);
  });
});
