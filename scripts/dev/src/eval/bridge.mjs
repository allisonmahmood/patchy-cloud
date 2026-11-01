// The way out of a `pnpm dev eval` sandbox, run inside it ahead of every command:
//   node bridge.mjs <instance port> -- <command> [args...]
// The sandbox has a network of its own, with nothing but loopback. This listens on
// loopback at the instance's port, IPv4 and IPv6 (`*.localhost` resolves to both),
// and at 3128 for the proxy, and joins each connection to the matching Unix socket
// the runner mounted at /run/eval: the instance, or the proxy that allows only the
// public internet. Then it runs the command and exits as it exits. The command
// writes its output to files in its HOME rather than the runner's pipes, and this
// hands each on as it grows, as fast as the runner reads: a builder's own tools
// can make an inherited pipe non-blocking, and a write that finds it full then
// kills the builder (`failed printing to stdout`, os error 11). HOME is on disk,
// unlike the sandbox's /tmp, so output waiting for the runner costs no memory.
// Plain JavaScript on purpose: it runs on the sandbox's Node before anything else.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

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

/**
 * One of the command's output streams: a file in HOME, unlinked once open so
 * nothing else finds it, that the command writes to and this reads as it grows
 * and hands on to `to`, never faster than `to` drains. `finish`, once the
 * command has exited, hands on what the file held at that moment and resolves:
 * a process the command left running may keep writing, and must not keep the
 * sandbox alive. A runner that stops reading ends the relay, never the bridge.
 */
const relay = (name, to) => {
  const path = `${process.env.HOME ?? "/tmp"}/.eval-${name}-${process.pid}`;
  const write = openSync(path, "w");
  const read = openSync(path, "r");
  unlinkSync(path);
  const buffer = Buffer.alloc(1 << 16);
  let handed = 0;
  let end = Infinity;
  const handedOn = (async () => {
    while (handed < end) {
      const n = readSync(read, buffer, 0, Math.min(buffer.length, end - handed), null);
      if (n > 0) {
        handed += n;
        if (!to.write(Buffer.from(buffer.subarray(0, n)))) await once(to, "drain");
      } else if (end !== Infinity) break;
      else await sleep(25);
    }
    await new Promise((resolve) => to.write("", resolve));
  })();
  handedOn.catch(() => {});
  return {
    fd: write,
    finish: () => {
      end = fstatSync(read).size;
      return handedOn;
    }
  };
};

const stdout = relay("stdout", process.stdout);
const stderr = relay("stderr", process.stderr);
const child = spawn(command, args, { stdio: ["inherit", stdout.fd, stderr.fd] });
closeSync(stdout.fd);
closeSync(stderr.fd);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  process.stderr.write(`bridge: ${command}: ${error.message}\n`);
  process.exit(127);
});
// Exiting ends everything the command left running, as the sandbox's first
// process; first, whatever it wrote last is handed on.
child.on("exit", (code, signal) => {
  const status = code ?? (signal === null ? 1 : 128);
  void Promise.allSettled([stdout.finish(), stderr.finish()]).then(() => process.exit(status));
});
