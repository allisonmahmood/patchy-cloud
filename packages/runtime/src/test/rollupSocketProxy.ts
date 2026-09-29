import { createConnection, createServer, type Socket } from "node:net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export type Fault = "before-statement" | "after-commit" | "before-prune";

// A plaintext PostgreSQL wire proxy. It parses complete frames so TCP chunking
// cannot move the fault, and never fabricates a SQL result or client error.
export const make = Effect.fnUntraced(function* (databaseUrl: string, fault: Fault) {
  const target = new URL(databaseUrl);
  const reached = yield* Deferred.make<string>();
  let armed = true;
  const sockets = new Set<Socket>();
  const server = createServer((downstream) => {
    const upstream = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
    sockets.add(downstream);
    sockets.add(upstream);
    let startup = true;
    let requests: Buffer = Buffer.alloc(0);
    let responses: Buffer = Buffer.alloc(0);
    let hideResponse = false;
    let closed = false;
    const close = () => {
      closed = true;
      downstream.destroy();
      upstream.destroy();
    };
    const drop = (status: string) => {
      Deferred.doneUnsafe(reached, Effect.succeed(status));
      close();
    };
    downstream.on("error", close);
    upstream.on("error", close);
    downstream.on("close", () => {
      sockets.delete(downstream);
      close();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      close();
    });
    downstream.on("data", (chunk: Buffer) => {
      requests = Buffer.concat([requests, chunk]);
      while (!closed && requests.length >= (startup ? 4 : 5)) {
        const size = startup ? requests.readInt32BE(0) : requests.readInt32BE(1) + 1;
        if (requests.length < size) return;
        const frame = requests.subarray(0, size);
        requests = requests.subarray(size);
        const type = startup ? 0 : frame[0];
        startup = false;
        if (armed && (type === 80 || type === 81)) {
          const statement = frame.toString("utf8", 5);
          const match =
            fault === "before-prune"
              ? statement.includes("DELETE FROM runtime_query_rollup_runs")
              : statement.includes("WITH inserted AS");
          if (match) {
            armed = false;
            if (fault !== "after-commit") {
              drop("not-sent");
              return;
            }
            hideResponse = true;
          }
        }
        upstream.write(frame);
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      responses = Buffer.concat([responses, chunk]);
      while (!closed && responses.length >= 5) {
        const size = responses.readInt32BE(1) + 1;
        if (responses.length < size) return;
        const frame = responses.subarray(0, size);
        responses = responses.subarray(size);
        if (hideResponse) {
          // ReadyForQuery's 'I' status proves the atomic statement committed.
          // Discard its entire response before breaking the client connection.
          if (frame[0] === 90) drop(frame.toString("utf8", 5));
        } else {
          downstream.write(frame);
        }
      }
    });
  });
  yield* Effect.acquireRelease(
    Effect.callback<void, Error>((resume) => {
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
      })
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* Effect.die("Missing proxy port");
  const proxyUrl = new URL(databaseUrl);
  proxyUrl.hostname = "127.0.0.1";
  proxyUrl.port = String(address.port);
  proxyUrl.searchParams.set("sslmode", "disable");
  return { url: proxyUrl.toString(), reached: Deferred.await(reached) };
});
