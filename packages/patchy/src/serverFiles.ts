import type { FileHandle, Upload } from "./config.js";
import { PatchyError } from "./clientError.js";
import { getDocumentTransport, type Transport } from "./clientTransport.js";
import { stagedUploadLimit } from "@patchy/api/file-config";

export interface ServerFiles {
  url(handle: FileHandle): Promise<string>;
  download(handle: FileHandle, filename?: string): Promise<null>;
  stage(
    bytes: Uint8Array | ArrayBuffer | Blob,
    options: { readonly contentType: string }
  ): Promise<Upload>;
  discard(upload: Upload): Promise<null>;
}

interface ServerFileClient extends ServerFiles {
  release(url: string): void;
  close(): void;
}

export function createServerFiles(transport: Transport) {
  const urls = new Set<string>();
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new PatchyError("unknown_outcome", "The client is closed.", {});
  };
  const files = {
    async stage(
      input: Uint8Array | ArrayBuffer | Blob,
      options: { readonly contentType: string }
    ): Promise<Upload> {
      assertOpen();
      const size = input instanceof Blob ? input.size : input.byteLength;
      if (size > stagedUploadLimit.value)
        throw new PatchyError(
          "too_large",
          `Staged uploads are limited to ${stagedUploadLimit.value} bytes.`,
          { maxBytes: stagedUploadLimit.value },
          undefined,
          stagedUploadLimit
        );
      const bytes =
        input instanceof Uint8Array
          ? input
          : new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());
      assertOpen();
      return transport.call(
        "files.stage",
        { contentType: options.contentType },
        bytes
      ) as Promise<Upload>;
    },
    async discard(upload: Upload): Promise<null> {
      assertOpen();
      return transport.call("files.discard", { upload }) as Promise<null>;
    },
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

let documentFiles: ServerFileClient | undefined;
export const getDocumentFiles = () => (documentFiles ??= createServerFiles(getDocumentTransport()));
