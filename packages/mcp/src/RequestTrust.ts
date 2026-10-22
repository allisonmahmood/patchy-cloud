/**
 * Which requests the door answers at all, before it reads a token (docs/product.md › The door
 * › Request trust). Authority comes only from the bearer, so nothing here depends on where a
 * client runs: these rules keep a stranger's page off a dev instance by DNS rebinding, and
 * refuse what can't be read as one request from one origin.
 *
 * `Host` is the gate. The load balancer passes it through unchanged and nothing in front of
 * the door forwards another, so the door reads `Host` alone and never believes a forwarded
 * host. Node keeps the first of two `Host` headers, which a browser can't send anyway.
 */
import { Session } from "@patchy/auth";

/** An authority as `Host` carries it: a name or bracketed IPv6 address, then an optional port. */
const authority = /^(\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?)(?::(\d{1,5}))?$/;

const defaultPort = (url: URL) => (url.protocol === "https:" ? 443 : 80);

/**
 * Whether `host` names the instance served at `publicUrl`: compared lowercased, with a trailing
 * dot and the scheme's default port treated as the same host.
 */
export const isOwnHost = (host: string | undefined, publicUrl: URL): boolean => {
  const parsed = authority.exec(host?.toLowerCase() ?? "");
  if (parsed === null) return false;
  const name = parsed[1]!.endsWith(".") ? parsed[1]!.slice(0, -1) : parsed[1]!;
  const port = parsed[2] === undefined ? defaultPort(publicUrl) : Number(parsed[2]);
  return (
    name === publicUrl.hostname &&
    port === (publicUrl.port === "" ? defaultPort(publicUrl) : Number(publicUrl.port))
  );
};

/**
 * An origin as browsers serialize it (RFC 6454): `null`, or a scheme, `://`, a host and an
 * optional port, with no path, user or second value. Node joins two `Origin` headers with a
 * comma, which no host here may hold, so a duplicated one is malformed too.
 */
const serializedOrigin =
  /^[a-z][a-z0-9+.-]*:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9\-._~!$&'()*+;=%]+)(?::\d+)?$/i;

/** What the Origin rules make of a request: `malformed` and `foreign` are both answered 403. */
export type OriginCheck = "allowed" | "malformed" | "foreign";

/**
 * In production a request with no `Origin` passes, and so does any well-formed one: with
 * bearer-only auth an origin carries no authority to check, which is how Patchy reads the MCP
 * spec's "invalid". A dev instance also requires its own origin when one is sent.
 */
export const checkOrigin = (origin: string | undefined, publicUrl: URL): OriginCheck => {
  if (origin === undefined) return "allowed";
  if (origin !== "null" && !serializedOrigin.test(origin)) return "malformed";
  if (!Session.isLoopback(publicUrl)) return "allowed";
  return origin.toLowerCase() === publicUrl.origin ? "allowed" : "foreign";
};
