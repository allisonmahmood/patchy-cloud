import { afterEach, expect, it, vi } from "vitest";
import { createClient, createServerClient, type QuerySnapshot } from "./client.js";
import type { Port } from "./clientTransport.js";
import { defineConfig, table, t, type Id } from "./config.js";
import type { Handler } from "./server.js";

// Its own file: the document's transport is made once per module graph, by whichever consumer asks first.
class FakePort extends EventTarget implements Port {
  readonly sent: Array<{ readonly id: string; readonly op: string; readonly args: unknown }> = [];
  closed = false;
  postMessage(value: unknown) {
    const message = value as { id?: string; op?: string; args?: unknown };
    if (message.id !== undefined && message.op !== undefined)
      this.sent.push({ id: message.id, op: message.op, args: message.args });
  }
  start() {}
  close() {
    this.closed = true;
  }
  /** Answers the last request for `op`. */
  answer(op: string, value: unknown) {
    const request = this.sent.findLast((sent) => sent.op === op);
    if (request === undefined) throw new Error(`Nothing asked for ${op}.`);
    this.dispatchEvent(
      new MessageEvent("message", { data: { v: 1, kind: "result", id: request.id, value } })
    );
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shares the document's one port between tiers, and a closed client leaves it to the next", async () => {
  const parent = {};
  const frame = Object.assign(new EventTarget(), {
    parent,
    location: { href: "https://instance/~content/p/v?n=document" }
  });
  vi.stubGlobal("window", frame);
  const config = defineConfig({
    name: "notes",
    tier: 1,
    tables: { notes: table("Notes.", { title: t.text() }) }
  });
  const note = "note" as Id<"notes">;
  const first = createClient<typeof config>(config);
  const server = createServerClient<{
    notes: { count: Handler<"query", Record<string, never>, number> };
  }>();
  const port = new FakePort();
  const bootstrap = new Event("message");
  Object.assign(bootstrap, {
    source: parent,
    data: { v: 1, kind: "bootstrap", nonce: "document", route: "/", handlerKinds: {} },
    ports: [port]
  });
  frame.dispatchEvent(bootstrap);

  const routes = vi.fn();
  first.route.subscribe(routes);
  const snapshots: Array<QuerySnapshot<unknown>> = [];
  first.tables.notes.list.subscribe(undefined, (snapshot) => snapshots.push(snapshot));
  const listed = first.tables.notes.get(note);
  await vi.waitFor(() => expect(port.sent.map(({ op }) => op)).toContain("tables.get"));
  port.answer("tables.get", null);
  await expect(listed).resolves.toBeNull();
  expect(routes.mock.calls).toEqual([["/"]]);
  const subscribed = port.sent.find(({ op }) => op === "subscriptions.subscribe")!;

  // Closing one client ends its subscriptions and calls, never the port the document shares.
  first.close();
  expect(port.closed).toBe(false);
  expect(port.sent.at(-1)).toMatchObject({
    op: "subscriptions.unsubscribe",
    args: { id: (subscribed.args as { id: string }).id }
  });
  const sentBefore = port.sent.length;
  await expect(first.tables.notes.get(note)).rejects.toMatchObject({ code: "unknown_outcome" });
  await expect(first.me()).rejects.toMatchObject({ code: "unknown_outcome" });
  expect(port.sent).toHaveLength(sentBefore);

  const me = server.me();
  await vi.waitFor(() => expect(port.sent.at(-1)?.op).toBe("me"));
  const viewer = {
    user: { id: "u", name: "Ada", email: "ada@example.com" },
    company: { id: "c", handle: "acme", name: "Acme" },
    admin: false
  };
  port.answer("me", viewer);
  await expect(me).resolves.toEqual(viewer);

  // With no client left, a remount in either tier uses the same port.
  server.close();
  expect(port.closed).toBe(false);
  await expect(server.server.notes.count({})).rejects.toMatchObject({ code: "unknown_outcome" });
  const second = createClient<typeof config>(config);
  const again = second.tables.notes.get(note);
  await vi.waitFor(() => expect(port.sent.at(-1)?.op).toBe("tables.get"));
  port.answer("tables.get", null);
  await expect(again).resolves.toBeNull();
  const remounted = createServerClient();
  const viewerAgain = remounted.me();
  await vi.waitFor(() => expect(port.sent.at(-1)?.op).toBe("me"));
  port.answer("me", viewer);
  await expect(viewerAgain).resolves.toEqual(viewer);
  routes.mockClear();
  frame.dispatchEvent(new Event("pagehide"));
  expect(port.closed).toBe(true);
  expect(routes).not.toHaveBeenCalled();
});
