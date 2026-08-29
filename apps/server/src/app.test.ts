import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServerConfig } from "@patchy/config";
import type { ServerConfig } from "@patchy/config";
import { sha256 } from "@patchy/core";
import { JsonFilePatchyDb } from "@patchy/db";
import type { RecordUploadInput, RecordUploadResult } from "@patchy/db";
import { FileSystemHtmlStorage } from "@patchy/storage";
import { classifyAuthorizationHeader, createApp, isProtectedApiPath } from "./app.js";
import { createTestRuntime } from "./testing.js";

let tempDir: string;

const uploadLikeApiTargets: ApiTargetCase[] = [
  {
    label: "trailing slash",
    url: "/api/uploads/"
  },
  {
    label: "duplicate slash",
    url: "/api//uploads"
  },
  {
    label: "encoded slash",
    url: "/api%2Fuploads"
  },
  {
    label: "escaped API prefix",
    url: "/%61pi/uploads/"
  },
  {
    label: "absolute escaped API prefix",
    url: "http://host/%61pi/uploads/",
    rawHttp: true
  },
  {
    label: "unsupported method on exact upload route",
    url: "/api/uploads",
    method: "PUT"
  }
];

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "patchy-server-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Patchy Cloud server", () => {
  it("classifies only an absent Authorization header as missing", () => {
    expect(classifyAuthorizationHeader(undefined)).toEqual({ kind: "missing" });
    expect(classifyAuthorizationHeader("")).toEqual({ kind: "invalid" });
    expect(classifyAuthorizationHeader("   ")).toEqual({ kind: "invalid" });
    expect(classifyAuthorizationHeader("Bearer   ")).toEqual({ kind: "invalid" });
    expect(classifyAuthorizationHeader("Bearer dev-token second-token")).toEqual({
      kind: "invalid"
    });
    expect(classifyAuthorizationHeader("Bearer dev-token")).toEqual({
      kind: "bearer",
      token: "dev-token"
    });
    const longPadding = " ".repeat(100_000);
    expect(classifyAuthorizationHeader(`bEaReR${longPadding}dev-token${longPadding}`)).toEqual({
      kind: "bearer",
      token: "dev-token"
    });
  });

  it("classifies router-equivalent protected API request targets", () => {
    expect(isProtectedApiPath("/api?ignored=true")).toBe(true);
    expect(isProtectedApiPath("/api#fragment")).toBe(true);
    expect(isProtectedApiPath("/%61pi/does-not-exist")).toBe(true);
    expect(isProtectedApiPath("http://host/api/does-not-exist?ignored=true")).toBe(true);
    expect(isProtectedApiPath("https://host/%61pi/does-not-exist#fragment")).toBe(true);
    expect(isProtectedApiPath("http://host?x=/api/%")).toBe(false);
    expect(isProtectedApiPath("HtTp://host/%61pi/does-not-exist")).toBe(true);
    expect(isProtectedApiPath("/api%2Fdoes-not-exist")).toBe(true);
    expect(isProtectedApiPath("/api//does-not-exist")).toBe(true);
    expect(isProtectedApiPath("/apix")).toBe(false);
    expect(isProtectedApiPath("/%")).toBe(true);
  });

  it("returns uploaded draft URLs on the configured public origin", async () => {
    const publicBaseUrl = "https://drafts.self-hoster.dev";
    const apiToken = "configured-origin-token";
    const config = getServerConfig({
      PATCHY_PUBLIC_BASE_URL: publicBaseUrl
    });
    const db = new JsonFilePatchyDb(path.join(tempDir, "configured-origin-db.json"));
    await db.initialize(apiToken);
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "configured-origin-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });

    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        html: "<!doctype html><html><head><title>Configured Origin</title></head><body></body></html>"
      }
    });

    expect(upload.statusCode).toBe(201);
    const body = upload.json() as {
      patchId: string;
      publicUrl: string;
      versionNumber: number;
    };
    expect(body.patchId).toMatch(/^[a-z0-9]{12}$/);
    expect(body.versionNumber).toBe(1);
    expect(body.publicUrl).toBe(`${publicBaseUrl}/d/${body.patchId}`);

    await app.close();
    await db.close();
  });

  it("requires auth for upload and renders uploaded drafts publicly", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });

    const unauth = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: { html: "<title>Nope</title>" }
    });
    expect(unauth.statusCode).toBe(401);

    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Test Draft</title></head><body><h1>Hello</h1></body></html>",
        filename: "plan.html"
      }
    });
    expect(upload.statusCode).toBe(201);
    const body = upload.json() as { patchId: string; publicUrl: string };
    expect(body.publicUrl).toBe(`http://localhost:3000/d/${body.patchId}`);

    const viewer = await app.inject({ method: "GET", url: `/d/${body.patchId}` });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(viewer.body).toContain("Test Draft");
    expect(viewer.body).toContain('class="draft-frame"');
    expect(viewer.body).toContain("&lt;h1&gt;Hello&lt;/h1&gt;");
    expect(viewer.body).not.toContain("patchy-banner");

    await app.close();
    await db.close();
  });

  it("refuses a tokenless upload under every configuration", async () => {
    for (const allowSelfServiceTokens of [false, true]) {
      const label = `allowSelfServiceTokens=${allowSelfServiceTokens}`;
      const config = { ...testConfig(), allowSelfServiceTokens };
      const db = new JsonFilePatchyDb(
        path.join(tempDir, `tokenless-db-${allowSelfServiceTokens}.json`)
      );
      await db.initialize(null);
      const storage = new FileSystemHtmlStorage(
        path.join(tempDir, `tokenless-drafts-${allowSelfServiceTokens}`)
      );
      const app = createApp({ config, db, storage, runtime: createTestRuntime() });
      const html =
        "<!doctype html><html><head><title>Tokenless</title></head><body>marker</body></html>";

      try {
        for (const payload of [
          { html },
          { html, patchId: null },
          { html, patchId: "abcdefghijkl" }
        ]) {
          const upload = await app.inject({
            method: "POST",
            url: "/api/uploads",
            payload
          });

          expect(upload.statusCode, label).toBe(401);
          expect(upload.json(), label).toEqual({
            ok: false,
            error: "Missing or invalid API token."
          });
        }
      } finally {
        await app.close();
        await db.close();
      }
    }
  });

  it("does not admit an absent credential on a non-create upload method", async () => {
    const config = { ...testConfig(), allowSelfServiceTokens: true };
    const db = new JsonFilePatchyDb(path.join(tempDir, "tokenless-method-db.json"));
    await db.initialize(null);
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "tokenless-method-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });

    const response = await app.inject({
      method: "PUT",
      url: "/api/uploads",
      headers: { "content-type": "application/json" },
      payload: `{"html":"${"x".repeat(2 * 1024 * 1024)}`
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      error: "Missing or invalid API token."
    });

    await app.close();
    await db.close();
  });

  it("keeps every upload-like POST target authenticated", async () => {
    const config = { ...testConfig(), allowSelfServiceTokens: true };
    const db = new JsonFilePatchyDb(path.join(tempDir, "upload-route-db.json"));
    await db.initialize(null);
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "upload-route-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });

    try {
      for (const target of [
        ...uploadLikeApiTargets,
        { label: "exact upload route", url: "/api/uploads" }
      ]) {
        const response = target.rawHttp
          ? await rawHttpRequest(app, target.url)
          : await app.inject({
              method: ("method" in target && target.method) || "POST",
              url: target.url,
              payload: {}
            });
        expect(response.statusCode, target.label).toBe(401);
        expect(response.json(), target.label).toEqual({
          ok: false,
          error: "Missing or invalid API token."
        });
      }
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("lets admin credentials alone moderate another principal's draft", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "moderation-db.json"));
    await db.initialize("admin-token");
    const admin = await db.findApiTokenByToken("admin-token");
    if (!admin) throw new Error("Expected bootstrap authentication.");
    await db.createApiToken({
      accountId: admin.accountId,
      name: "Ordinary token",
      token: "ordinary-token",
      scopes: ["upload"]
    });
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "moderation-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    let foreignDraftSequence = 0;
    const createForeignDraft = async (): Promise<string> => {
      foreignDraftSequence += 1;
      const patchId = `zzzzzzzzzzz${foreignDraftSequence}`;
      await db.recordUpload({
        intent: "create",
        draftId: patchId,
        versionId: `ver_foreign_${foreignDraftSequence}`,
        accountId: "acct_foreign",
        apiTokenId: admin.id,
        title: "Another principal's draft",
        objectKey: `drafts/${patchId}/versions/ver_foreign_${foreignDraftSequence}.html`,
        contentHash: `sha256:foreign${foreignDraftSequence}`,
        fileSize: 1,
        filename: "foreign.html",
        metadata: {},
        sourceIp: null,
        userAgent: "vitest"
      });
      return patchId;
    };

    try {
      const disableDraftId = await createForeignDraft();
      for (const request of [
        { method: "GET" as const, url: "/api/me" },
        {
          method: "POST" as const,
          url: `/api/patches/${disableDraftId}/disable`,
          payload: { reason: "tokenless attempt" }
        },
        { method: "DELETE" as const, url: `/api/patches/${disableDraftId}` }
      ]) {
        const tokenlessOperation = await app.inject(request);
        expect(tokenlessOperation.statusCode).toBe(401);
      }

      // An ordinary upload token reaches only what it owns.
      const ordinaryDisable = await app.inject({
        method: "POST",
        url: `/api/patches/${disableDraftId}/disable`,
        headers: { authorization: "Bearer ordinary-token" },
        payload: { reason: "not a moderator" }
      });
      expect(ordinaryDisable.statusCode).toBe(404);

      // The operator's takedown path: admin scope reaches any principal's draft,
      // which is what completes the moderation loop.
      const adminDisable = await app.inject({
        method: "POST",
        url: `/api/patches/${disableDraftId}/disable`,
        headers: { authorization: "Bearer admin-token" },
        payload: { reason: "operator policy" }
      });
      expect(adminDisable.statusCode).toBe(200);

      const deleteDraftId = await createForeignDraft();
      const ordinaryDelete = await app.inject({
        method: "DELETE",
        url: `/api/patches/${deleteDraftId}`,
        headers: { authorization: "Bearer ordinary-token" }
      });
      expect(ordinaryDelete.statusCode).toBe(404);

      const adminDelete = await app.inject({
        method: "DELETE",
        url: `/api/patches/${deleteDraftId}`,
        headers: { authorization: "Bearer admin-token" }
      });
      expect(adminDelete.statusCode).toBe(200);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("does not downgrade present bad credentials when self-service tokens are allowed", async () => {
    const config = { ...testConfig(), allowSelfServiceTokens: true };
    const dbFile = path.join(tempDir, "pre-body-auth-db.json");
    const db = new JsonFilePatchyDb(dbFile);
    await db.initialize("admin-token");
    const adminAuth = await db.findApiTokenByToken("admin-token");
    expect(adminAuth).not.toBeNull();
    await db.createApiToken({
      accountId: adminAuth!.accountId,
      name: "Read-only token",
      token: "read-token",
      scopes: ["read"]
    });
    await db.createApiToken({
      accountId: adminAuth!.accountId,
      name: "Revoked token",
      token: "revoked-token",
      scopes: ["upload"]
    });
    await markJsonTokenRevoked(dbFile, "Revoked token");

    const storage = new FileSystemHtmlStorage(path.join(tempDir, "pre-body-auth-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    const attackerJson = `{"html":"${"x".repeat(2 * 1024 * 1024)}`;

    try {
      const cases = [
        {
          label: "empty",
          authorization: "",
          statusCode: 401,
          error: "Missing or invalid API token."
        },
        {
          label: "whitespace",
          authorization: "   ",
          statusCode: 401,
          error: "Missing or invalid API token."
        },
        {
          label: "malformed",
          authorization: "Basic not-a-bearer-token",
          statusCode: 401,
          error: "Missing or invalid API token."
        },
        {
          label: "unknown",
          authorization: "Bearer unknown-token",
          statusCode: 401,
          error: "Missing or invalid API token."
        },
        {
          label: "revoked",
          authorization: "Bearer revoked-token",
          statusCode: 401,
          error: "Missing or invalid API token."
        },
        {
          label: "insufficient-scope",
          authorization: "Bearer read-token",
          statusCode: 403,
          error: "API token does not have the required scope."
        }
      ];

      for (const testCase of cases) {
        const response = await app.inject({
          method: "POST",
          url: "/api/uploads",
          headers: {
            "content-type": "application/json",
            ...(testCase.authorization !== undefined
              ? { authorization: testCase.authorization }
              : {})
          },
          payload: attackerJson
        });

        expect(response.statusCode, testCase.label).toBe(testCase.statusCode);
        expect(response.json(), testCase.label).toEqual({
          ok: false,
          error: testCase.error
        });
      }

      // A bad credential never opens a tokenless door, even with the flag on.
      const tokenlessAfterBadCredentials = await app.inject({
        method: "POST",
        url: "/api/uploads",
        payload: {
          html: "<!doctype html><html><head><title>Still closed</title></head><body></body></html>"
        }
      });
      expect(tokenlessAfterBadCredentials.statusCode).toBe(401);

      // A good credential is unaffected by the rejected attempts before it.
      const goodAfterBadCredentials = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer admin-token" },
        payload: {
          html: "<!doctype html><html><head><title>Good credential</title></head><body></body></html>"
        }
      });
      expect(goodAfterBadCredentials.statusCode).toBe(201);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it.each(uploadLikeApiTargets)(
    "rejects insufficient upload scope before parsing upload-like target: $label",
    async (target) => {
      const { app, db } = await createScopedTokenApp(`insufficient-${target.label}`);

      try {
        const response = await oversizedJsonApiRequest(app, {
          target,
          token: "read-token"
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({
          ok: false,
          error: "API token does not have the required scope."
        });
      } finally {
        await app.close();
        await db.close();
      }
    }
  );

  it.each(uploadLikeApiTargets)(
    "returns API 404 before parsing authorized upload-like unmatched target: $label",
    async (target) => {
      const { app, db } = await createScopedTokenApp(`authorized-${target.label}`);

      try {
        const response = await oversizedJsonApiRequest(app, {
          target,
          token: "upload-token"
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          ok: false,
          error: "Not found."
        });
      } finally {
        await app.close();
        await db.close();
      }
    }
  );

  it("allows admin scope to satisfy upload-like policy before unmatched API 404", async () => {
    const { app, db } = await createScopedTokenApp("authorized-admin-upload-like");

    try {
      const response = await oversizedJsonApiRequest(app, {
        target: uploadLikeApiTargets[0],
        token: "admin-only-token"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        ok: false,
        error: "Not found."
      });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("pins a draft only for an admin token, and only one that is there", async () => {
    const { app, db } = await createScopedTokenApp("pin-admin-only");

    try {
      const created = await createDraft(app, "upload-token", "Pinnable");
      expect(created.statusCode).toBe(201);
      const { patchId } = created.json() as { patchId: string };

      // Pinning is the operator's act, so the token that made the draft cannot
      // exempt it from expiry — only an admin can.
      for (const suffix of ["pin", "unpin"]) {
        const refused = await app.inject({
          method: "POST",
          url: `/api/patches/${patchId}/${suffix}`,
          headers: { authorization: "Bearer upload-token" }
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toEqual({
          ok: false,
          error: "API token does not have the required scope."
        });
      }

      // An admin pins any draft, whoever holds it.
      const pinned = await app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/pin`,
        headers: { authorization: "Bearer admin-only-token" }
      });
      expect(pinned.statusCode).toBe(200);
      expect(pinned.json()).toEqual({ ok: true, pinned: true });

      const missing = await app.inject({
        method: "POST",
        url: "/api/patches/doesnotexist1/pin",
        headers: { authorization: "Bearer admin-only-token" }
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ ok: false, error: "Patch not found." });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("returns API 404 before parsing arbitrary authenticated unmatched API targets", async () => {
    const { app, db } = await createScopedTokenApp("authorized-arbitrary-unmatched-api");

    try {
      const response = await oversizedJsonApiRequest(app, {
        target: {
          label: "arbitrary unmatched API",
          url: "/api/does-not-exist"
        },
        token: "read-token"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        ok: false,
        error: "Not found."
      });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("limits authorized upload-like unmatched targets by stable token identity", async () => {
    let now = 1_000;
    const { app, db } = await createScopedTokenApp("upload-like-unmatched-limit", () => now);
    const target: ApiTargetCase = {
      label: "encoded slash upload-like target",
      url: "/api%2Fuploads"
    };

    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: target.url,
          headers: { authorization: "Bearer upload-token" }
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          ok: false,
          error: "Not found."
        });
      }

      const limited = await app.inject({
        method: "POST",
        url: target.url,
        headers: { authorization: "Bearer upload-token" }
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(Number.isInteger(Number(limited.headers["retry-after"]))).toBe(true);
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      now = 61_000;
      const reset = await app.inject({
        method: "POST",
        url: target.url,
        headers: { authorization: "Bearer upload-token" }
      });
      expect(reset.statusCode).toBe(404);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("limits protected API attempts by canonical request IP", async () => {
    let now = 1_000;
    const config = getServerConfig({ PATCHY_TRUST_PROXY: "10.0.0.0/8" });
    const db = new JsonFilePatchyDb(path.join(tempDir, "protected-limit-db.json"));
    await db.initialize("unused-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "protected-limit-drafts"));
    const app = createApp({
      config,
      db,
      storage,
      clock: () => now,
      runtime: createTestRuntime({ clock: () => now })
    });

    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const response = await app.inject({
          method: "GET",
          url: "/api/me",
          remoteAddress: "10.0.0.5",
          headers: { "x-forwarded-for": "203.0.113.9" }
        });

        expect(response.statusCode).toBe(401);
      }

      const limited = await app.inject({
        method: "GET",
        url: "/api/me",
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.9" }
      });

      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(Number.isInteger(Number(limited.headers["retry-after"]))).toBe(true);
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      const otherIp = await app.inject({
        method: "GET",
        url: "/api/me",
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.10" }
      });
      expect(otherIp.statusCode).toBe(401);

      const health = await app.inject({
        method: "GET",
        url: "/healthz",
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.9" }
      });
      expect(health.statusCode).toBe(200);

      now = 61_000;
      const reset = await app.inject({
        method: "GET",
        url: "/api/me",
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "203.0.113.9" }
      });
      expect(reset.statusCode).toBe(401);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("protects unmatched API paths before parsing and counts them once per IP", async () => {
    let now = 1_000;
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "unmatched-api-limit-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "unmatched-api-limit-drafts"));
    const app = createApp({
      config,
      db,
      storage,
      clock: () => now,
      runtime: createTestRuntime({ clock: () => now })
    });

    try {
      const upload = await app.inject({
        method: "POST",
        url: "/api/uploads",
        remoteAddress: "198.51.100.10",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          html: "<!doctype html><html><head><title>Public Draft</title></head><body></body></html>"
        }
      });
      expect(upload.statusCode).toBe(201);
      const { patchId } = upload.json() as { patchId: string };

      const attackerJson = `{"html":"${"x".repeat(2 * 1024 * 1024)}`;
      const oversized = await app.inject({
        method: "POST",
        url: "/api/does-not-exist",
        remoteAddress: "203.0.113.9",
        headers: { "content-type": "application/json" },
        payload: attackerJson
      });
      expect(oversized.statusCode).toBe(401);
      expect(oversized.json()).toEqual({
        ok: false,
        error: "Missing or invalid API token."
      });

      for (let attempt = 1; attempt < 60; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/does-not-exist",
          remoteAddress: "203.0.113.9"
        });
        expect(response.statusCode).toBe(401);
      }

      const limited = await app.inject({
        method: "POST",
        url: "/api/does-not-exist",
        remoteAddress: "203.0.113.9"
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      const lookalike = await app.inject({
        method: "GET",
        url: "/apix",
        remoteAddress: "203.0.113.9"
      });
      expect(lookalike.statusCode).toBe(404);

      const health = await app.inject({
        method: "GET",
        url: "/healthz",
        remoteAddress: "203.0.113.9"
      });
      expect(health.statusCode).toBe(200);

      const viewer = await app.inject({
        method: "GET",
        url: `/d/${patchId}`,
        remoteAddress: "203.0.113.9"
      });
      expect(viewer.statusCode).toBe(200);
      expect(viewer.body).toContain("Public Draft");

      now = 61_000;
      const reset = await app.inject({
        method: "POST",
        url: "/api/does-not-exist",
        remoteAddress: "203.0.113.9"
      });
      expect(reset.statusCode).toBe(401);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it.each([
    {
      label: "origin-form escaped API prefix",
      url: "/%61pi/does-not-exist",
      rawHttp: false
    },
    {
      label: "absolute-form API target",
      url: "http://host/api/does-not-exist",
      rawHttp: true
    },
    {
      label: "mixed-case absolute-form API target",
      url: "HtTp://host/%61pi/does-not-exist",
      rawHttp: true
    }
  ])(
    "protects router-equivalent unmatched API target before parsing and counts it once per IP: $label",
    async ({ rawHttp, url }) => {
      let now = 1_000;
      const config = testConfig();
      const db = new JsonFilePatchyDb(
        path.join(tempDir, `${url.replaceAll(/[^a-z0-9]/gi, "-")}-db.json`)
      );
      await db.initialize("dev-token");
      const storage = new FileSystemHtmlStorage(
        path.join(tempDir, `${url.replaceAll(/[^a-z0-9]/gi, "-")}-drafts`)
      );
      const app = createApp({
        config,
        db,
        storage,
        clock: () => now,
        runtime: createTestRuntime({ clock: () => now })
      });

      try {
        const attackerJson = `{"html":"${"x".repeat(2 * 1024 * 1024)}`;
        const oversized = rawHttp
          ? await rawHttpRequest(
              app,
              url,
              '{"html":"',
              {
                "Content-Type": "application/json",
                "Content-Length": String(2 * 1024 * 1024 + 1)
              },
              { closeAfterWrite: false }
            )
          : await app.inject({
              method: "POST",
              url,
              remoteAddress: "203.0.113.9",
              headers: { "content-type": "application/json" },
              payload: attackerJson
            });
        expect(oversized.statusCode).toBe(401);
        expect(oversized.json()).toEqual({
          ok: false,
          error: "Missing or invalid API token."
        });

        for (let attempt = 1; attempt < 60; attempt += 1) {
          const response = rawHttp
            ? await rawHttpRequest(app, url)
            : await app.inject({
                method: "POST",
                url,
                remoteAddress: "203.0.113.9"
              });
          expect(response.statusCode).toBe(401);
        }

        const limited = rawHttp
          ? await rawHttpRequest(app, url)
          : await app.inject({
              method: "POST",
              url,
              remoteAddress: "203.0.113.9"
            });
        expect(limited.statusCode).toBe(429);
        expect(limited.headers["retry-after"]).toBe("60");
        expect(Number.isInteger(Number(limited.headers["retry-after"]))).toBe(true);
        expect(limited.json()).toEqual({
          ok: false,
          error: "Rate limit exceeded.",
          code: "rate_limited",
          retryAfterSeconds: 60
        });

        const health = await app.inject({
          method: "GET",
          url: "/healthz",
          remoteAddress: "203.0.113.9"
        });
        expect(health.statusCode).toBe(200);

        now = 61_000;
        const reset = rawHttp
          ? await rawHttpRequest(app, url)
          : await app.inject({
              method: "POST",
              url,
              remoteAddress: "203.0.113.9"
            });
        expect(reset.statusCode).toBe(401);
      } finally {
        await app.close();
        await db.close();
      }
    }
  );

  it.each([
    {
      label: "malformed percent escape",
      protectedTarget: "/api/%",
      authenticatedStatus: 400,
      authenticatedError: "Malformed request target."
    },
    {
      label: "escaped-prefix malformed percent escape",
      protectedTarget: "HtTp://host/%61pi/%",
      authenticatedStatus: 400,
      authenticatedError: "Malformed request target."
    },
    {
      label: "overlong route parameter",
      protectedTarget: `/api/patches/${"x".repeat(101)}/disable`,
      authenticatedStatus: 414,
      authenticatedError: "Request target is too long."
    },
    {
      label: "encoded overlong route parameter",
      protectedTarget: `/api/patches/${"x".repeat(60)}%2F${"x".repeat(60)}/disable`,
      authenticatedStatus: 414,
      authenticatedError: "Request target is too long."
    },
    {
      label: "DELETE overlong route parameter",
      protectedTarget: `/api/patches/${"x".repeat(101)}`,
      method: "DELETE",
      authenticatedStatus: 414,
      authenticatedError: "Request target is too long."
    },
    {
      // The moderation read registers the same bare shape DELETE does, so its
      // overlong parameter is a too-long target rather than a missing route.
      label: "GET overlong route parameter",
      protectedTarget: `/api/patches/${"x".repeat(101)}`,
      method: "GET",
      authenticatedStatus: 414,
      authenticatedError: "Request target is too long."
    },
    {
      label: "pin overlong route parameter",
      protectedTarget: `/api/patches/${"x".repeat(101)}/pin`,
      authenticatedStatus: 414,
      authenticatedError: "Request target is too long."
    },
    {
      label: "unpin overlong route parameter",
      protectedTarget: `/api/patches/${"x".repeat(101)}/unpin`,
      authenticatedStatus: 414,
      authenticatedError: "Request target is too long."
    }
  ])(
    "authenticates and limits pre-routing API failure: $label",
    async ({ label, protectedTarget, method, authenticatedStatus, authenticatedError }) => {
      let now = 1_000;
      const config = testConfig();
      const caseName = label.replaceAll(/[^a-z0-9]/gi, "-");
      const db = new JsonFilePatchyDb(path.join(tempDir, `${caseName}-pre-routing-db.json`));
      await db.initialize("dev-token");
      const storage = new FileSystemHtmlStorage(
        path.join(tempDir, `${caseName}-pre-routing-drafts`)
      );
      const app = createApp({
        config,
        db,
        storage,
        clock: () => now,
        runtime: createTestRuntime({ clock: () => now })
      });

      try {
        const publicMalformed = await rawHttpRequest(app, "/public/%");
        expect(publicMalformed.statusCode).toBe(400);

        for (let attempt = 1; attempt <= 60; attempt += 1) {
          const response = await rawHttpRequest(app, protectedTarget, "", {}, { method });
          expect(response.statusCode).toBe(401);
          expect(response.json()).toEqual({
            ok: false,
            error: "Missing or invalid API token."
          });
        }

        const limited = await rawHttpRequest(app, protectedTarget, "", {}, { method });
        expect(limited.statusCode).toBe(429);
        expect(limited.headers["retry-after"]).toBe("60");
        expect(limited.json()).toEqual({
          ok: false,
          error: "Rate limit exceeded.",
          code: "rate_limited",
          retryAfterSeconds: 60
        });

        now = 61_000;
        const authenticated = await rawHttpRequest(
          app,
          protectedTarget,
          "",
          { Authorization: "Bearer dev-token" },
          { closeAfterWrite: false, method }
        );
        expect(authenticated.statusCode).toBe(authenticatedStatus);
        expect(authenticated.json()).toEqual({
          ok: false,
          error: authenticatedError
        });
      } finally {
        await app.close();
        await db.close();
      }
    }
  );

  it("preserves authenticated 404s for long unmatched API route shapes", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "long-unmatched-api-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "long-unmatched-api-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    const longSegment = "x".repeat(101);

    try {
      for (const { method, requestTarget } of [
        { method: "POST", requestTarget: `/api/unmatched/${longSegment}` },
        {
          method: "POST",
          requestTarget: `/api/patches/${longSegment}`
        },
        {
          method: "DELETE",
          requestTarget: `/api/patches/${longSegment}/disable`
        },
        {
          method: "PUT",
          requestTarget: `/api/patches/${longSegment}/disable`
        }
      ]) {
        const response = await rawHttpRequest(
          app,
          requestTarget,
          "",
          { Authorization: "Bearer dev-token" },
          { closeAfterWrite: false, method }
        );
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ ok: false, error: "Not found." });
      }
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("does not classify an absolute URI query as an API path or consume its bucket", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "absolute-query-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "absolute-query-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });

    try {
      const publicQuery = await rawHttpRequest(app, "http://host?x=/api/%");
      // find-my-way 9.9 (Fastify 5.12) keeps `?x=/api/%` as query on `/`.
      // POST `/` is unregistered, so this is the public HTML 404 — not the
      // 9.7 onBadUrl 400 that treated the query slash as path `/api/%`.
      expect(publicQuery.statusCode).toBe(404);
      expect(publicQuery.headers["content-type"]).toMatch(/text\/html/);

      for (let attempt = 1; attempt <= 60; attempt += 1) {
        const response = await rawHttpRequest(app, "/api/does-not-exist");
        expect(response.statusCode).toBe(401);
      }

      const limited = await rawHttpRequest(app, "/api/does-not-exist");
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("limits authenticated upload attempts by stable token identity", async () => {
    let now = 1_000;
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "upload-limit-db.json"));
    await db.initialize("upload-token");
    const auth = await db.findApiTokenByToken("upload-token");
    expect(auth).not.toBeNull();
    await db.createApiToken({
      accountId: auth!.accountId,
      name: "Other upload token",
      token: "other-upload-token",
      scopes: ["upload"]
    });
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "upload-limit-drafts"));
    const app = createApp({
      config,
      db,
      storage,
      clock: () => now,
      runtime: createTestRuntime({ clock: () => now })
    });

    try {
      const upload = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer upload-token" },
        payload: {
          html: "<!doctype html><html><head><title>Limited Draft</title></head><body><h1>Hello</h1></body></html>"
        }
      });
      expect(upload.statusCode).toBe(201);
      const { patchId } = upload.json() as { patchId: string };

      for (let attempt = 0; attempt < 9; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/uploads",
          headers: { authorization: "Bearer upload-token" },
          payload: {}
        });
        expect(response.statusCode).toBe(400);
      }

      await db.initialize("rotated-upload-token");

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/uploads",
          headers: { authorization: "Bearer rotated-upload-token" },
          payload: {}
        });
        expect(response.statusCode).toBe(400);
      }

      const limited = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer rotated-upload-token" },
        payload: {}
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      const otherToken = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer other-upload-token" },
        payload: {}
      });
      expect(otherToken.statusCode).toBe(400);

      const viewer = await app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(viewer.statusCode).toBe(200);
      expect(viewer.body).toContain("Limited Draft");

      now = 61_000;
      const reset = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer rotated-upload-token" },
        payload: {}
      });
      expect(reset.statusCode).toBe(400);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("composes protected-API and token upload limits independently", async () => {
    let now = 1_000;
    const config = {
      ...testConfig(),
      allowSelfServiceTokens: true,
      protectedApiRateLimitPerMinute: 2,
      authenticatedUploadRateLimitPerMinute: 1
    };
    const db = new JsonFilePatchyDb(path.join(tempDir, "upload-limit-db.json"));
    await db.initialize("upload-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "upload-limit-drafts"));
    const app = createApp({
      config,
      db,
      storage,
      clock: () => now,
      runtime: createTestRuntime({ clock: () => now })
    });

    try {
      const authenticated = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer upload-token" },
        payload: {
          html: "<!doctype html><html><head><title>Authenticated quota</title></head><body></body></html>"
        }
      });
      expect(authenticated.statusCode).toBe(201);

      const tokenLimited = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer upload-token" },
        payload: {}
      });
      expect(tokenLimited.statusCode).toBe(429);
      expect(tokenLimited.headers["retry-after"]).toBe("60");

      const protectedLimited = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer upload-token" }
      });
      expect(protectedLimited.statusCode).toBe(429);

      now = 61_000;
      const resetAuthenticated = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer upload-token" },
        payload: {
          html: "<!doctype html><html><head><title>Reset token</title></head><body></body></html>"
        }
      });
      expect(resetAuthenticated.statusCode).toBe(201);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("limits draft creates per minute per token without counting updates", async () => {
    let now = 1_000;
    const config = { ...testConfig(), draftCreateRateLimitPerMinute: 2 };
    const db = new JsonFilePatchyDb(path.join(tempDir, "create-limit-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "create-limit-drafts"));
    const app = createApp({
      config,
      db,
      storage,
      clock: () => now,
      runtime: createTestRuntime({ clock: () => now })
    });

    try {
      const first = await createDraft(app, "dev-token", "First");
      expect(first.statusCode).toBe(201);
      const { patchId } = first.json() as { patchId: string };

      // Updates in the same window must not spend any of the create budget.
      for (let revision = 0; revision < 3; revision += 1) {
        const update = await updateDraft(app, "dev-token", patchId, `First v${revision}`);
        expect(update.statusCode).toBe(200);
      }

      // Still room for the window's second create, so the updates cost nothing.
      expect((await createDraft(app, "dev-token", "Second")).statusCode).toBe(201);

      const limited = await createDraft(app, "dev-token", "Third");
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      // An update still succeeds once the create bucket is empty.
      expect((await updateDraft(app, "dev-token", patchId, "First again")).statusCode).toBe(200);

      now = 61_000;
      const afterWindow = await createDraft(app, "dev-token", "Fourth");
      expect(afterWindow.statusCode).toBe(201);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("caps live drafts per token from the database, across a restart", async () => {
    const config = { ...testConfig(), liveDraftsPerToken: 2 };
    const dbFile = path.join(tempDir, "live-cap-db.json");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "live-cap-drafts"));
    // `dev-token` is the admin bootstrap token: the cap has no admin exemption.
    const db = new JsonFilePatchyDb(dbFile);
    await db.initialize("dev-token");
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });

    try {
      const one = await createDraft(app, "dev-token", "One");
      expect(one.statusCode).toBe(201);
      const { patchId } = one.json() as { patchId: string };
      expect((await createDraft(app, "dev-token", "Two")).statusCode).toBe(201);

      const overQuota = await createDraft(app, "dev-token", "Three");
      expect(overQuota.statusCode).toBe(403);
      expect(overQuota.json()).toEqual({
        ok: false,
        error:
          "Patch quota reached: 2 live patches per token. Delete or let a patch expire before creating another.",
        code: "live_patch_quota_exceeded",
        quota: 2
      });

      // The quota bounds creates only: at the ceiling, rewriting a draft the
      // token already holds still succeeds.
      expect((await updateDraft(app, "dev-token", patchId, "One revised")).statusCode).toBe(200);
    } finally {
      await app.close();
      await db.close();
    }

    // A restart drops every in-memory bucket. The cap is recounted from the
    // database, so it is still there.
    const restartedDb = new JsonFilePatchyDb(dbFile);
    await restartedDb.initialize("dev-token");
    const restarted = createApp({ config, db: restartedDb, storage, runtime: createTestRuntime() });

    try {
      const stillOverQuota = await createDraft(restarted, "dev-token", "Three again");
      expect(stillOverQuota.statusCode).toBe(403);
      expect(stillOverQuota.json()).toMatchObject({
        code: "live_patch_quota_exceeded",
        quota: 2
      });
    } finally {
      await restarted.close();
      await restartedDb.close();
    }
  });

  it("returns live-draft cap room when a draft is disabled or deleted", async () => {
    const config = { ...testConfig(), liveDraftsPerToken: 1 };
    const db = new JsonFilePatchyDb(path.join(tempDir, "live-cap-release-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    expect(auth).not.toBeNull();
    await db.createApiToken({
      accountId: auth!.accountId,
      name: "Sibling upload token",
      token: "sibling-token",
      scopes: ["upload"]
    });
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "live-cap-release-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });

    try {
      const created = await createDraft(app, "dev-token", "Only one");
      expect(created.statusCode).toBe(201);
      const { patchId } = created.json() as { patchId: string };
      expect((await createDraft(app, "dev-token", "Blocked")).statusCode).toBe(403);

      // The cap is per token, not per account: a sibling token on the same
      // account still has its own room.
      expect((await createDraft(app, "sibling-token", "Sibling")).statusCode).toBe(201);

      const disable = await app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/disable`,
        headers: { authorization: "Bearer dev-token" },
        payload: { reason: "quota test" }
      });
      expect(disable.statusCode).toBe(200);

      const afterDisable = await createDraft(app, "dev-token", "After disable");
      expect(afterDisable.statusCode).toBe(201);
      const replacementDraftId = (afterDisable.json() as { patchId: string }).patchId;
      expect((await createDraft(app, "dev-token", "Blocked again")).statusCode).toBe(403);

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/patches/${replacementDraftId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(removed.statusCode).toBe(200);

      expect((await createDraft(app, "dev-token", "After delete")).statusCode).toBe(201);
      // Nothing the first token did moved the sibling's own tally.
      expect((await createDraft(app, "sibling-token", "Sibling blocked")).statusCode).toBe(403);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it("persists the direct socket address when proxy trust is not configured", async () => {
    const sourceIp = await uploadSourceIp({
      remoteAddress: "192.0.2.10"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "192.0.2.10",
      eventSourceIp: "192.0.2.10"
    });
  });

  it.each(["1", "2", "32"])(
    "rejects hop-count PATCHY_TRUST_PROXY %s before attributing a forwarded address",
    async (trustProxy) => {
      await expect(
        uploadSourceIp({
          trustProxy,
          remoteAddress: "10.0.0.5",
          forwardedFor: "203.0.113.9, 198.51.100.7"
        })
      ).rejects.toThrow(/Invalid PATCHY_TRUST_PROXY/);
    }
  );

  it("ignores a spoofed forwarding header on a direct request by default", async () => {
    const sourceIp = await uploadSourceIp({
      remoteAddress: "192.0.2.10",
      forwardedFor: "203.0.113.9, 198.51.100.7"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "192.0.2.10",
      eventSourceIp: "192.0.2.10"
    });
  });

  it("attributes the rightmost forwarded address through one trusted proxy network", async () => {
    const sourceIp = await uploadSourceIp({
      trustProxy: "10.0.0.0/8",
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.9, 198.51.100.7"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "198.51.100.7",
      eventSourceIp: "198.51.100.7"
    });
  });

  it("attributes the first untrusted address beyond configured proxy networks", async () => {
    const sourceIp = await uploadSourceIp({
      trustProxy: "10.0.0.0/8, 198.51.100.0/24",
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.9, 198.51.100.7"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "203.0.113.9",
      eventSourceIp: "203.0.113.9"
    });
  });

  it("ignores a spoofed forwarding chain from outside configured proxy networks", async () => {
    const sourceIp = await uploadSourceIp({
      trustProxy: "10.0.0.0/8",
      remoteAddress: "192.0.2.10",
      forwardedFor: "203.0.113.9, 10.0.0.5"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "192.0.2.10",
      eventSourceIp: "192.0.2.10"
    });
  });

  it.each([
    "::ffff:0:0/96",
    "::0.0.0.0/96",
    "::192.0.2.10",
    "::192.0.2.0/120",
    "::/1",
    "0.0.0.0/1,128.0.0.0/1",
    "::ffff:10.0.0.0/104",
    "0:0:0:0:0:ffff:a00:0/104",
    "::fffe:0:0/95",
    "::ffff:0:0/95"
  ])(
    "rejects effective blanket trust %s before a direct peer can spoof attribution",
    async (trustProxy) => {
      await expect(
        uploadSourceIp({
          trustProxy,
          remoteAddress: "192.0.2.10",
          forwardedFor: "203.0.113.9"
        })
      ).rejects.toThrow(/Invalid PATCHY_TRUST_PROXY/);
    }
  );
  it("rejects an unknown client-supplied draft ID without creating a public draft", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "unknown-update-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "unknown-update-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    const patchId = "abcdefghijkl";

    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        patchId,
        html: "<!doctype html><html><head><title>Must not exist</title></head><body></body></html>"
      }
    });

    expect(upload.statusCode).toBe(404);
    expect(upload.json()).toEqual({ ok: false, error: "Patch not found." });
    const viewer = await app.inject({ method: "GET", url: `/d/${patchId}` });
    expect(viewer.statusCode).toBe(404);
    expect(await listFiles(storage.rootDir)).toEqual([]);

    await app.close();
    await db.close();
  });

  it("returns the same response for unavailable update targets", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "unavailable-update-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    if (!auth) throw new Error("Expected bootstrap authentication.");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "unavailable-update-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    const unknownDraftId = "aaaaaaaaaaaa";
    const foreignDraftId = "bbbbbbbbbbbb";
    const deletedDraftId = "cccccccccccc";
    const disabledDraftId = "dddddddddddd";

    for (const [patchId, accountId] of [
      [foreignDraftId, "acct_another"],
      [deletedDraftId, auth.accountId],
      [disabledDraftId, auth.accountId]
    ]) {
      await db.recordUpload({
        intent: "create",
        draftId: patchId,
        versionId: `ver_${patchId}`,
        accountId,
        apiTokenId: auth.id,
        title: "Existing target",
        objectKey: `drafts/${patchId}/versions/seed.html`,
        contentHash: "sha256:seed",
        fileSize: 1,
        filename: "seed.html",
        metadata: {},
        sourceIp: null,
        userAgent: "vitest"
      });
    }
    await db.deleteDraft(deletedDraftId, auth.accountId);
    await db.disableDraft(disabledDraftId, auth.accountId, "policy");

    const responses = await Promise.all(
      [unknownDraftId, foreignDraftId, deletedDraftId, disabledDraftId].map((patchId) =>
        app.inject({
          method: "POST",
          url: "/api/uploads",
          headers: { authorization: "Bearer dev-token" },
          payload: {
            patchId,
            html: "<!doctype html><html><head><title>Update</title></head><body></body></html>"
          }
        })
      )
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ ok: false, error: "Patch not found." });
    }

    await app.close();
    await db.close();
  });

  it("updates an existing owned draft and preserves its previous version", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "owned-update-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "owned-update-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    const headers = { authorization: "Bearer dev-token" };

    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers,
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body>original-marker</body></html>"
      }
    });
    const createBody = created.json() as { patchId: string; versionNumber: number };

    const updated = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers,
      payload: {
        patchId: createBody.patchId,
        html: "<!doctype html><html><head><title>Updated</title></head><body>updated-marker</body></html>"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(createBody.versionNumber).toBe(1);
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      patchId: createBody.patchId,
      versionNumber: 2,
      title: "Updated"
    });

    const currentViewer = await app.inject({
      method: "GET",
      url: `/d/${createBody.patchId}`
    });
    const originalViewer = await app.inject({
      method: "GET",
      url: `/d/${createBody.patchId}/v/1`
    });
    expect(currentViewer.statusCode).toBe(200);
    expect(currentViewer.body).toContain("updated-marker");
    expect(currentViewer.body).not.toContain("original-marker");
    expect(originalViewer.statusCode).toBe(200);
    expect(originalViewer.body).toContain("original-marker");

    await app.close();
    await db.close();
  });

  it("does not hold metadata locks while object storage is slow", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "slow-storage-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    if (!auth) throw new Error("Expected bootstrap authentication.");
    const storage = new ControlledHtmlStorage(path.join(tempDir, "slow-storage-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Slow target</title></head><body></body></html>"
      }
    });
    const createdBody = created.json();
    const unrelatedDraftId = "eeeeeeeeeeee";
    await db.recordUpload({
      intent: "create",
      draftId: unrelatedDraftId,
      versionId: "ver_unrelated",
      accountId: auth.accountId,
      apiTokenId: auth.id,
      title: "Unrelated",
      objectKey: `drafts/${unrelatedDraftId}/versions/ver_unrelated.html`,
      contentHash: "sha256:unrelated",
      fileSize: 1,
      filename: "unrelated.html",
      metadata: {},
      sourceIp: null,
      userAgent: "vitest"
    });

    const writeStarted = Promise.withResolvers<void>();
    const allowWrite = Promise.withResolvers<void>();
    storage.afterPut = async () => {
      writeStarted.resolve();
      await allowWrite.promise;
    };

    try {
      const update = app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          patchId: createdBody.patchId,
          html: "<!doctype html><html><head><title>Slow update</title></head><body></body></html>"
        }
      });
      await writeStarted.promise;

      const disable = db.disableDraft(unrelatedDraftId, auth.accountId, "unrelated policy action");
      // Await the operation itself rather than racing the filesystem against a
      // short wall-clock deadline. The test timeout remains the deadlock watchdog.
      await expect(disable).resolves.toBe(true);

      allowWrite.resolve();
      await expect(update).resolves.toMatchObject({ statusCode: 200 });
    } finally {
      allowWrite.resolve();
      await app.close();
      await db.close();
    }
  }, 10_000);

  it("removes only the new object when final eligibility recheck rejects", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "race-cleanup-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    if (!auth) throw new Error("Expected bootstrap authentication.");
    const storage = new ControlledHtmlStorage(path.join(tempDir, "race-cleanup-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body>original</body></html>"
      }
    });
    const createdBody = created.json();
    const originalKey = `drafts/${createdBody.patchId}/versions/${createdBody.versionId}.html`;
    storage.afterPut = async () => {
      await db.disableDraft(createdBody.patchId, auth.accountId, "policy race");
    };

    const update = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        patchId: createdBody.patchId,
        html: "<!doctype html><html><head><title>Rejected</title></head><body>rejected</body></html>"
      }
    });

    expect(update.statusCode).toBe(404);
    expect(update.json()).toEqual({ ok: false, error: "Patch not found." });
    expect(await listFiles(storage.rootDir)).toEqual([originalKey]);
    await expect(storage.getHtmlObject(originalKey)).resolves.toContain("original");

    await app.close();
    await db.close();
  });

  it("does not mutate metadata when object storage fails", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "storage-failure-db.json"));
    await db.initialize("dev-token");
    const storage = new ControlledHtmlStorage(path.join(tempDir, "storage-failure-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body>original</body></html>"
      }
    });
    const createdBody = created.json();
    storage.putError = new Error("Object storage unavailable.");

    const update = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        patchId: createdBody.patchId,
        html: "<!doctype html><html><head><title>Failed</title></head><body>failed</body></html>"
      }
    });

    expect(update.statusCode).toBe(500);
    const current = await db.findDraftVersion(createdBody.patchId);
    expect(current.version?.id).toBe(createdBody.versionId);
    expect(await listFiles(storage.rootDir)).toEqual([
      `drafts/${createdBody.patchId}/versions/${createdBody.versionId}.html`
    ]);

    await app.close();
    await db.close();
  });

  it("surfaces cleanup failure instead of masking an orphan as a safe rejection", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "cleanup-failure-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    if (!auth) throw new Error("Expected bootstrap authentication.");
    const storage = new ControlledHtmlStorage(path.join(tempDir, "cleanup-failure-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body></body></html>"
      }
    });
    const createdBody = created.json();
    storage.afterPut = async () => {
      await db.disableDraft(createdBody.patchId, auth.accountId, "policy race");
    };
    storage.deleteError = new Error("Cleanup unavailable.");

    const update = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        patchId: createdBody.patchId,
        html: "<!doctype html><html><head><title>Rejected</title></head><body></body></html>"
      }
    });

    expect(update.statusCode).toBe(500);
    expect(update.json()).toEqual({ ok: false, error: "Internal server error." });
    expect(await listFiles(storage.rootDir)).toHaveLength(2);

    await app.close();
    await db.close();
  });

  it("keeps the new object when metadata commit outcome is indeterminate", async () => {
    const config = testConfig();
    const db = new CommitIndeterminateJsonDb(path.join(tempDir, "indeterminate-db.json"));
    await db.initialize("dev-token");
    const storage = new ControlledHtmlStorage(path.join(tempDir, "indeterminate-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body></body></html>"
      }
    });
    const createdBody = created.json();
    db.throwAfterRecord = true;

    const update = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        patchId: createdBody.patchId,
        html: "<!doctype html><html><head><title>Committed</title></head><body>committed</body></html>"
      }
    });

    expect(update.statusCode).toBe(500);
    const current = await db.findDraftVersion(createdBody.patchId);
    expect(current.version?.versionNumber).toBe(2);
    if (!current.version) throw new Error("Expected committed version.");
    expect(await listFiles(storage.rootDir)).toHaveLength(2);
    await expect(storage.getHtmlObject(current.version.objectKey)).resolves.toContain("committed");

    await app.close();
    await db.close();
  });

  it("accepts the released CLI null draft marker as server-generated create intent", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "legacy-null-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "legacy-null-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });

    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Released CLI</title></head><body></body></html>",
        filename: "released-cli.html",
        patchId: null,
        metadata: {
          cliVersion: "0.1.0",
          fileSha256: "legacy-client-hash"
        }
      }
    });

    expect(upload.statusCode).toBe(201);
    const response = upload.json();
    expect(response.patchId).toMatch(/^[a-z0-9]{12}$/);
    expect(response.versionNumber).toBe(1);

    await app.close();
    await db.close();
  });

  it("names the rename to a client still sending draftId, instead of creating", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "legacy-key-db.json"));
    await db.initialize("dev-token");
    const auth = await db.findApiTokenByToken("dev-token");
    if (!auth) throw new Error("Expected bootstrap authentication.");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "legacy-key-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });

    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        draftId: "abcdefghijkl",
        html: "<!doctype html><html><head><title>Old client</title></head><body></body></html>"
      }
    });

    expect(upload.statusCode).toBe(400);
    expect(upload.json()).toEqual({
      ok: false,
      error:
        "Unknown field draftId: the wire renamed it to patchId. Send patchId to update that patch."
    });
    expect(await db.countLiveDraftsByCreatorApiToken(auth.id)).toBe(0);
    await app.close();
    await db.close();
  });

  it("rejects invalid non-null draft IDs instead of treating them as creates", async () => {
    const config = testConfig();
    const db = new JsonFilePatchyDb(path.join(tempDir, "explicit-intent-db.json"));
    await db.initialize("dev-token");
    const storage = new FileSystemHtmlStorage(path.join(tempDir, "explicit-intent-drafts"));
    const app = createApp({ config, db, storage, runtime: createTestRuntime() });

    for (const patchId of ["", 123]) {
      const upload = await app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          patchId,
          html: "<!doctype html><html><head><title>Invalid target</title></head><body></body></html>"
        }
      });

      expect(upload.statusCode).toBe(400);
      expect(upload.json()).toEqual({ ok: false, error: "Invalid patch ID." });
    }

    await app.close();
    await db.close();
  });

  it("serves drafts noindexed, unwatched, and open to machines", async () => {
    const served = await createServedDraft("serving-guarantees");

    for (const url of [served.latestUrl, served.versionUrl]) {
      const anonymous = await served.app.inject({ method: "GET", url });
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.headers["x-robots-tag"]).toBe("noindex");
      expect(anonymous.headers["set-cookie"]).toBeUndefined();
      expect(anonymous.headers["www-authenticate"]).toBeUndefined();
      expect(anonymous.body).toContain("Serving Guarantees");
    }

    // No auth or session on the serving host: reader credentials are neither
    // required nor consulted, and a bad one never turns into a challenge.
    const credentialed = await served.app.inject({
      method: "GET",
      url: served.latestUrl,
      headers: { authorization: "Bearer not-a-real-token", cookie: "session=whatever" }
    });
    expect(credentialed.statusCode).toBe(200);
    expect(credentialed.headers["set-cookie"]).toBeUndefined();
    expect(credentialed.headers["www-authenticate"]).toBeUndefined();
    expect(credentialed.body).toContain("Serving Guarantees");

    const missing = await served.app.inject({ method: "GET", url: "/d/doesnotexist1" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["x-robots-tag"]).toBe("noindex");
    expect(missing.headers["set-cookie"]).toBeUndefined();

    await served.close();
  });

  it("caches version URLs immutably, latest-draft URLs briefly, and everything else never", async () => {
    const served = await createServedDraft("serving-cache-headers");

    const latest = await served.app.inject({ method: "GET", url: served.latestUrl });
    expect(latest.statusCode).toBe(200);
    expect(latest.headers["cache-control"]).toBe("public, max-age=60");

    const version = await served.app.inject({ method: "GET", url: served.versionUrl });
    expect(version.statusCode).toBe(200);
    expect(version.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const missingVersion = await served.app.inject({
      method: "GET",
      url: `/d/${served.patchId}/v/9`
    });
    expect(missingVersion.statusCode).toBe(404);
    expect(missingVersion.headers["cache-control"]).toBe("no-store");

    const missingDraft = await served.app.inject({ method: "GET", url: "/d/doesnotexist1" });
    expect(missingDraft.statusCode).toBe(404);
    expect(missingDraft.headers["cache-control"]).toBe("no-store");

    // Everything that is not a served draft — API routes included — stays uncached.
    const uncachedResponses = [
      await served.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer dev-token" }
      }),
      await served.app.inject({ method: "GET", url: "/api/me" }),
      await served.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          html: "<!doctype html><html><head><title>Second</title></head><body></body></html>"
        }
      }),
      await served.app.inject({ method: "GET", url: "/healthz" }),
      await served.app.inject({ method: "GET", url: "/" })
    ];
    for (const response of uncachedResponses) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    await served.close();
  });

  it("locks the draft content security policy with no script sources", async () => {
    const served = await createServedDraft("serving-csp");

    for (const url of [served.latestUrl, served.versionUrl]) {
      const response = await served.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; " +
          "frame-src 'self' about:; base-uri 'none'; form-action 'none'"
      );
      expect(response.headers["content-security-policy"]).not.toContain("script");
      expect(response.body).not.toContain("<script");
    }

    await served.close();
  });

  it("serves a draft as the framed document and nothing else", async () => {
    const served = await createServedDraft("bare-wrapper");

    for (const url of [served.latestUrl, served.versionUrl]) {
      const response = await served.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);

      // The wrapper is the sandboxed frame alone: no footer, no first-party
      // link out of the page, and nothing a reader could submit or run.
      expect(response.body).not.toContain("<footer");
      expect(response.body).not.toContain("<script");
      expect(response.body).not.toContain("<form");
      expect(response.body).not.toContain("onclick");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }

    await served.close();
  });

  it("stops serving and stops updating a draft once its retention clock runs out", async () => {
    const clocked = await createClockedApp("expiry");

    try {
      const patchId = await publishDraft(clocked.app, "Ninety day page");

      // A visit this early tops up nothing, so the clock still ends at day 90.
      clocked.advanceDays(1);
      const early = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(early.statusCode).toBe(200);
      expect(early.body).toContain("Ninety day page");

      clocked.advanceDays(90);
      for (const url of [`/d/${patchId}`, `/d/${patchId}/v/1`]) {
        const gone = await clocked.app.inject({ method: "GET", url });
        expect(gone.statusCode).toBe(404);
        expect(gone.headers["content-type"]).toContain("text/html");
        expect(gone.body).not.toContain("Ninety day page");

        // An expired draft's 404 is an ordinary draft-URL 404 and carries the
        // same serving guarantees: still noindexed, and never cached — the page
        // it replaced was cacheable, and this must not inherit that.
        expect(gone.headers["x-robots-tag"]).toBe("noindex");
        expect(gone.headers["cache-control"]).toBe("no-store");
        expect(gone.headers["set-cookie"]).toBeUndefined();
      }

      const update = await clocked.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          patchId,
          html: "<!doctype html><html><head><title>Too late</title></head><body></body></html>"
        }
      });
      expect(update.statusCode).toBe(404);
      expect(update.json()).toEqual({ ok: false, error: "Patch not found." });
    } finally {
      await clocked.close();
    }
  });

  it("keeps a visited draft alive, and lets it go once the visits stop", async () => {
    const clocked = await createClockedApp("visit-topup");

    try {
      const patchId = await publishDraft(clocked.app, "Still visited");

      // Ten days left on the upload's window: this visit tops it up to thirty.
      clocked.advanceDays(80);
      const inWindow = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(inWindow.statusCode).toBe(200);

      // Day 95 — past where the upload alone would have ended it. The page is
      // still here because it was visited, and this visit extends it again.
      clocked.advanceDays(15);
      const extended = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(extended.statusCode).toBe(200);
      expect(extended.body).toContain("Still visited");

      // Thirty-one days without a visit, and it is gone.
      clocked.advanceDays(31);
      const abandoned = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(abandoned.statusCode).toBe(404);
    } finally {
      await clocked.close();
    }
  });

  it("serves a draft whose visit top-up write fails, without moving its clock", async () => {
    const clocked = await createClockedApp("visit-write-failure", {
      openDb: (file, clock) => new VisitFailingJsonDb(file, { clock })
    });

    try {
      const patchId = await publishDraft(clocked.app, "Survives a failed top-up");

      // Ten days left, so this visit is one the clock would move — and the
      // write throws. The reader still gets the page.
      clocked.advanceDays(80);
      const served = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toContain("Survives a failed top-up");

      // Best-effort means exactly that: the page was served and the clock
      // genuinely did not move, so the original window still ends it.
      clocked.advanceDays(11);
      const expired = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(expired.statusCode).toBe(404);
    } finally {
      await clocked.close();
    }
  });

  it("restarts the whole window when a new version is published", async () => {
    const clocked = await createClockedApp("upload-reset");

    try {
      const patchId = await publishDraft(clocked.app, "First cut");

      clocked.advanceDays(80);
      const republish = await clocked.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: {
          patchId,
          html: "<!doctype html><html><head><title>Second cut</title></head><body></body></html>"
        }
      });
      expect(republish.statusCode).toBe(200);

      // Day 100: past the first window, well inside the one the update opened.
      clocked.advanceDays(20);
      const served = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toContain("Second cut");
    } finally {
      await clocked.close();
    }
  });

  it("takes an expired draft's content and record together, with no way back", async () => {
    const clocked = await createClockedApp("expiry-sweep");

    try {
      const patchId = await publishDraft(clocked.app, "Ages out");
      const updated = await clocked.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: { patchId, html: draftHtml("Ages out, twice") }
      });
      expect(updated.statusCode).toBe(200);
      expect(await listFiles(clocked.storageDir)).toHaveLength(2);

      // Expired, and so already unserved — but every stored byte is still here,
      // which is what the sweep exists to change.
      clocked.advanceDays(91);
      expect(await listFiles(clocked.storageDir)).toHaveLength(2);

      expect(await clocked.app.sweepExpiredDrafts()).toEqual({
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });

      expect(await listFiles(clocked.storageDir)).toEqual([]);
      for (const url of [`/d/${patchId}`, `/d/${patchId}/v/1`, `/d/${patchId}/v/2`]) {
        const gone = await clocked.app.inject({ method: "GET", url });
        expect(gone.statusCode).toBe(404);
        expect(gone.body).not.toContain("Ages out");
      }

      // Republishing is the recovery path, and it is a new page.
      const republished = await clocked.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: { patchId, html: draftHtml("Too late") }
      });
      expect(republished.statusCode).toBe(404);
    } finally {
      await clocked.close();
    }
  });

  it("keeps a pinned draft serving forever, and lets it go once it is unpinned", async () => {
    const clocked = await createClockedApp("expiry-sweep-pinned");

    try {
      const patchId = await publishDraft(clocked.app, "Welcome page");
      const pinned = await clocked.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/pin`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(pinned.statusCode).toBe(200);
      expect(pinned.json()).toEqual({ ok: true, pinned: true });

      // A year with nobody reading it, and the instance's own page is still up.
      clocked.advanceDays(365);
      const served = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toContain("Welcome page");

      expect(await clocked.app.sweepExpiredDrafts()).toMatchObject({ deleted: 0 });
      const survived = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(survived.statusCode).toBe(200);
      expect(await listFiles(clocked.storageDir)).toHaveLength(1);

      const unpinned = await clocked.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/unpin`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(unpinned.statusCode).toBe(200);
      expect(unpinned.json()).toEqual({ ok: true, pinned: false });

      // The visit above topped the clock up to thirty days, so the page keeps
      // its window — and then goes, content and all.
      clocked.advanceDays(31);
      expect(await clocked.app.sweepExpiredDrafts()).toMatchObject({ deleted: 1 });
      const gone = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(gone.statusCode).toBe(404);
      expect(await listFiles(clocked.storageDir)).toEqual([]);
    } finally {
      await clocked.close();
    }
  });

  it("frees a pinned draft the operator deleted, pin and all", async () => {
    const clocked = await createClockedApp("expiry-sweep-pinned-then-deleted");

    try {
      const patchId = await publishDraft(clocked.app, "Pinned then withdrawn");
      const pinned = await clocked.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/pin`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(pinned.statusCode).toBe(200);

      const deleted = await clocked.app.inject({
        method: "DELETE",
        url: `/api/patches/${patchId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(deleted.statusCode).toBe(200);

      // Taking the page down ended the pin, so the ordinary clock applies and
      // the sweep frees the storage. A pin that survived here would exempt
      // bytes nobody can reach, with no way to unpin them back into reach.
      clocked.advanceDays(91);
      expect(await clocked.app.sweepExpiredDrafts()).toMatchObject({ deleted: 1 });
      expect(await listFiles(clocked.storageDir)).toEqual([]);

      // And pinning it again was never on the table.
      const repinned = await clocked.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/pin`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(repinned.statusCode).toBe(404);
    } finally {
      await clocked.close();
    }
  });

  it("sweeps repeatedly and concurrently while the server keeps serving", async () => {
    const clocked = await createClockedApp("expiry-sweep-idempotent");

    try {
      const expiring = await publishDraft(clocked.app, "Abandoned");
      clocked.advanceDays(91);
      const fresh = await publishDraft(clocked.app, "Still here");

      // Two runs at once are one run: the second finds nothing half-swept.
      const [first, second] = await Promise.all([
        clocked.app.sweepExpiredDrafts(),
        clocked.app.sweepExpiredDrafts()
      ]);
      expect(first).toEqual({ deleted: 1, skipped: 0, failed: 0, orphanedObjects: 0 });
      expect(second).toEqual(first);

      // Running again changes nothing, and the live draft was never in reach.
      expect(await clocked.app.sweepExpiredDrafts()).toEqual({
        deleted: 0,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });

      const gone = await clocked.app.inject({ method: "GET", url: `/d/${expiring}` });
      expect(gone.statusCode).toBe(404);
      const served = await clocked.app.inject({ method: "GET", url: `/d/${fresh}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toContain("Still here");
      expect(await listFiles(clocked.storageDir)).toHaveLength(1);
    } finally {
      await clocked.close();
    }
  });

  it("counts an object it could not delete once the record is already gone", async () => {
    const clocked = await createClockedApp("expiry-sweep-storage-failure", {
      openStorage: (dir) => new ControlledHtmlStorage(dir)
    });
    const storage = clocked.storage as ControlledHtmlStorage;

    try {
      const patchId = await publishDraft(clocked.app, "Object outlives its record");
      clocked.advanceDays(91);
      storage.deleteError = new Error("Storage delete failed.");

      expect(await clocked.app.sweepExpiredDrafts()).toEqual({
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 1
      });

      // The record went and the object stayed. Nothing serves it and no later
      // run can find it — storage to reclaim by hand, not a draft that survived.
      expect(await listFiles(clocked.storageDir)).toHaveLength(1);
      const gone = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(gone.statusCode).toBe(404);
      expect(await clocked.app.sweepExpiredDrafts()).toMatchObject({
        deleted: 0,
        orphanedObjects: 0
      });
    } finally {
      await clocked.close();
    }
  });

  it("answers an admin draft read with the principal and the token to revoke", async () => {
    const moderated = await createModerationApp("moderation-read");

    try {
      const created = await createDraft(moderated.app, moderated.publisherToken, "Flagged");
      expect(created.statusCode).toBe(201);
      const { patchId } = created.json() as { patchId: string };

      const read = await moderated.app.inject({
        method: "GET",
        url: `/api/patches/${patchId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        ok: true,
        patch: {
          id: patchId,
          principalId: moderated.principalId,
          createdByApiTokenId: moderated.publisherApiTokenId,
          title: "Flagged",
          deletedAt: null,
          disabledAt: null
        }
      });

      // The moderation surface is the operator's alone. An ordinary token is
      // refused for its scope, and no token at all never reaches the route.
      const ordinary = await moderated.app.inject({
        method: "GET",
        url: `/api/patches/${patchId}`,
        headers: { authorization: `Bearer ${moderated.publisherToken}` }
      });
      expect(ordinary.statusCode).toBe(403);
      expect(ordinary.json()).toEqual({
        ok: false,
        error: "API token does not have the required scope."
      });

      const tokenless = await moderated.app.inject({
        method: "GET",
        url: `/api/patches/${patchId}`
      });
      expect(tokenless.statusCode).toBe(401);

      const unknown = await moderated.app.inject({
        method: "GET",
        url: "/api/patches/zzzzzzzzzzzz",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toEqual({ ok: false, error: "Patch not found." });

      // A draft the operator has already taken down still answers: a complaint
      // arrives about pages that are off as often as pages that are on.
      const disabled = await moderated.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/disable`,
        headers: { authorization: "Bearer dev-token" },
        payload: { reason: "operator policy" }
      });
      expect(disabled.statusCode).toBe(200);

      const afterDisable = await moderated.app.inject({
        method: "GET",
        url: `/api/patches/${patchId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(afterDisable.statusCode).toBe(200);
      expect(
        (afterDisable.json() as { patch: { disabledReason: string } }).patch.disabledReason
      ).toBe("operator policy");
    } finally {
      await moderated.close();
    }
  });

  it("lists a principal's drafts for an admin and nobody else", async () => {
    const moderated = await createModerationApp("moderation-list");

    try {
      // A day between creates, so "newest first" is asserted against an order
      // the clock decided rather than one two same-millisecond writes fell into.
      const first = await createDraft(moderated.app, moderated.publisherToken, "One");
      moderated.advanceDays(1);
      const second = await createDraft(moderated.app, moderated.publisherToken, "Two");
      moderated.advanceDays(1);
      const removed = await createDraft(moderated.app, moderated.publisherToken, "Gone");
      const removedDraftId = (removed.json() as { patchId: string }).patchId;
      const deletion = await moderated.app.inject({
        method: "DELETE",
        url: `/api/patches/${removedDraftId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(deletion.statusCode).toBe(200);

      const listed = await moderated.app.inject({
        method: "GET",
        url: `/api/principals/${moderated.principalId}/patches`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(listed.statusCode).toBe(200);
      const body = listed.json() as {
        principalId: string;
        truncated: boolean;
        patches: { id: string; createdByApiTokenId: string }[];
      };
      expect(body.principalId).toBe(moderated.principalId);
      expect(body.truncated).toBe(false);
      // Newest first, and the one already deleted is not on the list.
      expect(body.patches.map((draft) => draft.id)).toEqual([
        (second.json() as { patchId: string }).patchId,
        (first.json() as { patchId: string }).patchId
      ]);
      expect(body.patches[0]?.createdByApiTokenId).toBe(moderated.publisherApiTokenId);

      const ordinary = await moderated.app.inject({
        method: "GET",
        url: `/api/principals/${moderated.principalId}/patches`,
        headers: { authorization: `Bearer ${moderated.publisherToken}` }
      });
      expect(ordinary.statusCode).toBe(403);

      const tokenless = await moderated.app.inject({
        method: "GET",
        url: `/api/principals/${moderated.principalId}/patches`
      });
      expect(tokenless.statusCode).toBe(401);

      // A principal nobody has ever published under is an empty list, not a 404:
      // "this principal holds nothing" is an answer, not a missing resource.
      const stranger = await moderated.app.inject({
        method: "GET",
        url: "/api/principals/acct_holds_nothing/patches",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(stranger.statusCode).toBe(200);
      expect(stranger.json()).toEqual({
        ok: true,
        principalId: "acct_holds_nothing",
        patches: [],
        truncated: false
      });
    } finally {
      await moderated.close();
    }
  });

  it("revokes a token idempotently and leaves it indistinguishable from a bad one", async () => {
    const moderated = await createModerationApp("moderation-revoke");

    try {
      const created = await createDraft(moderated.app, moderated.publisherToken, "Abusive");
      const { patchId } = created.json() as { patchId: string };

      const revokeUrl = `/api/tokens/${moderated.publisherApiTokenId}/revoke`;
      const ordinary = await moderated.app.inject({
        method: "POST",
        url: revokeUrl,
        headers: { authorization: `Bearer ${moderated.publisherToken}` }
      });
      expect(ordinary.statusCode).toBe(403);

      // Self-service minting put an unauthenticated route next door, under the
      // same `/api/tokens/` prefix. Revoking must never be swept into that
      // carve-out: a tokenless caller gets nowhere near it.
      const tokenlessRevoke = await moderated.app.inject({
        method: "POST",
        url: revokeUrl
      });
      expect(tokenlessRevoke.statusCode).toBe(401);
      expect(tokenlessRevoke.json()).toEqual({
        ok: false,
        error: "Missing or invalid API token."
      });

      const revoked = await moderated.app.inject({
        method: "POST",
        url: revokeUrl,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(revoked.statusCode).toBe(200);
      const revocation = revoked.json() as {
        alreadyRevoked: boolean;
        apiToken: { id: string; name: string; principalId: string; revokedAt: string };
      };
      expect(revocation.alreadyRevoked).toBe(false);
      expect(revocation.apiToken).toMatchObject({
        id: moderated.publisherApiTokenId,
        name: "Flagged publisher",
        principalId: moderated.principalId
      });
      expect(revocation.apiToken.revokedAt).toEqual(expect.any(String));

      // Idempotent, and the first moment stands — it is when top-ups froze.
      const again = await moderated.app.inject({
        method: "POST",
        url: revokeUrl,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({
        ok: true,
        alreadyRevoked: true,
        apiToken: revocation.apiToken
      });

      const unknown = await moderated.app.inject({
        method: "POST",
        url: "/api/tokens/tok_never_existed/revoke",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toEqual({ ok: false, error: "API token not found." });

      // The revoked token can do nothing anywhere, and says nothing about
      // itself doing it: the same 401 any garbage credential gets.
      for (const request of [
        { method: "GET" as const, url: "/api/me" },
        {
          method: "POST" as const,
          url: "/api/uploads",
          payload: { html: draftHtml("Still trying") }
        },
        {
          method: "POST" as const,
          url: "/api/uploads",
          payload: { patchId, html: draftHtml("Still trying") }
        },
        {
          method: "POST" as const,
          url: `/api/patches/${patchId}/disable`,
          payload: { reason: "cover tracks" }
        },
        { method: "DELETE" as const, url: `/api/patches/${patchId}` }
      ]) {
        const revokedAttempt = await moderated.app.inject({
          ...request,
          headers: { authorization: `Bearer ${moderated.publisherToken}` }
        });
        const nonsenseAttempt = await moderated.app.inject({
          ...request,
          headers: { authorization: "Bearer not-a-token-at-all" }
        });
        expect(revokedAttempt.statusCode).toBe(401);
        expect(revokedAttempt.json()).toEqual(nonsenseAttempt.json());
      }

      // The drafts stay up. Revocation is not a takedown.
      const served = await moderated.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toContain("Abusive");

      // And the row survives its revocation, so the loop can still read it.
      const read = await moderated.app.inject({
        method: "GET",
        url: `/api/patches/${patchId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(read.statusCode).toBe(200);
      expect(
        (read.json() as { patch: { createdByApiTokenId: string } }).patch.createdByApiTokenId
      ).toBe(moderated.publisherApiTokenId);
    } finally {
      await moderated.close();
    }
  });

  it("lets a revoked token's drafts run out the clock they had left", async () => {
    const clocked = await createClockedApp("revocation-freeze");

    try {
      const minted = await clocked.app.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { name: "Flagged publisher", scopes: ["upload"] }
      });
      const { token, apiToken } = minted.json() as {
        token: string;
        apiToken: { id: string };
      };
      const created = await createDraft(clocked.app, token, "Runs down");
      const { patchId } = created.json() as { patchId: string };

      // Day 80, ten days left: a visit before the revocation tops the clock up
      // to day 110, and that extension is not taken away afterwards.
      clocked.advanceDays(80);
      expect((await clocked.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        200
      );

      clocked.advanceDays(1);
      const revoked = await clocked.app.inject({
        method: "POST",
        url: `/api/tokens/${apiToken.id}/revoke`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(revoked.statusCode).toBe(200);

      // Day 105, five days left. Before the freeze this visit would have bought
      // another thirty; now it buys nothing, however popular the page is.
      clocked.advanceDays(24);
      for (let visit = 0; visit < 3; visit += 1) {
        const stillServed = await clocked.app.inject({
          method: "GET",
          url: `/d/${patchId}`
        });
        expect(stillServed.statusCode).toBe(200);
        expect(stillServed.body).toContain("Runs down");
      }

      clocked.advanceDays(4);
      expect((await clocked.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        200
      );

      // Day 111: the clock only ran down, and it has run out.
      clocked.advanceDays(2);
      expect((await clocked.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        404
      );
    } finally {
      await clocked.close();
    }
  });

  it("resolves a takedown on a self-service page through to revocation", async () => {
    // The whole story on the posture the public instance actually runs: the
    // publisher asked the service for its own key, with no operator involved.
    const clocked = await createClockedApp("self-service-moderation", {
      config: { ...testConfig(), allowSelfServiceTokens: true }
    });

    try {
      const minted = await clocked.app.inject({
        method: "POST",
        url: "/api/tokens/self-service",
        remoteAddress: "203.0.113.7"
      });
      expect(minted.statusCode).toBe(201);
      const { token } = minted.json() as { token: string };

      const flaggedUpload = await createDraft(clocked.app, token, "Abusive page");
      expect(flaggedUpload.statusCode).toBe(201);
      const { patchId } = flaggedUpload.json() as { patchId: string };
      const sibling = await createDraft(clocked.app, token, "Second abusive page");
      const siblingDraftId = (sibling.json() as { patchId: string }).patchId;

      expect((await clocked.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        200
      );

      // Step 1 — the flagged URL names the principal and the token to revoke.
      const read = await clocked.app.inject({
        method: "GET",
        url: `/api/patches/${patchId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(read.statusCode).toBe(200);
      const culprit = (
        read.json() as {
          draft: { principalId: string; createdByApiTokenId: string };
        }
      ).patch;

      // A self-service mint is 1:1 with a fresh principal, so the culprit is
      // not the operator's own — which is what makes revoking it surgical.
      const operator = await clocked.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer dev-token" }
      });
      expect(culprit.principalId).not.toBe((operator.json() as { accountId: string }).accountId);

      // Step 2 — and the sibling page comes with it.
      const listed = await clocked.app.inject({
        method: "GET",
        url: `/api/principals/${culprit.principalId}/patches`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(listed.statusCode).toBe(200);
      const held = (listed.json() as { patches: { id: string }[] }).patches;
      expect([...held.map((draft) => draft.id)].sort()).toEqual([patchId, siblingDraftId].sort());

      // Step 3 — revoke. Provenance makes no difference to it: this is the same
      // endpoint, the same answer shape, and the same effect as on a token the
      // operator minted by hand.
      const revoked = await clocked.app.inject({
        method: "POST",
        url: `/api/tokens/${culprit.createdByApiTokenId}/revoke`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toMatchObject({
        ok: true,
        alreadyRevoked: false,
        apiToken: {
          id: culprit.createdByApiTokenId,
          principalId: culprit.principalId
        }
      });

      // The key is dead everywhere, and because the principal was its alone,
      // nothing else can reach the pages it left behind.
      expect((await createDraft(clocked.app, token, "Another")).statusCode).toBe(401);
      expect((await updateDraft(clocked.app, token, patchId, "Rewritten")).statusCode).toBe(401);

      // The pages stay up and keep their remaining clock — and the freeze holds
      // for a self-service token exactly as it does for an operator's.
      clocked.advanceDays(80);
      expect((await clocked.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        200
      );

      clocked.advanceDays(11);
      for (const gone of [patchId, siblingDraftId]) {
        expect((await clocked.app.inject({ method: "GET", url: `/d/${gone}` })).statusCode).toBe(
          404
        );
      }
    } finally {
      await clocked.close();
    }
  });

  it("answers a moderation read for a draft the expiry sweep has already taken", async () => {
    const clocked = await createClockedApp("moderation-after-sweep");

    try {
      const created = await createDraft(clocked.app, "dev-token", "Flagged then expired");
      const { patchId } = created.json() as { patchId: string };

      clocked.advanceDays(91);
      expect(await clocked.app.sweepExpiredDrafts()).toMatchObject({ deleted: 1 });

      // A complaint outlives the page it was about, so the operator can still
      // arrive at a draft ID with nothing left behind it. The loop's first step
      // has nothing to name and says so — an ordinary 404, not a fall over.
      const read = await clocked.app.inject({
        method: "GET",
        url: `/api/patches/${patchId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(read.statusCode).toBe(404);
      expect(read.json()).toEqual({ ok: false, error: "Patch not found." });

      const operator = await clocked.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer dev-token" }
      });
      const listed = await clocked.app.inject({
        method: "GET",
        url: `/api/principals/${(operator.json() as { accountId: string }).accountId}/patches`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ ok: true, patches: [], truncated: false });
    } finally {
      await clocked.close();
    }
  });
});

describe("self-service minting", () => {
  it("mints a token whose plaintext appears once and is kept only as a hash", async () => {
    const minting = await createMintApp("mint-happy");

    try {
      const mint = await minting.mint("198.51.100.20");

      expect(mint.statusCode).toBe(201);
      const body = mint.json() as { ok: boolean; token: string };
      expect(body.ok).toBe(true);
      expect(body.token).toMatch(/^pp_[A-Za-z0-9_-]{43}$/);
      // The pinned success body is exactly these two keys — nothing about the
      // principal, the mint record, or the quota leaks into it.
      expect(Object.keys(body).sort()).toEqual(["ok", "token"]);
      // No credential was offered and none was asked for: this is how a caller
      // with nothing gets its first token.
      expect(mint.headers["cache-control"]).toBe("no-store");

      // The token works, and the mint date is what named it.
      const me = await minting.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: `Bearer ${body.token}` }
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        apiTokenName: "Self-service token 2026-01-01",
        scopes: ["upload"]
      });

      // "Exactly once" is a claim about storage as much as about the wire, and
      // the wire alone cannot make it. This is the one assertion in the suite
      // that reads what the instance kept: the plaintext is not in it.
      const stored = await readFile(minting.dbFile, "utf8");
      expect(stored).not.toContain(body.token);
      expect(stored).toContain(sha256(body.token));
    } finally {
      await minting.close();
    }
  });

  it("refuses to mint on an instance that keeps its admin-only token posture", async () => {
    const minting = await createMintApp("mint-disabled", { allowSelfServiceTokens: false });

    try {
      const refused = await minting.mint("198.51.100.21");

      expect(refused.statusCode).toBe(403);
      // Exactly the pinned refusal: no extra key, and `error` carries real copy
      // rather than being present and empty.
      expect(refusalBody(refused)).toEqual({
        ok: false,
        code: "self_service_disabled"
      });
      expect((refused.json() as { error: string }).error).toMatch(/operator/i);

      // The admin token endpoint is a different operation and is untouched by
      // the flag: still admin-scoped, still named the same, still takes a body.
      const unauthenticated = await minting.app.inject({
        method: "POST",
        url: "/api/tokens",
        payload: { name: "Sneaky" }
      });
      expect(unauthenticated.statusCode).toBe(401);

      const administered = await minting.app.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { authorization: "Bearer dev-token" },
        payload: { name: "Operator issued" }
      });
      expect(administered.statusCode).toBe(201);
      expect(administered.json()).toMatchObject({
        ok: true,
        apiToken: { name: "Operator issued" }
      });
    } finally {
      await minting.close();
    }
  });

  it("accepts an absent body and an empty JSON object alike", async () => {
    const minting = await createMintApp("mint-bodies");

    try {
      const shapes: Array<{ label: string; headers?: Record<string, string>; payload?: string }> = [
        { label: "no body and no content type" },
        {
          label: "empty JSON object",
          headers: { "content-type": "application/json" },
          payload: "{}"
        },
        {
          label: "JSON content type with nothing in the body",
          headers: { "content-type": "application/json" },
          payload: ""
        }
      ];

      const minted = new Set<string>();
      for (const shape of shapes) {
        const mint = await minting.app.inject({
          method: "POST",
          url: MINT_PATH,
          remoteAddress: "198.51.100.22",
          ...(shape.headers ? { headers: shape.headers } : {}),
          ...(shape.payload === undefined ? {} : { payload: shape.payload })
        });

        expect(mint.statusCode, shape.label).toBe(201);
        minted.add((mint.json() as { token: string }).token);
      }

      // Three requests, three distinct tokens — no shape was a silent no-op.
      expect(minted.size).toBe(3);

      // A body that is neither absent nor JSON is still a bad request: the
      // route is lenient about emptiness, not about malformed input.
      const malformed = await minting.app.inject({
        method: "POST",
        url: MINT_PATH,
        headers: { "content-type": "application/json" },
        payload: "{oops",
        remoteAddress: "198.51.100.23"
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ ok: false, error: "Malformed JSON body." });

      // And the leniency belongs to this route alone. An empty upload body is
      // still refused by Fastify's own parser before the handler sees it —
      // which is also what proves the mint route's parser stayed encapsulated
      // rather than quietly loosening every route in the app.
      const emptyUpload = await minting.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: {
          authorization: "Bearer dev-token",
          "content-type": "application/json"
        },
        payload: ""
      });
      expect(emptyUpload.statusCode).toBe(400);
      expect((emptyUpload.json() as { error: string }).error).toMatch(/Body cannot be empty/i);
    } finally {
      await minting.close();
    }
  });

  it("counts the daily mint quota in the database, where a restart cannot clear it", async () => {
    const minting = await createMintApp("mint-quota", { selfServiceMintsPerIpPerDay: 2 });

    try {
      expect((await minting.mint("203.0.113.30")).statusCode).toBe(201);
      expect((await minting.mint("203.0.113.30")).statusCode).toBe(201);

      const exceeded = await minting.mint("203.0.113.30");
      expect(exceeded.statusCode).toBe(429);
      // The pinned refusal plus `quota`, which is the one documented addition —
      // spelled out so a future change to the shape has to come through here.
      expect(refusalBody(exceeded)).toEqual({
        ok: false,
        code: "mint_quota_exceeded",
        quota: 2
      });
      // Copy speaks the rolling window rather than a calendar day.
      expect((exceeded.json() as { error: string }).error).toMatch(/24 hours/);

      // Another address carries its own tally.
      expect((await minting.mint("203.0.113.31")).statusCode).toBe(201);

      // A restart empties every bucket held in memory. The quota is not one of
      // them: it is recounted from the stored mint records.
      await minting.restart();
      const afterRestart = await minting.mint("203.0.113.30");
      expect(afterRestart.statusCode).toBe(429);
      expect(afterRestart.json()).toMatchObject({ code: "mint_quota_exceeded" });

      // The window rolls rather than resetting at a fixed hour, so the day has
      // to pass from the mints themselves before the address mints again.
      minting.advanceMs(DAY_MS + 1_000);
      expect((await minting.mint("203.0.113.30")).statusCode).toBe(201);
    } finally {
      await minting.close();
    }
  });

  it("throttles mints per minute from one address, in memory", async () => {
    const minting = await createMintApp("mint-rate", {
      selfServiceMintRateLimitPerMinute: 2,
      selfServiceMintsPerIpPerDay: 100
    });

    try {
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(201);
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(201);

      const limited = await minting.mint("203.0.113.40");
      expect(limited.statusCode).toBe(429);
      // Exactly the pinned refusal. `retryAfterSeconds` must be a positive
      // number, which is what the CLI relays as the wait.
      expect(refusalBody(limited)).toEqual({
        ok: false,
        code: "rate_limited",
        retryAfterSeconds: 60
      });
      expect(limited.headers["retry-after"]).toBe("60");

      // Another address is unaffected; the bucket is per source address.
      expect((await minting.mint("203.0.113.41")).statusCode).toBe(201);

      minting.advanceMs(60_000);
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(201);

      // In memory and nowhere else: a restart hands the address a fresh minute
      // even though the day's tally in the database keeps counting.
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(201);
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(429);
      await minting.restart();
      expect((await minting.mint("203.0.113.40")).statusCode).toBe(201);
    } finally {
      await minting.close();
    }
  });

  it("gives every mint its own principal with own-drafts-only rights", async () => {
    const minting = await createMintApp("mint-rights");

    try {
      const first = await minting.mintedToken("203.0.113.50");
      const second = await minting.mintedToken("203.0.113.51");

      // Fresh principal per mint: the two tokens share nothing to own through.
      expect(first.accountId).not.toBe(second.accountId);

      const patchId = await minting.uploadAs(first.token, "First principal page");

      // The other minted token cannot reach a draft it does not own — not to
      // update it, not to moderate it, not to delete it.
      const foreignUpdate = await minting.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: `Bearer ${second.token}` },
        payload: {
          patchId,
          html: "<!doctype html><html><head><title>Hijack</title></head><body></body></html>"
        }
      });
      expect(foreignUpdate.statusCode).toBe(404);

      const foreignDisable = await minting.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/disable`,
        headers: { authorization: `Bearer ${second.token}` },
        payload: { reason: "not mine" }
      });
      expect(foreignDisable.statusCode).toBe(404);

      const foreignDelete = await minting.app.inject({
        method: "DELETE",
        url: `/api/patches/${patchId}`,
        headers: { authorization: `Bearer ${second.token}` }
      });
      expect(foreignDelete.statusCode).toBe(404);

      // A draft the operator owns is just as far out of reach.
      const operatorDraftId = await publishDraft(minting.app, "Operator page");
      const reachUp = await minting.app.inject({
        method: "DELETE",
        url: `/api/patches/${operatorDraftId}`,
        headers: { authorization: `Bearer ${first.token}` }
      });
      expect(reachUp.statusCode).toBe(404);

      // Never admin, so it cannot mint further tokens through the admin
      // endpoint however it asks.
      const escalation = await minting.app.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { authorization: `Bearer ${first.token}` },
        payload: { name: "More reach", scopes: ["admin"] }
      });
      expect(escalation.statusCode).toBe(403);

      // Its own draft, though, it updates and deletes freely.
      const ownUpdate = await minting.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: `Bearer ${first.token}` },
        payload: {
          patchId,
          html: "<!doctype html><html><head><title>Second cut</title></head><body></body></html>"
        }
      });
      expect(ownUpdate.statusCode).toBe(200);

      const ownDelete = await minting.app.inject({
        method: "DELETE",
        url: `/api/patches/${patchId}`,
        headers: { authorization: `Bearer ${first.token}` }
      });
      expect(ownDelete.statusCode).toBe(200);
    } finally {
      await minting.close();
    }
  });

  it("subjects a minted principal's drafts to expiry like any other", async () => {
    const minting = await createMintApp("mint-expiry");

    try {
      const { token } = await minting.mintedToken("203.0.113.60");
      const patchId = await minting.uploadAs(token, "Minted and mortal");

      expect((await minting.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        200
      );

      // Minting buys no exemption: the retention clock runs on this draft
      // exactly as it does on the operator's, and the sweep takes it.
      minting.advanceMs(91 * DAY_MS);
      expect((await minting.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        404
      );
      expect(await minting.app.sweepExpiredDrafts()).toMatchObject({ deleted: 1 });

      // And pinning stays an operator's act — a self-service token cannot buy
      // itself the exemption either.
      const secondDraftId = await minting.uploadAs(token, "Minted and hopeful");
      const selfPin = await minting.app.inject({
        method: "POST",
        url: `/api/patches/${secondDraftId}/pin`,
        headers: { authorization: `Bearer ${token}` }
      });
      expect(selfPin.statusCode).toBe(403);
    } finally {
      await minting.close();
    }
  });
});

interface ServedDraft {
  app: ReturnType<typeof createApp>;
  /** The store behind the app, for reading what a request left behind. */
  db: JsonFilePatchyDb;
  patchId: string;
  latestUrl: string;
  versionUrl: string;
  /**
   * Winds the clock the app and its database share. The per-minute limiters
   * read it, so this is how a test crosses a rate-limit window boundary
   * without waiting a minute.
   */
  advanceMs: (ms: number) => void;
  close: () => Promise<void>;
}

async function createServedDraft(
  label: string,
  overrides: Partial<ServerConfig> = {}
): Promise<ServedDraft> {
  const safeLabel = label.replaceAll(/[^a-z0-9]/gi, "-");
  const config: ServerConfig = { ...testConfig(), ...overrides };
  let now = Date.UTC(2026, 0, 1);
  const clock = (): number => now;
  const db = new JsonFilePatchyDb(path.join(tempDir, `${safeLabel}-db.json`), { clock });
  await db.initialize("dev-token");
  const storage = new FileSystemHtmlStorage(path.join(tempDir, `${safeLabel}-drafts`));
  const app = createApp({ config, db, storage, clock, runtime: createTestRuntime({ clock }) });

  const upload = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: "Bearer dev-token" },
    payload: {
      html: "<!doctype html><html><head><title>Serving Guarantees</title></head><body><p>Served.</p></body></html>"
    }
  });
  expect(upload.statusCode).toBe(201);
  const body = upload.json() as { patchId: string; versionNumber: number };

  return {
    app,
    db,
    patchId: body.patchId,
    latestUrl: `/d/${body.patchId}`,
    versionUrl: `/d/${body.patchId}/v/${body.versionNumber}`,
    advanceMs(ms) {
      now += ms;
    },
    close: async () => {
      await app.close();
      await db.close();
    }
  };
}

interface SourceIpAttribution {
  versionSourceIp: string | null | undefined;
  eventSourceIp: string | null | undefined;
}

async function uploadSourceIp(options: {
  trustProxy?: string;
  remoteAddress: string;
  forwardedFor?: string;
}): Promise<SourceIpAttribution> {
  const apiToken = "trusted-proxy-token";
  const config = getServerConfig(
    options.trustProxy === undefined ? {} : { PATCHY_TRUST_PROXY: options.trustProxy }
  );
  const dbFile = path.join(tempDir, "trusted-proxy-db.json");
  const db = new JsonFilePatchyDb(dbFile);
  await db.initialize(apiToken);
  const storage = new FileSystemHtmlStorage(path.join(tempDir, "trusted-proxy-drafts"));
  const app = createApp({ config, db, storage, runtime: createTestRuntime() });

  try {
    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      remoteAddress: options.remoteAddress,
      headers: {
        authorization: `Bearer ${apiToken}`,
        ...(options.forwardedFor === undefined ? {} : { "x-forwarded-for": options.forwardedFor })
      },
      payload: {
        html: "<!doctype html><html><head><title>Trusted Proxy</title></head><body></body></html>"
      }
    });

    expect(upload.statusCode).toBe(201);
    const { patchId, versionId } = upload.json() as { patchId: string; versionId: string };
    const lookup = await db.findDraftVersion(patchId);
    const state = JSON.parse(await readFile(dbFile, "utf8")) as {
      uploadEvents: Array<{ draftVersionId: string; sourceIp: string | null }>;
    };
    const event = state.uploadEvents.find((row) => row.draftVersionId === versionId);

    return {
      versionSourceIp: lookup.version?.sourceIp,
      eventSourceIp: event?.sourceIp
    };
  } finally {
    await app.close();
    await db.close();
  }
}

async function markJsonTokenRevoked(filePath: string, name: string): Promise<void> {
  const state = JSON.parse(await readFile(filePath, "utf8")) as {
    apiTokens: Array<{ name: string; revokedAt: string | null }>;
  };
  const token = state.apiTokens.find((row) => row.name === name);
  expect(token).toBeDefined();
  token!.revokedAt = "2026-01-01T00:00:00.000Z";
  await writeFile(filePath, JSON.stringify(state, null, 2));
}

async function createScopedTokenApp(label: string, clock?: () => number): Promise<ScopedTokenApp> {
  const safeLabel = label.replaceAll(/[^a-z0-9]/gi, "-");
  const config = testConfig();
  const db = new JsonFilePatchyDb(path.join(tempDir, `${safeLabel}-db.json`));
  await db.initialize("admin-token");
  const adminAuth = await db.findApiTokenByToken("admin-token");
  expect(adminAuth).not.toBeNull();
  await db.createApiToken({
    accountId: adminAuth!.accountId,
    name: "Read token",
    token: "read-token",
    scopes: ["read"]
  });
  await db.createApiToken({
    accountId: adminAuth!.accountId,
    name: "Upload token",
    token: "upload-token",
    scopes: ["upload"]
  });
  await db.createApiToken({
    accountId: adminAuth!.accountId,
    name: "Admin only token",
    token: "admin-only-token",
    scopes: ["admin"]
  });
  const storage = new FileSystemHtmlStorage(path.join(tempDir, `${safeLabel}-drafts`));
  const app = createApp({ config, db, storage, clock, runtime: createTestRuntime({ clock }) });
  return { app, db };
}

function draftHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
}

async function createDraft(app: ReturnType<typeof createApp>, token: string, title: string) {
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: `Bearer ${token}` },
    payload: { html: draftHtml(title) }
  });
}

async function updateDraft(
  app: ReturnType<typeof createApp>,
  token: string,
  patchId: string,
  title: string
) {
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: `Bearer ${token}` },
    payload: { patchId, html: draftHtml(title) }
  });
}

async function oversizedJsonApiRequest(
  app: ReturnType<typeof createApp>,
  options: { target: ApiTargetCase; token: string }
) {
  const authorization = `Bearer ${options.token}`;
  if (options.target.rawHttp) {
    return rawHttpRequest(
      app,
      options.target.url,
      '{"html":"',
      {
        Authorization: authorization,
        "Content-Type": "application/json",
        "Content-Length": String(2 * 1024 * 1024 + 1)
      },
      { closeAfterWrite: false }
    );
  }

  return app.inject({
    method: options.target.method || "POST",
    url: options.target.url,
    headers: {
      authorization,
      "content-type": "application/json"
    },
    payload: `{"html":"${"x".repeat(2 * 1024 * 1024)}`
  });
}

async function rawHttpRequest(
  app: ReturnType<typeof createApp>,
  requestTarget: string,
  payload = "",
  headers: Record<string, string> = {},
  options: { closeAfterWrite?: boolean; method?: string } = {}
): Promise<RawHttpResponse> {
  const address = app.server.address();
  const port = address && typeof address !== "string" ? address.port : await listenOnLoopback(app);

  const raw = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    let response = "";
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => {
      socket.destroy();
      rejectOnce(new Error("Timed out waiting for raw HTTP response."));
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", resolveOnce);
    socket.on("error", (error) => {
      if (response) {
        resolveOnce();
        return;
      }
      rejectOnce(error);
    });
    socket.on("connect", () => {
      const requestHeaders = {
        Host: "host",
        Connection: "close",
        "Content-Length": String(Buffer.byteLength(payload)),
        ...headers
      };
      const headerLines = Object.entries(requestHeaders).map(
        ([name, value]) => `${name}: ${value}`
      );
      const request = [
        `${options.method ?? "POST"} ${requestTarget} HTTP/1.1`,
        ...headerLines,
        "",
        payload
      ].join("\r\n");
      if (options.closeAfterWrite === false) {
        socket.write(request);
        return;
      }
      socket.end(request);
    });
  });

  return parseRawHttpResponse(raw);
}

async function listenOnLoopback(app: ReturnType<typeof createApp>): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected Fastify test server to listen on a TCP address.");
  }
  return (address as AddressInfo).port;
}

function parseRawHttpResponse(raw: string): RawHttpResponse {
  const [head = "", encodedBody = ""] = raw.split("\r\n\r\n", 2);
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const statusCode = Number(statusLine.split(" ")[1]);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  const body =
    headers["transfer-encoding"]?.toLowerCase() === "chunked"
      ? decodeChunkedBody(encodedBody)
      : encodedBody;

  return {
    statusCode,
    headers,
    json: () => JSON.parse(body)
  };
}

function decodeChunkedBody(encodedBody: string): string {
  let cursor = 0;
  let decoded = "";
  while (cursor < encodedBody.length) {
    const lineEnd = encodedBody.indexOf("\r\n", cursor);
    if (lineEnd === -1) break;
    const size = Number.parseInt(encodedBody.slice(cursor, lineEnd), 16);
    if (!size) break;
    const chunkStart = lineEnd + 2;
    decoded += encodedBody.slice(chunkStart, chunkStart + size);
    cursor = chunkStart + size + 2;
  }
  return decoded;
}

type RawHttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  json: () => unknown;
};

type ApiTargetCase = {
  label: string;
  url: string;
  method?: string;
  rawHttp?: boolean;
};

type ScopedTokenApp = {
  app: ReturnType<typeof createApp>;
  db: JsonFilePatchyDb;
};

type ClockedApp = {
  app: ReturnType<typeof createApp>;
  storage: FileSystemHtmlStorage;
  /** Where this app's HTML objects land, so a test can watch them go. */
  storageDir: string;
  advanceDays(days: number): void;
  close(): Promise<void>;
};

type ClockedAppOptions = {
  openDb?: (file: string, clock: () => number) => JsonFilePatchyDb;
  openStorage?: (storageDir: string) => FileSystemHtmlStorage;
  /** Overrides `testConfig()`, for a clocked app that needs a posture changed. */
  config?: ServerConfig;
};

type ModerationApp = ClockedApp & {
  /** The publisher a takedown is about: plaintext token, its ID, its principal. */
  publisherToken: string;
  publisherApiTokenId: string;
  principalId: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The pinned mint route, spelled out here rather than imported from the app. */
const MINT_PATH = "/api/tokens/self-service";

/**
 * A refusal body with `error` checked and removed, so the caller can assert the
 * rest of the pinned shape exactly.
 *
 * Every pinned refusal carries `error`, but its wording is copy that should be
 * free to improve; what must not drift is that the field is there and says
 * something. Lifting it out here lets the assertions use `toEqual` — which
 * catches a field quietly appearing or vanishing — instead of `toMatchObject`,
 * which would wave both through.
 */
function refusalBody(response: InjectedResponse): Record<string, unknown> {
  const body = response.json() as Record<string, unknown>;
  expect(typeof body.error).toBe("string");
  expect((body.error as string).length).toBeGreaterThan(0);

  const pinned = { ...body };
  delete pinned.error;
  return pinned;
}

type MintedToken = { token: string; accountId: string };
type InjectedResponse = Awaited<ReturnType<ReturnType<typeof createApp>["inject"]>>;

interface MintApp {
  readonly app: ReturnType<typeof createApp>;
  readonly dbFile: string;
  mint(sourceIp: string): Promise<InjectedResponse>;
  /** Mints, then reads back the principal the token authenticates as. */
  mintedToken(sourceIp: string): Promise<MintedToken>;
  uploadAs(token: string, title: string): Promise<string>;
  advanceMs(ms: number): void;
  /** Drops the process and opens a new one over the same stored state. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

/**
 * An app for the mint route, with a clock both it and its database read, and a
 * restart that keeps the stored state while discarding everything in memory —
 * which is the only way to tell the durable half of the mint guardrail from the
 * per-minute half.
 */
async function createMintApp(
  label: string,
  overrides: Partial<ServerConfig> = {}
): Promise<MintApp> {
  let now = Date.UTC(2026, 0, 1);
  const clock = (): number => now;
  const dbFile = path.join(tempDir, `${label}-db.json`);
  const storage = new FileSystemHtmlStorage(path.join(tempDir, `${label}-drafts`));
  const config: ServerConfig = {
    ...testConfig(),
    allowSelfServiceTokens: true,
    jsonDbFile: dbFile,
    ...overrides
  };

  const open = async (): Promise<{
    app: ReturnType<typeof createApp>;
    db: JsonFilePatchyDb;
  }> => {
    const db = new JsonFilePatchyDb(dbFile, { clock });
    await db.initialize("dev-token");
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
    dbFile,
    async mint(sourceIp) {
      return running.app.inject({
        method: "POST",
        url: MINT_PATH,
        headers: { "content-type": "application/json" },
        payload: "{}",
        remoteAddress: sourceIp
      });
    },
    async mintedToken(sourceIp) {
      const mint = await this.mint(sourceIp);
      expect(mint.statusCode).toBe(201);
      const token = (mint.json() as { token: string }).token;

      const me = await running.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(me.statusCode).toBe(200);
      return { token, accountId: (me.json() as { accountId: string }).accountId };
    },
    async uploadAs(token, title) {
      const upload = await running.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          html: `<!doctype html><html><head><title>${title}</title></head><body></body></html>`
        }
      });
      expect(upload.statusCode).toBe(201);
      return (upload.json() as { patchId: string }).patchId;
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
    }
  };
}

/**
 * An app whose clock can be wound forward months. The database gets the *same*
 * clock: the retention clock is the database's, so an app-only clock would move
 * the rate limiters and nothing else.
 */
async function createClockedApp(
  label: string,
  options: ClockedAppOptions = {}
): Promise<ClockedApp> {
  const openDb = options.openDb ?? ((file, clock) => new JsonFilePatchyDb(file, { clock }));
  const openStorage = options.openStorage ?? ((dir) => new FileSystemHtmlStorage(dir));
  let now = Date.UTC(2026, 0, 1);
  const clock = (): number => now;
  const db = openDb(path.join(tempDir, `${label}-db.json`), clock);
  await db.initialize("dev-token");
  const storageDir = path.join(tempDir, `${label}-drafts`);
  const storage = openStorage(storageDir);
  const app = createApp({
    config: options.config ?? testConfig(),
    db,
    storage,
    clock,
    runtime: createTestRuntime({ clock })
  });

  return {
    app,
    storage,
    storageDir,
    advanceDays(days) {
      now += days * DAY_MS;
    },
    async close() {
      await app.close();
      await db.close();
    }
  };
}

/**
 * A clocked app plus a publisher whose token came from the *existing* admin
 * mint — the moderation loop's demo path has no dependency on self-service
 * minting. Its principal is the bootstrap one, because an admin mint hangs a
 * new token off the minting principal rather than making a fresh one; the loop
 * reads and lists by principal either way. A self-service mint is 1:1 instead,
 * which the revocation test alongside this one covers.
 */
async function createModerationApp(label: string): Promise<ModerationApp> {
  const clocked = await createClockedApp(label);

  const minted = await clocked.app.inject({
    method: "POST",
    url: "/api/tokens",
    headers: { authorization: "Bearer dev-token" },
    payload: { name: "Flagged publisher", scopes: ["upload"] }
  });
  expect(minted.statusCode).toBe(201);
  const publisher = minted.json() as { token: string; apiToken: { id: string } };

  // Ask the publisher which principal it is, rather than reading the store: the
  // moderation loop's answers have to agree with what the API already says.
  const identity = await clocked.app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${publisher.token}` }
  });
  expect(identity.statusCode).toBe(200);

  return {
    ...clocked,
    publisherToken: publisher.token,
    publisherApiTokenId: publisher.apiToken.id,
    principalId: (identity.json() as { accountId: string }).accountId
  };
}

async function publishDraft(app: ReturnType<typeof createApp>, title: string): Promise<string> {
  const upload = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: "Bearer dev-token" },
    payload: {
      html: `<!doctype html><html><head><title>${title}</title></head><body></body></html>`
    }
  });
  expect(upload.statusCode).toBe(201);
  return (upload.json() as { patchId: string }).patchId;
}

/** A store that can serve a draft but cannot record the visit that follows. */
class VisitFailingJsonDb extends JsonFilePatchyDb {
  override async recordDraftVisit(): Promise<void> {
    throw new Error("Forced visit top-up failure.");
  }
}

function testConfig(): ServerConfig {
  return {
    port: 3000,
    publicBaseUrl: "http://localhost:3000",
    trustProxy: false,
    bootstrapApiToken: "dev-token",
    allowSelfServiceTokens: false,
    maxHtmlBytes: 512 * 1024,
    protectedApiRateLimitPerMinute: 60,
    authenticatedUploadRateLimitPerMinute: 20,
    selfServiceMintRateLimitPerMinute: 5,
    selfServiceMintsPerIpPerDay: 5,
    draftCreateRateLimitPerMinute: 10,
    liveDraftsPerToken: 1_000,
    dbDriver: "json",
    databaseUrl: null,
    jsonDbFile: path.join(tempDir, "db.json"),
    storageDriver: "filesystem",
    storageDir: path.join(tempDir, "drafts"),
    azureStorageAccount: null,
    azureStorageContainer: null,
    azureStorageConnectionString: null
  };
}

class ControlledHtmlStorage extends FileSystemHtmlStorage {
  afterPut: (() => Promise<void>) | null = null;
  putError: Error | null = null;
  deleteError: Error | null = null;

  override async putHtmlObject(key: string, html: string): Promise<void> {
    if (this.putError) throw this.putError;
    await super.putHtmlObject(key, html);
    if (this.afterPut) await this.afterPut();
  }

  override async deleteHtmlObject(key: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    await super.deleteHtmlObject(key);
  }
}

class CommitIndeterminateJsonDb extends JsonFilePatchyDb {
  throwAfterRecord = false;

  override async recordUpload(input: RecordUploadInput): Promise<RecordUploadResult> {
    const result = await super.recordUpload(input);
    if (this.throwAfterRecord) {
      throw new Error("JSON metadata commit outcome is indeterminate.");
    }
    return result;
  }
}

async function listFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, entryPath)));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, entryPath));
    }
  }
  return files.sort();
}
