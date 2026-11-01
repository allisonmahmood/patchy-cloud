/**
 * The only ways out of a `pnpm dev eval` sandbox. Builders run in a network of
 * their own (`bwrap --unshare-net`), so nothing on this machine's network is
 * reachable: not the evidence instance's Postgres, not other worktrees'
 * instances, not the LAN. The runner opens two Unix sockets, mounted into every
 * sandbox, and the bridge inside (`bridge.mjs`) joins them to loopback:
 *
 * - the instance: every connection goes to the evidence instance's HTTP port;
 * - a proxy (`HTTPS_PROXY`): `CONNECT` to the public internet, as a real user's
 *   agent has, refusing loopback, private, shared and link-local addresses;
 *   only the exact `host:port` endpoints in `allow` (a model provider on a
 *   private network) skip that check. It connects to the address it vetted,
 *   so a name can't be rebound to a private one between the check and the
 *   connection. Whatever a request holds, it can only fail its own connection:
 *   every builder shares the proxy.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { lookup } from "node:dns/promises";
import net from "node:net";

export class DoorFailed extends Schema.TaggedError<DoorFailed>()("DoorFailed", {
  door: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `The sandbox's ${this.door} socket couldn't open: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

/** Where the sockets are, for the sandbox to mount, and the instance's port, for the bridge to listen on. */
export interface Network {
  /** The folder holding `instance.sock` and `proxy.sock`, mounted at `/run/eval`. */
  readonly sockets: string;
  readonly instancePort: number;
  /** The bridge script, mounted at `/opt/eval/bridge.mjs`. */
  readonly bridge: string;
  /** Real Node's binary, a single self-contained file, mounted at `/opt/eval/node` to run the bridge. */
  readonly node: string;
}

/** The port the bridge serves the proxy on inside every sandbox. */
export const PROXY_PORT = 3128;

/** Addresses a sandbox may never reach through the proxy: this machine, its networks, and nothing-addresses. */
const PRIVATE = (() => {
  const list = new net.BlockList();
  for (const [prefix, bits] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ] as const)
    list.addSubnet(prefix, bits, "ipv4");
  for (const [prefix, bits] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8]
  ] as const)
    list.addSubnet(prefix, bits, "ipv6");
  return list;
})();

/** Whether a sandbox may reach `address` through the proxy. IPv4-mapped IPv6 is judged as IPv4. */
export const isPublic = (address: string) => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return !PRIVATE.check(mapped, "ipv4");
  return !PRIVATE.check(address, net.isIP(address) === 6 ? "ipv6" : "ipv4");
};

/** An endpoint as the allow list holds it: a lowercased host without brackets, and a port. */
export const endpoint = (host: string, port: number) =>
  `${host.replace(/^\[|\]$/g, "").toLowerCase()}:${port}`;

/**
 * The address to connect to for `host:port`, or why not. An allowed endpoint
 * skips the private-address check, name or address alike; nothing else does.
 */
const vet = async (host: string, port: number, allow: ReadonlySet<string>) => {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = allow.has(endpoint(name, port));
  if (net.isIP(name) !== 0)
    return allowed || isPublic(name) ? { address: name } : { refused: "a private address" };
  const addresses = await lookup(name, { all: true }).catch(() => []);
  if (addresses.length === 0) return { refused: "a name that doesn't resolve" };
  if (allowed) return { address: addresses[0]!.address };
  const open = addresses.find((each) => isPublic(each.address));
  return addresses.every((each) => isPublic(each.address)) && open !== undefined
    ? { address: open.address }
    : { refused: "a private address" };
};

/** One proxy connection: reads the `CONNECT` line, vets it, then joins the two sides. */
const proxyConnection = (allow: ReadonlySet<string>) => (inside: net.Socket) => {
  let head = "";
  const refuse = (status: string) => inside.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  inside.on("error", () => inside.destroy());
  const onData = (chunk: Buffer) => {
    head += chunk.toString("latin1");
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) {
      if (head.length > 8_192) refuse("431 Request Header Fields Too Large");
      return;
    }
    inside.removeAllListeners("data");
    inside.pause();
    const match = /^CONNECT\s+(\[[^\]]+\]|[^\s:]+):(\d{1,5})\s+HTTP\/1\.[01]/i.exec(head);
    if (match === null) return refuse("405 Method Not Allowed");
    const host = match[1]!;
    const port = Number(match[2]);
    if (port < 1 || port > 65_535) return refuse("400 Bad Request");
    const rest = Buffer.from(head.slice(end + 4), "latin1");
    void vet(host, port, allow)
      .then((vetted) => {
        // The sandbox's side may have closed while the name resolved, the network with it.
        if (inside.destroyed) return;
        if ("refused" in vetted) return refuse("403 Forbidden");
        const outside = net.connect(port, vetted.address);
        // The far side goes with the sandbox's side, whichever way that ends.
        inside.on("close", () => outside.destroy());
        let joined = false;
        outside.on("error", () => {
          outside.destroy();
          if (joined) inside.destroy();
          else refuse("502 Bad Gateway");
        });
        outside.on("connect", () => {
          joined = true;
          inside.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) outside.write(rest);
          inside.pipe(outside).pipe(inside);
          inside.resume();
        });
      })
      .catch(() => refuse("502 Bad Gateway"));
  };
  inside.on("data", (chunk: Buffer) => {
    try {
      onData(chunk);
    } catch {
      inside.destroy();
    }
  });
};

/** Every connection joined to the instance's port on this machine's loopback. */
const instanceConnection = (port: number) => (inside: net.Socket) => {
  const outside = net.connect(port, "127.0.0.1");
  const close = () => {
    inside.destroy();
    outside.destroy();
  };
  inside.on("error", close);
  outside.on("error", close);
  inside.on("close", close);
  inside.pipe(outside).pipe(inside);
};

/**
 * A socket server for the rest of the scope. Closing it also ends every
 * connection still open, such as one a builder's browser left half-open:
 * `server.close` alone waits for each to end, so a suite would never finish.
 */
const listen = (door: string, file: string, handle: (socket: net.Socket) => void) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<{ server: net.Server; open: Set<net.Socket> }>((resolve, reject) => {
          const open = new Set<net.Socket>();
          const server = net.createServer((socket) => {
            open.add(socket);
            socket.on("close", () => open.delete(socket));
            handle(socket);
          });
          server.on("error", reject);
          server.listen(file, () => resolve({ server, open }));
        }),
      catch: (cause) => new DoorFailed({ door, cause })
    }),
    ({ server, open }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            for (const socket of open) socket.destroy();
          })
      )
  );

/**
 * Opens the instance and proxy sockets for the rest of the scope, in a temp
 * folder of their own: a Unix socket's path has to fit in about 100 bytes,
 * which a suite folder inside a worktree doesn't. `allow` names the `host:port`
 * endpoints the proxy may reach on a private network (`endpoint`), such as a
 * model provider on the developer's own.
 */
export const openNetwork = Effect.fn("Eval.openNetwork")(function* (input: {
  readonly instancePort: number;
  readonly allow: ReadonlyArray<string>;
  /** Real Node's binary, never Bun's: the runner itself runs on Bun. */
  readonly node: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-eval-" });
  const allow = new Set(input.allow.map((host) => host.toLowerCase()));
  yield* listen(
    "instance",
    path.join(dir, "instance.sock"),
    instanceConnection(input.instancePort)
  );
  yield* listen("proxy", path.join(dir, "proxy.sock"), proxyConnection(allow));
  return {
    sockets: dir,
    instancePort: input.instancePort,
    bridge: new URL("./bridge.mjs", import.meta.url).pathname,
    node: input.node
  } satisfies Network;
});
