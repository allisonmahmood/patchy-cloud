import type { FileHandle } from "./config.js";
import { PatchyError } from "./clientError.js";
import { getDocumentTransport, type Transport } from "./clientTransport.js";

export interface HandleFiles {
  url(handle: FileHandle): Promise<string>;
  download(handle: FileHandle, filename?: string): Promise<null>;
}

interface FileHandleClient extends HandleFiles {
  release(url: string): void;
  close(): void;
}

export function createFileHandles(transport: Transport) {
  const urls = new Set<string>();
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new PatchyError("unknown_outcome", "The client is closed.", {});
  };
  const files = {
    async url(handle: FileHandle): Promise<string> {
      assertOpen();
      // Never reuse bytes: each request must pass the host's live authority checks.
      const { bytes, contentType } = (await transport.call("files.redeem", { handle })) as {
        readonly bytes: Uint8Array<ArrayBuffer>;
        readonly contentType: string;
      };
      assertOpen();
      const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
      urls.add(url);
      return url;
    },
    async download(handle: FileHandle, filename?: string): Promise<null> {
      assertOpen();
      return transport.call("files.download", {
        handle,
        ...(filename === undefined ? {} : { filename })
      }) as Promise<null>;
    },
    release(url: string) {
      if (urls.delete(url)) URL.revokeObjectURL(url);
    },
    close() {
      if (closed) return;
      closed = true;
      globalThis.window?.removeEventListener("pagehide", files.close);
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    }
  };
  globalThis.window?.addEventListener("pagehide", files.close, { once: true });
  return files;
}

let documentFiles: FileHandleClient | undefined;
export const getDocumentFiles = () => (documentFiles ??= createFileHandles(getDocumentTransport()));
