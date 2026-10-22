/**
 * Which requests the door answers at all, before it reads a token (docs/product.md › The door
 * › Request trust). Authority comes only from the bearer, so nothing here depends on where a
 * client runs: these rules keep a stranger's page off a dev instance by DNS rebinding, and
 * refuse what can't be read as one request from one origin.
 *
 * `Host` is the gate. The door never believes a forwarded host: the load balancer preserves the
 * `Host` a client sent, port and duplicates included. The door reads an absolute-form target's
 * authority instead, as RFC 9112 does, and refuses a request that carried two `Host` fields,
 * since Node keeps only the first.
 */
import * as Predicate from "effect/Predicate";
import { Session } from "@patchy/auth";

/** An authority as `Host` carries it: a name or bracketed IPv6 address, then an optional port. */
const authority = /^(\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?)(?::(\d{1,5}))?$/;

const defaultPort = (url: URL) => (url.protocol === "https:" ? 443 : 80);

const withoutTrailingDot = (name: string) => (name.endsWith(".") ? name.slice(0, -1) : name);

/**
 * Whether `host` names the instance served at `publicUrl`: compared lowercased, with a trailing
 * dot and the scheme's default port treated as the same host.
 */
export const isOwnHost = (host: string | undefined, publicUrl: URL): boolean => {
  const parsed = authority.exec(host?.toLowerCase() ?? "");
  if (parsed === null) return false;
  const port = parsed[2] === undefined ? defaultPort(publicUrl) : Number(parsed[2]);
  return (
    withoutTrailingDot(parsed[1]!) === withoutTrailingDot(publicUrl.hostname) &&
    port === (publicUrl.port === "" ? defaultPort(publicUrl) : Number(publicUrl.port))
  );
};

/**
 * The authority a request was addressed to, as RFC 9112 reads it: an absolute-form target's,
 * else its one `Host` field. `undefined` when it carried two, which Node's own headers can't
 * show: only the raw fields a Node request keeps can.
 */
export const requestAuthority = (request: {
  readonly url: string;
  readonly headers: { readonly [name: string]: string | undefined };
  readonly source: object;
}): string | undefined => {
  const raw = Predicate.hasProperty(request.source, "rawHeaders")
    ? request.source.rawHeaders
    : undefined;
  if (
    Array.isArray(raw) &&
    raw.filter((field, at) => at % 2 === 0 && String(field).toLowerCase() === "host").length > 1
  )
    return undefined;
  const absolute = /^(https?):\/\/([^/?#]*)/i.exec(request.url);
  if (absolute !== null) {
    // The target's own port, or its scheme's default: never the public origin's by omission.
    const [, scheme, target] = absolute;
    if (target!.includes("@")) return undefined;
    return /:\d+$/.test(target!)
      ? target
      : `${target}:${scheme!.toLowerCase() === "https" ? 443 : 80}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(request.url)) return undefined;
  return request.headers["host"];
};

/** A reg-name host: unreserved and sub-delim characters or percent escapes, without a comma. */
const regName = /^(?:[a-z0-9\-._~!$&'()*+;=]|%[0-9a-f]{2})+$/i;
const ipFuture = /^\[v[0-9a-f]+\.[a-z0-9\-._~!$&'()*+;=:]+\]$/i;

/**
 * An origin as RFC 6454 serializes it: `null`, or a scheme, `://`, a host and an optional port,
 * with no path, user or second value. Node joins two `Origin` headers with a comma, which no
 * host here may hold, so a duplicated one is malformed too.
 */
const isSerializedOrigin = (origin: string): boolean => {
  if (origin === "null") return true;
  const parts = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^:/?#[\]@]*)(?::\d+)?$/i.exec(origin);
  if (parts === null) return false;
  const host = parts[1]!;
  if (!host.startsWith("[")) return regName.test(host);
  return ipFuture.test(host) || URL.canParse(`http://${host}`);
};

/** What the Origin rules make of a request: `malformed` and `foreign` are both answered 403. */
export type OriginCheck = "allowed" | "malformed" | "foreign";

/**
 * In production a request with no `Origin` passes, and so does any well-formed one: with
 * bearer-only auth an origin carries no authority to check, which is how Patchy reads the MCP
 * spec's "invalid". A dev instance also requires its own origin when one is sent.
 */
export const checkOrigin = (origin: string | undefined, publicUrl: URL): OriginCheck => {
  if (origin === undefined) return "allowed";
  if (!isSerializedOrigin(origin)) return "malformed";
  if (!Session.isLoopback(publicUrl)) return "allowed";
  return origin.toLowerCase() === publicUrl.origin ? "allowed" : "foreign";
};
