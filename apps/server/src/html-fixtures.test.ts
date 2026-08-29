import { describe, expect, it } from "vitest";
import { readFixtureCorpus } from "../../../test/html-fixtures.mjs";
import { createTestApp } from "./test-harness.js";

describe("HTML fixture corpus", () => {
  it.each([
    { kind: "accept" as const, statusCode: 201 },
    { kind: "reject" as const, statusCode: 422 }
  ])("serves the $kind fixtures through the upload policy", async ({ kind, statusCode }) => {
    const token = `${kind}-fixture-token`;
    const harness = await createTestApp({ config: { bootstrapApiToken: token } });

    try {
      for (const fixture of await readFixtureCorpus(kind)) {
        const response = await harness.app.inject({
          method: "POST",
          url: "/api/uploads",
          headers: { authorization: `Bearer ${token}` },
          payload: { filename: fixture.filename, html: fixture.html }
        });

        expect(response.statusCode, fixture.filename).toBe(statusCode);
        if (kind === "reject") {
          expect(response.json(), fixture.filename).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([expect.any(String)])
          });
        }
      }
    } finally {
      await harness.close();
    }
  });
});
