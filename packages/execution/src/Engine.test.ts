// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off -- real HTTP callbacks and exact content hashes exercise the workerd boundary.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { expect, it } from "@effect/vitest";
import * as GuestProtocol from "@patchy/api/guest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Engine from "./engine.js";
import { startWorkerd } from "./process.js";

const viewer = {
  user: { id: "usr_test", name: "Reader", email: "reader@example.test" },
  company: { id: "com_test", name: "Example", handle: "example" },
  admin: false
};
const bundle = (
  source: string,
  overrides: Partial<GuestProtocol.BundleBinding> = {}
): GuestProtocol.Bundle => ({
  companyId: "com_test",
  patchId: "pat_test",
  versionId: "ver_test",
  sha256: createHash("sha256").update(source).digest("hex"),
  bundle: source,
  ...overrides
});
const returnedReply = (response: GuestProtocol.InvokeReply) => {
  expect(response.outcome).toBe("returned");
  if (response.outcome !== "returned") throw new Error(`Guest did not return: ${response.outcome}`);
  return response.reply;
};
const invocation = (
  binding: GuestProtocol.BundleBinding,
  url: string,
  handler: string,
  overrides: Partial<GuestProtocol.Invoke> = {}
): GuestProtocol.Invoke => ({
  wire: 1,
  binding,
  invocationId: "inv_test",
  attemptId: "attempt_test",
  processGeneration: 3,
  deadline: Date.now() + 10_000,
  handler,
  args: {},
  viewer,
  callback: { url, capability: "private-host-capability" },
  ...overrides
});
const listener = (handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const server = createServer((request, response) => {
        void handle(request, response).catch(() => {
          response.writeHead(500);
          response.end();
        });
      });
      const ready = Promise.withResolvers<void>();
      server.once("error", ready.reject);
      server.listen(0, "127.0.0.1", ready.resolve);
      await ready.promise;
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing callback address.");
      return { server, url: `http://127.0.0.1:${address.port}/callback` };
    }),
    ({ server }) =>
      Effect.promise(async () => {
        const closed = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close(() => closed.resolve());
        await closed.promise;
      })
  );
const bodyOf = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const sdkSource = `
import { action, query, createGuest, t } from "patchy/server";
const read = query({ args: { id: t.text() }, result: t.json(), handler: async (ctx, args) => {
  ctx.log("read", { id: args.id });
  return { row: await ctx.tables.notes.get(args.id), viewer: ctx.viewer.user.id };
}});
const bytes = action({ args: {}, result: t.json(), handler: async ctx => {
  await ctx.files.docs.put("data.bin", new Uint8Array([0, 255, 1, 128]), { contentType: "application/x-test" });
  return Array.from(await ctx.files.docs.get("data.bin"));
}});
const transfer = action({ args: { direction: t.enum(["upload", "download"]), bytes: t.integer() }, result: t.json(), handler: async (ctx, args) => {
  if (args.direction === "upload") {
    await ctx.files.docs.put(String(args.bytes), new Uint8Array(args.bytes).fill(165), { contentType: "application/x-test" });
    return null;
  }
  const bytes = await ctx.files.docs.get(String(args.bytes));
  return { length: bytes.length, first: bytes[0], last: bytes[bytes.length - 1] };
}});
export default createGuest({ demo: { read, bytes, transfer } });
`;
const sdkBundle = Effect.promise(async () => {
  const result = await build({
    stdin: { contents: sdkSource, resolveDir: import.meta.dirname, sourcefile: "guest-fixture.ts" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"]
  });
  return result.outputFiles[0]!.text;
});

it.live(
  "runs SDK handlers with viewer data and JSON and binary callbacks",
  () =>
    Effect.gen(function* () {
      const calls: Array<{
        authorization: string | undefined;
        operation: unknown;
        bytes?: number[];
        contentType?: string;
      }> = [];
      const host = yield* listener(async (request, response) => {
        const body = await bodyOf(request);
        const framed = request.headers["x-patchy-callback"];
        const operation = JSON.parse(
          typeof framed === "string" ? decodeURIComponent(framed) : body.toString("utf8")
        ) as { op: string; args: Record<string, unknown> };
        calls.push({
          authorization: request.headers.authorization,
          operation,
          ...(framed === undefined
            ? {}
            : { bytes: [...body], contentType: request.headers["content-type"] })
        });
        if (operation.op === "files.get") {
          response.writeHead(200, {
            "x-patchy-file-body": "1",
            "content-type": "application/x-test"
          });
          response.end(Buffer.from([0, 255, 1, 128]));
        } else {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              ok: true,
              value:
                operation.op === "tables.get" ? { id: operation.args.id, title: "From host" } : null
            })
          );
        }
      });
      const process = yield* startWorkerd({ callbackUrls: [host.url] });
      const engine = yield* Engine.make({ url: process.url });
      const binding = yield* engine.bind(bundle(yield* sdkBundle));
      expect(
        returnedReply(
          yield* engine.invoke(
            invocation(binding, host.url, "demo.read", { args: { id: "row_test" } })
          )
        )
      ).toEqual({
        ok: true,
        value: { row: { id: "row_test", title: "From host" }, viewer: viewer.user.id }
      });
      expect(
        returnedReply(yield* engine.invoke(invocation(binding, host.url, "demo.bytes")))
      ).toEqual({
        ok: true,
        value: [0, 255, 1, 128]
      });
      expect(calls).toEqual(
        expect.arrayContaining([
          {
            authorization: "Bearer private-host-capability",
            operation: { op: "log", args: { message: "read", details: { id: "row_test" } } }
          },
          {
            authorization: "Bearer private-host-capability",
            operation: { op: "tables.get", args: { table: "notes", id: "row_test" } }
          },
          {
            authorization: "Bearer private-host-capability",
            operation: {
              op: "files.put",
              args: { store: "docs", name: "data.bin", contentType: "application/x-test" }
            },
            bytes: [0, 255, 1, 128],
            contentType: "application/x-test"
          },
          {
            authorization: "Bearer private-host-capability",
            operation: { op: "files.get", args: { store: "docs", name: "data.bin" } }
          }
        ])
      );
      expect(calls).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);

const statefulSource = `
let count = 0;
let previous;
export default { async fetch(request, env, ctx) {
  const input = await request.json();
  if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
  if (input.handler === "demo.capture") {
    previous = ctx.props.callbacks;
    return Response.json({ ok: true, value: { props: Object.keys(ctx.props).sort(), env: Object.keys(env), count: ++count } });
  }
  if (input.handler === "demo.replay") {
    let oldRefused;
    try { oldRefused = (await previous.call({ op: "old", args: {} })).ok === false; }
    catch { oldRefused = true; }
    return Response.json({ ok: true, value: {
      oldRefused,
      fresh: await ctx.props.callbacks.call({ op: "fresh", args: {} })
    }});
  }
  if (input.handler === "demo.hold") return Response.json(await ctx.props.callbacks.call({ op: "hold", args: {} }));
  return Response.json({ ok: true, value: ++count });
}};
`;

it.live(
  "isolates company/patch/version caches and refuses hash mismatches and rebinding",
  () =>
    Effect.gen(function* () {
      const callbackUrl = "http://127.0.0.1:1/callback";
      const process = yield* startWorkerd({ callbackUrls: [callbackUrl] });
      const engine = yield* Engine.make({ url: process.url });
      const first = bundle(statefulSource);
      const binding = yield* engine.bind(first);
      expect(yield* engine.bind(first)).toEqual(binding);
      const wrongHash = yield* engine
        .bind({ ...first, sha256: "0".repeat(64) })
        .pipe(Effect.result);
      expect(wrongHash).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_bundle" } });
      const conflict = yield* engine
        .bind(bundle(`${statefulSource}\n// changed bytes`))
        .pipe(Effect.result);
      expect(conflict).toMatchObject({ _tag: "Failure", failure: { reason: "binding_conflict" } });
      expect(
        returnedReply(yield* engine.invoke(invocation(binding, callbackUrl, "demo.count")))
      ).toEqual({
        ok: true,
        value: 1
      });
      for (const change of [
        { companyId: "another-company" },
        { patchId: "another-patch" },
        { versionId: "another-version" }
      ]) {
        const separate = yield* engine.bind(bundle(statefulSource, change));
        expect(
          returnedReply(yield* engine.invoke(invocation(separate, callbackUrl, "demo.count")))
        ).toEqual({ ok: true, value: 1 });
      }
      expect(
        returnedReply(yield* engine.invoke(invocation(binding, callbackUrl, "demo.count")))
      ).toEqual({
        ok: true,
        value: 2
      });
      const missing = yield* engine
        .invoke(invocation({ ...binding, versionId: "not-bound" }, callbackUrl, "demo.count"))
        .pipe(Effect.result);
      expect(missing).toMatchObject({ _tag: "Failure", failure: { reason: "bundle_required" } });
      const http = yield* HttpClient.HttpClient;
      for (const bad of [
        { wire: 2, ...first },
        { wire: 1, ...first, extra: true }
      ]) {
        const response = yield* http.execute(
          HttpClientRequest.post(`${process.url}/bind`).pipe(HttpClientRequest.bodyJsonUnsafe(bad))
        );
        expect(response.status).toBe(400);
        expect(yield* response.json).toEqual({ ok: false, code: "invalid_request" });
      }
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);

it.live(
  "never revives an old RPC stub when an attempt identity is reused",
  () =>
    Effect.gen(function* () {
      const operations: string[] = [];
      const host = yield* listener(async (request, response) => {
        const operation = JSON.parse((await bodyOf(request)).toString()) as { op: string };
        operations.push(operation.op);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, value: "fresh-authority" }));
      });
      const process = yield* startWorkerd({ callbackUrls: [host.url] });
      const engine = yield* Engine.make({ url: process.url });
      const binding = yield* engine.bind(bundle(statefulSource));
      expect(
        returnedReply(yield* engine.invoke(invocation(binding, host.url, "demo.capture")))
      ).toEqual({
        ok: true,
        value: { props: ["callbacks", "invocationId"], env: [], count: 1 }
      });
      const replay = yield* engine.invoke(invocation(binding, host.url, "demo.replay"));
      expect(returnedReply(replay)).toMatchObject({
        ok: true,
        value: { oldRefused: true, fresh: { ok: true, value: "fresh-authority" } }
      });
      expect(operations).toEqual(["fresh"]);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);

it.live(
  "refuses duplicate active attempts without replacing their callback authority",
  () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
      const host = yield* listener(async (request, response) => {
        await bodyOf(request);
        entered.resolve();
        await release.promise;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, value: "original" }));
      });
      const process = yield* startWorkerd({ callbackUrls: [host.url] });
      const engine = yield* Engine.make({ url: process.url });
      const binding = yield* engine.bind(bundle(statefulSource));
      const request = invocation(binding, host.url, "demo.hold");
      const first = yield* engine.invoke(request).pipe(Effect.forkChild);
      yield* Effect.promise(() => entered.promise);
      expect(yield* engine.invoke(request).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "protocol" }
      });
      release.resolve();
      expect(returnedReply(yield* Fiber.join(first))).toEqual({ ok: true, value: "original" });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);

it.live(
  "preserves host refusal data through the RPC and SDK guest",
  () =>
    Effect.gen(function* () {
      const refused = {
        ok: false,
        source: "patchy",
        code: "access_denied",
        error: "The table is unavailable.",
        correlationId: "cor_test"
      };
      const host = yield* listener(async (request, response) => {
        await bodyOf(request);
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify(refused));
      });
      const process = yield* startWorkerd({ callbackUrls: [host.url] });
      const engine = yield* Engine.make({ url: process.url });
      const binding = yield* engine.bind(bundle(yield* sdkBundle));
      expect(
        returnedReply(
          yield* engine.invoke(
            invocation(binding, host.url, "demo.read", { args: { id: "row_test" } })
          )
        )
      ).toEqual(refused);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);

it.live(
  "routes concurrent attempts to their own trusted issuing host",
  () =>
    Effect.gen(function* () {
      const first = yield* listener(async (request, response) => {
        await bodyOf(request);
        response.end(JSON.stringify({ ok: true, value: "first-host" }));
      });
      const second = yield* listener(async (request, response) => {
        await bodyOf(request);
        response.end(JSON.stringify({ ok: true, value: "second-host" }));
      });
      const process = yield* startWorkerd({ callbackUrls: [first.url, second.url] });
      const engine = yield* Engine.make({ url: process.url });
      const binding = yield* engine.bind(bundle(statefulSource));
      const replies = yield* Effect.all(
        [
          engine.invoke(invocation(binding, first.url, "demo.hold", { attemptId: "first" })),
          engine.invoke(invocation(binding, second.url, "demo.hold", { attemptId: "second" }))
        ],
        { concurrency: "unbounded" }
      );
      expect(replies.map(returnedReply)).toEqual([
        { ok: true, value: "first-host" },
        { ok: true, value: "second-host" }
      ]);
      expect(
        yield* engine
          .invoke(invocation(binding, "http://127.0.0.1:1/callback", "demo.hold"))
          .pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { reason: "protocol" } });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);

// These deadlines run in a separate workerd process; the test clock cannot advance them.
it.live(
  "separates engine observations from guest-authored outcomes and preserves late replies",
  () =>
    Effect.gen(function* () {
      const host = yield* listener(async (request, response) => {
        await bodyOf(request);
        response.end(JSON.stringify({ ok: true, value: null }));
      });
      const child = yield* startWorkerd({ callbackUrls: [host.url] });
      const engine = yield* Engine.make({ url: child.url });
      const binding = yield* engine.bind(
        bundle(`
      export default { async fetch(request, env, ctx) {
        const input = await request.json();
        if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
        if (input.args.late) {
          while (Date.now() < input.args.until) {
            await ctx.props.callbacks.call({ op: "clock", args: {} });
            const tick = Promise.withResolvers();
            setTimeout(tick.resolve, 10);
            await tick.promise;
          }
        }
        if (input.args.mode === "throw") throw new Error("guest failure");
        if (input.args.mode === "malformed") return new Response("not json");
        return Response.json(input.args.reply);
      }};
    `)
      );
      const forged = {
        ok: false,
        source: "patchy",
        code: "handler_timeout",
        error: "invented",
        correlationId: "another-operation"
      };
      expect(
        yield* engine.invoke(invocation(binding, host.url, "demo.run", { args: { reply: forged } }))
      ).toMatchObject({
        outcome: "returned",
        reply: forged
      });
      expect(
        yield* engine.invoke(
          invocation(binding, host.url, "demo.run", { deadline: Date.now() - 1 })
        )
      ).toEqual({
        outcome: "deadline",
        guestMs: 0
      });
      for (const mode of ["return", "throw", "malformed"]) {
        const deadline = Date.now() + 250;
        const result = yield* engine.invoke(
          invocation(binding, host.url, "demo.run", {
            deadline,
            args: { mode, late: true, until: deadline + 30, reply: { ok: true, value: "late" } }
          })
        );
        expect(result).toMatchObject(
          mode === "return"
            ? { outcome: "returned", reply: { ok: true, value: "late" } }
            : { outcome: "guest_failed" }
        );
        expect(Date.now()).toBeGreaterThanOrEqual(deadline);
      }
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);

it.live(
  "distinguishes unavailable callbacks and expired deadlines from permission refusals",
  () =>
    Effect.gen(function* () {
      // Exercise workerd's real AbortSignal deadline, not a guessed completion delay.
      const host = yield* listener(async (request, response) => {
        const { op } = JSON.parse((await bodyOf(request)).toString()) as { op: string };
        if (op === "reset") {
          request.socket.destroy();
          return;
        }
        if (op === "slow") {
          await delay(750);
          response.end(JSON.stringify({ ok: true, value: null }));
          return;
        }
        if (op === "html") {
          response.writeHead(503, { "content-type": "text/html" });
          response.end("<h1>Unavailable</h1>");
          return;
        }
        response.end(JSON.stringify({ unexpected: true }));
      });
      const child = yield* startWorkerd({ callbackUrls: [host.url] });
      const engine = yield* Engine.make({ url: child.url });
      const binding = yield* engine.bind(
        bundle(`
      export default { async fetch(request, env, ctx) {
        const input = await request.json();
        if (input.type === "describe") return Response.json({ ok: true, handlers: {} });
        return Response.json(await ctx.props.callbacks.call({ op: input.args.op, args: {} }));
      }};
    `)
      );
      for (const op of ["reset", "html", "malformed", "slow"]) {
        expect(
          yield* engine.invoke(
            invocation(binding, host.url, "demo.run", {
              args: { op },
              deadline: Date.now() + (op === "slow" ? 250 : 5_000)
            })
          )
        ).toMatchObject({
          outcome: "returned",
          reply: {
            ok: false,
            source: "patchy",
            code: op === "slow" ? "timeout" : "source_unavailable"
          }
        });
      }
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);

it.live(
  "enforces the tier two file callback cap in both directions with limit metadata",
  () =>
    Effect.gen(function* () {
      const maxBytes = 20 * 1024 * 1024;
      const uploads: number[] = [];
      const host = yield* listener(async (request, response) => {
        const data = await bodyOf(request);
        const framed = request.headers["x-patchy-callback"];
        if (framed !== undefined) {
          uploads.push(data.length);
          expect(request.headers["content-type"]).toBe("application/x-test");
          expect([data[0], data[data.length - 1]]).toEqual([165, 165]);
          response.end(JSON.stringify({ ok: true, value: null }));
        } else {
          const { args } = JSON.parse(data.toString()) as { args: { name: string } };
          response.writeHead(200, {
            "x-patchy-file-body": "1",
            "content-type": "application/x-test"
          });
          response.end(Buffer.alloc(Number(args.name), 165));
        }
      });
      const child = yield* startWorkerd({ callbackUrls: [host.url] });
      const engine = yield* Engine.make({ url: child.url });
      const binding = yield* engine.bind(bundle(yield* sdkBundle));
      for (const direction of ["upload", "download"]) {
        expect(
          yield* engine.invoke(
            invocation(binding, host.url, "demo.transfer", {
              args: { direction, bytes: maxBytes }
            })
          )
        ).toMatchObject({
          outcome: "returned",
          reply: {
            ok: true,
            value: direction === "upload" ? null : { length: maxBytes, first: 165, last: 165 }
          }
        });
        expect(
          yield* engine.invoke(
            invocation(binding, host.url, "demo.transfer", {
              args: { direction, bytes: maxBytes + 1 }
            })
          )
        ).toMatchObject({
          outcome: "returned",
          reply: {
            ok: false,
            source: "patchy",
            code: "too_large",
            scope: "viewer",
            limitId: "tier2.callbacks.fileBytes",
            value: maxBytes
          }
        });
      }
      expect(uploads).toEqual([maxBytes]);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  30_000
);
