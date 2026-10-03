import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  CURRENT_RELEASE,
  GenerationManifest,
  HandlerDescriptor,
  HandlerDescriptors,
  HandlerFailure,
  MANIFEST_VERSION,
  Manifest,
  RuntimeReply,
  RuntimeRequest,
  handlerArgsSchema,
  handlerValueSchema,
  HandlerSchema
} from "./index.js";
import { canonicalArgs } from "./canonicalArgs.js";

const tables = {
  leads: {
    description: "Sales leads.",
    columns: {
      name: { kind: "text" as const },
      score: { kind: "integer" as const },
      amount: { kind: "number" as const },
      active: { kind: "boolean" as const },
      visitedAt: { kind: "timestamp" as const },
      metadata: { kind: "json" as const },
      parent: { kind: "ref" as const, table: "leads", optional: true },
      priority: { kind: "integer" as const, default: 1 }
    },
    indexes: {}
  }
};
const manifest = {
  manifestVersion: MANIFEST_VERSION,
  release: CURRENT_RELEASE,
  tier: 2 as const,
  tables,
  files: {},
  uses: {}
};
const row = {
  id: "row_1",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  name: "A lead",
  score: 7,
  amount: 3.5,
  active: true,
  visitedAt: "2026-09-28T12:03:45.123456Z",
  metadata: { labels: ["new"] },
  parent: null,
  priority: 1
};
const query = { kind: "query" as const, args: {}, result: { kind: "boolean" as const } };
const decodeDescriptor = Schema.decodeUnknownExit(HandlerDescriptor);
const decodeManifest = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" });
const encodeManifest = Schema.encodeSync(Manifest);
const decodeRow = Schema.decodeUnknownExit(
  handlerValueSchema({ kind: "row", table: "leads" }, tables),
  {
    onExcessProperty: "error"
  }
);

describe("handler descriptors", () => {
  it("round-trips all handler kinds and recursive descriptors through the manifest", () => {
    const wire = {
      ...manifest,
      sdkImports: ["patchy/server", "patchy/csv"],
      handlers: {
        "leads.list": {
          kind: "query" as const,
          args: {
            search: { kind: "text" as const, optional: true as const },
            count: { kind: "integer" as const },
            amount: { kind: "number" as const },
            active: { kind: "boolean" as const },
            since: { kind: "timestamp" as const },
            metadata: { kind: "json" as const },
            state: { kind: "enum" as const, values: ["open", "closed"] }
          },
          result: { kind: "array" as const, element: { kind: "row" as const, table: "leads" } }
        },
        "leads.update": {
          kind: "mutation" as const,
          args: { row: { kind: "row" as const, table: "leads" } },
          result: { kind: "nullable" as const, value: { kind: "row" as const, table: "leads" } },
          errors: ["not_manager"]
        },
        "leads.attach": {
          kind: "action" as const,
          args: {
            attachment: { kind: "object" as const, fields: { upload: { kind: "upload" as const } } }
          },
          result: { kind: "object" as const, fields: { handle: { kind: "fileHandle" as const } } }
        }
      }
    };
    expect(encodeManifest(decodeManifest(wire))).toEqual(wire);
  });

  it("rejects table-only modifiers and misplaced capabilities at every nesting depth", () => {
    for (const args of [
      { value: { kind: "text", default: "hidden default" } },
      { value: { kind: "text", optional: true, default: undefined } },
      { value: { kind: "object", fields: { child: { kind: "text", default: null } } } },
      { value: { kind: "array", element: { kind: "text", default: "hidden" } } },
      { value: { kind: "nullable", value: { kind: "text", default: "hidden" } } },
      { value: { kind: "ref", table: "leads" } },
      { value: { kind: "array", element: { kind: "fileHandle" } } },
      { value: { kind: "object", fields: { upload: { kind: "upload" } } } },
      { value: { kind: "array", element: { kind: "text", optional: true } } },
      { value: { kind: "nullable", value: { kind: "text", optional: true } } }
    ]) {
      expect(decodeDescriptor({ ...query, args })._tag).toBe("Failure");
    }
    for (const kind of ["query", "mutation"]) {
      expect(decodeDescriptor({ ...query, kind, args: { upload: { kind: "upload" } } })._tag).toBe(
        "Failure"
      );
    }
    for (const result of [
      { kind: "upload" },
      { kind: "object", fields: { upload: { kind: "upload" } } },
      { kind: "text", optional: true },
      { kind: "enum", values: [] },
      { kind: "enum", values: ["same", "same"] }
    ]) {
      expect(decodeDescriptor({ ...query, kind: "action", result })._tag).toBe("Failure");
    }
  });

  it("rejects nested defaults in canonical JSON codecs", () => {
    const decode = Schema.decodeUnknownExit(Schema.toCodecJson(HandlerSchema));
    for (const defaultValue of [undefined, null, "hidden"]) {
      expect(
        decode({
          kind: "array",
          element: {
            kind: "object",
            fields: { value: { kind: "text", optional: true, default: defaultValue } }
          }
        })._tag
      ).toBe("Failure");
    }
  });

  it("rejects handler paths deeper than module.export and unknown row tables", () => {
    const decodeHandlers = Schema.decodeUnknownExit(HandlerDescriptors);
    for (const name of [
      "list",
      "leads.list.extra",
      "nested/leads.list",
      "../leads.list",
      ".list"
    ]) {
      expect(decodeHandlers({ [name]: query })._tag).toBe("Failure");
    }
    for (const schema of [Manifest, GenerationManifest]) {
      const decode = Schema.decodeUnknownExit(schema);
      expect(
        decode({
          ...manifest,
          handlers: {
            "leads.list": {
              ...query,
              result: { kind: "array", element: { kind: "row", table: "missing" } }
            }
          }
        })._tag
      ).toBe("Failure");
    }
  });

  it("distinguishes omitted argument fields from explicit nullable values", () => {
    const fields: Record<string, HandlerSchema> = {
      search: { kind: "text", optional: true },
      parent: { kind: "nullable", value: { kind: "text" } },
      state: { kind: "enum", values: ["open", "closed"] }
    };
    const decode = Schema.decodeUnknownExit(handlerArgsSchema(fields, tables));
    expect(decode({ parent: null, state: "open" })._tag).toBe("Success");
    expect(decode({ search: null, parent: null, state: "open" })._tag).toBe("Failure");
    expect(decode({ state: "open" })._tag).toBe("Failure");
    expect(decode({ parent: null, state: "removed" })._tag).toBe("Failure");
  });

  it("requires every row column and system field, including defaulted and nullable columns", () => {
    expect(decodeRow(row)._tag).toBe("Success");
    for (const field of Object.keys(row)) {
      const incomplete: Record<string, unknown> = { ...row };
      delete incomplete[field];
      expect(decodeRow(incomplete)._tag).toBe("Failure");
    }
    for (const invalid of [
      { id: "" },
      { createdAt: "yesterday" },
      { updatedAt: null },
      { name: 1 },
      { score: 1.5 },
      { score: 2147483648 },
      { amount: Infinity },
      { active: "true" },
      { visitedAt: "2026-02-30T00:00:00Z" },
      { metadata: undefined },
      { metadata: null },
      { parent: 42 },
      { priority: null }
    ]) {
      expect(decodeRow({ ...row, ...invalid })._tag).toBe("Failure");
    }
    expect(decodeRow({ id: "row_1" })._tag).toBe("Failure");
    expect(() => handlerValueSchema({ kind: "row", table: "missing" }, tables)).toThrow(TypeError);
  });

  it("validates nested upload objects and rejects legacy tokens or invalid metadata", () => {
    const schema = handlerArgsSchema(
      {
        attachments: {
          kind: "array",
          element: { kind: "object", fields: { upload: { kind: "upload" } } }
        }
      },
      tables
    );
    const upload = { token: "opaque-stage-token", size: 123, contentType: "image/png" };
    const args = { attachments: [{ upload }] };
    expect(Schema.decodeUnknownSync(schema)(args)).toEqual(args);
    for (const invalid of [
      upload.token,
      { ...upload, token: "" },
      { ...upload, size: -1 },
      { ...upload, size: 1.5 },
      { ...upload, contentType: "text/plain\r\nx-secret: forged" },
      { size: upload.size, contentType: upload.contentType }
    ]) {
      expect(Schema.decodeUnknownExit(schema)({ attachments: [{ upload: invalid }] })._tag).toBe(
        "Failure"
      );
    }
  });

  it("round-trips calls and preserves handler errors separately from Patchy refusals", () => {
    const call = {
      op: "server.call" as const,
      args: { handler: "leads.update", args: { id: "row_1" }, mutationKey: "key" }
    };
    expect(
      Schema.encodeSync(RuntimeRequest)(Schema.decodeUnknownSync(RuntimeRequest)(call))
    ).toEqual(call);
    const handlerError = {
      ok: false as const,
      source: "handler" as const,
      code: "not_manager",
      details: { role: "member" }
    };
    expect(
      Schema.encodeSync(RuntimeReply)(Schema.decodeUnknownSync(RuntimeReply)(handlerError))
    ).toEqual(handlerError);
    expect(
      Schema.decodeUnknownExit(HandlerFailure)({ ...handlerError, source: "patchy" })._tag
    ).toBe("Failure");
    const refusal = { ok: false, source: "patchy", code: "handler_failed", error: "Refused." };
    expect(
      Schema.encodeSync(RuntimeReply)(Schema.decodeUnknownSync(RuntimeReply)(refusal))
    ).toEqual(refusal);
    expect(Schema.decodeUnknownExit(RuntimeReply)({ ...refusal, source: undefined })._tag).toBe(
      "Failure"
    );
  });
});

describe("canonical query arguments", () => {
  it("shares identity for recursively reordered objects without reordering arrays", () => {
    expect(canonicalArgs({ b: 1, a: { y: 2, x: [3, 4] } })).toBe(
      canonicalArgs({ a: { x: [3, 4], y: 2 }, b: 1 })
    );
    expect(canonicalArgs({ values: [1, 2] })).not.toBe(canonicalArgs({ values: [2, 1] }));
    expect(canonicalArgs({ value: null })).not.toBe(canonicalArgs({}));
    expect(canonicalArgs({ text: 'a"b\\c', value: -0 })).toBe('{"text":"a\\"b\\\\c","value":0}');
  });

  it("omits undefined object fields recursively but keeps null distinct", () => {
    expect(canonicalArgs({ stage: null, search: undefined })).toBe(canonicalArgs({ stage: null }));
    expect(canonicalArgs({ filter: { search: undefined }, rows: [{ name: undefined }] })).toBe(
      canonicalArgs({ filter: {}, rows: [{}] })
    );
    expect(canonicalArgs({ search: undefined })).not.toBe(canonicalArgs({ search: null }));
  });

  it("refuses values that cannot have an unambiguous JSON subscription identity", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [undefined, NaN, Infinity, 1n, new Date(), [undefined], cycle]) {
      expect(() => canonicalArgs(value)).toThrow(TypeError);
    }
  });
});
