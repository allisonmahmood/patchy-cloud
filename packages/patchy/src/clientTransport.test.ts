import { afterEach, expect, it, vi } from "vitest";
import {
  createHttpTransport,
  createPortTransport,
  createPostMessageTransport,
  PatchyError
} from "./client.js";
import type { Port } from "./client.js";

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
    location: { href: "https://instance/~content/p/v?nonce=document-one" }
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

it("uses the byte envelope without detaching or including bytes in arguments", async () => {
  const port = new FakePort();
  const transport = createPortTransport(port);
  const source = new Uint8Array([0, 10, 20, 0]);
  const put = transport.call(
    "files.put",
    { store: "images", name: "x", contentType: "image/png" },
    source.subarray(1, 3)
  );
  expect(new Uint8Array(port.sent[0]!.bytes!)).toEqual(new Uint8Array([10, 20]));
  expect(source).toEqual(new Uint8Array([0, 10, 20, 0]));
  port.reply({ v: 1, id: port.sent[0]!.id, kind: "result", value: null });
  await put;
  const get = transport.call("files.get", { store: "images", name: "x" });
  port.reply({
    v: 1,
    id: port.sent[1]!.id,
    kind: "result",
    value: { contentType: "image/png" },
    bytes: new Uint8Array([10, 20]).buffer
  });
  await expect(get).resolves.toEqual({ contentType: "image/png", bytes: new Uint8Array([10, 20]) });
  transport.close();
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
