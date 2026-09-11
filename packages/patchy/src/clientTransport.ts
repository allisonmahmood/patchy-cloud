/// <reference lib="es2024.promise" />
// @effect-diagnostics globalTimers:off globalFetch:off
// Browser adapters deliberately use platform APIs, with no Effect runtime in the bundle.
import { PatchyError, decodeError } from "./clientError.js";
import { WIRE_VERSION } from "./release.js";

export type Operation =
  | "me"
  | `tables.${"get" | "getMany" | "list" | "insert" | "insertMany" | "update" | "delete"}`
  | `shared.${"get" | "getMany" | "list"}`
  | `files.${"get" | "put" | "list" | "delete"}`
  | `postgres.${"get" | "getMany" | "list" | "query"}`;
export type Call = (op: Operation, args: unknown, bytes?: Uint8Array) => Promise<unknown>;
export interface Transport {
  readonly call: Call;
  close(): void;
}
export interface Me {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly company: { readonly id: string; readonly handle: string; readonly name: string };
  readonly admin: boolean;
}

/** Structural subset implemented by browser MessagePort and the fake-port acceptance seam. */
export interface Port {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  start(): void;
  close(): void;
}
const lost = () =>
  new PatchyError(
    "unknown_outcome",
    "The runtime reply was lost; this operation has not been retried.",
    {}
  );

export function createPortTransport(
  port: Port,
  options: { readonly timeoutMs?: number } = {}
): Transport {
  const timeoutMs = options.timeoutMs ?? 35_000;
  let sequence = 0;
  let closed = false;
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const onMessage: EventListener = (event) => {
    const reply: unknown = (event as MessageEvent).data;
    if (reply === null || typeof reply !== "object") return;
    const value = reply as Record<string, unknown>;
    if (typeof value.id !== "string") return;
    const request = pending.get(value.id);
    if (!request) return;
    if (value.v !== WIRE_VERSION || (value.kind !== "result" && value.kind !== "error")) return;
    clearTimeout(request.timer);
    pending.delete(value.id);
    if (value.kind === "error") {
      request.reject(
        decodeError(value.error) ??
          new PatchyError("invalid_request", "The broker returned an invalid error.", {})
      );
    } else if (value.bytes instanceof ArrayBuffer || value.bytes instanceof Uint8Array) {
      request.resolve({
        ...(value.value as object),
        bytes: value.bytes instanceof Uint8Array ? value.bytes : new Uint8Array(value.bytes)
      });
    } else request.resolve(value.value);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    port.removeEventListener("message", onMessage);
    port.removeEventListener("messageerror", close);
    port.removeEventListener("close", close);
    port.close();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(lost());
    }
    pending.clear();
  };
  port.addEventListener("message", onMessage);
  port.addEventListener("messageerror", close);
  port.addEventListener("close", close);
  port.start();
  return {
    call: (op, args, bytes) => {
      if (closed) return Promise.reject(lost());
      const id = String(++sequence);
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(lost());
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const payload =
        bytes === undefined
          ? undefined
          : bytes.buffer instanceof ArrayBuffer &&
              bytes.byteOffset === 0 &&
              bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.slice().buffer;
      try {
        port.postMessage({
          v: WIRE_VERSION,
          id,
          op,
          args,
          ...(payload === undefined ? {} : { bytes: payload })
        });
      } catch {
        close();
      }
      return promise;
    },
    close
  };
}

/** Accept exactly the parent's port for this document's URL nonce; never rebind after navigation. */
export function createPostMessageTransport(
  options: { readonly window?: Window; readonly timeoutMs?: number } = {}
): Transport {
  const frame = options.window ?? globalThis.window;
  let transport: Transport | undefined;
  let closed = false;
  const { promise: ready, resolve, reject } = Promise.withResolvers<Transport>();
  let removeBootstrap = () => {};
  if (!frame || frame.parent === frame) {
    reject(new PatchyError("shell_outdated", "This client must run inside the Patchy shell.", {}));
  } else {
    const nonce = new URL(frame.location.href).searchParams.get("n");
    const timer = setTimeout(() => {
      removeBootstrap();
      reject(
        new PatchyError("shell_outdated", "The Patchy shell did not bootstrap this document.", {})
      );
    }, options.timeoutMs ?? 10_000);
    const bootstrap = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (
        event.source !== frame.parent ||
        !data ||
        data.kind !== "bootstrap" ||
        !nonce ||
        data.nonce !== nonce
      )
        return;
      if (data.v !== WIRE_VERSION || event.ports.length !== 1) {
        removeBootstrap();
        reject(
          new PatchyError("shell_outdated", "The shell and bundle use different wire versions.", {})
        );
        return;
      }
      removeBootstrap();
      const port = event.ports[0]!;
      transport = createPortTransport(port, options);
      try {
        port.postMessage({ kind: "ready", wire: WIRE_VERSION, nonce });
        resolve(transport);
      } catch {
        transport.close();
        reject(lost());
      }
    };
    removeBootstrap = () => {
      clearTimeout(timer);
      frame.removeEventListener("message", bootstrap);
    };
    frame.addEventListener("message", bootstrap);
  }
  // Bootstrap can fail before application code asks for its first operation.
  void ready.catch(() => {});
  const close = () => {
    if (closed) return;
    closed = true;
    removeBootstrap();
    frame?.removeEventListener("pagehide", close);
    transport?.close();
    reject(lost());
  };
  frame?.addEventListener("pagehide", close, { once: true });
  return {
    call: async (op, args, bytes) => {
      if (closed) throw lost();
      return (await ready).call(op, args, bytes);
    },
    close
  };
}

export interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly patchId: string;
  readonly versionId: string;
  readonly fetch?: typeof fetch;
}
/** Test adapter only. Production bundles reach HTTP exclusively through the shell's broker. */
export function createHttpTransport(options: HttpTransportOptions): Transport {
  const fetcher = options.fetch ?? globalThis.fetch;
  const origin = new URL(options.baseUrl).origin;
  const controller = new AbortController();
  let identity: Promise<Me | null> | undefined;
  const dispatch = async (
    op: Operation,
    args: unknown,
    principal: { readonly userId: string } | null,
    bytes?: Uint8Array
  ): Promise<unknown> => {
    if (controller.signal.aborted) throw lost();
    const headers = new Headers({
      "X-Patchy-Wire": String(WIRE_VERSION),
      "X-Patchy-Principal": JSON.stringify(principal),
      Origin: origin,
      "Sec-Fetch-Site": "same-origin"
    });
    const init: RequestInit = { credentials: "include", headers, signal: controller.signal };
    let url = new URL("/api/runtime/call", options.baseUrl);
    const file = args as { store: string; name: string; contentType?: string };
    if (op === "files.get" || op === "files.put") {
      const path = [options.patchId, options.versionId, file.store, ...file.name.split("/")]
        .map(encodeURIComponent)
        .join("/");
      url = new URL(`/api/runtime/files/${path}`, options.baseUrl);
      init.method = op === "files.put" ? "PUT" : "GET";
      if (op === "files.put") {
        headers.set("Content-Type", file.contentType!);
        init.body = bytes as BodyInit;
      }
    } else {
      init.method = "POST";
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify({
        patchId: options.patchId,
        versionId: options.versionId,
        principal,
        wire: WIRE_VERSION,
        op,
        args
      });
    }
    let response: Response;
    try {
      response = await fetcher(url, init);
    } catch {
      throw lost();
    }
    try {
      if (op === "files.get" && response.ok)
        return {
          bytes: new Uint8Array(await response.arrayBuffer()),
          contentType: response.headers.get("Content-Type") ?? "application/octet-stream"
        };
      if (op === "files.put" && response.ok) return null;
      const result: unknown = await response.json();
      const error = decodeError(result);
      if (error) throw error;
      if (
        !response.ok ||
        result === null ||
        typeof result !== "object" ||
        !("ok" in result) ||
        result.ok !== true ||
        !("value" in result)
      )
        throw new PatchyError("invalid_request", "The runtime returned an invalid response.", {});
      return result.value;
    } catch (error) {
      if (error instanceof PatchyError) throw error;
      throw lost();
    }
  };
  return {
    call: async (op, args, bytes) => {
      identity ??= dispatch("me", {}, null) as Promise<Me | null>;
      const me = await identity;
      if (op === "me") return me;
      return dispatch(op, args, me === null ? null : { userId: me.user.id }, bytes);
    },
    close: () => controller.abort()
  };
}
