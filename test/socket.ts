// @effect-diagnostics nodeBuiltinImport:off -- a raw socket sends what no HTTP client will.
/**
 * Requests on a raw socket, for what an HTTP client won't send or wait out: here, an upload whose
 * body never finishes.
 */
import { connect } from "node:net";

/** The server's answer to a stalled upload, and when it closed the connection. */
export interface StalledAnswer {
  /** The answer's status, or 0 for none. */
  readonly status: number;
  /** The answer's whole body. */
  readonly body: string;
  /** When the server closed the connection, or `undefined` if it was still open at `waitMs`. */
  readonly closedAfterMs: number | undefined;
}

/** The answer in `bytes`, and how many bytes of its body hadn't arrived; `undefined` before its head. */
const answerOf = (bytes: Buffer) => {
  const end = bytes.indexOf("\r\n\r\n");
  if (end === -1) return undefined;
  const head = bytes.subarray(0, end).toString("latin1");
  const length = /^content-length: *(\d+) *$/im.exec(head)?.[1];
  // Every refusal here has a fixed body; without a length there is no telling it all arrived.
  if (length === undefined) throw new Error(`The answer has no content-length:\n${head}`);
  const body = bytes.subarray(end + 4, end + 4 + Number(length));
  return {
    status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0),
    body: body.toString("utf8"),
    missing: Number(length) - body.byteLength
  };
};

/**
 * Sends `head` and then a body that never finishes: `{ chunked: n }` sends one chunk of `n` bytes
 * and never the terminating chunk; `{ declared: n }` declares `n` bytes and sends none. Waits up
 * to `waitMs` for the server to close the connection. Rejects when the server closed it before its
 * whole answer arrived, so a close that cut the refusal short never passes for an answer.
 */
export const stalledUpload = (
  port: number,
  head: string,
  body: { readonly chunked: number } | { readonly declared: number },
  waitMs = 3_000
): Promise<StalledAnswer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const started = performance.now();
    const socket = connect(port, "127.0.0.1");
    let finished = false;
    const finish = (closedAfterMs: number | undefined) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      try {
        const answer = answerOf(Buffer.concat(chunks));
        if (closedAfterMs !== undefined && (answer === undefined || answer.missing > 0))
          throw new Error(
            answer === undefined
              ? "The server closed the connection before its answer's head arrived."
              : `The server closed the connection ${answer.missing} bytes short of its answer's body.`
          );
        resolve({ status: answer?.status ?? 0, body: answer?.body ?? "", closedAfterMs });
      } catch (error) {
        reject(error);
      }
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
