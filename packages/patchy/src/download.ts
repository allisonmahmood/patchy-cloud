import type { Call } from "./clientTransport.js";

/** Resolves after the shell hands the file to the browser, not after a disk save. */
export type Download = (name: string, data: Blob | Uint8Array | ArrayBuffer) => Promise<null>;

export function createDownload(call: Call): Download {
  return async (name, data) => {
    const contentType = data instanceof Blob ? data.type : "application/octet-stream";
    const bytes =
      data instanceof Uint8Array
        ? data
        : new Uint8Array(data instanceof ArrayBuffer ? data : await data.arrayBuffer());
    return (await call("download.generated", { name, contentType }, bytes)) as null;
  };
}
