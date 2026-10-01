// @effect-diagnostics preferSchemaOverJson:off -- exercise the guest's raw HTTP JSON request and response boundary.
import { assert, it } from "@effect/vitest";
import type * as GuestProtocol from "@patchy/api/guest";
import { PatchyError } from "./clientError.js";
import { t, type Config, type Json } from "./config.js";
import { createGuest } from "./guest.js";
import { bindServer } from "./server.js";

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
const viewer = {
  user: { id: "usr_test", name: "Reader", email: "reader@example.test" },
  company: { id: "com_test", name: "Example", handle: "example" },
  admin: false
};
const invoke = async (definition: unknown, call: (operation: unknown) => Promise<unknown>) => {
  const guest = createGuest({ demo: { run: definition } });
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
