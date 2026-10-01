// @effect-diagnostics globalDate:off preferSchemaOverJson:off -- workerd request time and JSON HTTP framing are native Worker APIs.
import { WorkerEntrypoint } from "cloudflare:workers";
import * as GuestProtocol from "@patchy/api/guest";
import * as Schema from "effect/Schema";
import { parse } from "acorn";
import { full } from "acorn-walk";

interface Fetcher {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
interface Worker {
  getEntrypoint(name?: string, options?: { readonly props: object }): Fetcher;
}
interface Environment {
  readonly loader: {
    get(
      name: string,
      create: () => {
        compatibilityDate: string;
        compatibilityFlags: readonly string[];
        mainModule: string;
        modules: Record<string, string>;
        env: Record<string, never>;
        globalOutbound: Fetcher;
      }
    ): Worker;
  };
  readonly callbackUrls?: Readonly<Record<string, string>>;
  readonly [binding: string]: unknown;
}
interface AttemptReference extends GuestProtocol.Attempt {
  readonly serial: number;
}
interface LoaderContext {
  readonly exports: {
    Callbacks(options: { props: AttemptReference }): {
      call(operation: GuestProtocol.Callback): Promise<GuestProtocol.CallbackReply>;
    };
    Outbound(options: { props: object }): Fetcher;
  };
}
interface BoundWorker {
  readonly sha256: string;
  readonly bundle: string;
  readonly ready: Promise<boolean>;
}
interface LiveAttempt {
  readonly reference: AttemptReference;
  readonly callback: GuestProtocol.Invoke["callback"];
  readonly callbackService: Fetcher;
}
const strict = { onExcessProperty: "error" } as const;
const decodeBind = Schema.decodeUnknownSync(GuestProtocol.BindRequest, strict);
const decodeInvoke = Schema.decodeUnknownSync(GuestProtocol.Invoke, strict);
const decodeInspect = Schema.decodeUnknownSync(GuestProtocol.InspectRequest, strict);
const decodeInspectionReply = Schema.decodeUnknownSync(GuestProtocol.InspectionReply, strict);
const decodeGuestReply = Schema.decodeUnknownSync(GuestProtocol.GuestReply, strict);
const decodeCallback = Schema.decodeUnknownSync(GuestProtocol.Callback, strict);
const decodeCallbackReply = Schema.decodeUnknownSync(GuestProtocol.CallbackReply, strict);
const bound = new Map<string, BoundWorker>();
const attempts = new Map<number, LiveAttempt>();
const activeAttempts = new Set<string>();
let serial = 0;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const refusal = (
  code: "access_denied" | "handler_failed" | "invalid_request" | "timeout" | "source_unavailable",
  error: string
) => ({ ok: false, source: "patchy", code, error }) as const;
const fileTooLarge = {
  ok: false,
  source: "patchy",
  error: "The file exceeds the callback byte limit.",
  ...GuestProtocol.callbackFileLimit
} as const;
const endedCallback = (reference: AttemptReference) =>
  Date.now() >= reference.deadline
    ? refusal("timeout", "The invocation callback deadline has passed.")
    : refusal("access_denied", "The invocation callback has ended.");
const identity = (binding: GuestProtocol.BundleBinding) =>
  JSON.stringify([binding.companyId, binding.patchId, binding.versionId]);

async function describe(worker: Worker): Promise<GuestProtocol.InspectionReply> {
  const response = await worker.getEntrypoint(undefined, { props: {} }).fetch("http://guest/", {
    method: "POST",
    body: JSON.stringify({
      wire: GuestProtocol.wireVersion,
      type: "describe"
    } satisfies GuestProtocol.GuestRequest)
  });
  return decodeInspectionReply(await response.json());
}

function load(env: Environment, ctx: LoaderContext, name: string, bundle: string): Worker {
  return env.loader.get(name, () => {
    // Built-in modules are not all governed by nodejs_compat. Require the closed
    // artifact promised by wire 1, including in unreachable dynamic-import branches.
    full(parse(bundle, { ecmaVersion: "latest", sourceType: "module" }), (node) => {
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ImportExpression" ||
        node.type === "ExportAllDeclaration" ||
        (node.type === "ExportNamedDeclaration" && "source" in node && node.source !== null)
      )
        throw new Error("Server bundles must be closed modules.");
    });
    return {
      compatibilityDate: GuestProtocol.compatibilityDate,
      compatibilityFlags: GuestProtocol.compatibilityFlags,
      mainModule: "server.js",
      modules: { "server.js": bundle },
      env: {},
      globalOutbound: ctx.exports.Outbound({ props: {} })
    };
  });
}

async function bind(
  request: GuestProtocol.BindRequest,
  env: Environment,
  ctx: LoaderContext
): Promise<Response> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.bundle));
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  if (sha256 !== request.sha256) return json({ ok: false, code: "invalid_bundle" }, 400);
  const key = identity(request);
  let entry = bound.get(key);
  if (entry !== undefined && entry.sha256 !== sha256)
    return json({ ok: false, code: "binding_conflict" }, 409);
  if (entry === undefined) {
    try {
      const worker = load(env, ctx, JSON.stringify([key, sha256]), request.bundle);
      entry = {
        sha256,
        bundle: request.bundle,
        ready: describe(worker).then(
          (reply) => reply.ok,
          () => false
        )
      };
      // Reserve the identity before awaiting initialization, including when initialization fails.
      bound.set(key, entry);
    } catch {
      return json({ ok: false, code: "load_failed" }, 422);
    }
  }
  return (await entry.ready) ? json({ ok: true }) : json({ ok: false, code: "load_failed" }, 422);
}

async function invoke(
  request: GuestProtocol.Invoke,
  env: Environment,
  ctx: LoaderContext
): Promise<Response> {
  const entry = bound.get(identity(request.binding));
  if (entry === undefined) return json({ ok: false, code: "bundle_required" }, 409);
  if (entry.sha256 !== request.binding.sha256)
    return json({ ok: false, code: "binding_conflict" }, 409);
  if (!(await entry.ready)) return json({ ok: false, code: "load_failed" }, 422);
  const target = env.callbackUrls?.[request.callback.url];
  const callbackService = target === undefined ? undefined : (env[target] as Fetcher | undefined);
  if (callbackService === undefined) return json({ ok: false, code: "invalid_request" }, 400);
  const attemptKey = JSON.stringify([
    request.invocationId,
    request.attemptId,
    request.processGeneration
  ]);
  if (activeAttempts.has(attemptKey) || serial === Number.MAX_SAFE_INTEGER)
    return json({ ok: false, code: "invalid_request" }, 409);
  if (Date.now() >= request.deadline) return json({ outcome: "deadline", guestMs: 0 });
  const reference: AttemptReference = {
    invocationId: request.invocationId,
    attemptId: request.attemptId,
    processGeneration: request.processGeneration,
    deadline: request.deadline,
    serial: ++serial
  };
  const live = { reference, callback: request.callback, callbackService };
  activeAttempts.add(attemptKey);
  attempts.set(reference.serial, live);
  const started = Date.now();
  try {
    // Worker handles belong to one request; the loader caches the isolate, not this handle.
    const worker = load(
      env,
      ctx,
      JSON.stringify([identity(request.binding), entry.sha256]),
      entry.bundle
    );
    const response = await worker
      .getEntrypoint(undefined, {
        props: {
          invocationId: request.invocationId,
          callbacks: ctx.exports.Callbacks({ props: reference })
        }
      })
      .fetch("http://guest/", {
        method: "POST",
        body: JSON.stringify({
          wire: GuestProtocol.wireVersion,
          type: "invoke",
          handler: request.handler,
          args: request.args,
          viewer: request.viewer
        } satisfies GuestProtocol.GuestRequest)
      });
    const reply = decodeGuestReply(await response.json());
    // Even a late return remains guest data. Only the host knows whether effects committed.
    return json({ outcome: "returned", reply, guestMs: Date.now() - started });
  } catch {
    return json({ outcome: "guest_failed", guestMs: Date.now() - started });
  } finally {
    attempts.delete(reference.serial);
    activeAttempts.delete(attemptKey);
  }
}

export default {
  async fetch(request: Request, env: Environment, ctx: LoaderContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" && request.method === "GET") return json({ ok: true });
    if (request.method !== "POST") return json({ ok: false, code: "invalid_request" }, 405);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, code: "invalid_request" }, 400);
    }
    if (path === "/bind") {
      let input: GuestProtocol.BindRequest;
      try {
        input = decodeBind(body);
      } catch {
        return json({ ok: false, code: "invalid_request" }, 400);
      }
      return bind(input, env, ctx);
    }
    if (path === "/invoke") {
      let input: GuestProtocol.Invoke;
      try {
        input = decodeInvoke(body);
      } catch {
        return json({ ok: false, code: "invalid_request" }, 400);
      }
      return invoke(input, env, ctx);
    }
    if (path === "/inspect" && env.callbackUrls === undefined) {
      let input: GuestProtocol.InspectRequest;
      try {
        input = decodeInspect(body);
      } catch {
        return json(refusal("invalid_request", "Malformed inspection request."), 400);
      }
      try {
        return json(await describe(load(env, ctx, "inspection", input.bundle)));
      } catch {
        return json(refusal("handler_failed", "The bundle could not be loaded."));
      }
    }
    return json({ ok: false, code: "invalid_request" }, 404);
  }
};

function liveAttempt(reference: AttemptReference): LiveAttempt | undefined {
  const live = attempts.get(reference.serial);
  return live !== undefined &&
    live.reference.invocationId === reference.invocationId &&
    live.reference.attemptId === reference.attemptId &&
    live.reference.processGeneration === reference.processGeneration &&
    live.reference.deadline === reference.deadline &&
    Date.now() < reference.deadline
    ? live
    : undefined;
}

async function readFileBody(response: Response): Promise<Uint8Array | undefined> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > GuestProtocol.callbackFileLimit.value) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Props name one immutable dispatch, not a reusable invocation registry key. */
export class Callbacks extends WorkerEntrypoint<Environment, AttemptReference> {
  async call(input: unknown): Promise<GuestProtocol.CallbackReply> {
    if (liveAttempt(this.ctx.props) === undefined) return endedCallback(this.ctx.props);
    let operation: GuestProtocol.Callback;
    try {
      operation = decodeCallback(input);
    } catch {
      return refusal("invalid_request", "Malformed callback.");
    }
    if (
      operation.body !== undefined &&
      operation.body.bytes.byteLength > GuestProtocol.callbackFileLimit.value
    )
      return fileTooLarge;
    const live = liveAttempt(this.ctx.props);
    if (live === undefined) return endedCallback(this.ctx.props);
    try {
      const headers = new Headers({ authorization: `Bearer ${live.callback.capability}` });
      let body: BodyInit;
      if (operation.body === undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(operation);
      } else {
        headers.set("content-type", operation.body.contentType);
        headers.set(
          "x-patchy-callback",
          encodeURIComponent(JSON.stringify({ op: operation.op, args: operation.args }))
        );
        body = operation.body.bytes as Uint8Array<ArrayBuffer>;
      }
      const response = await live.callbackService.fetch(live.callback.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(live.reference.deadline - Date.now())))
      });
      let reply: GuestProtocol.CallbackReply;
      if (response.ok && response.headers.get("x-patchy-file-body") === "1") {
        const bytes = await readFileBody(response);
        if (bytes === undefined) return fileTooLarge;
        reply = {
          ok: true,
          body: {
            bytes,
            contentType: response.headers.get("content-type") ?? "application/octet-stream"
          }
        };
      } else reply = decodeCallbackReply(await response.json());
      // The host may finish or supersede the attempt while its body is arriving.
      if (liveAttempt(this.ctx.props) !== live) return endedCallback(this.ctx.props);
      return reply;
    } catch {
      // A lost reply says nothing about commit. Settlement and safe retry belong to the host.
      return Date.now() >= live.reference.deadline
        ? refusal("timeout", "The invocation callback deadline has passed.")
        : refusal("source_unavailable", "The invocation callback could not complete.");
    }
  }
}

/** Fetch reaches only this refusing loopback; closed bundles cannot import socket APIs. */
export class Outbound extends WorkerEntrypoint {
  fetch(): Response {
    return json(refusal("access_denied", "Guest network access is refused."), 403);
  }
}
