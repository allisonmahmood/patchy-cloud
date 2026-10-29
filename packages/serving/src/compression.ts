// @effect-diagnostics nodeBuiltinImport:off -- Effect has no brotli or gzip; zlib is Node's.
/**
 * Fixed bodies compressed once and served by `Accept-Encoding`: the shell's broker, compressed at
 * startup, and patch content documents, compressed when the host keeps them. Shell HTML, API
 * JSON, refusals and event streams go uncompressed.
 */
import { brotliCompress, constants, gzip } from "node:zlib";
import * as Effect from "effect/Effect";

/** The compressed codings on offer, in the order Patchy prefers them. */
const codings = ["br", "gzip"] as const;
export type ContentCoding = (typeof codings)[number] | "identity";

/** One body in every coding a response can send. */
export type Precompressed = Readonly<Record<ContentCoding, Uint8Array>>;

/** Runs one zlib coding on libuv's threadpool. It only fails on a zlib fault, a defect. */
const onThreadpool = (
  code: (body: Uint8Array, done: (error: Error | null, result: Uint8Array) => void) => void,
  body: Uint8Array
) =>
  Effect.callback<Uint8Array>((resume) => {
    code(body, (error, result) =>
      resume(error === null ? Effect.succeed(result) : Effect.die(error))
    );
  });

/**
 * Compresses `body` in every coding, one after the other on libuv's threadpool, so the event loop
 * keeps serving and only one pool thread is busy: about 30 ms for a 230 KB patch document and
 * 50 ms for the broker, but never per request. A host task has one vCPU, so running the codings
 * at once would finish no sooner. Brotli quality 9 is about 8% larger than quality 11 for
 * a fiftieth of its CPU (the broker: 89 KB in 30 ms against 83 KB in 1.5 s).
 *
 * Interrupting it stops the wait, not zlib: a caller bounding this work holds its permit until
 * the codings finish.
 */
export const compress = (body: Uint8Array): Effect.Effect<Precompressed> =>
  Effect.all({
    identity: Effect.succeed(body),
    br: onThreadpool(
      (input, done) =>
        brotliCompress(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }, done),
      body
    ),
    gzip: onThreadpool(gzip, body)
  });

/** RFC 9110 §12.4.2's weight: `0` with up to three decimals, or `1` with up to three zeros. */
const qvalue = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * The coding to send for a request's `Accept-Encoding`: the higher-weighted of `br` and `gzip`,
 * `br` on a tie, unless the reader weights `identity` above it. No header, `identity` alone, or
 * `q=0` on both compressed codings means identity.
 *
 * A header refusing everything, identity included (`*;q=0`), still gets identity rather than a
 * 406: RFC 9110 §12.4.1 lets a server disregard such a header, and refusing the shell's own
 * script would break the page. An entry whose weight breaks §12.4.2's grammar (`q=2`,
 * `q=0.0001`) is ignored, as if it weren't listed.
 */
export const negotiate = (acceptEncoding: string | undefined): ContentCoding => {
  const weights = new Map<string, number>();
  for (const entry of acceptEncoding?.split(",") ?? []) {
    const [coding = "", ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
    const q = parameters.find((parameter) => parameter.startsWith("q="))?.slice(2) ?? "1";
    if (coding !== "" && qvalue.test(q)) weights.set(coding, Number(q));
  }
  const weight = (coding: string) => weights.get(coding) ?? weights.get("*") ?? 0;
  const best = codings.reduce((preferred, coding) =>
    weight(coding) > weight(preferred) ? coding : preferred
  );
  return weight(best) > 0 && weight(best) >= weight("identity") ? best : "identity";
};
