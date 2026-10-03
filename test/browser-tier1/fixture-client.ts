import {
  createClient,
  createSharedTable,
  createSharedStore,
  isPatchyError,
  type Call,
  type QueryRegistry
} from "patchy/client";
import { createElement, render, useQuery } from "patchy/preact";
import type { RuntimeStreamFrame } from "../../packages/api/src/index.js";

export interface FixtureWindow extends Window {
  harness: {
    ready: boolean;
    readonly client: typeof client;
    replies: Array<{
      id?: string;
      kind?: string;
      event?: string;
      data?: RuntimeStreamFrame;
      error?: { code: string };
      value?: unknown;
    }>;
    raw(value: unknown, transfer?: Transferable[]): void;
    image(): Promise<void>;
    queryStatuses: string[];
    subscribeRows(source?: "own" | "shared"): void;
  };
}

const host = window as unknown as FixtureWindow;
let port: MessagePort;
const harness: FixtureWindow["harness"] = {
  ready: false,
  get client() {
    return client;
  },
  replies: [],
  raw(value, transfer = []) {
    port.postMessage(value, transfer);
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
  queryStatuses: [],
  subscribeRows(source = "own") {
    const root = document.createElement("section");
    root.id = "subscribed-screen";
    document.body.append(root);
    function Rows() {
      const snapshot = useQuery<
        Record<string, never>,
        { readonly rows: readonly { readonly id: string; readonly label?: unknown }[] }
      >(source === "shared" ? client.shared.source!.list : client.tables.rows!.list, {});
      harness.queryStatuses.push(snapshot.status);
      return createElement(
        "div",
        {},
        createElement("p", { id: "subscription-status" }, snapshot.status),
        createElement(
          "pre",
          { id: "subscription-rows" },
          snapshot.data === undefined
            ? "loading"
            : JSON.stringify(snapshot.data.rows.map((row) => row.label))
        ),
        snapshot.error
          ? createElement(
              "p",
              { role: "alert" },
              isPatchyError(snapshot.error) ? snapshot.error.code : snapshot.error.message
            )
          : null
      );
    }
    render(createElement(Rows, {}), root);
  }
};
host.harness = harness;
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.kind !== "bootstrap" || event.ports.length !== 1)
    return;
  port = event.ports[0]!;
  port.addEventListener("message", (message) => {
    harness.replies.push(message.data);
  });
  port.start();
});
const client = createClient(
  {
    tables: { rows: {} },
    files: { assets: {} },
    uses: { source: { kind: "sharedTable" }, library: { kind: "sharedStore" } }
  },
  {
    shared: {
      source: (alias: string, call: Call, queries: QueryRegistry) =>
        createSharedTable<{ readonly id: string; readonly label: string }>(alias, call, queries),
      library: (alias: string, call: Call) => createSharedStore(alias, call)
    },
    connections: {}
  }
);
client.route.subscribe((path) => {
  document.querySelector("#route")!.textContent = path;
});
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
  await client.route.set("/items/3");
});
document.querySelector("#download")!.addEventListener("click", () => {
  void client.files.assets!.download("active.html");
});

const copy = Object.assign(document.createElement("button"), {
  id: "copy",
  textContent: "Copy text"
});
const copyStatus = Object.assign(document.createElement("p"), { id: "copy-status" });
const pastedCopy = Object.assign(document.createElement("textarea"), { id: "pasted-copy" });
document.body.append(copy, copyStatus, pastedCopy);
// Negative probe without browser automation's implicit user gesture.
void navigator.clipboard.writeText("Unactivated clipboard probe").then(
  () => {
    copyStatus.textContent = "Unexpected automatic copy";
  },
  () => {
    copyStatus.textContent = "Copy unavailable";
  }
);
copy.addEventListener("click", async () => {
  copyStatus.textContent = "Copying";
  try {
    const text = "Patchy clipboard acceptance";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Chromium refuses async clipboard permission for opaque origins. The user-triggered
      // copy event remains available without giving the frame clipboard-read authority.
      const onCopy = (event: ClipboardEvent) => {
        event.clipboardData?.setData("text/plain", text);
        event.preventDefault();
      };
      document.addEventListener("copy", onCopy);
      try {
        if (!document.execCommand("copy")) throw new Error("Clipboard write unavailable");
      } finally {
        document.removeEventListener("copy", onCopy);
      }
    }
    copyStatus.textContent = "Copied";
  } catch (error) {
    copyStatus.textContent = `Copy unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
});
