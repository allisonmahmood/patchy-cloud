/**
 * Which proxies to believe about where a request came from. Every per-address
 * decision on the server — the protected-API limit, the mint limit and quota,
 * the source address a version records — keys on the request's remote address,
 * and behind a proxy that address is the proxy's. `PATCHY_TRUST_PROXY` names
 * the networks whose `X-Forwarded-For` is believed; from a direct peer the
 * header is ignored, since anyone can write one.
 *
 * Effect's `HttpMiddleware.xForwardedHeaders` takes the header's first address
 * and has no allow-list, so the walk is done here: from the socket address
 * leftward through the chain, the first address outside a trusted network is
 * the client's. Blanket trust — a list that covers a whole address family, or
 * the IPv4-mapped IPv6 alias of one — is refused at startup, because it would
 * let any direct peer choose its own attribution.
 */
// @effect-diagnostics nodeBuiltinImport:off -- `isIP` has no Effect equivalent.
import { isIP } from "node:net";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_MAX = (1n << 32n) - 1n;
const IPV6_MAX = (1n << 128n) - 1n;
const IPV4_MAPPED_IPV6_START = 0xffffn << 32n;
const IPV4_MAPPED_IPV6_END = IPV4_MAPPED_IPV6_START + IPV4_MAX;
const DEPRECATED_TRANSITIONAL_IPV6_PATTERN = /^::(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
const IPV4_MAPPED_IPV6_PATTERN = /^::ffff:((?:[0-9]{1,3}\.){3}[0-9]{1,3})$/i;

/** One trusted network: an address family and the inclusive span it covers. */
export class Range extends Schema.Class<Range>("TrustedProxyRange")({
  family: Schema.Literals([4, 6]),
  start: Schema.BigInt,
  end: Schema.BigInt
}) {}

/**
 * `PATCHY_TRUST_PROXY` as written: comma-separated addresses or CIDR blocks.
 * Decodes to the ranges, or refuses the whole value when any entry is not one
 * or the list adds up to blanket trust.
 */
export const TrustedProxies = Schema.String.pipe(
  Schema.decodeTo(Schema.Array(Range), {
    decode: SchemaGetter.transformOrFail((value: string, options) => {
      const ranges = parse(value);
      return ranges === null
        ? Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: `Invalid PATCHY_TRUST_PROXY value: ${value}` },
              value,
              options
            )
          )
        : Effect.succeed(ranges);
    }),
    encode: SchemaGetter.forbidden(() => "Trusted proxy ranges are read, never written.")
  })
);

/** The trusted networks, none unless configured. */
export const config = Config.schema(TrustedProxies, "PATCHY_TRUST_PROXY").pipe(
  Config.withDefault([] as ReadonlyArray<Range>)
);

/**
 * The client's address, given the socket's and the forwarding chain: the
 * socket address unless it is a trusted proxy's, in which case the chain is
 * walked right to left and the first untrusted address wins. A chain that is
 * trusted end to end answers with its leftmost entry.
 */
export const resolve = (
  ranges: ReadonlyArray<Range>,
  remoteAddress: Option.Option<string>,
  forwardedFor: string | undefined
): Option.Option<string> => {
  if (Option.isNone(remoteAddress) || !isTrusted(ranges, remoteAddress.value)) {
    return remoteAddress;
  }
  const chain = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  let candidate = remoteAddress.value;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    candidate = chain[index] as string;
    if (!isTrusted(ranges, candidate)) break;
  }
  return Option.some(candidate);
};

/**
 * Rewrites the request's remote address to the resolved client address, so
 * everything downstream keys on the client rather than the proxy in front of
 * it. Reads the configuration once; with no trusted networks the request is
 * left alone.
 */
export const make = Effect.map(config, (ranges) =>
  HttpMiddleware.make((httpEffect) =>
    ranges.length === 0
      ? httpEffect
      : Effect.updateService(httpEffect, HttpServerRequest.HttpServerRequest, (request) =>
          request.modify({
            remoteAddress: resolve(
              ranges,
              request.remoteAddress,
              request.headers["x-forwarded-for"]
            )
          })
        )
  )
);

function isTrusted(ranges: ReadonlyArray<Range>, address: string): boolean {
  const mapped = IPV4_MAPPED_IPV6_PATTERN.exec(address)?.[1];
  const family = isIP(mapped ?? address);
  if (family !== 4 && family !== 6) return false;
  const value = family === 4 ? ipv4ToBigInt(mapped ?? address) : ipv6ToBigInt(address);
  return ranges.some(
    (range) => range.family === family && value >= range.start && value <= range.end
  );
}

/** The ranges the value names, or `null` when it is not a valid, non-blanket list. */
function parse(value: string): ReadonlyArray<Range> | null {
  const ranges: Range[] = [];
  for (const entry of value.split(",").map((part) => part.trim())) {
    const range = parseRange(entry);
    if (range === null) return null;
    ranges.push(range);
  }
  if (coversFullAddressFamily(ranges, 4) || coversFullAddressFamily(ranges, 6)) return null;
  return ranges;
}

function parseRange(value: string): Range | null {
  if (value.includes("%")) return null;

  const [address, prefix, extra] = value.split("/");
  if (!address || extra !== undefined) return null;

  const family = isIP(address);
  if (family !== 4 && family !== 6) return null;

  const bitWidth = family === 4 ? IPV4_BITS : IPV6_BITS;
  const prefixLength = prefix === undefined ? bitWidth : parsePrefixLength(prefix, bitWidth);
  if (prefixLength === null) return null;
  if (family === 6 && DEPRECATED_TRANSITIONAL_IPV6_PATTERN.test(address)) return null;

  const range = cidrRange(address, family, prefixLength);
  if (family === 6 && overlapsIpv4MappedIpv6Alias(range)) return null;
  return range;
}

function parsePrefixLength(prefix: string, bitWidth: number): number | null {
  if (!/^[1-9]\d*$/.test(prefix)) return null;
  const prefixLength = Number(prefix);
  return prefixLength <= bitWidth ? prefixLength : null;
}

function cidrRange(address: string, family: 4 | 6, prefixLength: number): Range {
  const bitWidth = family === 4 ? IPV4_BITS : IPV6_BITS;
  const value = family === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  const size = 1n << BigInt(bitWidth - prefixLength);
  const start = (value / size) * size;
  return new Range({ family, start, end: start + size - 1n });
}

function overlapsIpv4MappedIpv6Alias(range: Range): boolean {
  return range.start <= IPV4_MAPPED_IPV6_END && range.end >= IPV4_MAPPED_IPV6_START;
}

function coversFullAddressFamily(ranges: ReadonlyArray<Range>, family: 4 | 6): boolean {
  const familyRanges = ranges
    .filter((range) => range.family === family)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  if (familyRanges.length === 0) return false;

  const max = family === 4 ? IPV4_MAX : IPV6_MAX;
  let nextUncovered = 0n;
  for (const range of familyRanges) {
    if (range.end < nextUncovered) continue;
    if (range.start > nextUncovered) return false;
    if (range.end === max) return true;
    nextUncovered = range.end + 1n;
  }
  return false;
}

function ipv4ToBigInt(address: string): bigint {
  let value = 0n;
  for (const octet of address.split(".")) {
    value = (value << 8n) + BigInt(Number(octet));
  }
  return value;
}

function ipv6ToBigInt(address: string): bigint {
  const halves = address.toLowerCase().split("::");
  const head = halves[0] ?? "";
  const tail = halves[1] ?? "";
  const zeroSegments =
    halves.length === 2 ? IPV6_BITS / 16 - countIpv6Segments(head) - countIpv6Segments(tail) : 0;
  const segments: number[] = [];

  appendIpv6Segments(segments, head);
  for (let index = 0; index < zeroSegments; index += 1) {
    segments.push(0);
  }
  appendIpv6Segments(segments, tail);

  let value = 0n;
  for (const segment of segments) {
    value = (value << 16n) + BigInt(segment);
  }
  return value;
}

function countIpv6Segments(section: string): number {
  if (!section) return 0;
  let count = 0;
  for (const segment of section.split(":")) {
    count += segment.includes(".") ? 2 : 1;
  }
  return count;
}

function appendIpv6Segments(segments: number[], section: string): void {
  if (!section) return;
  for (const segment of section.split(":")) {
    if (segment.includes(".")) {
      const ipv4 = ipv4ToBigInt(segment);
      segments.push(Number((ipv4 >> 16n) & 0xffffn));
      segments.push(Number(ipv4 & 0xffffn));
    } else {
      segments.push(Number.parseInt(segment, 16));
    }
  }
}
