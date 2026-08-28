import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import {
  CreatedToken,
  CreateTokenRequest,
  DisableRequest,
  Identity,
  InvalidHtml,
  MintedToken,
  MintQuotaExceeded,
  ModeratedPatch,
  Ok,
  PatchId,
  PatchQuotaExceeded,
  PatchView,
  PatchyApi,
  Pinned,
  PrincipalPatches,
  RateLimited,
  RevokedToken,
  SelfServiceDisabled,
  Unauthorized,
  UploadCreated,
  UploadRequest
} from "./index.js";

/** Decoding then encoding a wire document hands back the same document. */
const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, wire: S["Encoded"]) =>
  Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(wire));

describe("wire schemas", () => {
  it("round-trips an upload request with every optional field present or absent", () => {
    const full = {
      html: "<!doctype html><html></html>",
      filename: "plan.html",
      patchId: "abcdefghijkl",
      metadata: { repoOrg: "patchy", repoName: null, cliVersion: "0.0.1" }
    };
    expect(roundTrip(UploadRequest, full)).toEqual(full);
    expect(roundTrip(UploadRequest, { html: "<html></html>" })).toEqual({ html: "<html></html>" });
  });

  it("rejects a patch id that is not twelve lowercase alphanumerics", () => {
    for (const bad of ["", "ABCDEFGHIJKL", "abc", 123]) {
      expect(Schema.decodeUnknownExit(PatchId)(bad)._tag).toBe("Failure");
      expect(Schema.decodeUnknownExit(UploadRequest)({ html: "x", patchId: bad })._tag).toBe(
        "Failure"
      );
    }
  });

  it("round-trips the success and error bodies the CLI branches on", () => {
    const upload = {
      ok: true as const,
      patchId: "abcdefghijkl",
      versionId: "ver_x",
      versionNumber: 2,
      title: "Plan",
      publicUrl: "https://pages.example.com/d/abcdefghijkl",
      warnings: ["Missing <title>."]
    };
    expect(roundTrip(UploadCreated, upload)).toEqual(upload);

    const identity = {
      accountId: "acct_1",
      accountName: "Dev",
      apiTokenId: "tok_1",
      apiTokenName: "CLI API Token",
      scopes: ["upload"]
    };
    expect(roundTrip(Identity, identity)).toEqual(identity);

    const invalid = { ok: false as const, errors: ["<script> is not allowed."], warnings: [] };
    expect(roundTrip(InvalidHtml, invalid)).toEqual(invalid);

    const limited = {
      ok: false as const,
      error: "Rate limit exceeded.",
      code: "rate_limited" as const,
      retryAfterSeconds: 7
    };
    expect(roundTrip(RateLimited, limited)).toEqual(limited);

    const quota = {
      ok: false as const,
      error: "Patch quota reached.",
      code: "live_patch_quota_exceeded" as const,
      quota: 2
    };
    expect(roundTrip(PatchQuotaExceeded, quota)).toEqual(quota);
  });

  it("round-trips every other wire shape", () => {
    const apiToken = { id: "tok_1", name: "CLI API Token" };
    const patch = moderatedPatch();
    const cases: ReadonlyArray<[Schema.Codec<unknown, unknown>, unknown]> = [
      [MintedToken, { ok: true, token: "pp_x" }],
      [CreateTokenRequest, { name: "Deploy", scopes: ["upload", "admin"] }],
      [CreateTokenRequest, {}],
      [CreatedToken, { ok: true, apiToken, token: "pp_x" }],
      [
        RevokedToken,
        {
          ok: true,
          alreadyRevoked: true,
          apiToken: { ...apiToken, principalId: "acct_1", revokedAt: "2026-08-29T00:00:00.000Z" }
        }
      ],
      [DisableRequest, { reason: "Spam." }],
      [Ok, { ok: true }],
      [Pinned, { ok: true, pinned: false }],
      [PatchView, { ok: true, patch }],
      [PrincipalPatches, { ok: true, principalId: "acct_1", patches: [patch], truncated: true }],
      [Unauthorized, { ok: false, error: "Missing or invalid API token." }],
      [SelfServiceDisabled, { ok: false, error: "No.", code: "self_service_disabled" }],
      [MintQuotaExceeded, { ok: false, error: "Full.", code: "mint_quota_exceeded", quota: 5 }]
    ];
    for (const [schema, wire] of cases) expect(roundTrip(schema, wire)).toEqual(wire);
  });

  it("pins the 401 sentence, so no other wording can go out at that status", () => {
    expect(
      Schema.decodeUnknownExit(Unauthorized)({ ok: false, error: "Invalid token." })._tag
    ).toBe("Failure");
  });

  it("keeps timestamps as the ISO strings the database hands out", () => {
    const patch = moderatedPatch();
    expect(roundTrip(ModeratedPatch, patch)).toEqual(patch);
  });
});

function moderatedPatch() {
  return {
    id: "abcdefghijkl",
    principalId: "acct_1",
    createdByApiTokenId: null,
    title: "Plan",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    expiresAt: "2026-11-27T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    disabledAt: "2026-08-30T00:00:00.000Z",
    disabledReason: "Disabled."
  };
}

describe("PatchyApi", () => {
  it("puts every route under /api with patch naming and no draft on the wire", () => {
    const paths = Object.keys(OpenApi.fromApi(PatchyApi).paths);
    expect(paths).toEqual([
      "/api/tokens/self-service",
      "/api/me",
      "/api/tokens",
      "/api/tokens/{apiTokenId}/revoke",
      "/api/uploads",
      "/api/patches/{patchId}",
      "/api/principals/{principalId}/patches",
      "/api/patches/{patchId}/disable",
      "/api/patches/{patchId}/pin",
      "/api/patches/{patchId}/unpin"
    ]);
    expect(JSON.stringify(OpenApi.fromApi(PatchyApi))).not.toMatch(/draft/i);
  });
});
