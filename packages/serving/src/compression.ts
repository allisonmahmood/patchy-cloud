// @effect-diagnostics nodeBuiltinImport:off -- Effect has no brotli or gzip; zlib is Node's.
/**
 * Fixed bodies compressed once and served by `Accept-Encoding`. Only the shell's broker uses it
 * today; documents, API JSON, refusals and event streams go uncompressed.
 */
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** The compressed codings on offer, in the order Patchy prefers them. */
const codings = ["br", "gzip"] as const;
export type ContentCoding = (typeof codings)[number] | "identity";

/** One body in every coding a response can send. */
export type Precompressed = Readonly<Record<ContentCoding, Uint8Array>>;

/**
 * Compresses `body` in every coding. It is synchronous and takes about 45 ms for the broker, so
 * call it once when the bytes are fixed, never per request. Brotli quality 9 is about 8% larger
 * than quality 11 for a fiftieth of its CPU (the broker: 89 KB in 30 ms against 83 KB in 1.5 s).
 */
export const precompress = (body: Uint8Array): Precompressed => ({
  identity: body,
  br: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
  gzip: gzipSync(body)
});

/**
 * The coding to send for a request's `Accept-Encoding`: the higher-weighted of `br` and `gzip`,
 * `br` on a tie, unless the reader weights `identity` above it. No header, `identity` alone, or
 * `q=0` on both compressed codings means identity.
 */
export const negotiate = (acceptEncoding: string | undefined): ContentCoding => {
  const weights = new Map<string, number>();
  for (const entry of acceptEncoding?.split(",") ?? []) {
    const [coding = "", ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
    const q = parameters.find((parameter) => parameter.startsWith("q="));
    if (coding !== "") weights.set(coding, q === undefined ? 1 : Number(q.slice(2)) || 0);
  }
  const weight = (coding: string) => weights.get(coding) ?? weights.get("*") ?? 0;
  const best = codings.reduce((preferred, coding) =>
    weight(coding) > weight(preferred) ? coding : preferred
  );
  return weight(best) > 0 && weight(best) >= weight("identity") ? best : "identity";
};
