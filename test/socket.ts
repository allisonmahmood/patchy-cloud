// @effect-diagnostics nodeBuiltinImport:off -- a raw socket sends what no HTTP client will.
/**
 * Requests on a raw socket, for what an HTTP client won't send or wait out: here, an upload whose
 * body never ends.
 */
import { connect } from "node:net";

/**
 * Sends `head` with a chunked body of `bytes` bytes, never sends the terminating chunk, and waits
 * up to `waitMs` for the server to close the connection. `status` is the answer's, or 0 for none;
 * `closedAfterMs` is when the server closed it, or `undefined` if it was still open at `waitMs`.
 */
export const unterminatedUpload = (
  port: number,
  head: string,
  bytes: number,
  waitMs = 3_000
): Promise<{ readonly status: number; readonly closedAfterMs: number | undefined }> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const started = performance.now();
    const socket = connect(port, "127.0.0.1");
    let finished = false;
    const finish = (closedAfterMs: number | undefined) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      const status = /^HTTP\/1\.1 (\d{3})/.exec(Buffer.concat(chunks).toString("latin1"));
      resolve({ status: Number(status?.[1] ?? 0), closedAfterMs });
    };
    const timer = setTimeout(() => finish(undefined), waitMs);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => finish(performance.now() - started));
    socket.write(
      `${head.trim().replaceAll("\n", "\r\n")}\r\ntransfer-encoding: chunked\r\n\r\n` +
        `${bytes.toString(16)}\r\n${"x".repeat(bytes)}\r\n`
    );
  });
