// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off -- real workerd children and callback sockets are the boundary under test.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { promisify } from "node:util";
import { expect, it } from "@effect/vitest";
import * as GuestProtocol from "@patchy/api/guest";
import * as Management from "@patchy/api/management";
import { registry } from "@patchy/limits/registry";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Supervisor from "./supervisor.js";
import * as WorkerHttp from "./workerHttp.js";
import { NodeCryptography } from "@patchy/core";

/**
 * A guest that makes the calls it is told to, all at once, and answers with every reply; a call
 * with `file` carries that many bytes as a file body, as a raw callback can. `leave` starts them
 * and returns a moment later without their replies, as a handler that drops its promises does.
 */
const source = `
export default { async fetch(request, env, ctx) {
  const input = await request.json();
  if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
  const calls = input.args.calls.map(({ file, ...call }) => ctx.props.callbacks.call(
    file === undefined
      ? call
      : { ...call, body: { bytes: new Uint8Array(file), contentType: "application/octet-stream" } }
  ));
  if (input.handler === "demo.leave") {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return Response.json({ ok: true, value: "returned" });
  }
  const replies = await Promise.all(calls);
  return Response.json({ ok: true, value: replies.map((reply) => JSON.parse(JSON.stringify(reply))) });
}};`;
const bundle = (versionId: string): GuestProtocol.Bundle => ({
  companyId: "com_models",
  patchId: "pat_models",
  versionId,
  sha256: createHash("sha256").update(source).digest("hex"),
  bundle: source
});
const generate = (input: string = "hello") => ({
  op: "models.generate",
  args: { connection: "writer", input, maxOutputTokens: 16 }
});
const ordinary = (value: string = "x") => ({ op: "tables.get", args: { table: "rows", value } });

/** A host that records each callback and answers model calls only when the test lets it. */
const host = Effect.acquireRelease(
  Effect.promise(async () => {
    const seen: Array<{ readonly op: string; readonly marked: string | undefined }> = [];
    const held: ServerResponse[] = [];
    let holding = true;
    let lose = false;
    let huge = false;
    const answer = (response: ServerResponse) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, value: "answered" }));
    };
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const { op } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { op: string };
        const marked = request.headers["x-patchy-model-call"];
        seen.push({ op, marked: typeof marked === "string" ? marked : undefined });
        if (!op.startsWith("models.")) {
          response.setHeader("content-type", "application/json");
          return response.end(JSON.stringify({ ok: true, value: null }));
        }
        // The reply is lost on its way back: the host acted, and the connection dropped.
        if (lose) return response.socket?.destroy();
        // A reply past what the proxy reads back, as no host of this release answers.
        if (huge) {
          response.setHeader("content-type", "application/json");
          return response.end(
            JSON.stringify({ ok: true, value: "x".repeat(GuestProtocol.callbackFileLimit.value) })
          );
        }
        if (holding) held.push(response);
        else answer(response);
      });
    });
    const ready = Promise.withResolvers<void>();
    server.once("error", ready.reject);
    server.listen(0, "127.0.0.1", ready.resolve);
    await ready.promise;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No host address");
    return {
      server,
      url: `http://127.0.0.1:${address.port}/callback`,
      seen,
      held,
      /** Answers every held call and stops holding. */
      release: () => {
        holding = false;
        for (const response of held.splice(0)) answer(response);
      },
      /** Answers calls from now on, leaving those held unanswered. */
      stopHolding: () => {
        holding = false;
      },
      hold: () => {
        holding = true;
      },
      loseReplies: () => {
        lose = true;
      },
      hugeReplies: () => {
        huge = true;
      }
    };
  }),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
);
type Host = Effect.Success<typeof host>;

const invoke = (
  supervisor: Supervisor.Supervisor["Service"],
  bound: Management.BindReply,
  target: Host,
  invocationId: string,
  /** Each a callback the guest makes, its arguments any JSON, malformed ones included. */
  calls: ReadonlyArray<{
    readonly op: string;
    readonly args: GuestProtocol.Invoke["args"][string];
    readonly file?: number;
  }>,
  options: { readonly handler?: string; readonly deadlineMs?: number } = {}
) => {
  if (bound.binding === undefined || bound.processGeneration === undefined)
    throw new Error("Missing loaded binding");
  return supervisor.invoke({
    bindingEpoch: bound.bindingEpoch,
    request: {
      wire: 1,
      binding: bound.binding,
      processGeneration: bound.processGeneration,
      invocationId,
      attemptId: "attempt_one",
      deadline: Date.now() + (options.deadlineMs ?? 20_000),
      handler: options.handler ?? "demo.calls",
      args: {
        calls: calls.map(({ op, args, file }): GuestProtocol.Invoke["args"][string] =>
          file === undefined ? { op, args } : { op, args, file }
        )
      },
      viewer: {
        user: { id: "usr_models", name: "Reader", email: "reader@example.test" },
        company: { id: "com_models", name: "Example", handle: "example" },
        admin: false
      },
      callback: { url: target.url, capability: "host-attempt-capability" }
    }
  });
};
const replies = (reply: GuestProtocol.InvokeReply) => {
  if (reply.outcome !== "returned" || !reply.reply.ok || !("value" in reply.reply))
    throw new Error(`The guest didn't answer: ${JSON.stringify(reply)}`);
  return reply.reply.value as ReadonlyArray<Record<string, unknown>>;
};
const until = Effect.fnUntraced(function* (ready: () => boolean) {
  for (let i = 0; i < 800; i++) {
    if (ready()) return;
    yield* Effect.sleep(10);
  }
  throw new Error("Never reached the expected state");
});
const make = (target: Host, permits: number) =>
  Supervisor.make({
    callbackUrls: [target.url],
    operatingLimits: {
      "execution.residency.bytes": 8 * 1024 ** 3,
      "models.execution.inFlight": permits
    }
  });
const bindVersion = (supervisor: Supervisor.Supervisor["Service"], versionId: string) =>
  supervisor.bind({ companyId: "com_models", bindingEpoch: 1, bundle: bundle(versionId) });

it.live(
  "marks a model call for the host once it holds a permit, and leaves other calls as they were",
  () =>
    Effect.gen(function* () {
      const target = yield* host;
      target.release();
      const supervisor = yield* make(target, 4);
      const loaded = yield* bindVersion(supervisor, "ver_marked");
      const answered = replies(
        yield* invoke(supervisor, loaded, target, "inv_marked", [
          generate(),
          ordinary(),
          // Refused by the loader itself, before anything leaves it.
          { op: "models.generate", args: "malformed" },
          { op: "tables.get", args: "malformed" }
        ])
      );
      const malformed = {
        ok: false,
        source: "patchy",
        code: "invalid_request",
        error: "Malformed callback."
      };
      expect(answered).toEqual([
        { ok: true, value: "answered" },
        { ok: true, value: null },
        { ...malformed, details: { sent: false } },
        malformed
      ]);
      expect(target.seen).toEqual(
        expect.arrayContaining([
          { op: "models.generate", marked: "models.generate" },
          { op: "tables.get", marked: undefined }
        ])
      );
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
    ),
  20_000
);

it.live(
  "refuses a model call past the task's permits at once, sending nothing, while other calls pass",
  () =>
    Effect.gen(function* () {
      const target = yield* host;
      const supervisor = yield* make(target, 2);
      // Two versions, so the permits are seen to be the task's, not one process's.
      const first = yield* bindVersion(supervisor, "ver_first");
      const second = yield* bindVersion(supervisor, "ver_second");
      const holding = yield* invoke(supervisor, first, target, "inv_holding", [
        generate("one"),
        generate("two")
      ]).pipe(Effect.forkChild);
      yield* until(() => target.held.length === 2);
      const refused = replies(
        yield* invoke(supervisor, second, target, "inv_refused", [generate("three"), ordinary()])
      );
      expect(refused[0]).toEqual({
        ok: false,
        source: "patchy",
        code: "busy",
        error:
          "Too many model calls are running in this company's execution task, so nothing was sent. Try again shortly.",
        scope: "company",
        limitId: "models.execution.inFlight",
        value: 2,
        retryAfter: 1,
        details: { sent: false }
      });
      expect(refused[1]).toEqual({ ok: true, value: null });
      // The refused call never reached the host.
      expect(target.seen.filter(({ op }) => op === "models.generate")).toHaveLength(2);
      target.release();
      expect(replies(yield* Fiber.join(holding))).toEqual([
        { ok: true, value: "answered" },
        { ok: true, value: "answered" }
      ]);
      // Both permits came back with their calls.
      expect(
        replies(yield* invoke(supervisor, second, target, "inv_after", [generate(), generate()]))
      ).toEqual([
        { ok: true, value: "answered" },
        { ok: true, value: "answered" }
      ]);
      yield* supervisor.stop({ bindingEpoch: 1 });
      const { reports } = yield* supervisor.stats({ bindingEpoch: 1 });
      const peaks = reports.map(({ binding, event }) => ({
        versionId: binding.versionId,
        peak: event.limits?.find(({ limitId }) => limitId === "models.execution.inFlight")
      }));
      expect(peaks).toEqual(
        expect.arrayContaining([
          { versionId: "ver_first", peak: expect.objectContaining({ value: 2, peak: 2 }) },
          { versionId: "ver_second", peak: expect.objectContaining({ value: 2, peak: 2 }) }
        ])
      );
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
    ),
  30_000
);

it.live(
  "gives a model call's permit back when the call ends without its reply being read",
  () =>
    Effect.gen(function* () {
      const target = yield* host;
      const supervisor = yield* make(target, 1);
      const first = yield* bindVersion(supervisor, "ver_ends");
      const second = yield* bindVersion(supervisor, "ver_next");
      // Its attempt reaches its deadline while the host still holds the call.
      yield* invoke(supervisor, first, target, "inv_ends", [generate()], { deadlineMs: 1_500 });
      expect(target.held).toHaveLength(1);
      target.stopHolding();
      expect(replies(yield* invoke(supervisor, second, target, "inv_next", [generate()]))).toEqual([
        { ok: true, value: "answered" }
      ]);
      // A handler that returns without waiting leaves its call with the host, and nobody reads
      // the reply; the call's permit comes back once its process stops waiting for it.
      target.hold();
      yield* invoke(supervisor, first, target, "inv_leaves", [generate()], {
        handler: "demo.leave"
      });
      expect(target.held).toHaveLength(2);
      target.stopHolding();
      yield* until(() => target.held[1]?.socket?.destroyed === true);
      expect(replies(yield* invoke(supervisor, second, target, "inv_free", [generate()]))).toEqual([
        { ok: true, value: "answered" }
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
    ),
  30_000
);

it.live(
  "refuses a model call's arguments past models.ingress.bytes, sending nothing; other calls keep their cap",
  () =>
    Effect.gen(function* () {
      const target = yield* host;
      target.release();
      const supervisor = yield* make(target, 4);
      const loaded = yield* bindVersion(supervisor, "ver_large");
      const large = "x".repeat(registry["models.ingress.bytes"].default);
      const answered = replies(
        yield* invoke(supervisor, loaded, target, "inv_large", [generate(large), ordinary(large)])
      );
      expect(answered[0]).toEqual({
        ok: false,
        source: "patchy",
        code: "too_large",
        error: "The model call exceeds models.ingress.bytes, so nothing was sent.",
        scope: "viewer",
        limitId: "models.ingress.bytes",
        value: registry["models.ingress.bytes"].default,
        details: { sent: false }
      });
      expect(answered[1]).toEqual({ ok: true, value: null });
      expect(target.seen).toEqual([{ op: "tables.get", marked: undefined }]);
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
    ),
  20_000
);

it.live(
  "says nothing of a model call whose reply was lost after the host had it",
  () =>
    Effect.gen(function* () {
      const target = yield* host;
      target.release();
      target.loseReplies();
      const supervisor = yield* make(target, 4);
      const loaded = yield* bindVersion(supervisor, "ver_lost");
      const [lost] = replies(yield* invoke(supervisor, loaded, target, "inv_lost", [generate()]));
      expect(lost).toEqual({
        ok: false,
        source: "patchy",
        code: "source_unavailable",
        error: "The invocation callback could not complete."
      });
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
    ),
  20_000
);

/** The address a process's loader calls back on, read from the config its workerd was started with. */
const callbackAddress = Effect.fnUntraced(function* (
  supervisor: Supervisor.Supervisor["Service"],
  versionId: string
) {
  const { processes } = yield* supervisor.stats({ bindingEpoch: 1 });
  const pid = processes.find((process) => process.binding.versionId === versionId)?.pid;
  const { stdout } = yield* Effect.promise(() =>
    promisify(execFile)("ps", ["-o", "args=", "-p", String(pid)])
  );
  const config = /\S+config\.capnp/.exec(stdout)?.[0];
  if (config === undefined) throw new Error("No workerd config");
  const text = yield* Effect.promise(() => readFile(config, "utf8"));
  const url = /http:\/\/127\.0\.0\.1:\d+\/callback\/[0-9a-f-]+/.exec(text)?.[0];
  if (url === undefined) throw new Error("No callback address");
  return url;
});

/**
 * One request straight to a proxy, as only a loader should send one: its status, headers and
 * body. `declared` sends that Content-Length and only the headers, so nothing can be read.
 */
const direct = (
  url: string,
  headers: Readonly<Record<string, string>>,
  body: { readonly declared: number } | { readonly chunks: number; readonly size: number }
) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; headers: IncomingMessage["headers"]; body: unknown }>(
        (resolve, reject) => {
          const sending = httpRequest(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...headers,
              ...("declared" in body ? { "content-length": String(body.declared) } : {})
            }
          });
          sending.on("response", (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
              })
            );
          });
          sending.on("error", reject);
          if ("declared" in body) sending.flushHeaders();
          else {
            for (let index = 0; index < body.chunks; index++) sending.write("x".repeat(body.size));
            sending.end();
          }
        }
      )
  );

const tooLarge = {
  ok: false,
  source: "patchy",
  code: "too_large",
  error: "The model call exceeds models.ingress.bytes, so nothing was sent.",
  scope: "viewer",
  limitId: "models.ingress.bytes",
  value: registry["models.ingress.bytes"].default,
  details: { sent: false }
};
/** The proxy's own, in its own words: only a loader that didn't measure the call meets it. */
const atProxy = {
  ...tooLarge,
  error:
    "The model call exceeds models.ingress.bytes at the execution task's proxy, so nothing was sent."
};

it.live(
  "refuses a model call framed with a file body before sending it, its arguments unmeasured",
  () =>
    Effect.gen(function* () {
      const target = yield* host;
      target.release();
      const supervisor = yield* make(target, 4);
      const loaded = yield* bindVersion(supervisor, "ver_framed");
      const large = "x".repeat(registry["models.ingress.bytes"].default);
      const answered = replies(
        yield* invoke(supervisor, loaded, target, "inv_framed", [
          { ...generate(large), file: 16 },
          ordinary()
        ])
      );
      expect(answered[0]).toEqual({
        ok: false,
        source: "patchy",
        code: "invalid_request",
        error: "A model call carries no file, so nothing was sent.",
        details: { sent: false }
      });
      expect(answered[1]).toEqual({ ok: true, value: null });
      expect(target.seen).toEqual([{ op: "tables.get", marked: undefined }]);
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
    ),
  20_000
);

it.live(
  "returns the refusals the task itself gave a model call with the attempt's reply",
  () =>
    Effect.gen(function* () {
      const target = yield* host;
      const supervisor = yield* make(target, 1);
      const first = yield* bindVersion(supervisor, "ver_holding");
      const second = yield* bindVersion(supervisor, "ver_refused");
      const holding = yield* invoke(supervisor, first, target, "inv_hold", [generate()]).pipe(
        Effect.forkChild
      );
      yield* until(() => target.held.length === 1);
      const refused = yield* invoke(supervisor, second, target, "inv_refusals", [
        generate("busy"),
        generate("x".repeat(registry["models.ingress.bytes"].default)),
        ordinary()
      ]);
      const [busy, large] = replies(refused);
      // Each refusal the task gave, as the guest got it, with its status and its operation; the
      // host relays a guest's refusal only when it matches one of these or one of its own.
      expect(refused.outcome === "returned" ? refused.refusals : undefined).toEqual(
        expect.arrayContaining([
          { failure: busy, status: 429, operation: "models.generate" },
          { failure: large, status: 413, operation: "models.generate" }
        ])
      );
      expect(large).toEqual(tooLarge);
      target.release();
      yield* Fiber.join(holding);
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
    ),
  30_000
);

it.live(
  "says nothing of a model call whose host's reply was past what the proxy reads",
  () =>
    Effect.gen(function* () {
      const target = yield* host;
      target.release();
      target.hugeReplies();
      const supervisor = yield* make(target, 4);
      const loaded = yield* bindVersion(supervisor, "ver_huge");
      const [lost] = replies(yield* invoke(supervisor, loaded, target, "inv_huge", [generate()]));
      // The call went to the host, so whether it was sent is unknown: never the call's own
      // arguments refused, nothing sent.
      expect(lost).toEqual({
        ok: false,
        source: "patchy",
        code: "source_unavailable",
        error: "The invocation callback could not complete."
      });
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
    ),
  30_000
);

it.live(
  "classifies a model call before refusing it at the proxy, and refuses a body it can't take unread",
  () =>
    Effect.gen(function* () {
      const target = yield* host;
      const supervisor = yield* make(target, 2);
      const loaded = yield* bindVersion(supervisor, "ver_direct");
      const url = yield* callbackAddress(supervisor, "ver_direct");
      // Both of the task's permits held by one attempt's two calls.
      const holding = yield* invoke(supervisor, loaded, target, "inv_direct", [
        generate(),
        generate()
      ]).pipe(Effect.forkChild);
      yield* until(() => target.held.length === 2);
      const attempt = (invocationId: string) => ({
        authorization: "Bearer host-attempt-capability",
        "x-patchy-invocation-id": invocationId,
        "x-patchy-attempt-id": "attempt_one",
        "x-patchy-process-generation": String(loaded.processGeneration),
        "x-patchy-model-call": "models.generate"
      });
      const ended = {
        ok: false,
        source: "patchy",
        code: "access_denied",
        error: "The invocation callback has ended."
      };
      // An attempt the proxy doesn't hold, and an address it doesn't serve: a model call's refusal
      // says nothing was sent, wherever it falls.
      for (const address of [url, url.replace(/[0-9a-f-]+$/, "nowhere")]) {
        const gone = yield* direct(address, attempt("inv_gone"), { declared: 10 });
        expect(gone.body).toEqual({ ...ended, details: { sent: false } });
      }
      // Declared past the cap: refused before a permit is asked for, so not busy though both are
      // held, with nothing read and the connection closed after.
      const declared = yield* direct(url, attempt("inv_direct"), {
        declared: registry["models.ingress.bytes"].default + 1
      });
      expect(declared.status).toBe(413);
      expect(declared.body).toEqual(atProxy);
      expect(declared.headers.connection).toBe("close");
      target.release();
      yield* Fiber.join(holding);
      // Of no stated length, it takes the free permit and is read up to the cap and no further.
      target.hold();
      const streaming = yield* invoke(supervisor, loaded, target, "inv_stream", [generate()]).pipe(
        Effect.forkChild
      );
      yield* until(() => target.held.length === 1);
      const streamed = yield* direct(url, attempt("inv_stream"), {
        chunks: 3,
        size: registry["models.ingress.bytes"].default / 2
      });
      expect(streamed.status).toBe(413);
      expect(streamed.body).toEqual(atProxy);
      expect(streamed.headers.connection).toBe("close");
      target.release();
      yield* Fiber.join(streaming);
    }).pipe(
      Effect.scoped,
      Effect.provide([FetchHttpClient.layer, WorkerHttp.layer, NodeCryptography.layer])
    ),
  30_000
);
