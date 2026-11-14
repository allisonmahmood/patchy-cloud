// @effect-diagnostics nodeBuiltinImport:off -- a raw socket sends what no HTTP client will.
/**
 * Requests on a raw socket, for what an HTTP client won't send or wait out: here, an upload whose
 * body never finishes.
 */
import { connect } from "node:net";

/**
 * Sends `head` and then a body that never finishes: `{ chunked: n }` sends one chunk of `n` bytes
 * and never the terminating chunk; `{ declared: n }` declares `n` bytes and sends none. Waits up
 * to `waitMs` for the server to close the connection. `status` is the answer's, or 0 for none;
 * `closedAfterMs` is when the server closed it, or `undefined` if it was still open at `waitMs`.
 */
export const stalledUpload = (
  port: number,
  head: string,
  body: { readonly chunked: number } | { readonly declared: number },
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
    const start = `${head.trim().replaceAll("\n", "\r\n")}\r\n`;
    socket.write(
      "chunked" in body
        ? `${start}transfer-encoding: chunked\r\n\r\n${body.chunked.toString(16)}\r\n${"x".repeat(body.chunked)}\r\n`
        : `${start}content-length: ${body.declared}\r\n\r\n`
    );
  });
