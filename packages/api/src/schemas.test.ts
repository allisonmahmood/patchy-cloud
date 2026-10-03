import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  PatchId,
  PatchInventory,
  PrimitiveDetail,
  NotAdditive,
  RuntimeFailure,
  PublishRequest,
  CURRENT_RELEASE,
  MANIFEST_VERSION,
  Manifest,
  limitRefusal
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
  it("preserves refusals from a newer registry without treating them as unknown outcomes", () => {
    const refusal = {
      ok: false as const,
      source: "patchy" as const,
      error: "Company admission is busy.",
      code: "busy" as const,
      scope: "company" as const,
      limitId: "future.admission.capacity",
      value: 12,
      retryAfter: 1
    };
    expect(roundTrip(RuntimeFailure, refusal)).toEqual(refusal);
    expect(Schema.decodeUnknownExit(RuntimeFailure)({ ...refusal, limitId: "" })._tag).toBe(
      "Failure"
    );
  });

  it("includes retry timing only for safely retryable limit refusals", () => {
    expect(limitRefusal("company.connections", 8, 2)).toEqual({
      code: "busy",
      scope: "company",
      limitId: "company.connections",
      value: 8,
      retryAfter: 2
    });
    expect(limitRefusal("company.admission.rate", 100, 2)).toEqual({
      code: "limit_exceeded",
      scope: "company",
      limitId: "company.admission.rate",
      value: 100,
      retryAfter: 2
    });
    expect(limitRefusal("runtime.mutation.deadline", 30000, 2)).toEqual({
      code: "timeout",
      scope: "viewer",
      limitId: "runtime.mutation.deadline",
      value: 30000
    });
  });

  it("distinguishes an absent primitive default from an explicit null default", () => {
    const wire = {
      kind: "table" as const,
      name: "notes",
      description: "Notes keyed by id.",
      shared: true,
      declarable: true,
      schemaRevision: 2,
      columns: [
        { name: "title", kind: "text" as const, optional: false },
        { name: "metadata", kind: "json" as const, optional: false, default: null }
      ],
      indexes: []
    };
    const result = roundTrip(PrimitiveDetail, wire);
    expect(result).toEqual(wire);
    expect(Object.hasOwn(result.columns[0]!, "default")).toBe(false);
    expect(Object.hasOwn(result.columns[1]!, "default")).toBe(true);
  });

  it("preserves cumulative definitions and structured additive refusals on the wire", () => {
    const inventory = {
      schemaRevision: 3,
      tables: {
        notes: {
          description: "Notes keyed by id.",
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

  it("rejects a patch id that is not twelve lowercase alphanumerics", () => {
    for (const bad of ["", "ABCDEFGHIJKL", "abc", 123]) {
      expect(Schema.decodeUnknownExit(PatchId)(bad)._tag).toBe("Failure");
      expect(
        Schema.decodeUnknownExit(PublishRequest)({ ...attempt, html: "x", patchId: bad })._tag
      ).toBe("Failure");
    }
  });

  it("keeps historical release stamps decodable while rejecting malformed definitions", () => {
    const decode = Schema.decodeUnknownExit(Manifest, { onExcessProperty: "error" });
    expect(decode({ ...manifest, release: "0.0.0", manifestVersion: 7 })._tag).toBe("Success");
    for (const tables of [
      { "not-valid": { description: "Records keyed by id.", columns: {}, indexes: {} } },
      { ["a".repeat(64)]: { description: "Records keyed by id.", columns: {}, indexes: {} } },
      {
        notes: {
          description: "Records keyed by id.",
          columns: { count: { kind: "integer", default: 2147483648 } },
          indexes: {}
        }
      },
      {
        notes: {
          description: "Records keyed by id.",
          columns: { data: { kind: "json", default: null } },
          indexes: {}
        }
      },
      {
        notes: {
          description: "Records keyed by id.",
          columns: { title: { kind: "text", default: "nul\u0000text" } },
          indexes: {}
        }
      },
      {
        notes: {
          description: "Records keyed by id.",
          columns: { data: { kind: "json", default: { nested: ["\ud800"] } } },
          indexes: {}
        }
      },
      {
        notes: {
          description: "Records keyed by id.",
          columns: { data: { kind: "json", default: { ["nul\u0000key"]: true } } },
          indexes: {}
        }
      },
      {
        notes: {
          description: "Records keyed by id.",
          columns: { at: { kind: "timestamp", default: "2026-02-30T00:00:00Z" } },
          indexes: {}
        }
      },
      {
        notes: {
          description: "Records keyed by id.",
          columns: {},
          indexes: { inherited: { columns: ["toString"] } }
        }
      },
      {
        notes: {
          description: "Records keyed by id.",
          columns: { id: { kind: "text" } },
          indexes: {}
        }
      },
      {
        notes: {
          description: "Records keyed by id.",
          columns: { title: { kind: "integer", default: "wrong" } },
          indexes: {}
        }
      },
      {
        notes: {
          description: "Records keyed by id.",
          columns: { title: { kind: "text" } },
          indexes: { missing: { columns: ["absent"] } }
        }
      },
      {
        notes: {
          description: "Records keyed by id.",
          columns: { title: { kind: "invalid" } },
          indexes: {}
        }
      }
    ]) {
      expect(decode({ ...manifest, tables })._tag).toBe("Failure");
    }
    expect(
      decode({
        ...manifest,
        files: { images: { description: "Images keyed by file name.", unexpected: true } }
      })._tag
    ).toBe("Failure");
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
            description: "Notes keyed by id.",
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
        files: { images: { description: "Images keyed by file name." } },
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

  it("requires the fixed members declaration for member columns", () => {
    const withMember = {
      ...manifest,
      tables: {
        tasks: {
          description: "Tasks assigned to company users.",
          columns: { owner: { kind: "member" as const, optional: true } },
          indexes: {}
        }
      },
      uses: { members: { kind: "members" as const } }
    };
    const decode = Schema.decodeUnknownExit(Manifest);
    expect(roundTrip(Manifest, withMember)).toEqual(withMember);
    expect(decode({ ...withMember, uses: {} })._tag).toBe("Failure");
    expect(decode({ ...withMember, uses: { people: { kind: "members" } } })._tag).toBe("Failure");
  });

  it.each(["usr_active", null])("refuses member defaults at the publish boundary: %s", (value) => {
    const request = {
      ...attempt,
      html: "<!doctype html><html></html>",
      manifest: {
        ...manifest,
        tier: 1,
        uses: { members: { kind: "members" } },
        tables: {
          tasks: {
            description: "Tasks assigned to company users.",
            columns: { owner: { kind: "member", default: value } },
            indexes: {}
          }
        }
      }
    };
    expect(Schema.decodeUnknownExit(PublishRequest)(request)._tag).toBe("Failure");
  });

  it("round-trips shared declarations and resolved refs while rejecting invalid source names", () => {
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
          description: "Records keyed by id.",
          columns: { contact: { kind: "ref" as const, table: declaration.id } },
          indexes: {}
        }
      },
      files: { documents: { description: "Source documents.", shared: true } },
      uses: {
        contacts: declaration,
        photos: {
          kind: "sharedStore" as const,
          patchId: "abcdefghijkl",
          store: "photos",
          id: "abcdefghijkl/photos",
          revision: 3
        }
      }
    };
    expect(roundTrip(Manifest, consumer)).toEqual(consumer);
    const decode = Schema.decodeUnknownExit(Manifest);
    for (const table of ["contacts/name", "contact_name", "AContact", "a".repeat(64)]) {
      expect(decode({ ...consumer, uses: { contacts: { ...declaration, table } } })._tag).toBe(
        "Failure"
      );
      expect(
        decode({
          ...consumer,
          uses: { photos: { ...consumer.uses.photos, store: table } }
        })._tag
      ).toBe("Failure");
    }
    expect(
      decode({ ...consumer, uses: { contacts: { ...declaration, patchId: "source-name" } } })._tag
    ).toBe("Failure");
  });
});
