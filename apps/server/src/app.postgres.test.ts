import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getServerConfig } from "@patchy/config";
import type { ServerConfig } from "@patchy/config";
import { PostgresPatchyDb } from "@patchy/db";
import { FileSystemHtmlStorage } from "@patchy/storage";
import type { FastifyInstance } from "fastify";
import { createPostgresTestDatabase } from "../../../test/postgres.js";
import { createApp } from "./app.js";
import { createTestRuntime } from "./testing.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("Patchy Cloud HTTP with Postgres", () => {
  it("creates, updates, and serves a draft", async () => {
    const harness = await createPostgresHttpHarness("upload");

    try {
      const unauthenticated = await harness.app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: { html: html("Not allowed") }
      });
      expect(unauthenticated.statusCode).toBe(401);

      const created = await upload(harness.app, "Database create");
      expect(created.statusCode).toBe(201);
      const firstBody: unknown = created.json();
      const patchId = stringField(firstBody, "patchId");
      const versionNumber = numberField(firstBody, "versionNumber");

      const updated = await upload(harness.app, "Database update", {
        patchId
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ patchId, versionNumber: 2 });

      const latest = await harness.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(latest.statusCode).toBe(200);
      expect(latest.body).toContain("Database update");

      const original = await harness.app.inject({
        method: "GET",
        url: `/d/${patchId}/v/${versionNumber}`
      });
      expect(original.statusCode).toBe(200);
      expect(original.body).toContain("Database create");
    } finally {
      await harness.close();
    }
  });

  it("persists token scopes and admin-only pinning", async () => {
    const harness = await createPostgresHttpHarness("scopes");

    try {
      const readToken = await mintAdminToken(harness.app, "Read only", ["read"]);
      const uploadToken = await mintAdminToken(harness.app, "Uploader", ["upload"]);
      const adminToken = await mintAdminToken(harness.app, "Moderator", ["admin"]);

      expect((await upload(harness.app, "Wrong scope", {}, readToken)).statusCode).toBe(403);

      const created = await upload(harness.app, "Scoped upload", {}, uploadToken);
      expect(created.statusCode).toBe(201);
      const patchId = stringField(created.json(), "patchId");

      const refusedPin = await harness.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/pin`,
        headers: { authorization: `Bearer ${uploadToken}` }
      });
      expect(refusedPin.statusCode).toBe(403);

      const pinned = await harness.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/pin`,
        headers: { authorization: `Bearer ${adminToken}` }
      });
      expect(pinned.statusCode).toBe(200);
      expect(pinned.json()).toEqual({ ok: true, pinned: true });
    } finally {
      await harness.close();
    }
  });

  it("mints self-service tokens and moderates their drafts", async () => {
    const harness = await createPostgresHttpHarness("self-service", {
      allowSelfServiceTokens: true
    });

    try {
      const minted = await mintSelfServiceToken(harness.app, "198.51.100.20");
      expect(minted.statusCode).toBe(201);
      const token = stringField(minted.json(), "token");

      const identity = await harness.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(identity.statusCode).toBe(200);
      expect(identity.json()).toMatchObject({ scopes: ["upload"] });

      const created = await upload(harness.app, "Moderated", {}, token);
      expect(created.statusCode).toBe(201);
      const patchId = stringField(created.json(), "patchId");

      const inspected = await harness.app.inject({
        method: "GET",
        url: `/api/patches/${patchId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(inspected.statusCode).toBe(200);

      const disabled = await harness.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/disable`,
        headers: { authorization: "Bearer dev-token" },
        payload: { reason: "operator decision" }
      });
      expect(disabled.statusCode).toBe(200);
      expect((await harness.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        404
      );
    } finally {
      await harness.close();
    }
  });

  it("stops serving and updating a draft after its retention clock runs out", async () => {
    const harness = await createPostgresHttpHarness("expiry");

    try {
      const created = await upload(harness.app, "Ninety day page");
      const patchId = stringField(created.json(), "patchId");

      harness.advanceDays(1);
      expect((await harness.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        200
      );

      harness.advanceDays(90);
      for (const url of [`/d/${patchId}`, `/d/${patchId}/v/1`]) {
        const gone = await harness.app.inject({ method: "GET", url });
        expect(gone.statusCode).toBe(404);
        expect(gone.headers["x-robots-tag"]).toBe("noindex");
        expect(gone.headers["cache-control"]).toBe("no-store");
      }

      const update = await upload(harness.app, "Too late", { patchId });
      expect(update.statusCode).toBe(404);
      expect(update.json()).toEqual({ ok: false, error: "Patch not found." });
    } finally {
      await harness.close();
    }
  });

  it("tops up retention on visits and expires after visits stop", async () => {
    const harness = await createPostgresHttpHarness("visit-top-up");

    try {
      const created = await upload(harness.app, "Still visited");
      const patchId = stringField(created.json(), "patchId");

      harness.advanceDays(80);
      expect((await harness.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        200
      );

      harness.advanceDays(15);
      const extended = await harness.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(extended.statusCode).toBe(200);
      expect(extended.body).toContain("Still visited");

      harness.advanceDays(31);
      expect((await harness.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        404
      );
    } finally {
      await harness.close();
    }
  });

  it("sweeps an expired draft's record and stored versions together", async () => {
    const harness = await createPostgresHttpHarness("expiry-sweep");

    try {
      const created = await upload(harness.app, "Ages out");
      const patchId = stringField(created.json(), "patchId");
      expect((await upload(harness.app, "Ages out twice", { patchId })).statusCode).toBe(200);
      expect(await listFiles(harness.storageDir)).toHaveLength(2);

      harness.advanceDays(91);
      expect(await harness.app.sweepExpiredDrafts()).toEqual({
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });
      expect(await listFiles(harness.storageDir)).toEqual([]);

      for (const url of [`/d/${patchId}`, `/d/${patchId}/v/1`, `/d/${patchId}/v/2`]) {
        expect((await harness.app.inject({ method: "GET", url })).statusCode).toBe(404);
      }
      expect((await upload(harness.app, "Too late", { patchId })).statusCode).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it("keeps a pinned draft until it is unpinned and expires", async () => {
    const harness = await createPostgresHttpHarness("pinned-expiry");

    try {
      const created = await upload(harness.app, "Welcome page");
      const patchId = stringField(created.json(), "patchId");

      const pinned = await harness.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/pin`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(pinned.statusCode).toBe(200);

      harness.advanceDays(365);
      expect(await harness.app.sweepExpiredDrafts()).toMatchObject({ deleted: 0 });
      expect((await harness.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        200
      );

      const unpinned = await harness.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/unpin`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(unpinned.statusCode).toBe(200);

      harness.advanceDays(31);
      expect(await harness.app.sweepExpiredDrafts()).toMatchObject({ deleted: 1 });
      expect((await harness.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        404
      );
      expect(await listFiles(harness.storageDir)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("sweeps concurrently without deleting a live draft", async () => {
    const harness = await createPostgresHttpHarness("concurrent-sweep");

    try {
      const expiredId = stringField((await upload(harness.app, "Abandoned")).json(), "patchId");
      harness.advanceDays(91);
      const liveId = stringField((await upload(harness.app, "Still here")).json(), "patchId");

      const [first, second] = await Promise.all([
        harness.app.sweepExpiredDrafts(),
        harness.app.sweepExpiredDrafts()
      ]);
      expect(first).toEqual({ deleted: 1, skipped: 0, failed: 0, orphanedObjects: 0 });
      expect(second).toEqual(first);
      expect((await harness.app.inject({ method: "GET", url: `/d/${expiredId}` })).statusCode).toBe(
        404
      );
      expect((await harness.app.inject({ method: "GET", url: `/d/${liveId}` })).statusCode).toBe(
        200
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps the live-draft quota across a restart", async () => {
    const harness = await createPostgresHttpHarness("live-quota", {
      liveDraftsPerToken: 2
    });

    try {
      const first = await upload(harness.app, "One");
      const firstId = stringField(first.json(), "patchId");
      expect((await upload(harness.app, "Two")).statusCode).toBe(201);

      const overQuota = await upload(harness.app, "Three");
      expect(overQuota.statusCode).toBe(403);
      expect(overQuota.json()).toMatchObject({
        code: "live_patch_quota_exceeded",
        quota: 2
      });
      expect((await upload(harness.app, "One revised", { patchId: firstId })).statusCode).toBe(200);

      await harness.restart();
      const afterRestart = await upload(harness.app, "Three again");
      expect(afterRestart.statusCode).toBe(403);
      expect(afterRestart.json()).toMatchObject({
        code: "live_patch_quota_exceeded",
        quota: 2
      });
    } finally {
      await harness.close();
    }
  });

  it("keeps the daily mint quota across a restart", async () => {
    const harness = await createPostgresHttpHarness("mint-quota", {
      allowSelfServiceTokens: true,
      selfServiceMintsPerIpPerDay: 2
    });
    const sourceIp = "203.0.113.30";

    try {
      expect((await mintSelfServiceToken(harness.app, sourceIp)).statusCode).toBe(201);
      expect((await mintSelfServiceToken(harness.app, sourceIp)).statusCode).toBe(201);

      const exceeded = await mintSelfServiceToken(harness.app, sourceIp);
      expect(exceeded.statusCode).toBe(429);
      expect(exceeded.json()).toMatchObject({ code: "mint_quota_exceeded", quota: 2 });

      await harness.restart();
      expect((await mintSelfServiceToken(harness.app, sourceIp)).statusCode).toBe(429);

      harness.advanceMs(DAY_MS + 1_000);
      expect((await mintSelfServiceToken(harness.app, sourceIp)).statusCode).toBe(201);
    } finally {
      await harness.close();
    }
  });
});

interface PostgresHttpHarness {
  readonly app: FastifyInstance;
  readonly storageDir: string;
  advanceDays(days: number): void;
  advanceMs(ms: number): void;
  restart(): Promise<void>;
  close(): Promise<void>;
}

async function createPostgresHttpHarness(
  label: string,
  overrides: Partial<ServerConfig> = {}
): Promise<PostgresHttpHarness> {
  const testDatabase = await createPostgresTestDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `patchy-server-postgres-${label}-`));
  const storageDir = path.join(tempDir, "drafts");
  const storage = new FileSystemHtmlStorage(storageDir);
  const config: ServerConfig = {
    ...getServerConfig({
      PATCHY_BOOTSTRAP_API_TOKEN: "dev-token",
      PATCHY_STORAGE_DIR: storageDir
    }),
    ...overrides
  };
  let now = Date.UTC(2026, 0, 1);
  const clock = (): number => now;

  const open = async (): Promise<{ app: FastifyInstance; db: PostgresPatchyDb }> => {
    const db = new PostgresPatchyDb(testDatabase.connectionString, { clock });
    await db.initialize(config.bootstrapApiToken);
    return {
      app: createApp({ config, db, storage, clock, runtime: createTestRuntime({ clock }) }),
      db
    };
  };

  let running = await open();

  return {
    get app() {
      return running.app;
    },
    storageDir,
    advanceDays(days) {
      now += days * DAY_MS;
    },
    advanceMs(ms) {
      now += ms;
    },
    async restart() {
      await running.app.close();
      await running.db.close();
      running = await open();
    },
    async close() {
      await running.app.close();
      await running.db.close();
      await testDatabase.drop();
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

function mintSelfServiceToken(app: FastifyInstance, sourceIp: string) {
  return app.inject({
    method: "POST",
    url: "/api/tokens/self-service",
    remoteAddress: sourceIp
  });
}

function upload(
  app: FastifyInstance,
  title: string,
  target: { patchId?: string } = {},
  token = "dev-token"
) {
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: `Bearer ${token}` },
    payload: { ...target, html: html(title) }
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

async function listFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, entryPath)));
    } else {
      files.push(path.relative(rootDir, entryPath));
    }
  }
  return files.sort();
}
