import { assert, it } from "@effect/vitest";
import { HandlerDescriptors, Manifest, handlerArgsSchema, handlerValueSchema } from "@patchy/api";
import * as Schema from "effect/Schema";
import { defineConfig, files, t, table } from "./config.js";
import {
  bindServer,
  extractHandlerDescriptors,
  HandlerError,
  InvalidManifestError,
  isHandlerError,
  query
} from "./server.js";
import { MANIFEST_VERSION, RELEASE } from "./release.js";

const config = defineConfig({
  name: "handlers",
  tier: 2,
  tables: {
    leads: table("Leads keyed by id.", {
      name: t.text(),
      note: t.text().optional(),
      active: t.boolean().default(true)
    })
  },
  files: { documents: files("Lead documents keyed by filename.") }
});
const server = bindServer<typeof config>();
const decodeDescriptors = Schema.decodeUnknownSync(HandlerDescriptors);
const decodeManifest = Schema.decodeUnknownSync(Manifest);
const descriptor = {
  kind: "query",
  args: {
    search: { kind: "text", optional: true },
    stage: { kind: "nullable", value: { kind: "enum", values: ["open", "closed"] } }
  },
  result: { kind: "array", element: { kind: "row", table: "leads" } },
  errors: ["not_allowed"]
};

it("extracts serializable descriptors without executing handlers", () => {
  const list = server.query({
    args: { search: t.text().optional(), stage: t.nullable(t.enum(["open", "closed"])) },
    result: t.array(t.row("leads")),
    errors: ["not_allowed"],
    handler: () => {
      throw new Error("Inspection must not execute this callback");
    }
  });
  const upload = server.action({
    args: { file: t.upload() },
    result: t.object({ file: t.nullable(t.fileHandle()) }),
    handler: () => {
      throw new Error("Inspection must not execute this callback");
    }
  });
  const extracted = extractHandlerDescriptors({ leads: { list, upload } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(list)), descriptor);
  assert.deepStrictEqual(extracted["leads.list"], descriptor);
  assert.deepStrictEqual(decodeDescriptors(JSON.parse(JSON.stringify(extracted))), extracted);
  const manifest = decodeManifest({
    manifestVersion: MANIFEST_VERSION,
    release: RELEASE,
    tier: 2,
    tables: JSON.parse(JSON.stringify(config.tables)),
    files: config.files,
    uses: {},
    handlers: extracted,
    sdkImports: ["patchy/server"]
  });
  assert.deepStrictEqual(manifest.handlers, extracted);
});

it("keeps argument omission distinct from null and validates complete row results", () => {
  const handlers = decodeDescriptors({ "leads.list": descriptor });
  const list = handlers["leads.list"]!;
  const manifest = decodeManifest({
    manifestVersion: MANIFEST_VERSION,
    release: RELEASE,
    tier: 2,
    tables: JSON.parse(JSON.stringify(config.tables)),
    files: config.files,
    uses: {},
    handlers
  });
  const decodeArgs = Schema.decodeUnknownSync(handlerArgsSchema(list.args, manifest.tables));
  const decodeResult = Schema.decodeUnknownSync(handlerValueSchema(list.result, manifest.tables));
  assert.deepStrictEqual(decodeArgs({ stage: null }), { stage: null });
  assert.throws(() => decodeArgs({ stage: null, search: null }));
  assert.throws(() => decodeArgs({ search: "name" }));
  const row = {
    id: "lead-id",
    name: "A lead",
    note: null,
    active: true,
    createdAt: "2026-09-28T12:00:00Z",
    updatedAt: "2026-09-28T12:00:00Z"
  };
  assert.deepStrictEqual(decodeResult([row]), [row]);
  assert.throws(() => decodeResult([{ id: "lead-id" }]));
  assert.throws(() => decodeResult([{ ...row, name: 7 }]));
  assert.throws(() => decodeResult([{ ...row, active: undefined }]));
  assert.throws(() => decodeResult([{ ...row, note: undefined }]));
});

it("rejects non-handlers, forged handlers and nested names as invalid_manifest", () => {
  const list = query({ args: {}, result: t.boolean(), handler: () => true });
  for (const modules of [
    { leads: { constant: 1 } },
    { leads: { helper: () => true } },
    { leads: { nested: { list } } },
    { "nested/leads": { list } },
    { "nested.leads": { list } },
    { leads: { "nested.list": list } },
    { leads: { fake: { kind: "query", descriptor } } }
  ]) {
    const error = assert.throws(() => extractHandlerDescriptors(modules), InvalidManifestError);
    assert.propertyVal(error, "code", "invalid_manifest");
    assert.propertyVal(error, "exitCode", 1);
  }
  assert.deepStrictEqual(extractHandlerDescriptors({ empty: {} }), {});
});

it("refuses table modifiers and misplaced handler schemas at builder time", () => {
  for (const field of [
    t.ref("leads"),
    t.text().default("default"),
    t.fileHandle(),
    t.upload(),
    t.object({ nested: t.ref("leads") })
  ]) {
    assert.throws(
      () => query({ args: { field } as never, result: t.boolean(), handler: () => true }),
      InvalidManifestError
    );
  }
  for (const result of [
    t.upload(),
    t.text().optional(),
    t.array(t.text().optional()),
    t.nullable(t.text().optional())
  ]) {
    assert.throws(
      () =>
        query({
          args: {},
          result: result as never,
          handler: () => {
            throw new Error("not invoked");
          }
        }),
      InvalidManifestError
    );
  }
  assert.throws(() => t.enum(["duplicate", "duplicate"]));
});

it("distinguishes handler errors from platform errors and preserves JSON details", () => {
  const error = new HandlerError("duplicate", { name: "Lead", candidates: ["one", "two"] });
  assert.strictEqual(isHandlerError(error, "duplicate"), true);
  assert.strictEqual(isHandlerError(error, "missing"), false);
  assert.strictEqual(
    isHandlerError(
      Object.assign(new Error("duplicate"), { source: "patchy", code: "duplicate" }),
      "duplicate"
    ),
    false
  );
  assert.strictEqual(isHandlerError(new Error("duplicate"), "duplicate"), false);
  assert.deepStrictEqual(error.details, { name: "Lead", candidates: ["one", "two"] });
});
