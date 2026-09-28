/// <reference lib="dom" />
// @effect-diagnostics globalTimers:off globalFetch:off globalRandom:off
// This browser adapter owns fetch, visibility, timers and retry jitter without an Effect runtime.
import { RuntimeFailure, RuntimeStreamFrame, type RuntimePrincipal } from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import * as Schema from "effect/Schema";
import { createStreamStatus } from "./stream-status.js";

const decodeFrame = Schema.decodeUnknownSync(RuntimeStreamFrame);
const decodeFailure = Schema.decodeUnknownSync(RuntimeFailure);

export interface DocumentStream {
  replay(): void;
  close(): void;
}

declare global {
  interface Window {
    patchySession?: {
      refresh(): Promise<"refreshed" | "signed-out" | "unavailable">;
    };
  }
}

export function openDocumentStream(options: {
  readonly frame: HTMLIFrameElement;
  readonly patchId: string;
  readonly versionId: string;
  readonly base: string;
  readonly documentId: string;
  readonly tier: number;
  readonly wire: number;
  readonly principal: RuntimePrincipal;
  readonly send: (frame: RuntimeStreamFrame) => void;
  readonly notice: (code: string) => void;
  readonly stale: () => void;
}): DocumentStream {
  const status = createStreamStatus(options.frame, options.versionId, options.tier, options.base);
  const url = new URL("/api/runtime/stream", location.origin);
  url.searchParams.set("patchId", options.patchId);
  url.searchParams.set("versionId", options.versionId);
  url.searchParams.set("documentId", options.documentId);
  let closed = false;
  let suspended = false;
  let controller: AbortController | undefined;
  let retryTimer: number | undefined;
  let hiddenTimer: number | undefined;
  let failures = 0;
  let refreshAttempts = 0;
  let hello: Extract<RuntimeStreamFrame, { readonly type: "hello" }> | undefined;
  let helloAt = 0;
  let served: Extract<RuntimeStreamFrame, { readonly type: "served" }> | undefined;

  const connect = async () => {
    if (closed || suspended) return;
    status.connecting();
    const current = new AbortController();
    controller = current;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers = new Headers({
        Accept: "text/event-stream",
        "X-Patchy-Wire": String(options.wire),
        "X-Patchy-Principal": JSON.stringify(options.principal)
      });
      if (hello) headers.set("X-Patchy-Generation", hello.generation);
      const response = await fetch(url, {
        method: "GET",
        headers,
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "same-origin",
        cache: "no-store",
        signal: current.signal
      });
      if (!response.ok) {
        const failure = decodeFailure(await response.json());
        if (failure.code === "session_refresh_required" && refreshAttempts < 3) {
          refreshAttempts++;
          const result = await window.patchySession?.refresh();
          if (!closed && !current.signal.aborted && result === "signed-out")
            options.notice("session_expired");
        } else if (
          failure.code === "session_expired" ||
          failure.code === "principal_changed" ||
          failure.code === "access_denied"
        )
          options.notice(failure.code);
        else if (failure.code === "shell_outdated") options.stale();
        else if (failure.code === "limit_exceeded" && failure.limitId === "stream.documents")
          options.notice("stream_limit");
        // A conflict can come from an abandoned socket whose hello never arrived.
        // Keep the existing generation fence and retry until that socket closes.
        return;
      }
      if (!response.body || !response.headers.get("Content-Type")?.startsWith("text/event-stream"))
        return;
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed && !current.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length * 2 > registry["stream.buffer.bytes"].default)
          throw new Error("The stream frame exceeds the buffer limit.");
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
          const event = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          const frame = decodeFrame(JSON.parse(data));
          if (closed || current.signal.aborted) return;
          if (frame.type === "hello") {
            hello = frame;
            helloAt = performance.now();
            failures = 0;
            refreshAttempts = 0;
            // Until revision fences land, hello is the reopen/reconciliation boundary.
            status.connected();
          } else if (frame.type === "served") {
            served = frame;
            status.served(frame);
          }
          options.send(frame);
          if (
            frame.type === "revoked" ||
            frame.type === "session_expired" ||
            frame.type === "access_denied" ||
            frame.type === "principal_changed"
          ) {
            options.notice(frame.type);
            return;
          }
          if (frame.type === "closed") {
            if (frame.reason === "replaced") options.notice("stream_replaced");
            return;
          }
        }
      }
    } catch {
      // A drain, transport failure or malformed stream reconnects, never replays a call.
    } finally {
      current.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (controller === current) {
        controller = undefined;
        if (!closed && !suspended) {
          status.connecting();
          const ceiling = Math.min(30_000, 500 * 2 ** Math.min(failures++, 6));
          const delay = ceiling * (0.5 + Math.random() * 0.5);
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined;
            void connect();
          }, delay);
        }
      }
    }
  };
  const visibility = () => {
    clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
    if (document.hidden) {
      hiddenTimer = window.setTimeout(() => {
        hiddenTimer = undefined;
        suspended = true;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        controller?.abort();
      }, registry["stream.hidden.suspend"].default);
    } else if (suspended) {
      suspended = false;
      refreshAttempts = 0;
      // Detach the aborted read before reconnecting; its finalizer cannot retry this generation.
      controller = undefined;
      void connect();
    }
  };
  const online = () => {
    refreshAttempts = 0;
  };
  window.addEventListener("online", online);
  document.addEventListener("visibilitychange", visibility);
  visibility();
  void connect();
  return {
    replay() {
      // Only lifecycle state is replayed when the bound port becomes ready. The clock includes
      // bootstrap time spent waiting for the frame, without changing the generation.
      if (hello)
        options.send({ ...hello, serverTime: hello.serverTime + performance.now() - helloAt });
      if (served) options.send(served);
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(hiddenTimer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      controller?.abort();
      status.close();
    }
  };
}
