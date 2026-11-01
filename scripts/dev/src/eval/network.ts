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
 *   private network) skip that check. A network opened with `only` reaches
 *   just those exact public hosts besides `allow`, for judges, who need their
 *   model providers and nothing else; its tunnels must open TLS naming the
 *   host they vetted, since a shared ingress routes by that name and would
 *   otherwise serve any site it hosts on the same connection. (A request
 *   naming another site inside that TLS session is the ingress's to refuse.)
 *   It connects to the address it vetted,
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

/** Whether `name` is one of `only`'s exact hosts; true when there's no `only`. */
export const among = (name: string, only: ReadonlyArray<string> | undefined) =>
  only === undefined || only.includes(name);

/**
 * The server name a TLS ClientHello asks for: the name, null when the bytes
 * hold a whole first record that isn't a ClientHello naming one, or undefined
 * while that record is still arriving.
 */
export const serverNameOf = (bytes: Buffer): string | null | undefined => {
  if (bytes.length < 5) return undefined;
  if (bytes[0] !== 0x16) return null;
  const end = 5 + bytes.readUInt16BE(3);
  if (end > HELLO_MAX) return null;
  if (bytes.length < end) return undefined;
  let at = 5;
  if (bytes[at] !== 0x01) return null;
  // Handshake type and length, client version, random.
  at += 4 + 2 + 32;
  if (at + 1 > end) return null;
  at += 1 + bytes[at]!;
  if (at + 2 > end) return null;
  at += 2 + bytes.readUInt16BE(at);
  if (at + 1 > end) return null;
  at += 1 + bytes[at]!;
  if (at + 2 > end) return null;
  const extensionsEnd = Math.min(end, at + 2 + bytes.readUInt16BE(at));
  at += 2;
  while (at + 4 <= extensionsEnd) {
    const type = bytes.readUInt16BE(at);
    const size = bytes.readUInt16BE(at + 2);
    at += 4;
    // server_name: its list's length, the name's type (0, a host name), the name's length, the name.
    if (type === 0) {
      if (at + 5 > extensionsEnd || bytes[at + 2] !== 0) return null;
      const length = bytes.readUInt16BE(at + 3);
      return at + 5 + length <= extensionsEnd
        ? bytes.toString("latin1", at + 5, at + 5 + length).toLowerCase()
        : null;
    }
    at += size;
  }
  return null;
};

/** The longest first TLS record a narrowed tunnel waits for: one record's header and its largest body. */
const HELLO_MAX = 5 + 16_384;

/**
 * The address to connect to for `host:port`, or why not. An allowed endpoint
 * skips the private-address check, name or address alike; nothing else does.
 * Outside `allow`, a host must be among `only`, checked before any lookup.
 */
const vet = async (
  host: string,
  port: number,
  allow: ReadonlySet<string>,
  only: ReadonlyArray<string> | undefined
) => {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = allow.has(endpoint(name, port));
  if (!allowed && !among(name, only)) return { refused: "a host this network doesn't reach" };
  if (net.isIP(name) !== 0)
    return allowed || isPublic(name)
      ? { address: name, name, allowed }
      : { refused: "a private address" };
  const addresses = await lookup(name, { all: true }).catch(() => []);
  if (addresses.length === 0) return { refused: "a name that doesn't resolve" };
  if (allowed) return { address: addresses[0]!.address, name, allowed };
  const open = addresses.find((each) => isPublic(each.address));
  return addresses.every((each) => isPublic(each.address)) && open !== undefined
    ? { address: open.address, name, allowed }
    : { refused: "a private address" };
};

/** One proxy connection: reads the `CONNECT` line, vets it, then joins the two sides. */
const proxyConnection =
  (allow: ReadonlySet<string>, only: ReadonlyArray<string> | undefined) => (inside: net.Socket) => {
    let head = "";
    const refuse = (status: string) =>
      inside.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
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
      void vet(host, port, allow, only)
        .then((vetted) => {
          if ("refused" in vetted) return refuse("403 Forbidden");
          const outside = net.connect(port, vetted.address);
          let joined = false;
          outside.on("error", () => {
            outside.destroy();
            if (joined) inside.destroy();
            else refuse("502 Bad Gateway");
          });
          outside.on("connect", () => {
            joined = true;
            inside.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (only === undefined || vetted.allowed) {
              if (rest.length > 0) outside.write(rest);
              inside.pipe(outside).pipe(inside);
              inside.resume();
              return;
            }
            // A narrowed tunnel opens only once its TLS names the host it vetted;
            // a client that leaves before then takes the far side with it.
            inside.on("close", () => outside.destroy());
            let hello = rest;
            const check = () => {
              const name = hello.length > HELLO_MAX ? null : serverNameOf(hello);
              if (name === undefined) return;
              inside.removeListener("data", onHello);
              if (name !== vetted.name) {
                inside.destroy();
                outside.destroy();
                return;
              }
              outside.write(hello);
              inside.pipe(outside).pipe(inside);
            };
            const onHello = (chunk: Buffer) => {
              hello = Buffer.concat([hello, chunk]);
              check();
            };
            inside.on("data", onHello);
            inside.resume();
            check();
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
  inside.pipe(outside).pipe(inside);
};

const listen = (door: string, file: string, handle: (socket: net.Socket) => void) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<net.Server>((resolve, reject) => {
          const server = net.createServer(handle);
          server.on("error", reject);
          server.listen(file, () => resolve(server));
        }),
      catch: (cause) => new DoorFailed({ door, cause })
    }),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
  );

/**
 * Opens the instance and proxy sockets for the rest of the scope, in a temp
 * folder of their own: a Unix socket's path has to fit in about 100 bytes,
 * which a suite folder inside a worktree doesn't. `allow` names the `host:port`
 * endpoints the proxy may reach on a private network (`endpoint`), such as a
 * model provider on the developer's own; `only`, when given, narrows the
 * public internet to those exact hosts, reached over TLS that names them.
 */
export const openNetwork = Effect.fn("Eval.openNetwork")(function* (input: {
  readonly instancePort: number;
  readonly allow: ReadonlyArray<string>;
  readonly only?: ReadonlyArray<string>;
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
  yield* listen("proxy", path.join(dir, "proxy.sock"), proxyConnection(allow, input.only));
  return {
    sockets: dir,
    instancePort: input.instancePort,
    bridge: new URL("./bridge.mjs", import.meta.url).pathname,
    node: input.node
  } satisfies Network;
});
