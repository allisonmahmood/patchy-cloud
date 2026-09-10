import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  Identity,
  InvalidHtml,
  LoggedOut,
  Ok,
  PatchId,
  PatchQuotaExceeded,
  PatchInventory,
  NotAdditive,
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
  it("preserves cumulative definitions and structured additive refusals on the wire", () => {
    const inventory = {
      schemaRevision: 3,
      tables: {
        notes: {
          columns: {
            parent: { kind: "ref" as const, table: "notes", optional: true },
            priority: { kind: "integer" as const, default: 1 }
          },
          indexes: { byPriority: { columns: ["priority"], unique: false } },
          shared: true
        }
      },
      files: {}
    };
    expect(roundTrip(PatchInventory, inventory)).toEqual(inventory);
    const refusal = {
      ok: false as const,
      code: "not_additive" as const,
      error: "notes.priority: changing kind; add a new column.",
      changes: [{ object: "notes.priority", change: "changing kind", fix: "add a new column" }]
    };
    expect(roundTrip(NotAdditive, refusal)).toEqual(refusal);
    expect(
      Schema.decodeUnknownExit(PatchInventory)({ ...inventory, schemaRevision: -1 })._tag
    ).toBe("Failure");
  });

  it("round-trips a publish request with every optional field present or absent", () => {
    const full = {
      ...attempt,
      html: "<!doctype html><html></html>",
      patchId: "abcdefghijkl",
      scope: "public" as const,
      metadata: { filename: "plan.html", repoOrg: "patchy", repoName: null, cliVersion: "0.0.1" }
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
    const published = {
      ok: true as const,
      patchId: "abcdefghijkl",
      versionId: "ver_x",
      versionNumber: 2,
      title: "Plan",
      name: "plan",
      address: "https://pages.example.com/example/plan",
      publicUrl: "https://pages.example.com/example/plan",
      scope: "company" as const,
      tier: 0,
      schemaRevision: 0,
      provisioned: { tables: [], columns: [], indexes: [], stores: [] },
      unused: { tables: [], columns: [], indexes: [], stores: [] },
      warnings: ["Missing <title>."]
    };
    expect(roundTrip(PublishCreated, published)).toEqual(published);

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
          publicUrl: "https://pages.example.com/example/plan"
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
      { ["a".repeat(64)]: { columns: {}, indexes: {} } },
      { notes: { columns: { count: { kind: "integer", default: 2147483648 } }, indexes: {} } },
      { notes: { columns: { data: { kind: "json", default: null } }, indexes: {} } },
      { notes: { columns: { title: { kind: "text", default: "nul\u0000text" } }, indexes: {} } },
      {
        notes: { columns: { data: { kind: "json", default: { nested: ["\ud800"] } } }, indexes: {} }
      },
      {
        notes: {
          columns: { data: { kind: "json", default: { ["nul\u0000key"]: true } } },
          indexes: {}
        }
      },
      {
        notes: {
          columns: { at: { kind: "timestamp", default: "2026-02-30T00:00:00Z" } },
          indexes: {}
        }
      },
      { notes: { columns: {}, indexes: { inherited: { columns: ["toString"] } } } },
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
            id: "abcdefghijkl/notes",
            revision: 2
          }
        }
      })._tag
    ).toBe("Success");
  });

  it("round-trips shared declarations and resolved refs while rejecting invalid source table names", () => {
    const declaration = {
      kind: "sharedTable" as const,
      patchId: "abcdefghijkl",
      table: "contacts",
      id: "abcdefghijkl/contacts",
      revision: 3
    };
    const consumer = {
      ...manifest,
      tables: {
        notes: {
          columns: { contact: { kind: "ref" as const, table: declaration.id } },
          indexes: {}
        }
      },
      uses: { contacts: declaration }
    };
    expect(roundTrip(Manifest, consumer)).toEqual(consumer);
    const decode = Schema.decodeUnknownExit(Manifest);
    for (const table of ["contacts/name", "contact_name", "AContact", "a".repeat(64)]) {
      expect(decode({ ...consumer, uses: { contacts: { ...declaration, table } } })._tag).toBe(
        "Failure"
      );
    }
    expect(
      decode({ ...consumer, uses: { contacts: { ...declaration, patchId: "source-name" } } })._tag
    ).toBe("Failure");
  });
});
