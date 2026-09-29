import { afterEach, expect, it, vi } from "vitest";
import {
  createHttpTransport,
  createPortTransport,
  createPostMessageTransport
} from "./clientTransport.js";
import {
  createClient,
  createSharedTable,
  createServerClient,
  PatchyError,
  isHandlerError,
  isPatchyError,
  type MutationUnknownOutcome,
  type QueryRegistry,
  type QuerySnapshot,
  type Call
} from "./client.js";
import { defineConfig, files, table, t, sharedTable, type Id } from "./config.js";
import type { Port } from "./clientTransport.js";
import type { Handler } from "./server.js";

class FakePort extends EventTarget implements Port {
  readonly sent: Array<{ v: number; id: string; op: string; args: unknown; bytes?: ArrayBuffer }> =
    [];
  closed = false;
  postMessage(value: unknown) {
    this.sent.push(value as (typeof this.sent)[number]);
  }
  start() {}
  close() {
    this.closed = true;
  }
  reply(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
afterEach(() => vi.useRealTimers());

it("correlates out-of-order replies and decodes the one error class with details", async () => {
  const port = new FakePort();
  const transport = createPortTransport(port);
  const first = transport.call("tables.get", { table: "notes", id: "a" });
  const second = transport.call("postgres.query", {});
  const rejected = expect(second).rejects.toMatchObject({
    source: "patchy",
    code: "invalid_query",
    details: { sqlstate: "42703" },
    correlationId: "log-1"
  });
  port.reply({
    v: 1,
    id: port.sent[1]!.id,
    kind: "error",
    error: {
      source: "patchy",
      code: "invalid_query",
      error: "Missing column",
      details: { sqlstate: "42703", message: "Missing column" },
      correlationId: "log-1"
    }
  });
  port.reply({ v: 1, id: "not-pending", kind: "result", value: "ignored" });
  port.reply({ v: 1, id: port.sent[0]!.id, kind: "result", value: { id: "a", title: "First" } });
  await rejected;
  await expect(second).rejects.toBeInstanceOf(PatchyError);
  await expect(first).resolves.toEqual({ id: "a", title: "First" });
  transport.close();
});

it("keeps the hello clock advancing across a stream drop without replaying operations", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const port = new FakePort();
  const transport = createPortTransport(port);
  expect(transport.serverTime()).toBeUndefined();
  const pending = transport.call("tables.insert", { table: "notes", row: { title: "one" } });
  port.reply({
    v: 1,
    kind: "event",
    event: "stream",
    data: { type: "hello", generation: "first", serverTime: 50_000 }
  });
  await vi.advanceTimersByTimeAsync(250);
  port.reply({
    v: 1,
    kind: "event",
    event: "stream",
    data: { type: "closed", reason: "draining" }
  });
  expect(transport.serverTime()).toBe(50_250);
  await vi.advanceTimersByTimeAsync(250);
  expect(transport.serverTime()).toBe(50_500);
  port.reply({
    v: 1,
    kind: "event",
    event: "stream",
    data: { type: "hello", generation: "replacement", serverTime: 60_000 }
  });
  expect(transport.serverTime()).toBe(60_000);
  expect(port.sent).toHaveLength(1);
  port.reply({ v: 1, kind: "result", id: port.sent[0]!.id, value: { id: "row-1" } });
  await expect(pending).resolves.toEqual({ id: "row-1" });
  transport.close();
  expect(transport.serverTime()).toBeUndefined();
});

it("keeps lazy handler names and business errors distinct from similarly shaped values", async () => {
  const port = new FakePort();
  const transport = createPortTransport(port);
  type Modules = {
    leads: {
      renamed: Handler<"query", { search?: string; filter?: { stage?: string } }, unknown>;
    };
  };
  const client = createServerClient<Modules>({ transport });
  const business = {
    ok: false,
    source: "handler",
    code: "access_denied",
    details: { reason: "approval" }
  };
  const call = client.server.leads.renamed({ search: undefined, filter: { stage: undefined } });
  await Promise.resolve();
  expect(port.sent[0]!.args).toEqual({ handler: "leads.renamed", args: { filter: {} } });
  port.reply({ v: 1, id: port.sent[0]!.id, kind: "result", value: business });
  await expect(call).resolves.toEqual(business);
  const refused = client.server.leads.renamed({});
  const failure = refused.catch((error: unknown) => error);
  await Promise.resolve();
  port.reply({ v: 1, id: port.sent[1]!.id, kind: "error", error: business });
  const error = await failure;
  expect(isHandlerError(error, "access_denied")).toBe(true);
  expect(error).not.toBeInstanceOf(PatchyError);
  expect(error).toMatchObject({ details: { reason: "approval" } });
  client.close();
});

it("retries a lost query reply once with the original argument snapshot and ignores its late reply", async () => {
  vi.useFakeTimers();
  const port = new FakePort();
  const transport = createPortTransport(port, {
    timeoutMs: 100,
    handlerKinds: { "leads.find": "query" }
  });
  type Modules = {
    leads: { find: Handler<"query", { filter: { name: string } }, string> };
  };
  const client = createServerClient<Modules>({ transport });
  const args = { filter: { name: "Ada" } };
  const result = client.server.leads.find(args);
  args.filter.name = "Grace";
  await vi.advanceTimersByTimeAsync(101);
  expect(port.sent.map(({ op, args }) => ({ op, args }))).toEqual([
    { op: "server.call", args: { handler: "leads.find", args: { filter: { name: "Ada" } } } },
    { op: "server.call", args: { handler: "leads.find", args: { filter: { name: "Ada" } } } }
  ]);
  port.reply({ v: 1, kind: "result", id: port.sent[0]!.id, value: "late original" });
  port.reply({ v: 1, kind: "result", id: port.sent[1]!.id, value: "retried result" });
  await expect(result).resolves.toBe("retried result");
  client.close();
});

it("surfaces the second lost query reply without a third attempt", async () => {
  vi.useFakeTimers();
  const port = new FakePort();
  const client = createServerClient<{
    leads: { find: Handler<"query", Record<string, never>, string> };
  }>({
    transport: createPortTransport(port, {
      timeoutMs: 100,
      handlerKinds: { "leads.find": "query" }
    })
  });
  const lost = expect(client.server.leads.find({})).rejects.toMatchObject({
    source: "patchy",
    code: "unknown_outcome"
  });
  await vi.advanceTimersByTimeAsync(201);
  await lost;
  expect(port.sent).toHaveLength(2);
  client.close();
});

it.each([
  { name: "action", kinds: { "leads.find": "action" } },
  { name: "mutation", kinds: { "leads.find": "mutation" } },
  { name: "absent metadata", kinds: undefined },
  { name: "missing handler", kinds: { "leads.other": "query" } },
  { name: "invalid metadata", kinds: { "leads.find": "query", "leads.other": "invalid" } },
  { name: "inherited metadata", kinds: Object.create({ "leads.find": "query" }) }
])("never replays a lost call with $name, regardless of its TypeScript kind", async ({ kinds }) => {
  vi.useFakeTimers();
  const port = new FakePort();
  const client = createServerClient<{
    leads: { find: Handler<"query", Record<string, never>, string> };
  }>({
    transport: createPortTransport(port, { timeoutMs: 100, handlerKinds: kinds })
  });
  port.reply({
    v: 1,
    kind: "event",
    event: "stream",
    data: { type: "hello", generation: "first", serverTime: 50_000 }
  });
  const result = client.server.leads.find({}).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(201);
  const error = await result;
  expect(error).toMatchObject({ code: "unknown_outcome" });
  if (kinds?.["leads.find"] !== "mutation") expect(error).not.toHaveProperty("retry");
  expect(port.sent).toHaveLength(1);
  client.close();
});

it.each([
  { source: "patchy", code: "handler_timeout" },
  { source: "patchy", code: "busy" },
  { source: "patchy", code: "rate_limited" },
  { source: "patchy", code: "handler_failed" },
  { source: "patchy", code: "access_denied" },
  { source: "patchy", code: "unknown_outcome" },
  { source: "handler", code: "unknown_outcome" }
])("does not retry a delivered $source $code refusal", async (error) => {
  const port = new FakePort();
  const client = createServerClient<{
    leads: { find: Handler<"query", Record<string, never>, string> };
  }>({
    transport: createPortTransport(port, { handlerKinds: { "leads.find": "query" } })
  });
  const rejected = expect(client.server.leads.find({})).rejects.toMatchObject(error);
  await Promise.resolve();
  port.reply({
    v: 1,
    kind: "error",
    id: port.sent[0]!.id,
    error: { ok: false, ...error, message: "Refused.", details: {} }
  });
  await rejected;
  expect(port.sent).toHaveLength(1);
  client.close();
});

it("keeps a server call pending through startup, the action deadline and settlement", async () => {
  vi.useFakeTimers();
  const port = new FakePort();
  const transport = createPortTransport(port, { handlerKinds: { "leads.import": "action" } });
  const result = transport.call("server.call", { handler: "leads.import", args: {} });
  await vi.advanceTimersByTimeAsync(40_000 + 60_000 + 5_000);
  port.reply({ v: 1, kind: "result", id: port.sent[0]!.id, value: "imported" });
  await expect(result).resolves.toBe("imported");
  expect(port.sent).toHaveLength(1);
  transport.close();
});

it("learns query retry eligibility only from its nonce-bound parent bootstrap", async () => {
  vi.useFakeTimers();
  const parent = {};
  const frame = Object.assign(new EventTarget(), {
    parent,
    location: { href: "https://instance/~content/p/v?n=document-one" }
  });
  const port = new FakePort();
  const client = createServerClient<{
    leads: { find: Handler<"query", Record<string, never>, string> };
  }>({
    transport: createPostMessageTransport({ window: frame as unknown as Window })
  });
  const result = client.server.leads.find({});
  const bootstrap = (source: unknown, nonce: string, kind: string) => {
    const event = new Event("message");
    Object.assign(event, {
      source,
      data: {
        v: 1,
        kind: "bootstrap",
        nonce,
        route: "/",
        handlerKinds: { "leads.find": kind }
      },
      ports: [port]
    });
    frame.dispatchEvent(event);
  };
  bootstrap({}, "document-one", "action");
  bootstrap(parent, "other-document", "action");
  expect(port.sent).toEqual([]);
  bootstrap(parent, "document-one", "query");
  await vi.advanceTimersByTimeAsync(0);
  const first = port.sent.find((request) => request.op === "server.call")!;
  port.reply({
    v: 1,
    kind: "error",
    id: first.id,
    replyLost: true,
    error: { source: "patchy", code: "unknown_outcome", message: "Reply lost." }
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(port.sent.filter((request) => request.op === "server.call")).toHaveLength(2);
  port.reply({ v: 1, kind: "result", id: port.sent.at(-1)!.id, value: "retried" });
  await expect(result).resolves.toBe("retried");
  client.close();
});

it("mints distinct 128-bit mutation keys from the advancing server clock, not the wall clock", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
  const port = new FakePort();
  const client = createServerClient<{
    leads: { save: Handler<"mutation", { name: string }, string> };
  }>({
    transport: createPortTransport(port, { handlerKinds: { "leads.save": "mutation" } })
  });
  port.reply({
    v: 1,
    kind: "event",
    event: "stream",
    data: { type: "hello", generation: "first", serverTime: 1_800_000_000_000 }
  });
  await vi.advanceTimersByTimeAsync(125);
  const first = client.server.leads.save({ name: "Ada" });
  const second = client.server.leads.save({ name: "Ada" });
  await Promise.resolve();
  const keys = port.sent.map(({ args }) => {
    if (
      args === null ||
      typeof args !== "object" ||
      !("mutationKey" in args) ||
      typeof args.mutationKey !== "string"
    )
      throw new Error("Mutation call did not carry a key.");
    return args.mutationKey;
  });
  expect(keys[0]).toMatch(/^1800000000125-[A-Za-z0-9_-]{22}$/);
  expect(keys[1]).toMatch(/^1800000000125-[A-Za-z0-9_-]{22}$/);
  expect(keys[0]).not.toBe(keys[1]);
  for (const key of keys) {
    const suffix = key
      .slice(key.indexOf("-") + 1)
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    expect(atob(suffix)).toHaveLength(16);
  }
  port.reply({ v: 1, kind: "result", id: port.sent[0]!.id, value: "first" });
  port.reply({ v: 1, kind: "result", id: port.sent[1]!.id, value: "second" });
  await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  client.close();
});

it.each(["timeout", "broker", "runtime"] as const)(
  "retries an uncertain mutation from %s only explicitly, with its original key and deep arguments",
  async (failure) => {
    vi.useFakeTimers();
    const port = new FakePort();
    const client = createServerClient<{
      leads: {
        save: Handler<"mutation", { names: { name: string }[]; note?: string }, string>;
      };
    }>({
      transport: createPortTransport(port, {
        timeoutMs: 100,
        handlerKinds: { "leads.save": "mutation" }
      })
    });
    port.reply({
      v: 1,
      kind: "event",
      event: "stream",
      data: { type: "hello", generation: "first", serverTime: 50_000 }
    });
    const args = { names: [{ name: "Ada" }], note: undefined };
    const result = client.server.leads.save(args).catch((error: unknown) => error);
    args.names[0]!.name = "Grace";
    await Promise.resolve();
    const original = structuredClone(port.sent[0]!.args);
    if (failure !== "timeout")
      port.reply({
        v: 1,
        kind: "error",
        id: port.sent[0]!.id,
        ...(failure === "broker" ? { replyLost: true } : {}),
        error: {
          source: "patchy",
          code: "unknown_outcome",
          message: "Commit acknowledgement missing.",
          correlationId: "invocation-1",
          details: { phase: "commit" }
        }
      });
    await vi.advanceTimersByTimeAsync(101);
    const error = await result;
    expect(isPatchyError(error, "unknown_outcome")).toBe(true);
    if (failure === "runtime")
      expect(error).toMatchObject({
        message: "Commit acknowledgement missing.",
        correlationId: "invocation-1",
        details: { phase: "commit" }
      });
    expect(port.sent).toHaveLength(1);
    args.names.push({ name: "Katherine" });
    port.reply({
      v: 1,
      kind: "event",
      event: "stream",
      data: { type: "hello", generation: "replacement", serverTime: 60_000 }
    });
    const uncertain = error as MutationUnknownOutcome<string>;
    const retried = uncertain.retry();
    expect(port.sent[1]!.args).toEqual(original);
    expect(port.sent[1]!.args).toMatchObject({ args: { names: [{ name: "Ada" }] } });
    port.reply({ v: 1, kind: "result", id: port.sent[0]!.id, value: "late original" });
    port.reply({ v: 1, kind: "result", id: port.sent[1]!.id, value: "stored result" });
    await expect(retried).resolves.toBe("stored result");
    client.close();
  }
);

it("waits for trusted bootstrap metadata and hello before sending a pre-bootstrap mutation", async () => {
  vi.useFakeTimers();
  const parent = {};
  const frame = Object.assign(new EventTarget(), {
    parent,
    location: { href: "https://instance/~content/p/v?n=document-one" }
  });
  const port = new FakePort();
  const client = createServerClient<{
    leads: { save: Handler<"query", { name: string }, string> };
  }>({
    transport: createPostMessageTransport({ window: frame as unknown as Window })
  });
  const args = { name: "Ada" };
  const result = client.server.leads.save(args);
  args.name = "Grace";
  const bootstrap = (source: unknown, nonce: string, kind: string) => {
    const event = new Event("message");
    Object.assign(event, {
      source,
      data: {
        v: 1,
        kind: "bootstrap",
        nonce,
        route: "/",
        handlerKinds: { "leads.save": kind }
      },
      ports: [port]
    });
    frame.dispatchEvent(event);
  };
  bootstrap({}, "document-one", "query");
  bootstrap(parent, "other-document", "query");
  await vi.advanceTimersByTimeAsync(0);
  expect(port.sent).toEqual([]);
  bootstrap(parent, "document-one", "mutation");
  await vi.advanceTimersByTimeAsync(0);
  expect(port.sent).toEqual([{ kind: "ready", wire: 1, nonce: "document-one" }]);
  port.reply({
    v: 1,
    kind: "event",
    event: "stream",
    data: { type: "hello", generation: "first", serverTime: 50_000 }
  });
  await vi.advanceTimersByTimeAsync(0);
  const sent = port.sent.find(({ op }) => op === "server.call")!;
  expect(sent.args).toEqual({
    handler: "leads.save",
    args: { name: "Ada" },
    mutationKey: expect.stringMatching(/^50000-[A-Za-z0-9_-]{22}$/)
  });
  port.reply({ v: 1, kind: "result", id: sent.id, value: "saved" });
  await expect(result).resolves.toBe("saved");
  client.close();
});

it.each(["timeout", "close"] as const)(
  "settles a mutation waiting for hello on %s without sending it",
  async (failure) => {
    vi.useFakeTimers();
    const port = new FakePort();
    const client = createServerClient<{
      leads: { save: Handler<"mutation", Record<string, never>, string> };
    }>({
      transport: createPortTransport(port, {
        timeoutMs: 100,
        handlerKinds: { "leads.save": "mutation" }
      })
    });
    const result = client.server.leads.save({}).catch((error: unknown) => error);
    await Promise.resolve();
    if (failure === "close") client.close();
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({
      code: failure === "timeout" ? "timeout" : "unknown_outcome"
    });
    expect(await result).not.toHaveProperty("retry");
    port.reply({
      v: 1,
      kind: "event",
      event: "stream",
      data: { type: "hello", generation: "late", serverTime: 50_000 }
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(port.sent).toEqual([]);
    client.close();
  }
);

it.each(["timeout", "close"] as const)(
  "settles a pre-bootstrap mutation on %s without retry",
  async (failure) => {
    vi.useFakeTimers();
    const frame = Object.assign(new EventTarget(), {
      parent: {},
      location: { href: "https://instance/~content/p/v?n=document-one" }
    });
    const client = createServerClient<{
      leads: { save: Handler<"mutation", Record<string, never>, string> };
    }>({
      transport: createPostMessageTransport({
        window: frame as unknown as Window,
        timeoutMs: 100
      })
    });
    const result = client.server.leads.save({}).catch((error: unknown) => error);
    if (failure === "close") client.close();
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({
      code: failure === "timeout" ? "shell_outdated" : "unknown_outcome"
    });
    expect(await result).not.toHaveProperty("retry");
    client.close();
  }
);

it.each([
  { source: "handler", code: "unknown_outcome" },
  { source: "patchy", code: "write_conflict" }
])("does not offer mutation retry for a $source $code failure", async (failure) => {
  const port = new FakePort();
  const client = createServerClient<{
    leads: { save: Handler<"mutation", Record<string, never>, string> };
  }>({
    transport: createPortTransport(port, { handlerKinds: { "leads.save": "mutation" } })
  });
  port.reply({
    v: 1,
    kind: "event",
    event: "stream",
    data: { type: "hello", generation: "first", serverTime: 50_000 }
  });
  const result = client.server.leads.save({}).catch((error: unknown) => error);
  await Promise.resolve();
  port.reply({
    v: 1,
    kind: "error",
    id: port.sent[0]!.id,
    error: { ok: false, ...failure, message: "Refused.", details: {} }
  });
  const error = await result;
  expect(error).toMatchObject(failure);
  expect(error).not.toHaveProperty("retry");
  expect(isHandlerError(error, failure.code)).toBe(failure.source === "handler");
  expect(port.sent).toHaveLength(1);
  client.close();
});

it("closed ports and lost insert replies are unknown outcomes, never replayed", async () => {
  vi.useFakeTimers();
  const port = new FakePort();
  const transport = createPortTransport(port, { timeoutMs: 100 });
  const insert = transport.call("tables.insert", { table: "notes", row: { title: "one" } });
  const lost = expect(insert).rejects.toMatchObject({ source: "patchy", code: "unknown_outcome" });
  await vi.advanceTimersByTimeAsync(101);
  await lost;
  expect(port.sent.filter((request) => request.op === "tables.insert")).toHaveLength(1);
  const read = transport.call("tables.get", { table: "notes", id: "a" });
  const closed = expect(read).rejects.toMatchObject({ code: "unknown_outcome" });
  port.dispatchEvent(new Event("close"));
  await closed;
  await expect(transport.call("tables.insert", {})).rejects.toMatchObject({
    code: "unknown_outcome"
  });
  expect(port.sent.filter((request) => request.op === "tables.insert")).toHaveLength(1);
});

it("binds bootstrap to the parent and URL nonce and closes pending calls on pagehide", async () => {
  const parent = {};
  const frame = Object.assign(new EventTarget(), {
    parent,
    location: { href: "https://instance/~content/p/v?n=document-one" }
  });
  const transport = createPostMessageTransport({ window: frame as unknown as Window });
  const port = new FakePort();
  const bootstrap = (source: unknown, nonce: string) => {
    const event = new Event("message");
    Object.assign(event, {
      source,
      data: { v: 1, kind: "bootstrap", nonce, route: "/" },
      ports: [port]
    });
    frame.dispatchEvent(event);
  };
  bootstrap({}, "document-one");
  bootstrap(parent, "other-document");
  expect(port.sent).toEqual([]);
  bootstrap(parent, "document-one");
  expect(port.sent).toEqual([{ kind: "ready", wire: 1, nonce: "document-one" }]);
  const call = transport.call("tables.insert", { table: "notes", row: {} });
  const rejected = expect(call).rejects.toMatchObject({ code: "unknown_outcome" });
  await Promise.resolve();
  frame.dispatchEvent(new Event("pagehide"));
  await rejected;
  expect(port.closed).toBe(true);
  bootstrap(parent, "document-one");
  expect(port.sent.filter((request) => request.op === "tables.insert")).toHaveLength(1);
});

it("transfers owned upload buffers and isolates subviews without leaking neighboring bytes", async () => {
  const channel = new MessageChannel();
  const transport = createPortTransport(channel.port1);
  const config = defineConfig({
    name: "uploads",
    tier: 1,
    files: { images: files("Images keyed by filename.") }
  });
  const client = createClient<typeof config>(config, { transport, shared: {}, connections: {} });
  const uploads: Uint8Array[] = [];
  channel.port2.onmessage = ({ data }) => {
    expect(data.args).toEqual({ store: "images", name: "x", contentType: "image/png" });
    uploads.push(new Uint8Array(data.bytes));
    channel.port2.postMessage({ v: 1, id: data.id, kind: "result", value: null });
  };
  try {
    const owned = new Uint8Array([10, 20]);
    const put = client.files.images.put("x", owned, { contentType: "image/png" });
    expect(owned.buffer.byteLength).toBe(0);
    await expect(put).resolves.toBeNull();

    const buffer = new Uint8Array([30, 40]).buffer;
    const second = client.files.images.put("x", buffer, { contentType: "image/png" });
    expect(buffer.byteLength).toBe(0);
    await expect(second).resolves.toBeNull();

    const source = new Uint8Array([99, 50, 60, 88]);
    await client.files.images.put("x", source.subarray(1, 3), { contentType: "image/png" });
    expect(source).toEqual(new Uint8Array([99, 50, 60, 88]));
    expect(uploads).toEqual([
      new Uint8Array([10, 20]),
      new Uint8Array([30, 40]),
      new Uint8Array([50, 60])
    ]);
  } finally {
    client.close();
    channel.port2.close();
  }
});

it("decodes transferred file replies into client bytes and downloads through the broker", async () => {
  const channel = new MessageChannel();
  const transport = createPortTransport(channel.port1);
  const config = defineConfig({
    name: "downloads",
    tier: 1,
    files: { images: files("Images keyed by filename.") }
  });
  const client = createClient<typeof config>(config, { transport, shared: {}, connections: {} });
  const downloads: unknown[] = [];
  channel.port2.onmessage = ({ data }) => {
    if (data.op === "files.get") {
      const bytes = new Uint8Array([10, 20]).buffer;
      channel.port2.postMessage(
        { v: 1, id: data.id, kind: "result", value: { contentType: "image/png" }, bytes },
        [bytes]
      );
    } else {
      downloads.push({ op: data.op, args: data.args });
      channel.port2.postMessage({ v: 1, id: data.id, kind: "result", value: null });
    }
  };
  try {
    await expect(client.files.images.get("folder/x.png")).resolves.toEqual(
      new Uint8Array([10, 20])
    );
    await expect(client.files.images.download("folder/x.png")).resolves.toBeNull();
    expect(downloads).toEqual([
      { op: "download", args: { store: "images", name: "folder/x.png" } }
    ]);
  } finally {
    client.close();
    channel.port2.close();
  }
});

it("preserves bootstrap routes, acknowledges sets and receives popstate before id replies", async () => {
  const parent = {};
  const frame = Object.assign(new EventTarget(), {
    parent,
    location: { href: "https://instance/~content/p/v?n=route-document" }
  });
  const channel = new MessageChannel();
  const transport = createPostMessageTransport({ window: frame as unknown as Window });
  const config = defineConfig({ name: "routes", tier: 1 });
  const client = createClient<typeof config>(config, { transport, shared: {}, connections: {} });
  const paths: string[] = [];
  const cancelled = vi.fn();
  client.route.subscribe(cancelled)();
  const unsubscribe = client.route.subscribe((path) => paths.push(path));
  const initial = client.route.get();
  const requests: Array<{ id: string; args: { path: string } }> = [];
  const requested = Promise.withResolvers<void>();
  channel.port2.onmessage = ({ data }) => {
    if (data.op === "route.set") {
      requests.push(data);
      requested.resolve();
      if (data.args.path === "/rejected")
        channel.port2.postMessage({
          v: 1,
          id: data.id,
          kind: "error",
          error: {
            source: "patchy",
            code: "invalid_request",
            error: "Rejected route.",
            details: {}
          }
        });
    } else if (data.op === "me") {
      channel.port2.postMessage({ v: 1, id: data.id, kind: "result", value: null });
    }
  };
  try {
    const bootstrap = new Event("message");
    Object.assign(bootstrap, {
      source: parent,
      data: { v: 1, kind: "bootstrap", nonce: "route-document", route: "/notes/deep-link" },
      ports: [channel.port1]
    });
    frame.dispatchEvent(bootstrap);
    await expect(initial).resolves.toBe("/notes/deep-link");
    expect(paths).toEqual(["/notes/deep-link"]);
    expect(cancelled).not.toHaveBeenCalled();

    const changed = client.route.set("/notes/next");
    await requested.promise;
    expect(paths).toEqual(["/notes/deep-link"]);
    await expect(client.route.get()).resolves.toBe("/notes/deep-link");
    channel.port2.postMessage({ v: 1, id: requests[0]!.id, kind: "result", value: null });
    await expect(changed).resolves.toBeNull();
    expect(paths).toEqual(["/notes/deep-link", "/notes/next"]);
    // The shell's route event after a set repeats an unchanged path without notifying again.
    channel.port2.postMessage({
      v: 1,
      kind: "event",
      event: "route",
      data: { path: "/notes/next" }
    });
    await expect(client.route.set("/rejected")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.route.get()).resolves.toBe("/notes/next");
    expect(paths).toEqual(["/notes/deep-link", "/notes/next"]);
    expect(requests.map((request) => request.args.path)).toEqual(["/notes/next", "/rejected"]);

    channel.port2.postMessage({
      v: 2,
      kind: "event",
      event: "route",
      data: { path: "/wrong-wire" }
    });
    channel.port2.postMessage({
      v: 1,
      kind: "event",
      event: "other",
      data: { path: "/wrong-event" }
    });
    channel.port2.postMessage({ v: 1, kind: "event", event: "route", data: { path: 42 } });
    channel.port2.postMessage({
      v: 1,
      kind: "event",
      event: "route",
      data: { path: "/notes/back" }
    });
    await transport.call("me", {});
    expect(paths).toEqual(["/notes/deep-link", "/notes/next", "/notes/back"]);
    await expect(client.route.get()).resolves.toBe("/notes/back");

    unsubscribe();
    channel.port2.postMessage({
      v: 1,
      kind: "event",
      event: "route",
      data: { path: "/notes/unsubscribed" }
    });
    await transport.call("me", {});
    expect(paths).toEqual(["/notes/deep-link", "/notes/next", "/notes/back"]);
    await expect(client.route.get()).resolves.toBe("/notes/unsubscribed");
    client.route.subscribe(cancelled);
    client.close();
    await Promise.resolve();
    expect(cancelled).not.toHaveBeenCalled();
    await expect(client.route.get()).rejects.toMatchObject({ code: "unknown_outcome" });
    await expect(client.route.set("/after-close")).rejects.toMatchObject({
      code: "unknown_outcome"
    });
  } finally {
    client.close();
    channel.port2.close();
  }
});

it("cancels each subscription independently and drops queued notifications on close", async () => {
  const channel = new MessageChannel();
  const transport = createPortTransport(channel.port1, { route: "/initial" });
  const listener = vi.fn();
  try {
    const first = transport.route.subscribe(listener);
    const second = transport.route.subscribe(listener);
    first();
    await Promise.resolve();
    expect(listener.mock.calls).toEqual([["/initial"]]);
    second();
    transport.route.subscribe(listener);
    transport.close();
    await Promise.resolve();
    expect(listener.mock.calls).toEqual([["/initial"]]);
  } finally {
    transport.close();
    channel.port2.close();
  }
});

it("does not deliver subscriptions cancelled or closed before bootstrap", async () => {
  const frame = Object.assign(new EventTarget(), {
    parent: {},
    location: { href: "https://instance/~content/p/v?n=unbootstrapped" }
  });
  const transport = createPostMessageTransport({ window: frame as unknown as Window });
  const listener = vi.fn();
  transport.route.subscribe(listener);
  const initial = transport.route.get();
  const rejected = expect(initial).rejects.toMatchObject({ code: "unknown_outcome" });
  transport.close();
  await rejected;
  expect(listener).not.toHaveBeenCalled();
});

it("refuses browser-only operations in the HTTP adapter without making requests", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const transport = createHttpTransport({
    baseUrl: "https://instance",
    patchId: "p",
    versionId: "v",
    fetch: fetcher
  });
  try {
    await expect(transport.route.get()).rejects.toMatchObject({ code: "invalid_request" });
    await expect(transport.route.set("/next")).rejects.toMatchObject({ code: "invalid_request" });
    expect(() => transport.route.subscribe(() => {})).toThrow(PatchyError);
    await expect(transport.call("route.set", { path: "/next" })).rejects.toMatchObject({
      code: "invalid_request"
    });
    await expect(transport.call("download", { store: "images", name: "x" })).rejects.toMatchObject({
      code: "invalid_request"
    });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    transport.close();
  }
});

it.each([
  null,
  {
    user: { id: "user-1", name: "Pat", email: "pat@example.com" },
    company: { id: "co", handle: "company", name: "Company" },
    admin: false
  }
])("HTTP bootstraps me once before JSON and byte calls as the bound principal: %j", async (me) => {
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    requests.push(request);
    if (request.url.endsWith("/call")) {
      const body = (await request.clone().json()) as { op: string; principal: unknown };
      return Response.json({ ok: true, value: body.op === "me" ? me : { id: "created" } });
    }
    return request.method === "GET"
      ? new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png" } })
      : new Response(null, { status: 204 });
  };
  const transport = createHttpTransport({
    baseUrl: "https://instance",
    patchId: "patch",
    versionId: "version",
    fetch: fetcher
  });
  await Promise.all([
    transport.call("tables.insert", { table: "notes", row: {} }),
    transport.call(
      "files.put",
      { store: "images", name: "folder/a b.png", contentType: "image/png" },
      new Uint8Array([1, 2])
    )
  ]);
  await expect(
    transport.call("files.get", { store: "images", name: "folder/a b.png" })
  ).resolves.toEqual({ bytes: new Uint8Array([1, 2]), contentType: "image/png" });
  await expect(transport.call("me", {})).resolves.toEqual(me);
  expect(await requests[0]!.clone().json()).toMatchObject({ op: "me", principal: null });
  expect(requests).toHaveLength(4);
  for (const request of requests.slice(1)) {
    expect(request.headers.get("X-Patchy-Principal")).toBe(
      JSON.stringify(me === null ? null : { userId: me.user.id })
    );
    expect(request.headers.get("X-Patchy-Wire")).toBe("1");
  }
  const put = requests.find((request) => request.method === "PUT")!;
  expect(put.url).toBe("https://instance/api/runtime/files/patch/version/images/folder/a%20b.png");
  expect(new Uint8Array(await put.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  transport.close();
});

it("never retries a mutation when HTTP loses its response", async () => {
  const sent: string[] = [];
  const transport = createHttpTransport({
    baseUrl: "https://instance",
    patchId: "p",
    versionId: "v",
    fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string) as { op: string };
      sent.push(body.op);
      if (body.op === "me") return Response.json({ ok: true, value: null });
      throw new TypeError("network lost");
    }
  });
  await expect(transport.call("tables.insert", { table: "notes", row: {} })).rejects.toMatchObject({
    code: "unknown_outcome"
  });
  expect(sent).toEqual(["me", "tables.insert"]);
  transport.close();
});

it("HTTP distinguishes declared handler errors, platform refusals and business-shaped data", async () => {
  const business = { ok: false, source: "handler", code: "access_denied", details: "business" };
  const refusal = { ok: false, source: "patchy", code: "access_denied", error: "Platform denial." };
  let reply = { status: 200, body: { ok: true, value: business } as unknown };
  const transport = createHttpTransport({
    baseUrl: "https://instance",
    patchId: "p",
    versionId: "v",
    fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string) as { op: string };
      return body.op === "me"
        ? Response.json({ ok: true, value: null })
        : Response.json(reply.body, { status: reply.status });
    }
  });
  try {
    await expect(transport.call("server.call", {})).resolves.toEqual(business);
    reply = { status: 200, body: business };
    const declared = await transport.call("server.call", {}).catch((error: unknown) => error);
    expect(isHandlerError(declared, "access_denied")).toBe(true);
    expect(declared).toMatchObject({ source: "handler", details: "business" });
    reply = { status: 403, body: refusal };
    await expect(transport.call("server.call", {})).rejects.toMatchObject({
      source: "patchy",
      code: "access_denied",
      message: "Platform denial."
    });
    for (const body of [business, { ok: false, code: "access_denied", error: "Missing source." }]) {
      reply = { status: 403, body };
      await expect(transport.call("server.call", {})).rejects.toMatchObject({
        source: "patchy",
        code: "invalid_request"
      });
    }
    reply = { status: 200, body: business };
    await expect(transport.call("tables.get", {})).rejects.toMatchObject({
      source: "patchy",
      code: "invalid_request"
    });
  } finally {
    transport.close();
  }
});

it("shares table subscriptions with hook stores and retains data and query errors across session refresh", async () => {
  const port = new FakePort();
  const transport = createPortTransport(port);
  const config = defineConfig({
    name: "subscriptions",
    tier: 1,
    tables: { notes: table("Team notes.", { title: t.text() }) },
    uses: { team: sharedTable("source", "notes") }
  });
  const shared = {
    team: (alias: string, call: Call, queries: QueryRegistry) =>
      createSharedTable<{ readonly id: string; readonly title: string }>(alias, call, queries)
  };
  const client = createClient<typeof config, typeof shared>(config, {
    transport,
    shared,
    connections: {}
  });
  const own: QuerySnapshot<unknown>[] = [];
  const sharedRows: QuerySnapshot<unknown>[] = [];
  client.tables.notes.get.subscribe("new-row" as Id<"notes">, (snapshot) => own.push(snapshot));
  const hook = client.tables.notes.get.__patchyQueryStore('"new-row"');
  hook.subscribe(() => {});
  client.shared.team.list.subscribe({ limit: 20 }, (snapshot) => sharedRows.push(snapshot));
  const requests = port.sent.filter((request) => request.op === "subscriptions.subscribe");
  expect(requests).toHaveLength(2);
  const ownRequest = requests[0]!.args;
  const sharedRequest = requests[1]!.args;
  if (
    !ownRequest ||
    typeof ownRequest !== "object" ||
    !("id" in ownRequest) ||
    !sharedRequest ||
    typeof sharedRequest !== "object" ||
    !("id" in sharedRequest)
  )
    throw new Error("Subscription commands must identify their query.");
  const ownId = ownRequest.id;
  const sharedId = sharedRequest.id;
  for (const request of requests) port.reply({ v: 1, kind: "result", id: request.id, value: null });
  const stream = (data: unknown) => port.reply({ v: 1, kind: "event", event: "stream", data });
  stream({
    type: "snapshot",
    id: ownId,
    revision: "1",
    result: null,
    vector: { "table:own:notes": "0" }
  });
  expect(hook.getSnapshot()).toMatchObject({ status: "ready", data: null });
  stream({
    type: "snapshot",
    id: ownId,
    revision: "2",
    result: { id: "new-row", title: "Appeared" },
    vector: { "table:own:notes": "1" }
  });
  expect(own.at(-1)?.data).toEqual({ id: "new-row", title: "Appeared" });
  const page = { rows: [{ id: "shared", title: "Whole page" }], cursor: null };
  stream({
    type: "snapshot",
    id: sharedId,
    revision: "1",
    result: page,
    vector: { "table:source:notes": "1", "patch:source": "2" }
  });
  stream({
    type: "error",
    id: sharedId,
    permanent: false,
    error: {
      ok: false,
      source: "patchy",
      code: "access_denied",
      error: "Source unshared",
      details: { alias: "team" }
    }
  });
  expect(sharedRows.at(-1)).toMatchObject({
    status: "error",
    data: page,
    error: { code: "access_denied", details: { alias: "team" } }
  });
  const refused = sharedRows.at(-1);
  const ready = hook.getSnapshot();
  stream({ type: "closed", reason: "reauthenticate" });
  stream({ type: "hello", generation: "refreshed", serverTime: 100 });
  expect(sharedRows.at(-1)).toBe(refused);
  expect(hook.getSnapshot()).toBe(ready);
  expect(ready).toMatchObject({
    status: "ready",
    data: { id: "new-row", title: "Appeared" },
    error: undefined
  });
  stream({
    type: "up-to-date",
    id: sharedId,
    revision: "1",
    vector: { "table:source:notes": "1", "patch:source": "3" }
  });
  expect(sharedRows.at(-1)).toEqual({
    status: "ready",
    data: page,
    error: undefined,
    loading: false
  });
  stream({
    type: "error",
    id: sharedId,
    permanent: true,
    error: {
      ok: false,
      source: "patchy",
      code: "limit_exceeded",
      error: "Snapshot too large",
      scope: "viewer",
      limitId: "subscriptions.snapshot.bytes",
      value: 8388608
    }
  });
  const ended = sharedRows.at(-1);
  expect(ended).toMatchObject({
    status: "error",
    data: page,
    error: { limitId: "subscriptions.snapshot.bytes", value: 8388608 }
  });
  stream({
    type: "snapshot",
    id: sharedId,
    revision: "2",
    result: { rows: [], cursor: null },
    vector: {}
  });
  stream({ type: "hello", generation: "next", serverTime: 100 });
  expect(sharedRows.at(-1)).toBe(ended);
  expect(port.sent.filter((request) => request.op === "subscriptions.subscribe")).toHaveLength(2);
  const remounted: QuerySnapshot<unknown>[] = [];
  client.shared.team.list.subscribe({ limit: 20 }, (snapshot) => remounted.push(snapshot));
  expect(remounted.at(-1)).toBe(ended);
  expect(port.sent.filter((request) => request.op === "subscriptions.subscribe")).toHaveLength(2);
  client.close();
  await Promise.resolve();
});

it("keeps a refused subscription ended across reconnect and additional consumers", async () => {
  const port = new FakePort();
  const transport = createPortTransport(port);
  const config = defineConfig({
    name: "notes",
    tier: 1,
    tables: { notes: table("Notes.", { title: t.text() }) }
  });
  const client = createClient<typeof config>(config, { transport, shared: {}, connections: {} });
  const seen: QuerySnapshot<unknown>[] = [];
  client.tables.notes.list.subscribe({}, (snapshot) => seen.push(snapshot));
  const request = port.sent[0]!;
  port.reply({
    v: 1,
    kind: "error",
    id: request.id,
    error: {
      source: "patchy",
      code: "limit_exceeded",
      message: "Document full",
      scope: "viewer",
      limitId: "subscriptions.document",
      value: 64
    }
  });
  await Promise.resolve();
  expect(seen.at(-1)).toMatchObject({ status: "error", error: { code: "limit_exceeded" } });
  port.reply({
    v: 1,
    kind: "event",
    event: "stream",
    data: { type: "hello", generation: "next", serverTime: 100 }
  });
  expect(port.sent).toHaveLength(1);
  const remounted: QuerySnapshot<unknown>[] = [];
  client.tables.notes.list.subscribe({}, (snapshot) => remounted.push(snapshot));
  expect(remounted.at(-1)).toBe(seen.at(-1));
  expect(port.sent).toHaveLength(1);
  client.close();
  await Promise.resolve();
});

it("shares canonical server queries over the document stream and retains data through refusals", async () => {
  const port = new FakePort();
  const transport = createPortTransport(port);
  type Modules = {
    leads: {
      list: Handler<
        "query",
        { filter: { stage: string; owner?: string }; limit: number },
        readonly string[]
      >;
      count: Handler<"query", Record<string, never>, number>;
    };
  };
  const client = createServerClient<Modules>({ transport });
  const seen: QuerySnapshot<readonly string[]>[] = [];
  const other: QuerySnapshot<number>[] = [];
  const args = { filter: { stage: "open" }, limit: 20 };
  client.server.leads.list.subscribe(args, (snapshot) => seen.push(snapshot));
  args.filter.stage = "closed";
  const joined: QuerySnapshot<readonly string[]>[] = [];
  client.server.leads.list.subscribe(
    { limit: 20, filter: { owner: undefined, stage: "open" } },
    (snapshot) => joined.push(snapshot)
  );
  client.server.leads.count.subscribe({}, (snapshot) => other.push(snapshot));
  expect(port.sent.map((request) => request.op)).toEqual([
    "subscriptions.subscribe",
    "subscriptions.subscribe"
  ]);
  const request = port.sent[0]!;
  expect(request.args).toEqual({
    id: expect.any(String),
    op: "server.call",
    args: { handler: "leads.list", args: { filter: { stage: "open" }, limit: 20 } }
  });
  const queryArgs = request.args;
  const otherArgs = port.sent[1]!.args;
  if (
    !queryArgs ||
    typeof queryArgs !== "object" ||
    !("id" in queryArgs) ||
    !otherArgs ||
    typeof otherArgs !== "object" ||
    !("id" in otherArgs)
  )
    throw new Error("Subscription commands must identify their query.");
  const id = queryArgs.id;
  const otherId = otherArgs.id;
  for (const request of port.sent) {
    port.reply({ v: 1, kind: "result", id: request.id, value: null });
  }
  const stream = (data: unknown) => port.reply({ v: 1, kind: "event", event: "stream", data });
  stream({
    type: "snapshot",
    id,
    revision: "1",
    result: ["Ada"],
    vector: { "table:own:leads": "1" }
  });
  expect(seen.at(-1)).toEqual({
    status: "ready",
    data: ["Ada"],
    error: undefined,
    loading: false
  });
  expect(joined.at(-1)).toBe(seen.at(-1));
  stream({
    type: "error",
    id,
    permanent: false,
    error: { ok: false, source: "patchy", code: "access_denied", error: "Source unshared" }
  });
  expect(seen.at(-1)).toMatchObject({
    status: "error",
    data: ["Ada"],
    error: { code: "access_denied" },
    loading: false
  });
  stream({ type: "hello", generation: "reconnected", serverTime: 100 });
  stream({
    type: "snapshot",
    id,
    revision: "2",
    result: ["Grace"],
    vector: { "table:own:leads": "2" }
  });
  expect(seen.at(-1)).toEqual({
    status: "ready",
    data: ["Grace"],
    error: undefined,
    loading: false
  });
  stream({
    type: "error",
    id,
    permanent: true,
    error: { ok: false, source: "patchy", code: "handler_failed", error: "Invalid result" }
  });
  const ended = seen.at(-1);
  expect(ended).toMatchObject({
    status: "error",
    data: ["Grace"],
    error: { code: "handler_failed" },
    loading: false
  });
  client.server.leads.list.subscribe({ filter: { stage: "open" }, limit: 20 }, (snapshot) =>
    joined.push(snapshot)
  );
  stream({ type: "hello", generation: "next", serverTime: 200 });
  stream({ type: "snapshot", id, revision: "3", result: [], vector: {} });
  expect(joined.at(-1)).toBe(ended);
  expect(seen.at(-1)).toBe(ended);
  expect(port.sent).toHaveLength(2);
  stream({ type: "snapshot", id: otherId, revision: "1", result: 2, vector: {} });
  expect(other.at(-1)).toEqual({ status: "ready", data: 2, error: undefined, loading: false });
  client.close();
  await Promise.resolve();
});
