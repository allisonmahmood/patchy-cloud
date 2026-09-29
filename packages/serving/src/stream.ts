/// <reference lib="dom" />
// @effect-diagnostics globalTimers:off globalFetch:off globalRandom:off globalDate:off
// This browser adapter owns fetch, visibility, timers, retry deadlines and jitter without an Effect runtime.
import {
  RuntimeFailure,
  RuntimeStreamFrame,
  limitRefusal,
  type RuntimePrincipal,
  type RuntimeSubscription,
  type RuntimeSubscriptionRequest
} from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import * as Schema from "effect/Schema";
import { createStreamStatus } from "./stream-status.js";

const decodeFrame = Schema.decodeUnknownSync(RuntimeStreamFrame);
const decodeFailure = Schema.decodeUnknownSync(RuntimeFailure);

export interface DocumentStream {
  replay(): void;
  subscribe(subscription: RuntimeSubscription, bytes: number): void;
  unsubscribe(id: string): void;
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
  readonly executionState: (
    state: "starting" | "ready" | "failed",
    failure?: Extract<RuntimeStreamFrame, { readonly type: "start_failed" }>
  ) => void;
  readonly reserve: (bytes: number) => void;
  readonly release: (bytes: number) => void;
}): DocumentStream {
  const status = createStreamStatus(
    options.frame,
    options.versionId,
    options.tier,
    options.base,
    () => retryBinding()
  );
  const url = new URL("/api/runtime/stream", location.origin);
  url.searchParams.set("patchId", options.patchId);
  url.searchParams.set("versionId", options.versionId);
  url.searchParams.set("documentId", options.documentId);
  let closed = false;
  let suspended = false;
  let controller: AbortController | undefined;
  let retryTimer: number | undefined;
  let hiddenTimer: number | undefined;
  let reconciliationTimer: number | undefined;
  let reconciliationAttempts = 0;
  let failures = 0;
  let refreshAttempts = 0;
  let bindingFailures = 0;
  let bindingRetryAt = 0;
  let execution: "starting" | "ready" | "failed" = options.tier === 2 ? "starting" : "ready";
  let hello: Extract<RuntimeStreamFrame, { readonly type: "hello" }> | undefined;
  let helloAt = 0;
  let served: Extract<RuntimeStreamFrame, { readonly type: "served" }> | undefined;
  let handlers: Extract<RuntimeStreamFrame, { readonly type: "handlers" }> | undefined;

  let sequence = 0;
  let admitted = -1;
  let generation: string | undefined;
  const desired = new Map<
    string,
    { subscription: RuntimeSubscription; answered: boolean; fenceSequence: number; bytes: number }
  >();
  const reconciled = () => {
    if (generation === undefined || admitted !== sequence) {
      scheduleReconciliation();
      return;
    }
    for (const entry of desired.values()) {
      if (!entry.answered) {
        scheduleReconciliation();
        return;
      }
    }
    clearTimeout(reconciliationTimer);
    reconciliationTimer = undefined;
    reconciliationAttempts = 0;
    status.connected();
  };
  const forget = (id: string) => {
    const entry = desired.get(id);
    if (!entry) return false;
    desired.delete(id);
    options.release(entry.bytes);
    return true;
  };
  const post = async (request: RuntimeSubscriptionRequest) => {
    const current = controller;
    if (!current || current.signal.aborted || suspended || closed) return;
    let bytes = 0;
    try {
      const body = JSON.stringify(request);
      options.reserve(body.length * 2);
      bytes = body.length * 2;
      const response = await fetch(new URL("/api/runtime/subscriptions", location.origin), {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Patchy-Wire": String(options.wire),
          "X-Patchy-Principal": JSON.stringify(options.principal)
        },
        body,
        signal: current.signal
      });
      if (!response.ok) throw new Error("Subscription reconciliation was refused.");
      // The SSE admitted frame is authoritative, not this HTTP acknowledgement.
      void response.body?.cancel().catch(() => {});
    } catch {
      if (
        controller === current &&
        generation === request.generation &&
        sequence === request.sequence
      )
        current.abort();
    } finally {
      options.release(bytes);
    }
  };
  const envelope = () => ({
    patchId: options.patchId,
    versionId: options.versionId,
    documentId: options.documentId,
    generation: generation!,
    sequence
  });
  const replace = () => {
    if (generation === undefined) return;
    admitted = -1;
    for (const entry of desired.values()) {
      entry.answered = false;
      entry.fenceSequence = sequence;
    }
    status.connecting();
    void post({
      ...envelope(),
      type: "replace",
      subscriptions: Array.from(desired.values(), (entry) => entry.subscription)
    });
    scheduleReconciliation();
  };
  const scheduleReconciliation = () => {
    if (closed || suspended || generation === undefined || reconciliationTimer !== undefined)
      return;
    const delay = Math.min(
      registry["subscriptions.reconcile.interval"].default,
      1_000 * 2 ** Math.min(reconciliationAttempts++, 5)
    );
    reconciliationTimer = window.setTimeout(() => {
      reconciliationTimer = undefined;
      replace();
    }, delay);
  };
  const startExecution = () => {
    if (options.tier !== 2) return;
    const failed = execution === "failed";
    execution = "starting";
    options.executionState("starting");
    status.starting(failed);
  };
  const retryBinding = () => {
    if (closed || suspended || execution !== "failed") return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    bindingRetryAt = 0;
    controller?.abort();
    controller = undefined;
    void connect();
  };
  const connect = async () => {
    if (closed || suspended) return;
    // The first call can arrive before any stream bytes. Resume and bind retries need the
    // same hold; a normal transport reconnect keeps an already-ready task usable.
    if (execution !== "ready") startExecution();
    generation = undefined;
    admitted = -1;
    clearTimeout(reconciliationTimer);
    reconciliationTimer = undefined;
    reconciliationAttempts = 0;
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
            generation = frame.generation;
            sequence = 0;
            replace();
          } else if (frame.type === "served") {
            served = frame;
            status.served(frame);
          } else if (frame.type === "handlers") {
            handlers = frame;
          }
          if (frame.type === "starting") {
            startExecution();
          } else if (frame.type === "ready") {
            execution = "ready";
            bindingFailures = 0;
            bindingRetryAt = 0;
            options.executionState("ready");
            status.ready();
            reconciled();
          } else if (frame.type === "start_failed") {
            execution = "failed";
            const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(bindingFailures++, 5));
            bindingRetryAt = Date.now() + Math.max(frame.retryAfter * 1_000, backoff);
            options.executionState("failed", frame);
            status.startFailed();
            options.send(frame);
            // A fresh stream requests another bounded bind attempt. Failed calls are gone;
            // only newly requested work can wait for its ready.
            return;
          }
          if (frame.type === "admitted") {
            admitted = Math.max(admitted, frame.sequence);
            reconciled();
          } else if (frame.type === "resync_required") {
            replace();
          } else if (frame.type === "snapshot" || frame.type === "up-to-date") {
            const entry = desired.get(frame.id);
            if (!entry) continue;
            if (
              entry.subscription.revision !== undefined &&
              BigInt(frame.revision) < BigInt(entry.subscription.revision)
            )
              continue;
            entry.subscription = {
              ...entry.subscription,
              revision: frame.revision,
              vector: frame.vector
            };
            entry.answered = admitted >= entry.fenceSequence;
            reconciled();
          } else if (frame.type === "error") {
            const entry = desired.get(frame.id);
            if (!entry) continue;
            if (frame.permanent) forget(frame.id);
            else {
              // A refusal answers this fence. Keep its last data and let the server retry.
              entry.answered = admitted >= entry.fenceSequence;
            }
            reconciled();
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
        generation = undefined;
        admitted = -1;
        clearTimeout(reconciliationTimer);
        reconciliationTimer = undefined;
        for (const entry of desired.values()) entry.answered = false;
        if (!closed && !suspended) {
          status.connecting();
          const ceiling = Math.min(30_000, 500 * 2 ** Math.min(failures++, 6));
          const delay = Math.max(
            ceiling * (0.5 + Math.random() * 0.5),
            bindingRetryAt - Date.now()
          );
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined;
            void connect();
          }, delay);
        }
      }
    }
  };
  const visibility = () => {
    status.visibility(document.hidden);
    clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
    if (document.hidden) {
      hiddenTimer = window.setTimeout(() => {
        hiddenTimer = undefined;
        suspended = true;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        clearTimeout(reconciliationTimer);
        reconciliationTimer = undefined;
        controller?.abort();
        // The company can be released while this document is suspended.
        if (options.tier === 2) {
          execution = "starting";
          options.executionState("starting");
        }
      }, registry["stream.hidden.suspend"].default);
    } else if (suspended) {
      suspended = false;
      refreshAttempts = 0;
      if (options.tier === 2) status.starting(true);
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
    subscribe(subscription, bytes) {
      if (closed || desired.has(subscription.id)) return;
      if (desired.size >= registry["subscriptions.document"].default) {
        options.send({
          type: "error",
          id: subscription.id,
          permanent: true,
          error: {
            ok: false,
            source: "patchy",
            error: "The document subscription limit was reached.",
            ...limitRefusal("subscriptions.document")
          }
        });
        return;
      }
      options.reserve(bytes);
      desired.set(subscription.id, {
        subscription,
        answered: false,
        fenceSequence: generation === undefined ? 0 : sequence + 1,
        bytes
      });
      if (generation !== undefined) {
        sequence++;
        void post({ ...envelope(), type: "subscribe", subscription });
      }
      scheduleReconciliation();
    },
    unsubscribe(id) {
      if (!forget(id)) return;
      if (generation !== undefined) {
        sequence++;
        void post({ ...envelope(), type: "unsubscribe", id });
      }
      reconciled();
    },
    replay() {
      // Only lifecycle state is replayed when the bound port becomes ready. The clock includes
      // bootstrap time spent waiting for the frame, without changing the generation.
      if (hello)
        options.send({ ...hello, serverTime: hello.serverTime + performance.now() - helloAt });
      if (served) options.send(served);
      if (handlers) options.send(handlers);
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(hiddenTimer);
      clearTimeout(reconciliationTimer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      controller?.abort();
      status.close();
      for (const id of desired.keys()) forget(id);
    }
  };
}
