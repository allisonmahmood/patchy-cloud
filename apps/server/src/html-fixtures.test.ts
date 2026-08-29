import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServerConfig } from "@patchy/config";
import { JsonFilePatchyDb } from "@patchy/db";
import { FileSystemHtmlStorage } from "@patchy/storage";
import { readFixtureCorpus } from "../../../test/html-fixtures.mjs";
import { createApp } from "./app.js";
import { createTestRuntime } from "./testing.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "patchy-html-fixtures-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("HTML fixture corpus", () => {
  it.each([
    { kind: "accept" as const, statusCode: 201 },
    { kind: "reject" as const, statusCode: 422 }
  ])("serves the $kind fixtures through the upload policy", async ({ kind, statusCode }) => {
    const token = `${kind}-fixture-token`;
    const db = new JsonFilePatchyDb(path.join(tempDir, `${kind}-db.json`));
    await db.initialize(token);
    const storage = new FileSystemHtmlStorage(path.join(tempDir, `${kind}-drafts`));
    const config = getServerConfig({});
    const app = createApp({ config, db, storage, runtime: createTestRuntime({ db, config }) });

    try {
      for (const fixture of await readFixtureCorpus(kind)) {
        const response = await app.inject({
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
      await app.close();
      await db.close();
    }
  });
});
