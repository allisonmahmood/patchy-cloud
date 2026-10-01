// @effect-diagnostics preferSchemaOverJson:off -- exercise the guest's raw HTTP JSON request and response boundary.
import { assert, it } from "@effect/vitest";
import { limitRefusal } from "@patchy/api";
import type * as GuestProtocol from "@patchy/api/guest";
import { PatchyError } from "./clientError.js";
import { t, type Config, type FileStoreDefinition, type Json } from "./config.js";
import { createGuest } from "./guest.js";
import { HandlerError } from "./handlerError.js";
import { bindServer } from "./server.js";
import type { ReadFileStore } from "./client.js";

type Key = { readonly id: string };
interface Relation {
  get(key: Key): Promise<Json>;
  getMany(keys: readonly Key[]): Promise<readonly Json[]>;
  list(): Promise<Json>;
}
interface Connections {
  readonly db: {
    query(
      sql: string,
      params: readonly Json[],
      shape: Readonly<Record<string, object>>
    ): Promise<Json>;
    readonly accounts: Relation;
    readonly audit: {
      readonly entries: Relation;
      readonly get: Relation;
      readonly getMany: Relation;
      readonly list: Relation;
    };
  };
}
const server = bindServer<Config, Record<never, never>, Record<never, never>, Connections>();
const fileServer = bindServer<
  Config & { files: { documents: FileStoreDefinition } },
  Record<never, never>,
  { assets: ReadFileStore }
>();
const viewer = {
  user: { id: "usr_test", name: "Reader", email: "reader@example.test" },
  company: { id: "com_test", name: "Example", handle: "example" },
  admin: false
};
const invoke = async (
  definition: unknown,
  call: (operation: unknown) => Promise<unknown>,
  sharedStores: readonly string[] = []
) => {
  const guest = createGuest({ demo: { run: definition } }, sharedStores);
  const response = await guest.fetch(
    new Request("https://guest/invoke", {
      method: "POST",
      body: JSON.stringify({
        wire: 1,
        type: "invoke",
        handler: "demo.run",
        args: {},
        viewer
      })
    }),
    undefined,
    { props: { invocationId: "inv_test", callbacks: { call } } }
  );
  return (await response.json()) as unknown;
};

it.each([
  { name: "a reference builder", column: t.ref("accounts") },
  { name: "a plain reference", column: { kind: "ref", table: "accounts" } },
  { name: "a member builder", column: t.member() },
  { name: "a plain member", column: { kind: "member" } },
  { name: "a defaulted builder", column: t.text().default("default") },
  { name: "a plain default", column: { kind: "text", default: "default" } },
  { name: "an extra plain field", column: { kind: "text", table: "accounts" } }
])("returns invalid_request for $name without calling the host", async ({ column }) => {
  let callbacks = 0;
  const definition = server.action({
    args: {},
    result: t.json(),
    handler: (ctx) => ctx.connections.db.query("select value", [], { value: column })
  });
  const reply = await invoke(definition, async () => {
    callbacks++;
    throw new Error("Local validation must finish before any callback.");
  });
  assert.deepInclude(reply, { ok: false, source: "patchy", code: "invalid_request", details: {} });
  assert.strictEqual(callbacks, 0);
});

it.each([
  new PatchyError("invalid_request", "Handler-created platform refusal.", {}),
  Object.assign(new Error("Platform-looking error."), { source: "patchy", code: "invalid_request" })
])("does not classify an arbitrary handler error as a local SDK refusal", async (error) => {
  const definition = server.action({
    args: {},
    result: t.json(),
    handler: () => {
      throw error;
    }
  });
  const reply = await invoke(definition, async () => {
    throw new Error("This handler does not call the host.");
  });
  assert.deepInclude(reply, { ok: false, source: "patchy", code: "handler_failed" });
});

it.each([{ errors: undefined }, { errors: ["declared_refusal"] }])(
  "logs an undeclared HandlerError privately when declared errors are $errors",
  async ({ errors }) => {
    const error = new HandlerError("undeclared_refusal", { private: "details" });
    error.message = "Private failure message.";
    error.stack = "HandlerError: Private failure message.\n    at demo.run";
    const definition = server.action({
      args: {},
      result: t.json(),
      ...(errors === undefined ? {} : { errors }),
      handler: () => {
        throw error;
      }
    });
    const logs: unknown[] = [];
    const reply = await invoke(definition, async (operation) => {
      logs.push(operation);
      return { ok: true, value: null };
    });
    assert.deepStrictEqual(logs, [
      { op: "log", args: { message: error.message, details: { stack: error.stack } } }
    ]);
    assert.deepStrictEqual(reply, {
      ok: false,
      source: "patchy",
      code: "handler_failed",
      error: "The handler failed."
    });
  }
);

it("returns a declared business refusal without logging its cause", async () => {
  const error = new HandlerError("declared_refusal", { reason: "unavailable" });
  error.message = "Private business error message.";
  const definition = server.action({
    args: {},
    result: t.json(),
    errors: ["declared_refusal"],
    handler: () => {
      throw error;
    }
  });
  const operations: unknown[] = [];
  const reply = await invoke(definition, async (operation) => {
    operations.push(operation);
    return { ok: true, value: null };
  });
  assert.deepStrictEqual(operations, []);
  assert.deepStrictEqual(reply, {
    ok: false,
    source: "handler",
    code: "declared_refusal",
    details: { reason: "unavailable" }
  });
});

it.each(["\u754c", "\ud83d\ude80", "\u0000"])(
  "retains bounded private exception diagnostics for oversized %j text",
  async (character) => {
    const error = new Error(`Private message: ${character.repeat(40_000)}`);
    error.stack = `Private stack: ${character.repeat(40_000)}`;
    const definition = server.action({
      args: {},
      result: t.json(),
      handler: () => {
        throw error;
      }
    });
    const logs: GuestProtocol.Callback["args"][] = [];
    const reply = await invoke(definition, async (operation) => {
      const { op, args } = operation as GuestProtocol.Callback;
      assert.strictEqual(op, "log");
      const bytes = new TextEncoder().encode(JSON.stringify(args)).byteLength;
      if (bytes > limitRefusal("tier2.log.bytes").value)
        return {
          ok: false,
          source: "patchy",
          error: "Log budget exceeded.",
          ...limitRefusal("tier2.log.bytes")
        };
      logs.push(args);
      return { ok: true, value: null };
    });
    assert.strictEqual(logs.length, 1);
    const diagnostic = logs[0]!;
    assert.isString(diagnostic.message);
    assert.match(diagnostic.message as string, /^Private message: /);
    assert.include(diagnostic.message as string, character);
    assert.isTrue((diagnostic.message as string).isWellFormed());
    assert.notStrictEqual(diagnostic.message, error.message);
    const { stack } = diagnostic.details as { stack: string };
    assert.match(stack, /^Private stack: /);
    assert.include(stack, character);
    assert.isTrue(stack.isWellFormed());
    assert.notStrictEqual(stack, error.stack);
    assert.deepStrictEqual(reply, {
      ok: false,
      source: "patchy",
      code: "handler_failed",
      error: "The handler failed."
    });
  }
);

it("folds builder and plain query columns into the same wire shape", async () => {
  const definition = server.action({
    args: {},
    result: t.json(),
    handler: (ctx) =>
      ctx.connections.db.query("select name, count, enabled", [], {
        name: t.text(),
        count: t.integer().optional(),
        enabled: { kind: "boolean", optional: true }
      })
  });
  const rows = [{ name: "Ada", count: null, enabled: null }];
  const reply = await invoke(definition, async (operation) => {
    assert.deepStrictEqual(operation, {
      op: "postgres.query",
      args: {
        connection: "db",
        sql: "select name, count, enabled",
        params: [],
        shape: {
          name: { kind: "text", optional: false },
          count: { kind: "integer", optional: true },
          enabled: { kind: "boolean", optional: true }
        }
      }
    });
    return { ok: true, value: { ok: true, rows } };
  });
  assert.deepStrictEqual(reply, { ok: true, value: { ok: true, rows } });
});

it.each([
  { schema: "public", name: "accounts" },
  { schema: "audit", name: "entries" },
  { schema: "audit", name: "get" },
  { schema: "audit", name: "getMany" },
  { schema: "audit", name: "list" }
] as const)("supports list, get and getMany on $schema.$name", async ({ schema, name }) => {
  const definition = server.action({
    args: {},
    result: t.json(),
    handler: async (ctx) => {
      const relation =
        name === "accounts" ? ctx.connections.db.accounts : ctx.connections.db.audit[name];
      return {
        listed: await relation.list(),
        found: await relation.get({ id: "one" }),
        missing: await relation.get({ id: "missing" }),
        selected: await relation.getMany([{ id: "two" }, { id: "missing" }, { id: "one" }])
      };
    }
  });
  const rows = [
    { id: "one", value: "First" },
    { id: "two", value: "Second" }
  ];
  const reply = await invoke(definition, async (operation) => {
    const { op, args } = operation as GuestProtocol.Callback;
    assert.strictEqual(args.connection, "db");
    assert.deepStrictEqual(args.relation, { schema, name });
    if (op === "postgres.list") return { ok: true, value: { ok: true, rows, cursor: null } };
    if (op === "postgres.get") {
      const key = args.key as Key;
      return { ok: true, value: { ok: true, rows: rows.filter((row) => row.id === key.id) } };
    }
    assert.strictEqual(op, "postgres.getMany");
    const keys = args.keys as readonly Key[];
    return {
      ok: true,
      value: { ok: true, rows: keys.map((key) => rows.find((row) => row.id === key.id) ?? null) }
    };
  });
  assert.deepStrictEqual(reply, {
    ok: true,
    value: {
      listed: { ok: true, rows, cursor: null },
      found: rows[0],
      missing: null,
      selected: [rows[1], null, rows[0]]
    }
  });
});

it("joins a pending log callback and returns its refusal instead of dropping it", async () => {
  const started = Promise.withResolvers<void>();
  const callback = Promise.withResolvers<unknown>();
  const definition = server.action({
    args: {},
    result: t.text(),
    handler: (ctx) => {
      ctx.log("Finished work.");
      return "result";
    }
  });
  let returned = false;
  const reply = invoke(definition, () => {
    started.resolve();
    return callback.promise;
  }).then((value) => {
    returned = true;
    return value;
  });
  await started.promise;
  await Promise.resolve();
  assert.strictEqual(returned, false);
  callback.resolve({
    ok: false,
    source: "patchy",
    code: "source_unavailable",
    error: "The callback service is unavailable."
  });
  assert.deepInclude(await reply, { ok: false, source: "patchy", code: "source_unavailable" });
});

it.each([
  {
    name: "a typed-array slice",
    input: new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4),
    contentType: "application/octet-stream"
  },
  {
    name: "an ArrayBuffer",
    input: new Uint8Array([1, 2, 3]).buffer,
    contentType: "application/octet-stream"
  },
  {
    name: "a Blob",
    input: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    contentType: "image/png"
  }
])(
  "stores and reads only the plain bytes of $name before deleting them",
  async ({ input, contentType }) => {
    const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
    const definition = fileServer.action({
      args: {},
      result: t.object({
        bytes: t.array(t.integer()),
        contentType: t.text(),
        size: t.integer(),
        deleted: t.boolean()
      }),
      handler: async (ctx) => {
        await ctx.files.documents.put("report.bin", input);
        const bytes = await ctx.files.documents.get("report.bin");
        const metadata = await ctx.files.documents.stat("report.bin");
        await ctx.files.documents.delete("report.bin");
        return {
          bytes: [...bytes],
          contentType: metadata!.contentType,
          size: metadata!.size,
          deleted: (await ctx.files.documents.stat("report.bin")) === null
        };
      }
    });
    const reply = await invoke(definition, async (operation) => {
      const { op, args, body } = operation as GuestProtocol.Callback;
      const name = args.name as string;
      if (op === "files.put") {
        objects.set(name, { bytes: body!.bytes.slice(), contentType: body!.contentType });
        return { ok: true, value: null };
      }
      if (op === "files.delete") {
        objects.delete(name);
        return { ok: true, value: null };
      }
      const object = objects.get(name);
      if (op === "files.stat")
        return {
          ok: true,
          value: object
            ? {
                name,
                size: object.bytes.byteLength,
                contentType: object.contentType,
                updatedAt: "2026-09-29T00:00:00.000Z"
              }
            : null
        };
      if (op === "files.get" && object) return { ok: true, body: object };
      throw new Error(`Unexpected file callback: ${op}`);
    });
    assert.deepStrictEqual(reply, {
      ok: true,
      value: { bytes: [1, 2, 3], contentType, size: 3, deleted: true }
    });
    assert.strictEqual(objects.size, 0);
  }
);

it.each(["owned", "shared"] as const)(
  "preserves a %s file refusal instead of reporting malformed bytes",
  async (kind) => {
    const definition = fileServer.action({
      args: {},
      result: t.integer(),
      handler: async (ctx) =>
        (await (kind === "shared" ? ctx.shared.assets : ctx.files.documents).get("report.bin"))
          .byteLength
    });
    const reply = await invoke(
      definition,
      async () => ({
        ok: false,
        source: "patchy",
        code: "access_denied",
        error: "You no longer have access to this file store."
      }),
      ["assets"]
    );
    assert.deepStrictEqual(reply, {
      ok: false,
      source: "patchy",
      code: "access_denied",
      error: "You no longer have access to this file store."
    });
  }
);
