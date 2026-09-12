import { resolveObjectURL } from "node:buffer";
import { expect, it } from "vitest";
import { build } from "esbuild";
import * as ts from "typescript";
import {
  createClient,
  createSharedTable,
  errorCodes,
  decodeError,
  type Transport
} from "./client.js";
import { defineConfig, files, table, t } from "./config.js";
import { generateClient } from "../../sdk/src/generateClient.js";
import { RuntimeCode, runtimeOperations } from "../../api/src/runtime.js";

const unusedRoute: Transport["route"] = {
  get: async () => {
    throw new Error("This test does not implement routes.");
  },
  set: async () => {
    throw new Error("This test does not implement routes.");
  },
  subscribe: () => {
    throw new Error("This test does not implement routes.");
  }
};

it("keeps the lightweight error decoder exactly on the authoritative runtime code contract", () => {
  expect(Object.keys(errorCodes).sort()).toEqual([...RuntimeCode.literals].sort());
  expect(decodeError({ code: "invented_code", message: "no" })).toBeUndefined();
});

it("caches blob URLs until replacement/deletion and revokes them on close", async () => {
  const config = defineConfig({
    name: "notes",
    tier: 1,
    tables: { notes: table({ title: t.text() }) },
    files: { images: files() }
  });
  const calls: string[] = [];
  let bytes = new Uint8Array([1]);
  const transport: Transport = {
    route: unusedRoute,
    call: async (op, _args, input) => {
      calls.push(op);
      if (op === "files.get") return { bytes, contentType: "image/png" };
      if (op === "files.put") bytes = new Uint8Array(input!);
      return null;
    },
    close() {}
  };
  const client = createClient<typeof config>(config, { transport, shared: {}, connections: {} });
  const first = await client.files.images.url("a");
  expect(await client.files.images.url("a")).toBe(first);
  expect(calls).toEqual(["files.get"]);
  expect(new Uint8Array(await resolveObjectURL(first)!.arrayBuffer())).toEqual(new Uint8Array([1]));
  await client.files.images.put("a", new Uint8Array([2]), { contentType: "image/png" });
  expect(resolveObjectURL(first)).toBeUndefined();
  const second = await client.files.images.url("a");
  expect(new Uint8Array(await resolveObjectURL(second)!.arrayBuffer())).toEqual(
    new Uint8Array([2])
  );
  await client.files.images.delete("a");
  expect(resolveObjectURL(second)).toBeUndefined();
  const third = await client.files.images.url("a");
  client.close();
  await Promise.resolve();
  expect(resolveObjectURL(third)).toBeUndefined();
});

it.each(["put", "delete", "close"] as const)(
  "rejects an in-flight file URL invalidated by %s instead of returning revoked bytes",
  async (action) => {
    const config = defineConfig({ name: "notes", tier: 1, files: { images: files() } });
    const read = Promise.withResolvers<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }>();
    let first = true;
    const transport: Transport = {
      route: unusedRoute,
      call: async (op) => {
        if (op !== "files.get") return null;
        if (first) {
          first = false;
          return read.promise;
        }
        return { bytes: new Uint8Array([2]), contentType: "image/png" };
      },
      close() {}
    };
    const client = createClient<typeof config>(config, { transport, shared: {}, connections: {} });
    const pending = client.files.images.url("a");
    const rejected = expect(pending).rejects.toMatchObject({
      code: action === "close" ? "unknown_outcome" : "invalid_request"
    });
    if (action === "close") client.close();
    else if (action === "delete") await client.files.images.delete("a");
    else await client.files.images.put("a", new Uint8Array([2]), { contentType: "image/png" });
    read.resolve({ bytes: new Uint8Array([1]), contentType: "image/png" });
    await rejected;
    if (action === "put") {
      const url = await client.files.images.url("a");
      expect(new Uint8Array(await resolveObjectURL(url)!.arrayBuffer())).toEqual(
        new Uint8Array([2])
      );
    }
    client.close();
  }
);

it("shares the supplied transport with generated aliases and exposes shared reads only", async () => {
  const sent: unknown[] = [];
  const call: Transport["call"] = async (op, args) => {
    sent.push({ op, args });
    return null;
  };
  const config = defineConfig({ name: "notes", tier: 1 });
  const manifest = {
    ...config,
    uses: { team: { kind: "sharedTable" }, sales: { kind: "postgres" } }
  };
  const shared = {
    team: (alias: string, call: Transport["call"]) =>
      createSharedTable<{ id: string; title: string }>(alias, call)
  };
  const connections = {
    sales: (alias: string, call: Transport["call"]) => ({
      query: () =>
        call("postgres.query", { connection: alias, sql: "select 1", params: [], shape: {} })
    })
  };
  const client = createClient<typeof config, typeof shared, typeof connections>(manifest, {
    transport: { call, route: unusedRoute, close() {} },
    shared,
    connections
  });
  await client.shared.team.get("row");
  await client.connections.sales.query();
  expect(Object.keys(client.shared.team).sort()).toEqual(["get", "getMany", "list"]);
  expect(sent).toEqual([
    { op: "shared.get", args: { alias: "team", id: "row" } },
    { op: "postgres.query", args: { connection: "sales", sql: "select 1", params: [], shape: {} } }
  ]);
  client.close();
});

it("infers the owned facade and generated aliases without widening index, id, or write boundaries", () => {
  const root = new URL("../dist/", import.meta.url).pathname;
  const source = `import { createClient, createSharedTable, type Call, type ErrorCode, type Operation, type Me, type FileMetadata } from "patchy/client";
import { defineConfig, table, t, files, postgres, sharedTable, type Id } from "patchy/config";
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
const operationsConform: Equal<Operation, "route.set" | "download" | ${Object.keys(
    runtimeOperations
  )
    .map((name) => JSON.stringify(name))
    .join(" | ")}> = true;
const config = defineConfig({ name: "notes", tier: 1, tables: {
  notes: table({ title: t.text(), body: t.text().optional(), count: t.integer().default(0), parent: t.ref("notes").optional() }, { indexes: { byTitle: ["title"] } }),
  people: table({ name: t.text() }),
  data: table({ required: t.json(), defaulted: t.json().default({}), optional: t.json().optional() })
}, files: { images: files() }, uses: { team: sharedTable("source", "notes"), sales: postgres("warehouse") } });
const shared = { team: (alias: string, call: Call) => createSharedTable<{ id: Id<"source/notes">; title: string }>(alias, call) };
const connections = { sales: (alias: string, call: Call) => ({ count: async () => 42 }) };
const client = createClient<typeof config, typeof shared, typeof connections>(config, { shared, connections });
async function use() {
  const row = await client.tables.notes.insert({ title: "ok" });
  const id: Id<"notes"> = row.id;
  const title: string = row.title;
  const nullable: string | null = row.body;
  const defaulted: number = row.count;
  await client.tables.notes.update(id, { body: null });
  await client.tables.notes.list({ index: "byTitle", eq: { title: "ok" }, range: { column: "title", gte: "a" } });
  await client.tables.notes.list({ index: "parent", eq: { parent: id } });
  const count: number = await client.connections.sales.count();
  const path: string = await client.route.get();
  const routed: null = await client.route.set("/notes");
  const unsubscribe: () => void = client.route.subscribe((path) => {
    const current: string = path;
  });
  unsubscribe();
  const downloaded: null = await client.files.images.download("report.csv");
  await client.tables.data.insert({ required: { nested: null }, optional: null });
  await client.tables.data.update("id" as Id<"data">, { defaulted: [null], optional: null });
  // @ts-expect-error required JSON cannot be top-level null
  client.tables.data.insert({ required: null });
  // @ts-expect-error defaulted JSON cannot be top-level null
  client.tables.data.insert({ required: {}, defaulted: null });
  // @ts-expect-error required JSON cannot be cleared
  client.tables.data.update("id" as Id<"data">, { required: null });
  // @ts-expect-error defaulted JSON cannot be cleared
  client.tables.data.update("id" as Id<"data">, { defaulted: null });
  // @ts-expect-error nonexistent owned table
  client.tables.unknown.get(id);
  // @ts-expect-error another table's ID
  client.tables.people.get(id);
  // @ts-expect-error required insert field
  client.tables.notes.insert({});
  // @ts-expect-error defaulted does not mean nullable
  client.tables.notes.update(id, { count: null });
  // @ts-expect-error system fields are not writable
  client.tables.notes.update(id, { createdAt: "now" });
  // @ts-expect-error unknown index
  client.tables.notes.list({ index: "missing" });
  // @ts-expect-error unindexed filter
  client.tables.notes.list({ index: "byTitle", eq: { count: 2 } });
  // @ts-expect-error wrong filter value
  client.tables.notes.list({ index: "byTitle", eq: { title: 2 } });
  // @ts-expect-error shared aliases are read only
  client.shared.team.insert({ title: "no" });
  // @ts-expect-error nonexistent generated alias
  client.connections.missing.count();
  // @ts-expect-error missing generated declaration
  createClient<typeof config>(config, { shared: {}, connections: {} });
}
`;
  const filename = `${root}consumer.virtual.ts`;
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    paths: {
      "patchy/client": [`${root}client.d.ts`],
      "patchy/config": [`${root}config.d.ts`]
    },
    resolveJsonModule: true,
    skipLibCheck: true
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, onError, fresh) =>
    file === filename
      ? ts.createSourceFile(file, source, language, true)
      : getSourceFile(file, language, onError, fresh);
  const program = ts.createProgram([filename], options, host);
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
  ).toEqual([]);
});

it("bundles the actual browser entry and generated template without Node, Effect, PGlite or executing config", async () => {
  const clientPath = new URL("./client.ts", import.meta.url).pathname;
  const result = await build({
    stdin: {
      contents: generateClient(),
      sourcefile: "generated-client.ts",
      resolveDir: new URL("./", import.meta.url).pathname,
      loader: "ts"
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    plugins: [
      {
        name: "generated-browser-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^patchy\/client$/ }, () => ({ path: clientPath }));
          builder.onResolve({ filter: /manifest\.json$/ }, () => ({
            path: "manifest",
            namespace: "fixture"
          }));
          builder.onResolve({ filter: /patchy\.config/ }, () => {
            throw new Error("The browser attempted to execute its config");
          });
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: JSON.stringify({ tables: {}, files: {}, uses: {} }),
            loader: "json"
          }));
        }
      }
    ]
  });
  expect(
    Object.keys(result.metafile!.inputs).filter((path) =>
      /node:|node_modules|effect|pglite|executeConfig/i.test(path)
    )
  ).toEqual([]);
  expect(Object.values(result.metafile!.outputs).flatMap((output) => output.imports)).toEqual([]);
});
