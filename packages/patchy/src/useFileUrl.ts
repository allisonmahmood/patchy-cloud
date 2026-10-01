import { useEffect, useState } from "preact/hooks";
import type { FileHandle } from "./config.js";
import { getDocumentFiles } from "./fileHandles.js";

interface FileUrlState {
  readonly url: string | undefined;
  readonly error: Error | undefined;
}

/** Each mounted consumer owns its URL; a changed selection never keeps the previous image. */
export function useFileUrl(handle: FileHandle | null | undefined): FileUrlState {
  const [state, setState] = useState<FileUrlState & { readonly handle: typeof handle }>({
    handle,
    url: undefined,
    error: undefined
  });
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    const files = getDocumentFiles();
    setState({ handle, url: undefined, error: undefined });
    if (handle != null) {
      void files.url(handle).then(
        (resolved) => {
          if (!active) return files.release(resolved);
          url = resolved;
          setState({ handle, url, error: undefined });
        },
        (error: unknown) => {
          if (!active) return;
          setState({
            handle,
            url: undefined,
            error: error instanceof Error ? error : new Error(String(error))
          });
        }
      );
    }
    return () => {
      active = false;
      if (url !== undefined) files.release(url);
    };
  }, [handle]);
  return state.handle === handle ? state : { url: undefined, error: undefined };
}
