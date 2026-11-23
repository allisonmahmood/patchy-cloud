// @effect-diagnostics nodeBuiltinImport:off -- a real loopback server is what the worker client is for.
import { createServer, type ServerResponse } from "node:http";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as WorkerHttp from "./workerHttp.js";

/** A loopback server that holds every request but `/now`, counting connections and hang-ups. */
const server = Effect.acquireRelease(
  Effect.promise(async () => {
    const held: ServerResponse[] = [];
    const seen = { sockets: 0, abandoned: 0, connection: new Set<string>() };
    const listener = createServer((request, response) => {
      seen.connection.add(String(request.headers.connection));
      response.once("close", () => {
        if (!response.writableFinished) seen.abandoned++;
      });
      if (request.url === "/now") response.end("now");
      else held.push(response);
    });
    listener.on("connection", () => seen.sockets++);
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("No server address");
    return { listener, url: `http://127.0.0.1:${address.port}`, held, seen };
  }),
  ({ listener }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          listener.closeAllConnections();
          listener.close(() => resolve());
        })
    )
);

it.live(
  "runs more requests at once than Bun's fetch, each on a connection of its own that interruption closes",
  () =>
    Effect.gen(function* () {
      const { url, held, seen } = yield* server;
      const workers = yield* WorkerHttp.WorkerHttp;
      // Bun's fetch runs 256 at once. Spaced, as a listen backlog on macOS holds only 128.
      const fibers: Array<Fiber.Fiber<unknown, unknown>> = [];
      for (let index = 0; index < 300; index++) {
        fibers.push(yield* workers.get(`${url}/held`).pipe(Effect.forkChild));
        yield* Effect.sleep(2);
      }
      while (held.length < 300) yield* Effect.sleep(10);
      expect(
        yield* workers.get(`${url}/now`).pipe(
          Effect.flatMap((response) => response.text),
          Effect.timeout(1_000)
        )
      ).toBe("now");
      expect(seen.sockets).toBe(301);
      expect([...seen.connection]).toEqual(["close"]);
      yield* Fiber.interruptAll(fibers);
      while (seen.abandoned < 300) yield* Effect.sleep(10);
    }).pipe(Effect.scoped, Effect.provide(WorkerHttp.layer)),
  20_000
);

it.live("fails a refused connection as transport, before any response", () =>
  Effect.gen(function* () {
    const { listener, url } = yield* server;
    yield* Effect.promise(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    const workers = yield* WorkerHttp.WorkerHttp;
    expect(yield* workers.get(`${url}/now`).pipe(Effect.flip)).toMatchObject({
      reason: { _tag: "TransportError" }
    });
  }).pipe(Effect.scoped, Effect.provide(WorkerHttp.layer))
);
