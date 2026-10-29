import { resolveObjectURL } from "node:buffer";
import { expect, it } from "vitest";
import { build } from "esbuild";
import { typecheck } from "../../../test/typescript.js";
import { createClient, decodeError, isPatchyError, type Transport } from "./client.js";
import { defineConfig, files, table, t } from "./config.js";
import { generateClient } from "../../sdk/src/generateClient.js";
import { RuntimeCode } from "../../api/src/runtime.js";

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
const unusedQueries: Transport["queries"] = {
  subscribe() {
    throw new Error("This test does not implement subscriptions.");
  }
};

it("decodes every runtime refusal without confusing handler errors or untagged data", () => {
  for (const code of RuntimeCode.literals) {
    expect(decodeError({ source: "patchy", code, error: "Refused." })).toMatchObject({
      source: "patchy",
      code,
      message: "Refused."
    });
  }
  expect(decodeError({ source: "patchy", code: "invented_code", message: "no" })).toBeUndefined();
  expect(
    decodeError({ source: "handler", code: "access_denied", error: "business" })
  ).toBeUndefined();
  expect(decodeError({ code: "access_denied", error: "Missing source." })).toBeUndefined();
  expect(
    decodeError({ ok: true, source: "patchy", code: "busy", error: "Successful business data." })
  ).toBeUndefined();
});

it("records the operation that refused, so its integration's details narrow by it", () => {
  const posthog = decodeError(
    { source: "patchy", code: "invalid_query", error: "Bad HogQL.", details: { message: "x" } },
    "posthog.query"
  );
  const postgres = decodeError(
    {
      source: "patchy",
      code: "invalid_query",
      error: "Bad SQL.",
      details: { sqlstate: "42703", message: "y" }
    },
    "postgres.query"
  );
  expect(posthog?.operation).toBe("posthog.query");
  // An error decoded once keeps its operation.
  expect(decodeError(posthog, "tables.list")?.operation).toBe("posthog.query");
  // A refusal an action relays names the operation that refused, not the server call.
  const relayed = decodeError(
    {
      source: "patchy",
      code: "invalid_query",
      error: "Bad HogQL.",
      details: { message: "x" },
      operation: "posthog.query"
    },
    "server.call"
  );
  expect(relayed?.operation).toBe("posthog.query");
  expect(isPatchyError(relayed, "invalid_query", "posthog")).toBe(true);
  expect(isPatchyError(posthog, "invalid_query", "posthog")).toBe(true);
  expect(isPatchyError(posthog, "invalid_query", "posthog.query")).toBe(true);
  expect(isPatchyError(posthog, "invalid_query", "postgres")).toBe(false);
  // @ts-expect-error a from names a whole integration; a prefix of one matches nothing
  expect(isPatchyError(posthog, "invalid_query", "post")).toBe(false);
  expect(isPatchyError(postgres, "invalid_query", "postgres")).toBe(true);
  const error: unknown = posthog;
  if (isPatchyError(error, "invalid_query", "posthog")) {
    const message: string = error.details.message;
    // @ts-expect-error PostHog sends no SQLSTATE
    void error.details.sqlstate;
    void message;
  }
  if (isPatchyError(error, "shape_mismatch", "posthog.query")) {
    const type: string | undefined = error.details.type;
    void type;
  }
  if (isPatchyError(error, "invalid_query", "postgres")) {
    const sqlstate: string = error.details.sqlstate;
    void sqlstate;
  }
  const from: "postgres" | "posthog" = Math.random() > 0.5 ? "posthog" : "postgres";
  if (isPatchyError(error, "invalid_query", from)) {
    const message: string = error.details.message;
    // @ts-expect-error either integration may have refused, and PostHog sends no SQLSTATE
    void error.details.sqlstate;
    void message;
  }
  const loose: string = "posthog";
  // @ts-expect-error a from must name one integration, or one of its operations
  isPatchyError(error, "invalid_query", loose);
  // @ts-expect-error a pattern could match either integration's operations
  isPatchyError(error, "invalid_query", "posthog.query" as `${string}.query`);
  // Narrowing on the code alone keeps Postgres's details, as patches written before PostHog do.
  if (isPatchyError(error, "invalid_query")) {
    const sqlstate: string = error.details.sqlstate;
    void sqlstate;
  }
});

it("caches blob URLs until replacement/deletion and revokes them on close", async () => {
  const config = defineConfig({
    name: "notes",
    tier: 1,
    tables: { notes: table("Notes identified by id.", { title: t.text() }) },
    files: { images: files("Images keyed by filename.") }
  });
  const calls: string[] = [];
  let bytes = new Uint8Array([1]);
  const transport: Transport = {
    route: unusedRoute,
    ready: async () => {},
    waitForServerTime: async () => {
      throw new Error("This test does not implement the server clock.");
    },
    serverTime: () => undefined,
    handlerKind: () => undefined,
    queries: unusedQueries,
    call: async (op, _args, input) => {
      calls.push(op);
      if (op === "files.get") return { bytes, contentType: "image/png" };
      if (op === "files.put") bytes = new Uint8Array(input!);
      return null;
    },
    close() {}
  };
  const client = createClient<typeof config>(config, { transport });
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
    const config = defineConfig({
      name: "notes",
      tier: 1,
      files: { images: files("Images keyed by filename.") }
    });
    const read = Promise.withResolvers<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }>();
    let first = true;
    const transport: Transport = {
      route: unusedRoute,
      ready: async () => {},
      waitForServerTime: async () => {
        throw new Error("This test does not implement the server clock.");
      },
      serverTime: () => undefined,
      handlerKind: () => undefined,
      queries: unusedQueries,
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
    const client = createClient<typeof config>(config, { transport });
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

it("infers the owned facade without widening index, id, or write boundaries", () => {
  const source = `import { createClient, type ErrorCode, type Me, type FileMetadata } from "patchy/client";
import { defineConfig, table, t, files, type Id } from "patchy/config";
const config = defineConfig({ name: "notes", tier: 1, tables: {
  notes: table("Notes identified by id; parent links another note.", { title: t.text(), body: t.text().optional(), count: t.integer().default(0), parent: t.ref("notes").optional() }, { indexes: { byTitle: ["title"] } }),
  people: table("People identified by id.", { name: t.text() }),
  data: table("JSON records identified by id.", { required: t.json(), defaulted: t.json().default({}), optional: t.json().optional() })
}, files: { images: files("Images keyed by filename.") } });
const client = createClient<typeof config>(config);
async function use() {
  const row = await client.tables.notes.insert({ title: "ok" });
  const id: Id<"notes"> = row.id;
  const title: string = row.title;
  const nullable: string | null = row.body;
  const defaulted: number = row.count;
  await client.tables.notes.update(id, { body: null });
  await client.tables.notes.list({ index: "byTitle", eq: { title: "ok" }, range: { column: "title", gte: "a" } });
  await client.tables.notes.list({ index: "parent", eq: { parent: id } });
  client.tables.notes.list.subscribe({ index: "byTitle", eq: { title: "ok" } }, (snapshot) => {
    const title: string | undefined = snapshot.data?.rows[0]?.title;
  });
  client.tables.notes.get.subscribe(id, (snapshot) => {
    const title: string | undefined = snapshot.data?.title;
  });
  // @ts-expect-error subscribing preserves branded row IDs
  client.tables.people.get.subscribe(id, () => {});
  // @ts-expect-error subscribing preserves index names
  client.tables.notes.list.subscribe({ index: "missing" }, () => {});
  const path: string = await client.route.get();
  const routed: null = await client.route.set("/notes");
  const unsubscribe: () => void = client.route.subscribe((path) => {
    const current: string = path;
  });
  unsubscribe();
  const downloaded: null = await client.files.images.download("report.csv");
  // @ts-expect-error browser stores expose no server metadata stat operation
  client.files.images.stat("logo.svg");
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
  // @ts-expect-error tier 1 reaches connections only from tier 2 handlers
  client.connections;
}
`;
  expect(typecheck({ "consumer.ts": source })).toEqual([]);
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
    conditions: ["development"],
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
