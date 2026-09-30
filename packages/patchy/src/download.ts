import type { Call } from "./clientTransport.js";

/** Resolves after the shell hands the file to the browser, not after a disk save. */
export type Download = (name: string, data: Blob | Uint8Array | ArrayBuffer) => Promise<null>;

export function createDownload(call: Call): Download {
  return async (name, data) => {
    const contentType = data instanceof Blob ? data.type : "application/octet-stream";
    // The transport transfers its buffer; preserve the caller's bytes for reuse after dismissal.
    const bytes =
      data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data));
    return (await call("download.generated", { name, contentType }, bytes)) as null;
  };
}
