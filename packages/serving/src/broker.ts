/// <reference lib="dom" />
// @effect-diagnostics globalTimers:off globalFetch:off
// This browser entry owns platform I/O; it never creates an Effect runtime.
import {
  RuntimeRequest,
  RuntimeFailure,
  runtimeOperations,
  runtimeBodyLimit,
  runtimeByteLimits,
  WIRE_VERSION
} from "@patchy/api";
import type { RuntimeCode, RuntimeMe, RuntimePrincipal } from "@patchy/api";
import * as Schema from "effect/Schema";

const KiB = 1024;
const MiB = 1024 * KiB;
const MAX_HELD = 64 * MiB;
const MAX_FILE = runtimeByteLimits.fileBytes;
const MAX_PENDING = 32;
const decodeRequest = Schema.decodeUnknownSync(RuntimeRequest);
const decodeFailure = Schema.decodeUnknownSync(RuntimeFailure);
const isMe = Schema.is(runtimeOperations.me.response);
const routeArguments = Schema.Struct({ path: Schema.String }).annotate({
  parseOptions: { onExcessProperty: "error" }
});
const decodeRoute = Schema.decodeUnknownSync(routeArguments);
const decoder = new TextDecoder();
type Operation = keyof typeof runtimeOperations;
type Reply = { value: unknown; bytes?: ArrayBuffer; heldBytes: number };
class Refusal extends Error {
  constructor(
    readonly code: RuntimeCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    readonly correlationId?: string
  ) {
    super(message);
  }
}
const invalid = () => new Refusal("invalid_request", "The broker request is malformed.");
const tooLarge = (maxBytes: number) =>
  new Refusal("too_large", `The operation exceeds ${maxBytes} bytes.`, { maxBytes });
const lost = () =>
  new Refusal(
    "unknown_outcome",
    "The runtime reply was lost; this operation has not been retried."
  );

/** Bound work before JSON.stringify or recursive Schema decoding touches hostile structured clones. */
function jsonBytes(value: unknown, limit: number): number {
  let size = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const add = (bytes: number) => {
    size += bytes;
    if (size > limit) throw tooLarge(limit);
  };
  const string = (text: string) => {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(2);
      else if (c < 32) add(6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        add(4);
        i++;
      } else add(c >= 0xd800 && c <= 0xdfff ? 6 : 3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > limit || depth > 64) throw invalid();
    if (item === null) return add(4);
    if (typeof item === "string") return string(item);
    if (typeof item === "boolean") return add(item ? 4 : 5);
    if (typeof item === "number" && Number.isFinite(item)) return add(String(item).length);
    if (typeof item !== "object") throw invalid();
    if (ancestors.has(item)) throw invalid();
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw invalid();
    ancestors.add(item);
    add(2);
    let count = 0;
    if (array) {
      if (item.length > limit) throw tooLarge(limit);
      for (const entry of item) {
        if (count++) add(1);
        visit(entry, depth + 1);
      }
    } else {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (count++) add(1);
        string(key);
        add(1);
        visit((item as Record<string, unknown>)[key], depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return size;
}

function routePath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\?#\u0000-\u0020\u007f]/.test(path))
    throw invalid();
  for (const part of path.slice(1).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      throw invalid();
    }
    // Every ~ segment belongs to Patchy; encoded separators and dot traversal cannot escape the address.
    if (
      segment.startsWith("~") ||
      segment === "." ||
      segment === ".." ||
      /[/\\\u0000-\u001f\u007f]/.test(segment)
    )
      throw invalid();
  }
  return path;
}

function mount(frame: HTMLIFrameElement): void {
  const { patchId, versionId, nonce, base, contentSrc } = frame.dataset;
  const wire = Number(frame.dataset.wire);
  let port: MessagePort | undefined;
  let issued = false;
  let ready = false;
  let closed = false;
  let held = 0;
  const pending = new Set<string>();
  // Keep admitted ids for the document's lifetime: even a completed mutation cannot be replayed.
  const seen = new Set<string>();
  const downloads = new Map<string, { size: number; timer: number }>();
  let identity: Promise<RuntimeMe> | undefined;
  let principal: RuntimePrincipal = null;
  const reserve = (size: number) => {
    if (size > MAX_HELD - held) throw tooLarge(MAX_HELD);
    held += size;
  };
  const release = (size: number) => {
    held -= size;
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(bootstrapTimer);
    port?.close();
    port = undefined;
    // Work already admitted by Runtime keeps its original principal and is not replayed.
    // Only the reply channel closes; cancelling the HTTP request could interrupt a mutation.
    for (const [url, download] of downloads) {
      clearTimeout(download.timer);
      URL.revokeObjectURL(url);
      release(download.size);
    }
    downloads.clear();
    window.removeEventListener("popstate", popstate);
    window.removeEventListener("pagehide", stop);
  };
  const notice = (code: string) => {
    if (closed) return;
    stop();
    location.replace(
      `/~shell/notice/${code}?return=${encodeURIComponent(location.pathname + location.search + location.hash)}`
    );
  };
  const stale = () => {
    if (closed) return;
    const url = new URL(location.href);
    if (url.searchParams.get("__patchy_shell_reload") === "1") return notice("shell_outdated");
    stop();
    url.searchParams.set("__patchy_shell_reload", "1");
    location.replace(url.href);
  };
  const send = (message: unknown, transfer: Transferable[] = []) => {
    if (closed) return;
    try {
      port?.postMessage(message, transfer);
    } catch {
      stop();
    }
  };
  const failure = (id: string, error: Refusal) => {
    send({
      v: wire,
      id,
      kind: "error",
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId })
      }
    });
    if (error.code === "shell_outdated") stale();
    else if (
      error.code === "session_expired" ||
      error.code === "principal_changed" ||
      error.code === "access_denied"
    )
      notice(error.code);
  };
  const route = () => {
    const path = location.pathname;
    return base && path.startsWith(base + "/") ? path.slice(base.length) : "/";
  };
  const popstate = () => {
    if (ready) send({ v: wire, kind: "event", event: "route", data: { path: route() } });
  };
  const bootstrapTimer = window.setTimeout(() => notice("bootstrap_failed"), 10_000);
  if (!patchId || !versionId || !nonce || !base || !contentSrc) return notice("bootstrap_failed");
  if (wire !== WIRE_VERSION) return stale();

  /** Stream into a bounded buffer; reservations include both chunks and the final contiguous copy. */
  const readBody = async (response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> => {
    if (!response.body) return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let copyReservation = 0;
    try {
      const declared = Number(response.headers.get("Content-Length"));
      if (declared > limit) throw tooLarge(limit);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (closed) throw lost();
        if (chunk.value.byteLength > limit - length) throw tooLarge(limit);
        reserve(chunk.value.byteLength);
        length += chunk.value.byteLength;
        chunks.push(chunk.value);
      }
      reserve(length);
      copyReservation = length;
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      copyReservation = 0;
      return bytes;
    } finally {
      release(length + copyReservation);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  const runtime = async (op: Operation, args: unknown, bytes?: ArrayBuffer): Promise<Reply> => {
    if (closed) throw lost();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 35_000);
    let responseBytes = 0;
    try {
      const headers = new Headers({
        "X-Patchy-Wire": String(wire),
        "X-Patchy-Principal": JSON.stringify(principal)
      });
      const init: RequestInit = {
        credentials: "same-origin",
        redirect: "error",
        // Preserve exact-Origin admission despite the shell document's no-referrer policy.
        referrerPolicy: "same-origin",
        headers,
        signal: controller.signal
      };
      let url = "/api/runtime/call";
      if (op === "files.get" || op === "files.put") {
        const file = args as { store: string; name: string; contentType?: string };
        url =
          "/api/runtime/files/" +
          [patchId, versionId, file.store, ...file.name.split("/")]
            .map(encodeURIComponent)
            .join("/");
        init.method = op === "files.get" ? "GET" : "PUT";
        if (op === "files.put") {
          headers.set("Content-Type", file.contentType!);
          init.body = bytes;
        }
      } else {
        init.method = "POST";
        headers.set("Content-Type", "application/json");
        const body = { patchId, versionId, principal, wire, op, args };
        jsonBytes(body, runtimeBodyLimit(op));
        init.body = JSON.stringify(body);
      }
      const response = await fetch(url, init);
      if (closed) throw lost();
      const data = await readBody(
        response,
        op === "files.get" && response.ok ? MAX_FILE : runtimeByteLimits.resultBytes
      );
      responseBytes = data.byteLength;
      if (op === "files.get" && response.ok) {
        const heldBytes = responseBytes;
        responseBytes = 0; // The caller owns this reservation until transfer or download revocation.
        return {
          value: {
            contentType: response.headers.get("Content-Type") ?? "application/octet-stream"
          },
          bytes: data.buffer,
          heldBytes
        };
      }
      if (op === "files.put" && response.ok) return { value: null, heldBytes: 0 };
      // Account for decoded UTF-16 text and the JSON object while the wire buffer remains held.
      reserve(data.byteLength * 3);
      responseBytes += data.byteLength * 3;
      let result: unknown;
      try {
        result = JSON.parse(decoder.decode(data));
      } catch {
        throw lost();
      }
      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        const error = decodeFailure(result);
        throw new Refusal(error.code, error.error, error.details, error.correlationId);
      }
      if (
        !response.ok ||
        !result ||
        typeof result !== "object" ||
        !("ok" in result) ||
        result.ok !== true ||
        !("value" in result)
      )
        throw lost();
      const heldBytes = responseBytes;
      responseBytes = 0;
      return { value: result.value, heldBytes };
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw lost();
    } finally {
      release(responseBytes);
      clearTimeout(timeout);
    }
  };
  const identify = () => {
    identity ??= runtime("me", {}).then(({ value, heldBytes }) => {
      if (!isMe(value)) {
        release(heldBytes);
        throw lost();
      }
      principal = value === null ? null : { userId: value.user.id };
      // The cached identity remains accounted for until this document closes.
      return value;
    });
    return identity;
  };
  const handle = async (data: unknown) => {
    if (closed) return;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const message = data as Record<string, unknown>;
    if (!ready) {
      if (message.kind !== "ready" || message.nonce !== nonce) return;
      if (message.wire !== wire) return stale();
      ready = true;
      clearTimeout(bootstrapTimer);
      // This is always the first runtime call, including for anonymous public shells.
      void identify().catch((error: unknown) => {
        if (
          error instanceof Refusal &&
          (error.code === "session_expired" ||
            error.code === "principal_changed" ||
            error.code === "access_denied")
        )
          notice(error.code);
        else if (error instanceof Refusal && error.code === "shell_outdated") stale();
        else notice("bootstrap_failed");
      });
      return;
    }
    const id = message.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) return;
    let reserved = 0;
    let admitted = false;
    let replyBytes = 0;
    try {
      if (seen.has(id)) {
        failure(
          id,
          new Refusal("invalid_request", "Request ids cannot be reused within a document.")
        );
        stop();
        return;
      }
      if (message.v !== wire)
        throw new Refusal("shell_outdated", "The bundle and shell wire versions differ.");
      if (typeof message.op !== "string" || message.op.length > 64) throw invalid();
      for (const key in message) {
        if (!Object.hasOwn(message, key)) continue;
        if (key !== "v" && key !== "id" && key !== "op" && key !== "args" && key !== "bytes")
          throw invalid();
      }
      const op = message.op;
      if (op !== "route.set" && op !== "download" && !Object.hasOwn(runtimeOperations, op))
        throw invalid();
      if (pending.size >= MAX_PENDING)
        throw new Refusal(
          "too_many_requests",
          `At most ${MAX_PENDING} requests may be outstanding.`
        );
      const payload = message.bytes;
      if (op === "files.put" ? !(payload instanceof ArrayBuffer) : payload !== undefined)
        throw invalid();
      const bytes = payload as ArrayBuffer | undefined;
      if (bytes && bytes.byteLength > MAX_FILE) throw tooLarge(MAX_FILE);
      const size = jsonBytes({ v: message.v, id, op, args: message.args }, runtimeBodyLimit(op));
      const requestBytes = size * 3 + (bytes?.byteLength ?? 0);
      reserve(requestBytes);
      reserved = requestBytes;
      // Account for the retained id plus the Set entry, not only in-flight request bodies.
      reserve(id.length * 2 + 64);
      seen.add(id);
      pending.add(id);
      admitted = true;
      let request: RuntimeRequest | undefined;
      let path: string | undefined;
      try {
        if (op === "route.set") path = routePath(decodeRoute(message.args).path);
        else
          request = decodeRequest({ op: op === "download" ? "files.get" : op, args: message.args });
      } catch (error) {
        throw error instanceof Refusal ? error : invalid();
      }
      const me = await identify();
      if (closed) return;
      let reply: Reply;
      if (op === "route.set") {
        const next = new URL(location.href);
        next.pathname = base + path!;
        history.pushState(null, "", next);
        reply = { value: null, heldBytes: 0 };
      } else if (op === "me") reply = { value: me, heldBytes: 0 };
      else reply = await runtime(request!.op, request!.args, bytes);
      replyBytes = reply.heldBytes;
      if (closed) return;
      if (op === "download" && reply.bytes) {
        // Blob storage is a second held copy until the transferred response buffer is released.
        reserve(reply.bytes.byteLength);
        const file = request!.args as { name: string };
        let url: string;
        try {
          url = URL.createObjectURL(new Blob([reply.bytes], { type: "application/octet-stream" }));
        } catch (error) {
          release(reply.bytes.byteLength);
          throw error;
        }
        const timer = window.setTimeout(() => {
          URL.revokeObjectURL(url);
          const download = downloads.get(url);
          if (download) {
            release(download.size);
            downloads.delete(url);
          }
        }, 10_000);
        downloads.set(url, { size: reply.bytes.byteLength, timer });
        const anchor = Object.assign(document.createElement("a"), {
          href: url,
          download: file.name.split("/").at(-1)!
        });
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        reply = { value: null, heldBytes: 0 };
      }
      send(
        {
          v: wire,
          id,
          kind: "result",
          value: reply.value,
          ...(reply.bytes ? { bytes: reply.bytes } : {})
        },
        reply.bytes ? [reply.bytes] : []
      );
    } catch (error) {
      failure(id, error instanceof Refusal ? error : lost());
    } finally {
      release(replyBytes);
      if (admitted) pending.delete(id);
      release(reserved);
    }
  };
  frame.addEventListener("load", () => {
    if (closed) return;
    if (issued) return stop();
    issued = true;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (event: MessageEvent<unknown>) => {
      void handle(event.data);
    };
    port.onmessageerror = stop;
    port.start();
    try {
      frame.contentWindow!.postMessage(
        { v: wire, kind: "bootstrap", nonce, route: frame.dataset.route ?? route() },
        "*",
        [channel.port2]
      );
    } catch {
      notice("bootstrap_failed");
    }
  });
  window.addEventListener("popstate", popstate);
  window.addEventListener("pagehide", stop, { once: true });
  // Install the one-shot load handoff before permitting the initial document to load.
  frame.src = contentSrc;
}

const frame = document.getElementById("patch");
if (frame instanceof HTMLIFrameElement) mount(frame);
