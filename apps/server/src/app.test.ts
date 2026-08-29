import { readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { getServerConfig } from "@patchy/config";
import type { ServerConfig } from "@patchy/config";
import { Tokens } from "@patchy/auth";
import { sha256 } from "@patchy/core";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import { Patches } from "@patchy/patches";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createApp, isProtectedApiPath } from "./app.js";
import { sweepExpiredPatches } from "./runtime.js";
import { createTestApp, type TestApp } from "./test-harness.js";

/** The bootstrap principal every `dev-token` upload lands on. */
const OPERATOR = Tokens.BOOTSTRAP_PRINCIPAL_ID;
/** The dev seed's principal and token: a second, foreign principal every test database holds. */
const FOREIGN = { accountId: "acct_dev", apiTokenId: "tok_dev" };

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

describe("Patchy Cloud server", () => {
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

  it("returns uploaded patch URLs on the configured public origin", async () => {
    const publicBaseUrl = "https://drafts.self-hoster.dev";
    const apiToken = "configured-origin-token";
    const harness = await createTestApp({ config: { publicBaseUrl, bootstrapApiToken: apiToken } });
    const { app } = harness;

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

    await harness.close();
  });

  it("requires auth for upload and renders uploaded patches publicly", async () => {
    const harness = await createTestApp();
    const { app } = harness;

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

    await harness.close();
  });

  it("refuses a tokenless upload under every configuration", async () => {
    for (const allowSelfServiceTokens of [false, true]) {
      const label = `allowSelfServiceTokens=${allowSelfServiceTokens}`;
      const harness = await createTestApp({
        config: { allowSelfServiceTokens, bootstrapApiToken: null }
      });
      const { app } = harness;
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
        await harness.close();
      }
    }
  });

  it("does not admit an absent credential on a non-create upload method", async () => {
    const harness = await createTestApp({
      config: { allowSelfServiceTokens: true, bootstrapApiToken: null }
    });
    const { app } = harness;

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

    await harness.close();
  });

  it("keeps every upload-like POST target authenticated", async () => {
    const harness = await createTestApp({
      config: { allowSelfServiceTokens: true, bootstrapApiToken: null }
    });
    const { app } = harness;

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
      await harness.close();
    }
  });

  it("lets admin credentials alone moderate another principal's patch", async () => {
    const harness = await createTestApp({ config: { bootstrapApiToken: "admin-token" } });
    const { app } = harness;
    await harness.createToken({
      name: "Ordinary token",
      token: "ordinary-token",
      scopes: ["upload"]
    });
    const createForeignPatch = async (): Promise<string> =>
      (await harness.upload(seedUpload({ ...FOREIGN, title: "Another principal's patch" })))
        .patchId;

    try {
      const disablePatchId = await createForeignPatch();
      for (const request of [
        { method: "GET" as const, url: "/api/me" },
        {
          method: "POST" as const,
          url: `/api/patches/${disablePatchId}/disable`,
          payload: { reason: "tokenless attempt" }
        },
        { method: "DELETE" as const, url: `/api/patches/${disablePatchId}` }
      ]) {
        const tokenlessOperation = await app.inject(request);
        expect(tokenlessOperation.statusCode).toBe(401);
      }

      // An ordinary upload token reaches only what it owns.
      const ordinaryDisable = await app.inject({
        method: "POST",
        url: `/api/patches/${disablePatchId}/disable`,
        headers: { authorization: "Bearer ordinary-token" },
        payload: { reason: "not a moderator" }
      });
      expect(ordinaryDisable.statusCode).toBe(404);

      // The operator's takedown path: admin scope reaches any principal's draft,
      // which is what completes the moderation loop.
      const adminDisable = await app.inject({
        method: "POST",
        url: `/api/patches/${disablePatchId}/disable`,
        headers: { authorization: "Bearer admin-token" },
        payload: { reason: "operator policy" }
      });
      expect(adminDisable.statusCode).toBe(200);

      const deletePatchId = await createForeignPatch();
      const ordinaryDelete = await app.inject({
        method: "DELETE",
        url: `/api/patches/${deletePatchId}`,
        headers: { authorization: "Bearer ordinary-token" }
      });
      expect(ordinaryDelete.statusCode).toBe(404);

      const adminDelete = await app.inject({
        method: "DELETE",
        url: `/api/patches/${deletePatchId}`,
        headers: { authorization: "Bearer admin-token" }
      });
      expect(adminDelete.statusCode).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it("does not downgrade present bad credentials when self-service tokens are allowed", async () => {
    const harness = await createTestApp({
      config: { allowSelfServiceTokens: true, bootstrapApiToken: "admin-token" }
    });
    const { app } = harness;
    await harness.createToken({ name: "Read-only token", token: "read-token", scopes: ["read"] });
    const revoked = await harness.createToken({
      name: "Revoked token",
      token: "revoked-token",
      scopes: ["upload"]
    });
    await harness.revokeToken(revoked.id);
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
      await harness.close();
    }
  });

  it.each(uploadLikeApiTargets)(
    "rejects insufficient upload scope before parsing upload-like target: $label",
    async (target) => {
      const harness = await createScopedTokenApp(`insufficient-${target.label}`);
      const { app } = harness;

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
        await harness.close();
      }
    }
  );

  it.each(uploadLikeApiTargets)(
    "returns API 404 before parsing authorized upload-like unmatched target: $label",
    async (target) => {
      const harness = await createScopedTokenApp(`authorized-${target.label}`);
      const { app } = harness;

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
        await harness.close();
      }
    }
  );

  it("allows admin scope to satisfy upload-like policy before unmatched API 404", async () => {
    const harness = await createScopedTokenApp("authorized-admin-upload-like");
    const { app } = harness;

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
      await harness.close();
    }
  });

  it("pins a patch only for an admin token, and only one that is there", async () => {
    const harness = await createScopedTokenApp("pin-admin-only");
    const { app } = harness;

    try {
      const created = await createPatch(app, "upload-token", "Pinnable");
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
      await harness.close();
    }
  });

  it("returns API 404 before parsing arbitrary authenticated unmatched API targets", async () => {
    const harness = await createScopedTokenApp("authorized-arbitrary-unmatched-api");
    const { app } = harness;

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
      await harness.close();
    }
  });

  it("limits authorized upload-like unmatched targets by stable token identity", async () => {
    let now = 1_000;
    const harness = await createScopedTokenApp("upload-like-unmatched-limit", () => now);
    const { app } = harness;
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
      await harness.close();
    }
  });

  it("limits protected API attempts by canonical request IP", async () => {
    let now = 1_000;
    const harness = await createTestApp({
      clock: () => now,
      config: { trustProxy: trustProxyOf("10.0.0.0/8"), bootstrapApiToken: "unused-token" }
    });
    const { app } = harness;

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
      await harness.close();
    }
  });

  it("protects unmatched API paths before parsing and counts them once per IP", async () => {
    let now = 1_000;
    const harness = await createTestApp({ clock: () => now });
    const { app } = harness;

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
      await harness.close();
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
      const harness = await createTestApp({ clock: () => now });
      const { app } = harness;

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
        await harness.close();
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
    async ({ protectedTarget, method, authenticatedStatus, authenticatedError }) => {
      let now = 1_000;
      const harness = await createTestApp({ clock: () => now });
      const { app } = harness;

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
        await harness.close();
      }
    }
  );

  it("preserves authenticated 404s for long unmatched API route shapes", async () => {
    const harness = await createTestApp();
    const { app } = harness;
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
      await harness.close();
    }
  });

  it("does not classify an absolute URI query as an API path or consume its bucket", async () => {
    const harness = await createTestApp();
    const { app } = harness;

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
      await harness.close();
    }
  });

  it("limits authenticated upload attempts by stable token identity", async () => {
    let now = 1_000;
    const harness = await createTestApp({
      clock: () => now,
      config: { bootstrapApiToken: "upload-token" }
    });
    const { app } = harness;
    await harness.createToken({
      name: "Other upload token",
      token: "other-upload-token",
      scopes: ["upload"]
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

      // The bootstrap token rotates: same token id, new plaintext.
      await harness.sql("UPDATE api_tokens SET token_hash = $1 WHERE id = $2", [
        sha256("rotated-upload-token"),
        Tokens.BOOTSTRAP_API_TOKEN_ID
      ]);

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
      await harness.close();
    }
  });

  it("composes protected-API and token upload limits independently", async () => {
    let now = 1_000;
    const harness = await createTestApp({
      clock: () => now,
      config: {
        allowSelfServiceTokens: true,
        protectedApiRateLimitPerMinute: 2,
        authenticatedUploadRateLimitPerMinute: 1,
        bootstrapApiToken: "upload-token"
      }
    });
    const { app } = harness;

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
      await harness.close();
    }
  });

  it("limits patch creates per minute per token without counting updates", async () => {
    let now = 1_000;
    const harness = await createTestApp({
      clock: () => now,
      config: { patchCreateRateLimitPerMinute: 2 }
    });
    const { app } = harness;

    try {
      const first = await createPatch(app, "dev-token", "First");
      expect(first.statusCode).toBe(201);
      const { patchId } = first.json() as { patchId: string };

      // Updates in the same window must not spend any of the create budget.
      for (let revision = 0; revision < 3; revision += 1) {
        const update = await updatePatch(app, "dev-token", patchId, `First v${revision}`);
        expect(update.statusCode).toBe(200);
      }

      // Still room for the window's second create, so the updates cost nothing.
      expect((await createPatch(app, "dev-token", "Second")).statusCode).toBe(201);

      const limited = await createPatch(app, "dev-token", "Third");
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.json()).toEqual({
        ok: false,
        error: "Rate limit exceeded.",
        code: "rate_limited",
        retryAfterSeconds: 60
      });

      // An update still succeeds once the create bucket is empty.
      expect((await updatePatch(app, "dev-token", patchId, "First again")).statusCode).toBe(200);

      now = 61_000;
      const afterWindow = await createPatch(app, "dev-token", "Fourth");
      expect(afterWindow.statusCode).toBe(201);
    } finally {
      await harness.close();
    }
  });

  it("caps live patches per token from the database, across a restart", async () => {
    // `dev-token` is the admin bootstrap token: the cap has no admin exemption.
    let harness = await createTestApp({ config: { livePatchesPerToken: 2 } });
    const { app } = harness;

    try {
      const one = await createPatch(app, "dev-token", "One");
      expect(one.statusCode).toBe(201);
      const { patchId } = one.json() as { patchId: string };
      expect((await createPatch(app, "dev-token", "Two")).statusCode).toBe(201);

      const overQuota = await createPatch(app, "dev-token", "Three");
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
      expect((await updatePatch(app, "dev-token", patchId, "One revised")).statusCode).toBe(200);

      // A restart drops every in-memory bucket. The cap is recounted from the
      // database, so it is still there.
      harness = await harness.restart();
      const stillOverQuota = await createPatch(harness.app, "dev-token", "Three again");
      expect(stillOverQuota.statusCode).toBe(403);
      expect(stillOverQuota.json()).toMatchObject({
        code: "live_patch_quota_exceeded",
        quota: 2
      });
    } finally {
      await harness.close();
    }
  });

  it("returns live-patch cap room when a patch is disabled or deleted", async () => {
    const harness = await createTestApp({ config: { livePatchesPerToken: 1 } });
    const { app } = harness;
    await harness.createToken({
      name: "Sibling upload token",
      token: "sibling-token",
      scopes: ["upload"]
    });

    try {
      const created = await createPatch(app, "dev-token", "Only one");
      expect(created.statusCode).toBe(201);
      const { patchId } = created.json() as { patchId: string };
      expect((await createPatch(app, "dev-token", "Blocked")).statusCode).toBe(403);

      // The cap is per token, not per account: a sibling token on the same
      // account still has its own room.
      expect((await createPatch(app, "sibling-token", "Sibling")).statusCode).toBe(201);

      const disable = await app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/disable`,
        headers: { authorization: "Bearer dev-token" },
        payload: { reason: "quota test" }
      });
      expect(disable.statusCode).toBe(200);

      const afterDisable = await createPatch(app, "dev-token", "After disable");
      expect(afterDisable.statusCode).toBe(201);
      const replacementPatchId = (afterDisable.json() as { patchId: string }).patchId;
      expect((await createPatch(app, "dev-token", "Blocked again")).statusCode).toBe(403);

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/patches/${replacementPatchId}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(removed.statusCode).toBe(200);

      expect((await createPatch(app, "dev-token", "After delete")).statusCode).toBe(201);
      // Nothing the first token did moved the sibling's own tally.
      expect((await createPatch(app, "sibling-token", "Sibling blocked")).statusCode).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it("persists the direct socket address when proxy trust is not configured", async () => {
    const sourceIp = await uploadSourceIp({
      remoteAddress: "192.0.2.10"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "192.0.2.10"
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
      versionSourceIp: "192.0.2.10"
    });
  });

  it("attributes the rightmost forwarded address through one trusted proxy network", async () => {
    const sourceIp = await uploadSourceIp({
      trustProxy: "10.0.0.0/8",
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.9, 198.51.100.7"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "198.51.100.7"
    });
  });

  it("attributes the first untrusted address beyond configured proxy networks", async () => {
    const sourceIp = await uploadSourceIp({
      trustProxy: "10.0.0.0/8, 198.51.100.0/24",
      remoteAddress: "10.0.0.5",
      forwardedFor: "203.0.113.9, 198.51.100.7"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "203.0.113.9"
    });
  });

  it("ignores a spoofed forwarding chain from outside configured proxy networks", async () => {
    const sourceIp = await uploadSourceIp({
      trustProxy: "10.0.0.0/8",
      remoteAddress: "192.0.2.10",
      forwardedFor: "203.0.113.9, 10.0.0.5"
    });

    expect(sourceIp).toEqual({
      versionSourceIp: "192.0.2.10"
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
  it("rejects an unknown client-supplied patch ID without creating a public patch", async () => {
    const harness = await createTestApp();
    const { app, config } = harness;
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
    expect(await listFiles(config.storageDir)).toEqual([]);

    await harness.close();
  });

  it("returns the same response for unavailable update targets", async () => {
    const harness = await createTestApp();
    const { app } = harness;
    const unknownPatchId = "aaaaaaaaaaaa";
    const foreignPatchId = (await harness.upload(seedUpload(FOREIGN))).patchId;
    const deletedPatchId = (await harness.upload(seedUpload(OPERATOR_UPLOAD))).patchId;
    const disabledPatchId = (await harness.upload(seedUpload(OPERATOR_UPLOAD))).patchId;
    await harness.delete(deletedPatchId, OPERATOR);
    await harness.disable(disabledPatchId, OPERATOR, "policy");

    const responses = await Promise.all(
      [unknownPatchId, foreignPatchId, deletedPatchId, disabledPatchId].map((patchId) =>
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

    await harness.close();
  });

  it("updates an existing owned patch and preserves its previous version", async () => {
    const harness = await createTestApp();
    const { app } = harness;
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

    await harness.close();
  });

  it("does not hold metadata locks while object storage is slow", async () => {
    const storage = controlledContentStore();
    const harness = await createTestApp({ contentStore: storage.layer });
    const { app } = harness;
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Slow target</title></head><body></body></html>"
      }
    });
    const createdBody = created.json();
    const unrelatedPatchId = (
      await harness.upload(seedUpload({ ...OPERATOR_UPLOAD, title: "Unrelated" }))
    ).patchId;

    const writeStarted = Promise.withResolvers<void>();
    const allowWrite = Promise.withResolvers<void>();
    storage.control.afterPut = async () => {
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

      const disable = harness.disable(unrelatedPatchId, OPERATOR, "unrelated policy action");
      // Await the operation itself rather than racing the filesystem against a
      // short wall-clock deadline. The test timeout remains the deadlock watchdog.
      await expect(disable).resolves.toBe(true);

      allowWrite.resolve();
      await expect(update).resolves.toMatchObject({ statusCode: 200 });
    } finally {
      allowWrite.resolve();
      await harness.close();
    }
  }, 10_000);

  it("removes only the new object when final eligibility recheck rejects", async () => {
    const storage = controlledContentStore();
    const harness = await createTestApp({ contentStore: storage.layer });
    const { app, config } = harness;
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body>original</body></html>"
      }
    });
    const createdBody = created.json();
    const originalKey = `patches/${createdBody.patchId}/versions/${createdBody.versionId}.html`;
    storage.control.afterPut = async () => {
      await harness.disable(createdBody.patchId, OPERATOR, "policy race");
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
    expect(await listFiles(config.storageDir)).toEqual([originalKey]);
    await expect(
      harness.run(Effect.flatMap(ContentStore.ContentStore, (store) => store.get(originalKey)))
    ).resolves.toContain("original");

    await harness.close();
  });

  it("does not mutate metadata when object storage fails", async () => {
    const storage = controlledContentStore();
    const harness = await createTestApp({ contentStore: storage.layer });
    const { app, config } = harness;
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body>original</body></html>"
      }
    });
    const createdBody = created.json();
    storage.control.putError = new Error("Object storage unavailable.");

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
    expect((await harness.currentVersion(createdBody.patchId))?.id).toBe(createdBody.versionId);
    expect(await listFiles(config.storageDir)).toEqual([
      `patches/${createdBody.patchId}/versions/${createdBody.versionId}.html`
    ]);

    await harness.close();
  });

  it("surfaces cleanup failure instead of masking an orphan as a safe rejection", async () => {
    const storage = controlledContentStore();
    const harness = await createTestApp({ contentStore: storage.layer });
    const { app, config } = harness;
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        html: "<!doctype html><html><head><title>Original</title></head><body></body></html>"
      }
    });
    const createdBody = created.json();
    storage.control.afterPut = async () => {
      await harness.disable(createdBody.patchId, OPERATOR, "policy race");
    };
    storage.control.deleteError = new Error("Cleanup unavailable.");

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
    expect(await listFiles(config.storageDir)).toHaveLength(2);

    await harness.close();
  });

  it("accepts the released CLI null patch marker as server-generated create intent", async () => {
    const harness = await createTestApp();
    const { app } = harness;

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

    await harness.close();
  });

  it("names the rename to a client still sending patchId, instead of creating", async () => {
    const harness = await createTestApp();
    const { app } = harness;

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
    expect(
      await harness.run(
        Effect.flatMap(Patches.Patches, (patches) =>
          patches.countLive(Tokens.BOOTSTRAP_API_TOKEN_ID)
        )
      )
    ).toBe(0);
    await harness.close();
  });

  it("rejects invalid non-null patch IDs instead of treating them as creates", async () => {
    const harness = await createTestApp();
    const { app } = harness;

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

    await harness.close();
  });

  it("serves patches noindexed, unwatched, and open to machines", async () => {
    const served = await createServedPatch("serving-guarantees");

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

  it("caches version URLs immutably, latest-patch URLs briefly, and everything else never", async () => {
    const served = await createServedPatch("serving-cache-headers");

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

    const missingPatch = await served.app.inject({ method: "GET", url: "/d/doesnotexist1" });
    expect(missingPatch.statusCode).toBe(404);
    expect(missingPatch.headers["cache-control"]).toBe("no-store");

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

  it("locks the patch content security policy with no script sources", async () => {
    const served = await createServedPatch("serving-csp");

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

  it("serves a patch as the framed document and nothing else", async () => {
    const served = await createServedPatch("bare-wrapper");

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

  it("stops serving and stops updating a patch once its retention clock runs out", async () => {
    const clocked = await createClockedApp("expiry");

    try {
      const patchId = await publishPatch(clocked.app, "Ninety day page");

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

  it("keeps a visited patch alive, and lets it go once the visits stop", async () => {
    const clocked = await createClockedApp("visit-topup");

    try {
      const patchId = await publishPatch(clocked.app, "Still visited");

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

  it("serves a patch whose visit top-up write fails, without moving its clock", async () => {
    const clocked = await createClockedApp("visit-write-failure");

    try {
      const patchId = await publishPatch(clocked.app, "Survives a failed top-up");
      // From here every move of a retention anchor fails inside the database.
      await clocked.sql(`
        CREATE FUNCTION fail_visit() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'Forced visit top-up failure.'; END
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_visit BEFORE UPDATE OF expires_at ON patches
          FOR EACH ROW EXECUTE FUNCTION fail_visit();
      `);

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
      const patchId = await publishPatch(clocked.app, "First cut");

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

  it("takes an expired patch's content and record together, with no way back", async () => {
    const clocked = await createClockedApp("expiry-sweep");

    try {
      const patchId = await publishPatch(clocked.app, "Ages out");
      const updated = await clocked.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: "Bearer dev-token" },
        payload: { patchId, html: patchHtml("Ages out, twice") }
      });
      expect(updated.statusCode).toBe(200);
      expect(await listFiles(clocked.storageDir)).toHaveLength(2);

      // Expired, and so already unserved — but every stored byte is still here,
      // which is what the sweep exists to change.
      clocked.advanceDays(91);
      expect(await listFiles(clocked.storageDir)).toHaveLength(2);

      expect(await sweepExpiredPatches(clocked.runtime)).toEqual({
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
        payload: { patchId, html: patchHtml("Too late") }
      });
      expect(republished.statusCode).toBe(404);
    } finally {
      await clocked.close();
    }
  });

  it("keeps a pinned patch serving forever, and lets it go once it is unpinned", async () => {
    const clocked = await createClockedApp("expiry-sweep-pinned");

    try {
      const patchId = await publishPatch(clocked.app, "Welcome page");
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

      expect(await sweepExpiredPatches(clocked.runtime)).toMatchObject({ deleted: 0 });
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
      expect(await sweepExpiredPatches(clocked.runtime)).toMatchObject({ deleted: 1 });
      const gone = await clocked.app.inject({ method: "GET", url: `/d/${patchId}` });
      expect(gone.statusCode).toBe(404);
      expect(await listFiles(clocked.storageDir)).toEqual([]);
    } finally {
      await clocked.close();
    }
  });

  it("frees a pinned patch the operator deleted, pin and all", async () => {
    const clocked = await createClockedApp("expiry-sweep-pinned-then-deleted");

    try {
      const patchId = await publishPatch(clocked.app, "Pinned then withdrawn");
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
      expect(await sweepExpiredPatches(clocked.runtime)).toMatchObject({ deleted: 1 });
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
      const expiring = await publishPatch(clocked.app, "Abandoned");
      clocked.advanceDays(91);
      const fresh = await publishPatch(clocked.app, "Still here");

      // Two runs at once take the patch once: whichever gets the row lock
      // deletes it, and the other finds nothing half-swept.
      const [first, second] = await Promise.all([
        sweepExpiredPatches(clocked.runtime),
        sweepExpiredPatches(clocked.runtime)
      ]);
      expect(first.deleted + second.deleted).toBe(1);
      expect(first.failed + second.failed + first.orphanedObjects + second.orphanedObjects).toBe(0);

      // Running again changes nothing, and the live draft was never in reach.
      expect(await sweepExpiredPatches(clocked.runtime)).toEqual({
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
    const storage = controlledContentStore();
    const clocked = await createClockedApp("expiry-sweep-storage-failure", {
      contentStore: storage.layer
    });

    try {
      const patchId = await publishPatch(clocked.app, "Object outlives its record");
      clocked.advanceDays(91);
      storage.control.deleteError = new Error("Storage delete failed.");

      expect(await sweepExpiredPatches(clocked.runtime)).toEqual({
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
      expect(await sweepExpiredPatches(clocked.runtime)).toMatchObject({
        deleted: 0,
        orphanedObjects: 0
      });
    } finally {
      await clocked.close();
    }
  });

  it("answers an admin patch read with the principal and the token to revoke", async () => {
    const moderated = await createModerationApp("moderation-read");

    try {
      const created = await createPatch(moderated.app, moderated.publisherToken, "Flagged");
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

  it("lists a principal's patches for an admin and nobody else", async () => {
    const moderated = await createModerationApp("moderation-list");

    try {
      // A day between creates, so "newest first" is asserted against an order
      // the clock decided rather than one two same-millisecond writes fell into.
      const first = await createPatch(moderated.app, moderated.publisherToken, "One");
      moderated.advanceDays(1);
      const second = await createPatch(moderated.app, moderated.publisherToken, "Two");
      moderated.advanceDays(1);
      const removed = await createPatch(moderated.app, moderated.publisherToken, "Gone");
      const removedPatchId = (removed.json() as { patchId: string }).patchId;
      const deletion = await moderated.app.inject({
        method: "DELETE",
        url: `/api/patches/${removedPatchId}`,
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
      expect(body.patches.map((patch) => patch.id)).toEqual([
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
      const created = await createPatch(moderated.app, moderated.publisherToken, "Abusive");
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
          payload: { html: patchHtml("Still trying") }
        },
        {
          method: "POST" as const,
          url: "/api/uploads",
          payload: { patchId, html: patchHtml("Still trying") }
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

  it("lets a revoked token's patches run out the clock they had left", async () => {
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
      const created = await createPatch(clocked.app, token, "Runs down");
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
      config: { allowSelfServiceTokens: true }
    });

    try {
      const minted = await clocked.app.inject({
        method: "POST",
        url: "/api/tokens/self-service",
        remoteAddress: "203.0.113.7"
      });
      expect(minted.statusCode).toBe(201);
      const { token } = minted.json() as { token: string };

      const flaggedUpload = await createPatch(clocked.app, token, "Abusive page");
      expect(flaggedUpload.statusCode).toBe(201);
      const { patchId } = flaggedUpload.json() as { patchId: string };
      const sibling = await createPatch(clocked.app, token, "Second abusive page");
      const siblingPatchId = (sibling.json() as { patchId: string }).patchId;

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
          patch: { principalId: string; createdByApiTokenId: string };
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
      expect([...held.map((patch) => patch.id)].sort()).toEqual([patchId, siblingPatchId].sort());

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
      expect((await createPatch(clocked.app, token, "Another")).statusCode).toBe(401);
      expect((await updatePatch(clocked.app, token, patchId, "Rewritten")).statusCode).toBe(401);

      // The pages stay up and keep their remaining clock — and the freeze holds
      // for a self-service token exactly as it does for an operator's.
      clocked.advanceDays(80);
      expect((await clocked.app.inject({ method: "GET", url: `/d/${patchId}` })).statusCode).toBe(
        200
      );

      clocked.advanceDays(11);
      for (const gone of [patchId, siblingPatchId]) {
        expect((await clocked.app.inject({ method: "GET", url: `/d/${gone}` })).statusCode).toBe(
          404
        );
      }
    } finally {
      await clocked.close();
    }
  });

  it("answers a moderation read for a patch the expiry sweep has already taken", async () => {
    const clocked = await createClockedApp("moderation-after-sweep");

    try {
      const created = await createPatch(clocked.app, "dev-token", "Flagged then expired");
      const { patchId } = created.json() as { patchId: string };

      clocked.advanceDays(91);
      expect(await sweepExpiredPatches(clocked.runtime)).toMatchObject({ deleted: 1 });

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
      const stored = JSON.stringify(await minting.sql("SELECT token_hash FROM api_tokens"));
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

  it("gives every mint its own principal with own-patches-only rights", async () => {
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
      const operatorPatchId = await publishPatch(minting.app, "Operator page");
      const reachUp = await minting.app.inject({
        method: "DELETE",
        url: `/api/patches/${operatorPatchId}`,
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

  it("subjects a minted principal's patches to expiry like any other", async () => {
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
      expect(await sweepExpiredPatches(minting.runtime)).toMatchObject({ deleted: 1 });

      // And pinning stays an operator's act — a self-service token cannot buy
      // itself the exemption either.
      const secondPatchId = await minting.uploadAs(token, "Minted and hopeful");
      const selfPin = await minting.app.inject({
        method: "POST",
        url: `/api/patches/${secondPatchId}/pin`,
        headers: { authorization: `Bearer ${token}` }
      });
      expect(selfPin.statusCode).toBe(403);
    } finally {
      await minting.close();
    }
  });
});

interface ServedPatch {
  app: ReturnType<typeof createApp>;
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

async function createServedPatch(overrides: Partial<ServerConfig> = {}): Promise<ServedPatch> {
  let now = Date.UTC(2026, 0, 1);
  const harness = await createTestApp({ clock: () => now, config: overrides });
  const { app } = harness;

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
    patchId: body.patchId,
    latestUrl: `/d/${body.patchId}`,
    versionUrl: `/d/${body.patchId}/v/${body.versionNumber}`,
    advanceMs(ms) {
      now += ms;
    },
    close: () => harness.close()
  };
}

interface SourceIpAttribution {
  versionSourceIp: string | null | undefined;
}

/** The trusted-proxy setting as the config parses it; throws on an invalid value. */
function trustProxyOf(value: string): ServerConfig["trustProxy"] {
  return getServerConfig({ PATCHY_TRUST_PROXY: value }).trustProxy;
}

async function uploadSourceIp(options: {
  trustProxy?: string;
  remoteAddress: string;
  forwardedFor?: string;
}): Promise<SourceIpAttribution> {
  const apiToken = "trusted-proxy-token";
  const harness = await createTestApp({
    config: {
      bootstrapApiToken: apiToken,
      ...(options.trustProxy === undefined ? {} : { trustProxy: trustProxyOf(options.trustProxy) })
    }
  });

  try {
    const upload = await harness.app.inject({
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
    const { patchId } = upload.json() as { patchId: string };
    return { versionSourceIp: (await harness.currentVersion(patchId))?.sourceIp };
  } finally {
    await harness.close();
  }
}

async function createScopedTokenApp(_label: string, clock?: () => number): Promise<TestApp> {
  const harness = await createTestApp({ clock, config: { bootstrapApiToken: "admin-token" } });
  await harness.createToken({ name: "Read token", token: "read-token", scopes: ["read"] });
  await harness.createToken({ name: "Upload token", token: "upload-token", scopes: ["upload"] });
  await harness.createToken({
    name: "Admin only token",
    token: "admin-only-token",
    scopes: ["admin"]
  });
  return harness;
}

function patchHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
}

async function createPatch(app: ReturnType<typeof createApp>, token: string, title: string) {
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: `Bearer ${token}` },
    payload: { html: patchHtml(title) }
  });
}

async function updatePatch(
  app: ReturnType<typeof createApp>,
  token: string,
  patchId: string,
  title: string
) {
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: { authorization: `Bearer ${token}` },
    payload: { patchId, html: patchHtml(title) }
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

type ClockedApp = {
  app: ReturnType<typeof createApp>;
  runtime: TestApp["runtime"];
  /** Runs SQL on the app's database, for what only the store can be made to do. */
  sql: TestApp["sql"];
  /** Where this app's HTML objects land, so a test can watch them go. */
  storageDir: string;
  advanceDays(days: number): void;
  close(): Promise<void>;
};

type ClockedAppOptions = {
  contentStore?: Layer.Layer<ContentStore.ContentStore>;
  /** Overrides the defaults, for a clocked app that needs a posture changed. */
  config?: Partial<ServerConfig>;
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
  readonly runtime: TestApp["runtime"];
  readonly sql: TestApp["sql"];
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
  _label: string,
  overrides: Partial<ServerConfig> = {}
): Promise<MintApp> {
  let now = Date.UTC(2026, 0, 1);
  const clock = (): number => now;
  let running = await createTestApp({
    clock,
    config: { allowSelfServiceTokens: true, ...overrides }
  });

  return {
    get app() {
      return running.app;
    },
    get runtime() {
      return running.runtime;
    },
    sql: (text, values) => running.sql(text, values),
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
      running = await running.restart();
    },
    async close() {
      await running.close();
    }
  };
}

/**
 * An app whose clock can be wound forward months. The database reads the
 * *same* clock: the retention clock is the database's, so an app-only clock
 * would move the rate limiters and nothing else.
 */
async function createClockedApp(
  _label: string,
  options: ClockedAppOptions = {}
): Promise<ClockedApp> {
  let now = Date.UTC(2026, 0, 1);
  const harness = await createTestApp({
    clock: () => now,
    config: options.config,
    contentStore: options.contentStore
  });

  return {
    app: harness.app,
    runtime: harness.runtime,
    sql: (text, values) => harness.sql(text, values),
    storageDir: harness.storageDir,
    advanceDays(days) {
      now += days * DAY_MS;
    },
    close: () => harness.close()
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

async function publishPatch(app: ReturnType<typeof createApp>, title: string): Promise<string> {
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

/** An upload as a seeded row: a title, a body, and whose it is. */
function seedUpload(input: {
  accountId: string;
  apiTokenId: string;
  title?: string;
}): Parameters<TestApp["upload"]>[0] {
  const title = input.title ?? "Existing target";
  return {
    patchId: null,
    accountId: input.accountId,
    apiTokenId: input.apiTokenId,
    title,
    html: `<!doctype html><html><head><title>${title}</title></head><body></body></html>`,
    filename: null,
    repoOrg: null,
    repoName: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null
  };
}

/** The operator's own uploads, as seeded rows. */
const OPERATOR_UPLOAD = { accountId: OPERATOR, apiTokenId: Tokens.BOOTSTRAP_API_TOKEN_ID };

interface ContentStoreControl {
  /** Runs after a put has landed, while the request is still inside the store call. */
  afterPut: (() => Promise<void>) | null;
  putError: Error | null;
  deleteError: Error | null;
}

/**
 * The filesystem store with a hand on it: a put can be held or failed and a
 * delete failed, so the upload contract's outcomes can be forced one by one.
 */
function controlledContentStore(): {
  control: ContentStoreControl;
  layer: Layer.Layer<ContentStore.ContentStore>;
} {
  const control: ContentStoreControl = { afterPut: null, putError: null, deleteError: null };
  const layer = Layer.effect(
    ContentStore.ContentStore,
    Effect.map(ContentStore.ContentStore, (inner) =>
      ContentStore.ContentStore.of({
        put: (key, html) =>
          control.putError
            ? Effect.fail(
                new ContentStore.StoreUnavailable({
                  operation: "put",
                  key,
                  cause: control.putError
                })
              )
            : inner
                .put(key, html)
                .pipe(
                  Effect.andThen(Effect.promise(() => control.afterPut?.() ?? Promise.resolve()))
                ),
        get: inner.get,
        delete: (key) =>
          control.deleteError
            ? Effect.fail(
                new ContentStore.StoreUnavailable({
                  operation: "delete",
                  key,
                  cause: control.deleteError
                })
              )
            : inner.delete(key)
      })
    )
  ).pipe(Layer.provide(FilesystemContentStore.layer));
  return { control, layer };
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
