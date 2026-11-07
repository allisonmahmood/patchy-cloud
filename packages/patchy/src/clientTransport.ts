/// <reference lib="es2024.promise" />
// @effect-diagnostics globalTimers:off globalFetch:off
// Browser adapters deliberately use platform APIs, with no Effect runtime in the bundle.
import { PatchyError, decodeError } from "./clientError.js";
import { HandlerError, decodeHandlerError } from "./handlerError.js";
import { WIRE_VERSION } from "./release.js";
import type { QueryDriver, QueryFrame } from "./queryRegistry.js";
import { serverReplyTimeoutMs as serverReplyTimeout } from "@patchy/api/query-config";
import type { HandlerKindName } from "./server.js";

export type Operation =
  | "me"
  | "server.call"
  | "route.set"
  | "shortcuts.setting"
  | "download"
  | "download.generated"
  | "files.download"
  | "files.redeem"
  | "files.stage"
  | "files.discard"
  | "subscriptions.subscribe"
  | "subscriptions.unsubscribe"
  | `tables.${"get" | "getMany" | "list" | "insert" | "insertMany" | "update" | "delete"}`
  | `members.${"get" | "getMany" | "list" | "search"}`
  | `shared.${"get" | "getMany" | "list"}`
  | "shared.download"
  | `shared.files.${"get" | "list" | "stat"}`
  | `files.${"get" | "put" | "list" | "stat" | "delete"}`
  | `postgres.${"get" | "getMany" | "list" | "query"}`
  | "posthog.query"
  | `pidgeon.${"read" | "write"}`
  | `attio.${"listRecords" | "getRecord" | "getManyRecords" | "listEntries" | "getEntry" | "listMembers"}`;
export type Call = (op: Operation, args: unknown, bytes?: Uint8Array) => Promise<unknown>;
export interface Route {
  get(): Promise<string>;
  set(path: string): Promise<null>;
  subscribe(listener: (path: string) => void): () => void;
}
export interface Transport {
  readonly call: Call;
  readonly route: Route;
  readonly queries: QueryDriver;
  /** Wait for the document-bound transport and its trusted handler descriptors. */
  ready(): Promise<void>;
  /** Current server-clock estimate from hello, unavailable before the document stream opens. */
  serverTime(): number | undefined;
  /** Wait for hello without substituting the browser's wall clock. */
  waitForServerTime(): Promise<number>;
  /** The loaded version's host-inspected kind, never inferred from the caller's types. */
  handlerKind(name: string): HandlerKindName | undefined;
  close(): void;
}
/** A guest is someone from another company the patch is shared with, in the patch's company. */
export interface Me {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly company: { readonly id: string; readonly handle: string; readonly name: string };
  readonly admin: boolean;
  readonly guest?: true;
}

/** Structural subset implemented by browser MessagePort and the fake-port acceptance seam. */
export interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  start(): void;
  close(): void;
}
/** Transport provenance is local to the adapter, never inferred from a runtime refusal code. */
export class LostReply extends PatchyError<"unknown_outcome"> {}
const lost = () => new LostReply("unknown_outcome", "The runtime reply was lost.", {});

/**
 * How a transport still waiting for its port holds a call: in one queue for every client on it,
 * sent in call order the moment the port arrives, before anything made after can go out. A
 * client's `wanted` is read then, so a call from a client that has closed since never goes out.
 */
type Hold = <T>(dispatch: () => Promise<T>, wanted?: () => boolean) => Promise<T>;
const holds = new WeakMap<Transport, Hold>();

type HandlerKinds = Readonly<Record<string, HandlerKindName>>;
const readHandlerKinds = (value: unknown): HandlerKinds | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kinds: Record<string, HandlerKindName> = Object.create(null);
  for (const [name, kind] of Object.entries(value)) {
    if (kind !== "query" && kind !== "mutation" && kind !== "action") return undefined;
    kinds[name] = kind;
  }
  return kinds;
};

export function createPortTransport(
  port: Port,
  options: {
    readonly timeoutMs?: number;
    readonly route?: string;
    readonly handlerKinds?: unknown;
  } = {}
): Transport {
  let handlerKinds = readHandlerKinds(options.handlerKinds);
  let sequence = 0;
  let closed = false;
  let path = options.route ?? "/";
  let clock: { readonly serverTime: number; readonly receivedAt: number } | undefined;
  const serverTime = () =>
    closed || clock === undefined
      ? undefined
      : clock.serverTime + performance.now() - clock.receivedAt;
  const clockWaiters = new Set<{
    resolve(time: number): void;
    reject(error: unknown): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const listeners = new Set<(path: string) => void>();
  const queries = new Map<string, (frame: QueryFrame) => void>();
  let querySequence = 0;
  const notify = (listener: (path: string) => void, value: string) => {
    queueMicrotask(() => {
      if (!closed && listeners.has(listener)) listener(value);
    });
  };
  // Adopts a set's request path on acknowledgement; the shell's route event then corrects it to the
  // canonical decoded form. An unchanged path notifies nobody, so a set reports once.
  const updateRoute = (value: string) => {
    if (value === path) return;
    path = value;
    for (const listener of listeners) notify(listener, value);
  };
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      op: Operation;
      reject(error: unknown): void;
      timer: ReturnType<typeof setTimeout> | undefined;
      path?: string;
    }
  >();
  const onMessage: EventListener = (event) => {
    const reply: unknown = (event as MessageEvent).data;
    if (reply === null || typeof reply !== "object") return;
    const value = reply as Record<string, unknown>;
    if (value.v !== WIRE_VERSION) return;
    if (value.kind === "event") {
      const data = value.data;
      if (
        value.event === "route" &&
        data !== null &&
        typeof data === "object" &&
        "path" in data &&
        typeof data.path === "string"
      )
        updateRoute(data.path);
      else if (
        value.event === "stream" &&
        data !== null &&
        typeof data === "object" &&
        "type" in data &&
        data.type === "hello" &&
        "generation" in data &&
        typeof data.generation === "string" &&
        "serverTime" in data &&
        typeof data.serverTime === "number" &&
        Number.isFinite(data.serverTime)
      ) {
        clock = { serverTime: data.serverTime, receivedAt: performance.now() };
        for (const waiter of clockWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(data.serverTime);
        }
        clockWaiters.clear();
      }
      if (value.event === "stream" && data !== null && typeof data === "object" && "type" in data) {
        const frame = data as Record<string, unknown>;
        if (frame.type === "handlers") {
          const kinds = readHandlerKinds(frame.kinds);
          if (kinds !== undefined) handlerKinds = kinds;
          return;
        }
        if (typeof frame.id === "string") {
          const listener = queries.get(frame.id);
          if (!listener) return;
          if (frame.type === "error") {
            const error = decodeHandlerError(frame.error) ?? decodeError(frame.error);
            if (!error || typeof frame.permanent !== "boolean") return;
            if (frame.permanent) queries.delete(frame.id);
            listener({ status: "error", error, permanent: frame.permanent });
          } else if (typeof frame.revision === "string" && /^\d+$/.test(frame.revision)) {
            if (frame.type === "snapshot")
              listener({ status: "ready", revision: frame.revision, data: frame.result });
            else if (frame.type === "up-to-date")
              listener({ status: "up-to-date", revision: frame.revision });
          }
        }
      }
      return;
    }
    if (typeof value.id !== "string") return;
    const request = pending.get(value.id);
    if (!request) return;
    if (value.kind !== "result" && value.kind !== "error") return;
    clearTimeout(request.timer);
    pending.delete(value.id);
    if (value.kind === "error") {
      const error =
        (request.op === "server.call" ? decodeHandlerError(value.error) : undefined) ??
        decodeError(value.error, request.op) ??
        new PatchyError("invalid_request", "The broker returned an invalid error.", {});
      request.reject(
        value.replyLost === true && error instanceof PatchyError && error.code === "unknown_outcome"
          ? lost()
          : error
      );
    } else if (value.bytes instanceof ArrayBuffer || value.bytes instanceof Uint8Array) {
      request.resolve({
        ...(value.value as object),
        bytes: value.bytes instanceof Uint8Array ? value.bytes : new Uint8Array(value.bytes)
      });
    } else {
      if (request.path !== undefined) updateRoute(request.path);
      request.resolve(value.value);
    }
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
    for (const waiter of clockWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(lost());
    }
    clockWaiters.clear();
    listeners.clear();
    for (const listener of queries.values())
      listener({ status: "error", error: lost(), permanent: true });
    queries.clear();
  };
  port.addEventListener("message", onMessage);
  port.addEventListener("messageerror", close);
  port.addEventListener("close", close);
  port.start();
  const call: Call = (op, args, bytes) => {
    if (closed) return Promise.reject(lost());
    const id = String(++sequence);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    // A shell-local offer or question waits for the person, not a runtime reply deadline.
    const timer =
      op === "download.generated" || op === "shortcuts.setting"
        ? undefined
        : setTimeout(
            () => {
              pending.delete(id);
              reject(lost());
            },
            options.timeoutMs ?? (op === "server.call" ? serverReplyTimeout : 35_000)
          );
    pending.set(id, {
      op,
      resolve,
      reject,
      timer,
      ...(op === "route.set" &&
      args !== null &&
      typeof args === "object" &&
      "path" in args &&
      typeof args.path === "string"
        ? { path: args.path }
        : {})
    });
    const payload =
      bytes === undefined
        ? undefined
        : bytes.buffer instanceof ArrayBuffer &&
            bytes.byteOffset === 0 &&
            bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : new Uint8Array(bytes).buffer;
    try {
      port.postMessage(
        {
          v: WIRE_VERSION,
          id,
          op,
          args,
          ...(payload === undefined ? {} : { bytes: payload })
        },
        payload === undefined ? [] : [payload]
      );
    } catch {
      close();
    }
    return promise;
  };
  return {
    ready: () => (closed ? Promise.reject(lost()) : Promise.resolve()),
    handlerKind: (name) => (closed ? undefined : handlerKinds?.[name]),
    call,
    queries: {
      subscribe(request, onFrame) {
        if (closed) {
          onFrame({ status: "error", error: lost(), permanent: true });
          return () => {};
        }
        const id = `query-${++querySequence}`;
        queries.set(id, onFrame);
        void call("subscriptions.subscribe", { id, op: request.handler, args: request.args }).catch(
          (error: unknown) => {
            if (queries.get(id) !== onFrame) return;
            queries.delete(id);
            onFrame({
              status: "error",
              error: error instanceof Error ? error : lost(),
              permanent: true
            });
          }
        );
        return () => {
          if (!queries.delete(id) || closed) return;
          void call("subscriptions.unsubscribe", { id }).catch(() => {});
        };
      }
    },
    serverTime,
    waitForServerTime() {
      if (closed) return Promise.reject(lost());
      const time = serverTime();
      if (time !== undefined) return Promise.resolve(time);
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          clockWaiters.delete(waiter);
          reject(new PatchyError("timeout", "The document stream did not provide its clock.", {}));
        }, options.timeoutMs ?? 10_000)
      };
      clockWaiters.add(waiter);
      return promise;
    },
    route: {
      get: () => (closed ? Promise.reject(lost()) : Promise.resolve(path)),
      set: (path) => call("route.set", { path }) as Promise<null>,
      subscribe: (listener) => {
        if (closed) return () => {};
        const subscription = (path: string) => listener(path);
        listeners.add(subscription);
        notify(subscription, path);
        return () => {
          listeners.delete(subscription);
        };
      }
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
  // Calls made before the port arrives, from every client, in the order they were made.
  const held: Array<{ readonly send: () => void; readonly fail: (error: unknown) => void }> = [];
  const hold: Hold = <T>(dispatch: () => Promise<T>, wanted = () => true) => {
    const { promise, resolve: settle, reject: refuse } = Promise.withResolvers<T>();
    held.push({
      send: () => {
        if (wanted()) void dispatch().then(settle, refuse);
        else refuse(lost());
      },
      fail: refuse
    });
    return promise;
  };
  let bootstrapping = false;
  const fail = (error: unknown) => {
    holds.delete(self);
    for (const call of held.splice(0)) call.fail(error);
    reject(error);
  };
  if (!frame || frame.parent === frame) {
    reject(new PatchyError("shell_outdated", "This client must run inside the Patchy shell.", {}));
  } else {
    bootstrapping = true;
    const nonce = new URL(frame.location.href).searchParams.get("n");
    const timer = setTimeout(() => {
      removeBootstrap();
      fail(
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
      if (data.v !== WIRE_VERSION || event.ports.length !== 1 || typeof data.route !== "string") {
        removeBootstrap();
        fail(
          new PatchyError("shell_outdated", "The shell and bundle use different wire versions.", {})
        );
        return;
      }
      removeBootstrap();
      const port = event.ports[0]!;
      transport = createPortTransport(port, {
        ...options,
        route: data.route,
        handlerKinds: data.handlerKinds
      });
      try {
        port.postMessage({ kind: "ready", wire: WIRE_VERSION, nonce });
      } catch {
        transport.close();
        fail(lost());
        return;
      }
      // Everything called before the port goes out now, in order, before anything called after.
      holds.delete(self);
      for (const call of held.splice(0)) call.send();
      resolve(transport);
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
    fail(lost());
  };
  frame?.addEventListener("pagehide", close, { once: true });
  // A call goes out as it is made once the port is here; before that it waits in `held`.
  const send = <T>(dispatch: (connected: Transport) => Promise<T>): Promise<T> =>
    closed
      ? Promise.reject(lost())
      : transport !== undefined
        ? dispatch(transport)
        : holds.has(self)
          ? hold(() => send(dispatch))
          : ready.then(dispatch);
  const self: Transport = {
    ready: async () => {
      if (closed) throw lost();
      await ready;
      if (closed) throw lost();
    },
    call: (op, args, bytes) => send((connected) => connected.call(op, args, bytes)),
    serverTime: () => (closed ? undefined : transport?.serverTime()),
    waitForServerTime: async () => {
      if (closed) throw lost();
      return (await ready).waitForServerTime();
    },
    handlerKind: (name) => (closed ? undefined : transport?.handlerKind(name)),
    queries: {
      subscribe(request, onFrame) {
        let active = !closed;
        let unsubscribe: (() => void) | undefined;
        // In turn with the calls, so one made before the port goes out in its place.
        void send(async (connected) => {
          if (active && !closed) unsubscribe = connected.queries.subscribe(request, onFrame);
        }).catch((error: unknown) => {
          if (active)
            onFrame({
              status: "error",
              error: error instanceof Error ? error : lost(),
              permanent: true
            });
        });
        return () => {
          active = false;
          unsubscribe?.();
        };
      }
    },
    route: {
      get: async () => {
        if (closed) throw lost();
        return (await ready).route.get();
      },
      set: (path) => send((connected) => connected.route.set(path)),
      subscribe: (listener) => {
        let active = !closed;
        let unsubscribe: (() => void) | undefined;
        void ready.then(
          (transport) => {
            if (active && !closed) unsubscribe = transport.route.subscribe(listener);
          },
          () => {}
        );
        return () => {
          active = false;
          unsubscribe?.();
        };
      }
    },
    close
  };
  if (bootstrapping) holds.set(self, hold);
  return self;
}

// The document's one broker port, shared by tier 1 and tier 2 clients, handle-only hooks and
// `patchy/hotkeys`. Whichever asks first makes it, and the bootstrap it waits for comes once.
let documentTransport: Transport | undefined;
export const getDocumentTransport = (): Transport =>
  (documentTransport ??= createPostMessageTransport());

/**
 * One client's share of a transport. Closing it ends only what this client started: its waits for
 * the bootstrap or the server's clock reject as lost, and so does each call still waiting for the
 * bootstrap, which then never goes out, and each later call; its route listeners and query
 * subscriptions stop. A call already sent settles with its own outcome. Calls keep the order they
 * were made in, across the bootstrap and across clients. The transport, its port and every other
 * consumer of it stay open.
 */
export function createClientTransport(shared: Transport): Transport {
  let closed = false;
  const active = new Set<() => void>();
  const waiting = new Set<(error: unknown) => void>();
  const open = <T>(start: () => Promise<T>): Promise<T> =>
    closed ? Promise.reject(lost()) : start();
  // A wait this client gives up on as it closes, though the transport keeps waiting.
  const wait = <T>(start: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(lost());
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    waiting.add(reject);
    void start()
      .then(resolve, reject)
      .finally(() => waiting.delete(reject));
    return promise;
  };
  // A call goes out as it is made, unless the transport is still waiting for its port. Then it
  // waits in the transport's queue with every client's calls, and goes out in its turn if this
  // client is still open.
  const send = <T>(dispatch: () => Promise<T>): Promise<T> => {
    const hold = holds.get(shared);
    return hold === undefined ? open(dispatch) : wait(() => hold(dispatch, () => !closed));
  };
  // A subscription's stop, which closing calls too; either way it runs once.
  const track = (stop: () => void): (() => void) => {
    const end = () => {
      if (active.delete(end)) stop();
    };
    active.add(end);
    return end;
  };
  return {
    call: (op, args, bytes) => send(() => shared.call(op, args, bytes)),
    ready: () => wait(() => shared.ready()),
    serverTime: () => (closed ? undefined : shared.serverTime()),
    waitForServerTime: () => wait(() => shared.waitForServerTime()),
    handlerKind: (name) => (closed ? undefined : shared.handlerKind(name)),
    queries: {
      subscribe(request, onFrame) {
        if (closed) {
          onFrame({ status: "error", error: lost(), permanent: true });
          return () => {};
        }
        return track(
          shared.queries.subscribe(request, (frame) => {
            if (!closed) onFrame(frame);
          })
        );
      }
    },
    route: {
      get: () => send(() => shared.route.get()),
      set: (path) => send(() => shared.route.set(path)),
      subscribe: (listener) =>
        closed
          ? () => {}
          : track(
              shared.route.subscribe((path) => {
                if (!closed) listener(path);
              })
            )
    },
    close() {
      if (closed) return;
      closed = true;
      for (const reject of waiting) reject(lost());
      waiting.clear();
      for (const end of [...active]) end();
    }
  };
}

export interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly patchId: string;
  readonly versionId: string;
  readonly fetch?: typeof fetch;
  /** Test adapters must supply the host-inspected kinds for this exact version. */
  readonly handlerKinds?: HandlerKinds;
}
/** Test adapter only. Production bundles reach HTTP exclusively through the shell's broker. */
export function createHttpTransport(options: HttpTransportOptions): Transport {
  const fetcher = options.fetch ?? globalThis.fetch;
  const origin = new URL(options.baseUrl).origin;
  const handlerKinds = readHandlerKinds(options.handlerKinds);
  const controller = new AbortController();
  let identity: Promise<Me | null> | undefined;
  const browserOnly = () =>
    new PatchyError("invalid_request", "This operation requires the Patchy shell, not HTTP.", {});
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
    const file = args as {
      store: string;
      alias: string;
      name: string;
      handle: string;
      contentType?: string;
    };
    if (op === "files.stage") {
      const path = [options.patchId, options.versionId].map(encodeURIComponent).join("/");
      url = new URL(`/api/runtime/staged-files/${path}`, options.baseUrl);
      init.method = "PUT";
      headers.set("Content-Type", file.contentType!);
      init.body = bytes as BodyInit;
    } else if (op === "files.redeem") {
      const path = [options.patchId, options.versionId, file.handle]
        .map(encodeURIComponent)
        .join("/");
      url = new URL(`/api/runtime/file-handles/${path}`, options.baseUrl);
      init.method = "GET";
    } else if (op === "files.get" || op === "files.put" || op === "shared.files.get") {
      const shared = op === "shared.files.get";
      const path = [
        options.patchId,
        options.versionId,
        shared ? file.alias : file.store,
        ...file.name.split("/")
      ]
        .map(encodeURIComponent)
        .join("/");
      url = new URL(`/api/runtime/${shared ? "shared-files" : "files"}/${path}`, options.baseUrl);
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
      if (
        (op === "files.get" || op === "shared.files.get" || op === "files.redeem") &&
        response.ok
      ) {
        const encodedName =
          op === "files.redeem" ? response.headers.get("X-Patchy-File-Name") : null;
        if (op === "files.redeem" && encodedName === null) throw lost();
        return {
          bytes: new Uint8Array(await response.arrayBuffer()),
          ...(encodedName === null ? {} : { name: decodeURIComponent(encodedName) }),
          contentType: response.headers.get("Content-Type") ?? "application/octet-stream"
        };
      }
      if (op === "files.put" && response.ok) return null;
      const result: unknown = await response.json();
      if (result !== null && typeof result === "object" && "ok" in result && result.ok === false) {
        const error =
          (op === "server.call" && response.ok ? decodeHandlerError(result) : undefined) ??
          decodeError(result, op);
        if (error) throw error;
      }
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
      if (error instanceof PatchyError || error instanceof HandlerError) throw error;
      throw lost();
    }
  };
  return {
    ready: () => (controller.signal.aborted ? Promise.reject(lost()) : Promise.resolve()),
    serverTime: () => undefined,
    waitForServerTime: () => Promise.reject(browserOnly()),
    handlerKind: (name) => (controller.signal.aborted ? undefined : handlerKinds?.[name]),
    queries: {
      subscribe() {
        throw browserOnly();
      }
    },
    call: async (op, args, bytes) => {
      if (
        op === "route.set" ||
        op === "download" ||
        op === "shared.download" ||
        op === "files.download" ||
        op === "download.generated" ||
        op === "shortcuts.setting" ||
        op.startsWith("subscriptions.")
      )
        throw browserOnly();
      identity ??= dispatch("me", {}, null) as Promise<Me | null>;
      const me = await identity;
      if (op === "me") return me;
      return dispatch(op, args, me === null ? null : { userId: me.user.id }, bytes);
    },
    route: {
      get: () => Promise.reject(browserOnly()),
      set: () => Promise.reject(browserOnly()),
      subscribe: () => {
        throw browserOnly();
      }
    },
    close: () => controller.abort()
  };
}
