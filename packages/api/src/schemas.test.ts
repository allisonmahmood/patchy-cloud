import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import {
  Identity,
  InvalidHtml,
  LoggedOut,
  Ok,
  PatchId,
  PatchQuotaExceeded,
  PatchyApi,
  RateLimited,
  Shared,
  ShareRequest,
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
      scope: "public" as const,
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
      scope: "company" as const,
      warnings: ["Missing <title>."]
    };
    expect(roundTrip(UploadCreated, upload)).toEqual(upload);

    const identity = {
      user: { id: "usr_1", email: "dev@example.com", name: "Dev" },
      company: { id: "cmp_1", handle: "example", name: "Example" },
      role: "member" as const,
      machine: { id: "tok_1", name: "CLI Machine" }
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
    const cases: ReadonlyArray<[Schema.Codec<unknown, unknown>, unknown]> = [
      [ShareRequest, { scope: "public" }],
      [
        Shared,
        {
          ok: true,
          patchId: "abcdefghijkl",
          scope: "company",
          publicUrl: "https://pages.example.com/d/abcdefghijkl"
        }
      ],
      [LoggedOut, { ok: true, alreadyRevoked: false }],
      [Ok, { ok: true }],
      [Unauthorized, { ok: false, error: "Missing or invalid API token." }]
    ];
    for (const [schema, wire] of cases) expect(roundTrip(schema, wire)).toEqual(wire);
  });
});

describe("PatchyApi", () => {
  it("puts every route under /api with patch naming and no draft on the wire", () => {
    const paths = Object.keys(OpenApi.fromApi(PatchyApi).paths);
    expect(paths).toEqual([
      "/api/me",
      "/api/logout",
      "/api/uploads",
      "/api/patches/{patchId}/share",
      "/api/patches/{patchId}"
    ]);
    expect(JSON.stringify(OpenApi.fromApi(PatchyApi))).not.toMatch(/draft/i);
  });
});
