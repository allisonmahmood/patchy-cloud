// The way out of a `pnpm dev eval` sandbox, run inside it ahead of every command:
//   node bridge.mjs <instance port> -- <command> [args...]
// The sandbox has a network of its own, with nothing but loopback. This listens on
// loopback at the instance's port, IPv4 and IPv6 (`*.localhost` resolves to both),
// and at 3128 for the proxy, and joins each connection to the matching Unix socket
// the runner mounted at /run/eval: the instance, or the proxy that allows only the
// public internet. Then it runs the command, stdio and all, and exits as it exits.
// Plain JavaScript on purpose: it runs on the sandbox's Node before anything else.
import { spawn } from "node:child_process";
import net from "node:net";

const [, , port, separator, command, ...args] = process.argv;
if (separator !== "--" || command === undefined) {
  process.stderr.write("usage: node bridge.mjs <instance port> -- <command> [args...]\n");
  process.exit(2);
}

/** Joins every connection to `host:port` with a connection to `socket`. */
const join = (socket, listenPort, host) =>
  new Promise((resolve, reject) => {
    const server = net.createServer((inside) => {
      const outside = net.connect(socket);
      const close = () => {
        inside.destroy();
        outside.destroy();
      };
      inside.on("error", close);
      outside.on("error", close);
      inside.pipe(outside).pipe(inside);
    });
    server.on("error", reject);
    server.listen(Number(listenPort), host, () => resolve(server));
  });

const servers = await Promise.all([
  join("/run/eval/instance.sock", port, "127.0.0.1"),
  join("/run/eval/instance.sock", port, "::1"),
  join("/run/eval/proxy.sock", 3128, "127.0.0.1")
]);
for (const server of servers) server.unref();

const child = spawn(command, args, { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  process.stderr.write(`bridge: ${command}: ${error.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
