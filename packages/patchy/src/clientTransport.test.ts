import { afterEach, expect, it, vi } from "vitest";
import {
  createHttpTransport,
  createPortTransport,
  createPostMessageTransport
} from "./clientTransport.js";
import { createClient, PatchyError } from "./client.js";
import { defineConfig, files } from "./config.js";
import type { Port } from "./clientTransport.js";

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
    code: "invalid_query",
    details: { sqlstate: "42703" },
    correlationId: "log-1"
  });
  port.reply({
    v: 1,
    id: port.sent[1]!.id,
    kind: "error",
    error: {
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

it("closed ports and lost insert replies are unknown outcomes, never replayed", async () => {
  vi.useFakeTimers();
  const port = new FakePort();
  const transport = createPortTransport(port, { timeoutMs: 100 });
  const insert = transport.call("tables.insert", { table: "notes", row: { title: "one" } });
  const lost = expect(insert).rejects.toMatchObject({ code: "unknown_outcome" });
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
  const config = defineConfig({ name: "uploads", tier: 1, files: { images: files() } });
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
  const config = defineConfig({ name: "downloads", tier: 1, files: { images: files() } });
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
          error: { code: "invalid_request", error: "Rejected route.", details: {} }
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
