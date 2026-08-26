import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getServerConfig } from "@patchy/config";
import type { ServerConfig } from "@patchy/config";
import { JsonFilePatchyDb, PostgresPatchyDb } from "@patchy/db";
import type { PatchyDb } from "@patchy/db";
import { FileSystemHtmlStorage } from "@patchy/storage";
import type { FastifyInstance } from "fastify";
import { createPostgresTestDatabase } from "../../../test/postgres.js";
import { createApp } from "./app.js";

interface OpenedDatabase {
  db: PatchyDb;
  databaseUrl?: string;
  close(): Promise<void>;
}

interface HttpDatabaseDriver {
  name: string;
  open(tempDir: string): Promise<OpenedDatabase>;
}

const databaseDrivers: HttpDatabaseDriver[] = [
  {
    name: "JSON",
    async open(tempDir) {
      const db = new JsonFilePatchyDb(path.join(tempDir, "db.json"));
      return { db, close: () => db.close() };
    }
  },
  {
    name: "Postgres",
    async open() {
      const testDatabase = await createPostgresTestDatabase();
      const db = new PostgresPatchyDb(testDatabase.connectionString);
      return {
        db,
        databaseUrl: testDatabase.connectionString,
        async close() {
          await db.close();
          await testDatabase.drop();
        }
      };
    }
  }
];

describe.each(databaseDrivers)("Patchy Cloud HTTP database contract: $name", (driver) => {
  it("creates, updates, and serves a draft", async () => {
    const harness = await createHttpHarness(driver, "upload");

    try {
      const unauthenticated = await harness.app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: { html: html("Not allowed") }
      });
      expect(unauthenticated.statusCode).toBe(401);

      const created = await upload(harness.app, "dev-token", "Database create");
      expect(created.statusCode).toBe(201);
      const firstBody: unknown = created.json();
      const draftId = stringField(firstBody, "draftId");
      const versionNumber = numberField(firstBody, "versionNumber");
      const updated = await harness.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: { draftId, html: html("Database update") }
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        draftId,
        versionNumber: 2
      });

      const latest = await harness.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(latest.statusCode).toBe(200);
      expect(latest.body).toContain("Database update");

      const original = await harness.app.inject({
        method: "GET",
        url: `/d/${draftId}/v/${versionNumber}`
      });
      expect(original.statusCode).toBe(200);
      expect(original.body).toContain("Database create");
    } finally {
      await harness.close();
    }
  });

  it("persists token scopes and admin-only moderation", async () => {
    const harness = await createHttpHarness(driver, "scopes");

    try {
      const readToken = await mintAdminToken(harness.app, "Read only", ["read"]);
      const uploadToken = await mintAdminToken(harness.app, "Uploader", ["upload"]);
      const adminToken = await mintAdminToken(harness.app, "Moderator", ["admin"]);

      const refusedUpload = await upload(harness.app, readToken, "Wrong scope");
      expect(refusedUpload.statusCode).toBe(403);

      const created = await upload(harness.app, uploadToken, "Scoped upload");
      expect(created.statusCode).toBe(201);
      const draftId = stringField(created.json(), "draftId");

      const refusedPin = await harness.app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/pin`,
        headers: { authorization: `Bearer ${uploadToken}` }
      });
      expect(refusedPin.statusCode).toBe(403);

      const pinned = await harness.app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/pin`,
        headers: { authorization: `Bearer ${adminToken}` }
      });
      expect(pinned.statusCode).toBe(200);
      expect(pinned.json()).toEqual({ ok: true, pinned: true });
    } finally {
      await harness.close();
    }
  });

  it("mints self-service tokens and records the moderation loop", async () => {
    const harness = await createHttpHarness(driver, "self-service", {
      allowSelfServiceTokens: true
    });

    try {
      const minted = await harness.app.inject({
        method: "POST",
        url: "/api/tokens/self-service",
        remoteAddress: "198.51.100.20"
      });
      expect(minted.statusCode).toBe(201);
      const token = stringField(minted.json(), "token");

      const identity = await harness.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(identity.statusCode).toBe(200);
      expect(identity.json()).toMatchObject({ scopes: ["upload"] });

      const created = await upload(harness.app, token, "Reportable");
      expect(created.statusCode).toBe(201);
      const draftId = stringField(created.json(), "draftId");

      const reported = await harness.app.inject({
        method: "POST",
        url: `/report/${draftId}`,
        remoteAddress: "203.0.113.9",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "reason=Database+contract"
      });
      expect(reported.statusCode).toBe(200);

      const inspected = await harness.app.inject({
        method: "GET",
        url: `/api/drafts/${draftId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(inspected.statusCode).toBe(200);

      const disabled = await harness.app.inject({
        method: "POST",
        url: `/api/drafts/${draftId}/disable`,
        headers: { authorization: "Bearer dev-token" },
        payload: { reason: "operator decision" }
      });
      expect(disabled.statusCode).toBe(200);

      const unavailable = await harness.app.inject({ method: "GET", url: `/d/${draftId}` });
      expect(unavailable.statusCode).toBe(404);
    } finally {
      await harness.close();
    }
  });
});

interface HttpHarness {
  app: FastifyInstance;
  close(): Promise<void>;
}

async function createHttpHarness(
  driver: HttpDatabaseDriver,
  label: string,
  overrides: Partial<ServerConfig> = {}
): Promise<HttpHarness> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `patchy-server-${label}-`));
  const opened = await driver.open(tempDir);
  const config: ServerConfig = {
    ...getServerConfig({
      ...(opened.databaseUrl ? { DATABASE_URL: opened.databaseUrl } : {}),
      PATCHY_BOOTSTRAP_API_TOKEN: "dev-token",
      PATCHY_DB_FILE: path.join(tempDir, "db.json"),
      PATCHY_STORAGE_DIR: path.join(tempDir, "drafts")
    }),
    ...overrides
  };
  await opened.db.initialize(config.bootstrapApiToken);
  const storage = new FileSystemHtmlStorage(config.storageDir);
  const app = createApp({ config, db: opened.db, storage });

  return {
    app,
    async close() {
      await app.close();
      await opened.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function mintAdminToken(
  app: FastifyInstance,
  name: string,
  scopes: string[]
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/tokens",
    headers: { authorization: "Bearer dev-token" },
    payload: { name, scopes }
  });
  expect(response.statusCode).toBe(201);
  return stringField(response.json(), "token");
}

function upload(app: FastifyInstance, token: string, title: string) {
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: `Bearer ${token}` },
    payload: { html: html(title) }
  });
}

function stringField(value: unknown, field: string): string {
  if (hasField(value, field) && typeof value[field] === "string") {
    return value[field];
  }
  throw new Error(`Expected response field ${field} to be a string.`);
}

function numberField(value: unknown, field: string): number {
  if (hasField(value, field) && typeof value[field] === "number") {
    return value[field];
  }
  throw new Error(`Expected response field ${field} to be a number.`);
}

function hasField<K extends PropertyKey>(value: unknown, field: K): value is Record<K, unknown> {
  return value !== null && typeof value === "object" && field in value;
}

function html(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
}
