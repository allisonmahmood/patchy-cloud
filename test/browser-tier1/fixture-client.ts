import { createClient } from "patchy/client";

export interface FixtureWindow extends Window {
  harness: {
    ready: boolean;
    readonly client: typeof client;
    replies: Array<{ id?: string; kind?: string; error?: { code: string }; value?: unknown }>;
    raw(value: unknown, transfer?: Transferable[]): void;
    image(): Promise<void>;
    printRows(): void;
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
  port.addEventListener("message", (message) => {
    harness.replies.push(message.data);
  });
  port.start();
});
const client = createClient(
  { tables: { rows: {} }, files: { assets: {} }, uses: {} },
  { shared: {}, connections: {} }
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
