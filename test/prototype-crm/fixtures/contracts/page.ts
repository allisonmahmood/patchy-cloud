// PROTOTYPE for #315: the contracts source's page; the proofs drive it through window.harness.
import { createServerOnlyClient, type Upload } from "patchy/client";

const client = createServerOnlyClient<never, { documents: typeof import("./server/documents") }>(
  {},
  { serverModules: ["documents"] }
);
const server = client.server as unknown as {
  documents: {
    list(args: object): Promise<Array<{ name: string; handle: string }>>;
    replace(args: { name: string; file: Upload }): Promise<{ name: string; handle: string }>;
  };
};
(window as unknown as { harness: unknown }).harness = {
  ready: true,
  list: () => server.documents.list({}),
  async replace(name: string, base64: string, contentType: string) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const file = await client.files.stage(bytes, { contentType });
    return server.documents.replace({ name, file });
  }
};
document.body.dataset.ready = "true";
