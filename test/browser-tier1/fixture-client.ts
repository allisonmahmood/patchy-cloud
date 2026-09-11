import { createClient } from "patchy/client";
import { WIRE_VERSION } from "../../packages/patchy/src/release.js";

export interface FixtureWindow extends Window {
  harness: {
    ready: boolean;
    route: string;
    replies: Array<{ id?: string; kind?: string; error?: { code: string }; value?: unknown }>;
    call(op: string, args?: unknown): Promise<unknown>;
    raw(value: unknown, transfer?: Transferable[]): void;
    image(): Promise<void>;
    printRows(): void;
  };
}

const host = window as unknown as FixtureWindow;
let port: MessagePort;
let serial = 0;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
const harness: FixtureWindow["harness"] = {
  ready: false,
  route: "",
  replies: [],
  raw(value, transfer = []) {
    port.postMessage(value, transfer);
  },
  call(op, args = {}) {
    const id = `probe-${++serial}`;
    const request = Promise.withResolvers<unknown>();
    pending.set(id, request);
    port.postMessage({ v: WIRE_VERSION, id, op, args });
    return request.promise;
  },
  async image() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const png = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), (c) =>
      c.charCodeAt(0)
    );
    await client.files.assets!.put("pixel.png", png, { contentType: "image/png" });
    const image = document.querySelector<HTMLImageElement>("#own-image")!;
    image.src = await client.files.assets!.url("pixel.png");
    await image.decode();
    await client.files.assets!.put(
      "active.html",
      new TextEncoder().encode(
        "<!doctype html><script>top.location='https://example.invalid'</script><p>download bytes</p>"
      ),
      { contentType: "text/html" }
    );
  },
  printRows() {
    const body = document.querySelector("#rows")!;
    body.replaceChildren();
    for (let i = 1; i <= 2000; i++) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.textContent = `Print row ${String(i).padStart(4, "0")}`;
      row.append(cell);
      body.append(row);
    }
  }
};
host.harness = harness;
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.kind !== "bootstrap" || event.ports.length !== 1)
    return;
  port = event.ports[0]!;
  harness.route = event.data.route;
  document.querySelector("#route")!.textContent = harness.route;
  port.addEventListener("message", (message) => {
    if (message.data?.event === "route") {
      harness.route = message.data.data.path;
      document.querySelector("#route")!.textContent = harness.route;
      return;
    }
    harness.replies.push(message.data);
    const waiter = pending.get(message.data?.id);
    if (!waiter) return;
    pending.delete(message.data.id);
    if (message.data.kind === "result") waiter.resolve(message.data.value);
    else waiter.reject(message.data.error);
  });
  port.start();
});
const client = createClient(
  { tables: { rows: {} }, files: { assets: {} }, uses: {} },
  { shared: {}, connections: {} }
);
void client.me().then(
  (me) => {
    harness.ready = true;
    document.querySelector("#identity")!.textContent = me?.user.id ?? "anonymous";
  },
  (error: unknown) => {
    document.querySelector("#identity")!.textContent = String(error);
  }
);
document.querySelector("#route-next")!.addEventListener("click", async () => {
  await harness.call("route.set", { path: "/items/3" });
  harness.route = "/items/3";
  document.querySelector("#route")!.textContent = harness.route;
});
document.querySelector("#download")!.addEventListener("click", () => {
  void harness.call("download", { store: "assets", name: "active.html" });
});
