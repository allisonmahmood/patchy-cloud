// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- disposable TCP listeners and literal guest source exercise workerd's network boundary.
import { createServer, get } from "node:http";
import type { Socket } from "node:net";
import * as Effect from "effect/Effect";

export const networkListener = Effect.acquireRelease(
  Effect.promise(async () => {
    let connections = 0;
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => response.end("reachable"));
    server.on("connection", (socket) => {
      connections++;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    const ready = Promise.withResolvers<void>();
    server.once("error", ready.reject);
    server.listen(0, "127.0.0.1", ready.resolve);
    await ready.promise;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing TCP address.");
    const url = `http://127.0.0.1:${address.port}/`;
    return {
      server,
      sockets,
      port: address.port,
      connections: () => connections,
      control: Effect.promise(() => {
        const result = Promise.withResolvers<string>();
        const request = get(url, { agent: false }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.once("end", () => result.resolve(body));
          response.once("error", result.reject);
        });
        request.once("error", result.reject);
        return result.promise;
      })
    };
  }),
  ({ server, sockets }) =>
    Effect.promise(async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      for (const socket of sockets) socket.destroy();
      await closed.promise;
    })
);

export const networkProbeBundle = (port: number) => `
let loaded = "none";
// PR437 comment5893848355: keep this unparenthesized lexer bypass verbatim.
const p = function(){} / import("cloudflare:sockets").then((m) => { loaded = typeof m.connect; }) / 1;
// Capture the same imported capability for an actual TCP attempt, not just a typeof probe.
const socketsReady = Promise.withResolvers();
const capture = function(){} / import("cloudflare:sockets").then(socketsReady.resolve, socketsReady.reject) / 1;
async function probeNetwork() {
  const { connect } = await socketsReady.promise;
  const attempt = async (operation) => {
    try { await operation(); return "allowed"; }
    catch { return "refused"; }
  };
  const tcp = await attempt(async () => {
    const socket = connect({ hostname: "127.0.0.1", port: ${port} });
    socket.closed.catch(() => {});
    try { await socket.opened; }
    finally { await socket.close().catch(() => {}); }
  });
  const http = await attempt(() => fetch("http://127.0.0.1:${port}/"));
  const webSocket = await attempt(() => fetch("http://127.0.0.1:${port}/", {
    headers: { Upgrade: "websocket" }
  }));
  return { loaded, tcp, fetch: http, webSocket };
}
export default { async fetch(request, env, ctx) {
  const input = await request.json();
  const network = await probeNetwork();
  if (input.type === "describe") {
    return Response.json({ ok: true, handlers: Object.fromEntries(
      Object.entries(network).map(([name, value]) => ["probe." + name + "_" + value,
        { kind: "query", args: {}, result: { kind: "json" } }])
    ) });
  }
  const callback = await ctx.props.callbacks.call({ op: "network.probe", args: {} });
  return Response.json({ ok: true, value: { ...network, callback } });
} };
`;
