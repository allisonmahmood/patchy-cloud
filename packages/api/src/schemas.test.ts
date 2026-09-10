import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  Identity,
  InvalidHtml,
  LoggedOut,
  Ok,
  PatchId,
  PatchQuotaExceeded,
  RateLimited,
  Shared,
  ShareRequest,
  Unauthorized,
  PublishCreated,
  PublishRequest,
  CURRENT_RELEASE,
  MANIFEST_VERSION,
  Manifest
} from "./index.js";

/** Decoding then encoding a wire document hands back the same document. */
const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, wire: S["Encoded"]) =>
  Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(wire));

const manifest = {
  manifestVersion: MANIFEST_VERSION,
  release: CURRENT_RELEASE,
  tier: 0 as const,
  tables: {},
  files: {},
  uses: {}
};
const attempt = { manifest, publishKey: "test-key", metadata: {} };
describe("wire schemas", () => {
  it("round-trips an upload request with every optional field present or absent", () => {
    const full = {
      ...attempt,
      html: "<!doctype html><html></html>",
      patchId: "abcdefghijkl",
      scope: "public" as const,
      metadata: { repoOrg: "patchy", repoName: null, cliVersion: "0.0.1" }
    };
    expect(roundTrip(PublishRequest, full)).toEqual(full);
    expect(roundTrip(PublishRequest, { ...attempt, html: "<html></html>" })).toEqual({
      ...attempt,
      html: "<html></html>"
    });
  });

  it("rejects a patch id that is not twelve lowercase alphanumerics", () => {
    for (const bad of ["", "ABCDEFGHIJKL", "abc", 123]) {
      expect(Schema.decodeUnknownExit(PatchId)(bad)._tag).toBe("Failure");
      expect(
        Schema.decodeUnknownExit(PublishRequest)({ ...attempt, html: "x", patchId: bad })._tag
      ).toBe("Failure");
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
      tier: 0,
      schemaRevision: 0,
      provisioned: { tables: [], columns: [], indexes: [], stores: [] },
      unused: { tables: [], columns: [], indexes: [], stores: [] },
      warnings: ["Missing <title>."]
    };
    expect(roundTrip(PublishCreated, upload)).toEqual(upload);

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
  it("keeps historical release stamps decodable while rejecting malformed definitions", () => {
    const decode = Schema.decodeUnknownExit(Manifest, { onExcessProperty: "error" });
    expect(decode({ ...manifest, release: "0.0.0", manifestVersion: 7 })._tag).toBe("Success");
    for (const tables of [
      { "not-valid": { columns: {}, indexes: {} } },
      { notes: { columns: { id: { kind: "text" } }, indexes: {} } },
      { notes: { columns: { title: { kind: "integer", default: "wrong" } }, indexes: {} } },
      {
        notes: {
          columns: { title: { kind: "text" } },
          indexes: { missing: { columns: ["absent"] } }
        }
      },
      { notes: { columns: { title: { kind: "invalid" } }, indexes: {} } }
    ]) {
      expect(decode({ ...manifest, tables })._tag).toBe("Failure");
    }
    expect(decode({ ...manifest, files: { images: { unexpected: true } } })._tag).toBe("Failure");
    expect(
      decode({
        ...manifest,
        uses: { sales: { kind: "postgres", handle: "warehouse" } }
      })._tag
    ).toBe("Failure");
    expect(
      decode({
        ...manifest,
        tier: 1,
        tables: {
          notes: {
            columns: {
              title: { kind: "text", default: "Untitled" },
              body: { kind: "text", optional: true },
              count: { kind: "integer", default: 0 },
              score: { kind: "number", default: 1.5 },
              enabled: { kind: "boolean", default: true },
              at: { kind: "timestamp", default: "now" },
              extra: { kind: "json", default: {} },
              parent: { kind: "ref", table: "notes", optional: true }
            },
            indexes: { byTitle: { columns: ["title"], unique: true } },
            shared: true
          }
        },
        files: { images: {} },
        uses: {
          sales: { kind: "postgres", handle: "warehouse", id: "conn_1", revision: 1 },
          shared: {
            kind: "sharedTable",
            patchId: "abcdefghijkl",
            table: "notes",
            id: "table_1",
            revision: 2
          }
        }
      })._tag
    ).toBe("Success");
  });
});
