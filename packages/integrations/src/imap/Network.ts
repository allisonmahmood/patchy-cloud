// @effect-diagnostics nodeBuiltinImport:off -- DNS resolution is the native transport boundary.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ImapPort } from "@patchy/api";
import { isPublicAddress } from "@patchy/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * The network under IMAP sessions: resolving a mail server's name, which addresses it may be
 * reached at, where a checked address is dialled, and which certificate authorities are trusted.
 * Tests and the dev runner replace only this; `Source` keeps the address check, TLS, the
 * certificate check and every IMAP rule.
 */

export class LookupFailed extends Schema.TaggedError<LookupFailed>()("ImapLookupFailed", {
  host: Schema.String,
  /** Node's DNS error code, such as ENOTFOUND, when it gave one. */
  reason: Schema.optionalKey(Schema.String)
}) {
  override get message() {
    return `DNS lookup failed for ${this.host}.`;
  }
}

/** A checked address, the host it was resolved for and the port typed for it. */
export interface Target {
  readonly host: string;
  readonly address: string;
  readonly port: ImapPort;
}

export class Network extends Context.Service<
  Network,
  {
    /** Every address `host` resolves to. A session asks once and dials only the answer. */
    readonly resolve: (host: string) => Effect.Effect<ReadonlyArray<string>, LookupFailed>;
    /** Whether `address`, resolved for `host`, may be dialled: production admits public ones only. */
    readonly admits: (host: string, address: string) => boolean;
    /** Where a checked address is dialled: production dials it at the typed port. */
    readonly destination: (target: Target) => { readonly address: string; readonly port: number };
    /** Certificate authorities trusted beside the system's for `host`; production adds none. */
    readonly ca: (host: string) => ReadonlyArray<string> | undefined;
  }
>()("@patchy/integrations/imap/Network") {}

const system = Effect.fn("Imap.lookup")((host: string) =>
  Effect.tryPromise({
    try: () => lookup(host, { all: true, verbatim: true }),
    catch: (cause) =>
      new LookupFailed({
        host,
        ...(typeof cause === "object" && cause !== null && "code" in cause
          ? { reason: String(cause.code) }
          : {})
      })
  }).pipe(Effect.map((found) => found.map(({ address }) => address)))
);

/** Production's network: the system's resolver, public addresses only, the system's CAs. */
export const layer = Layer.succeed(
  Network,
  Network.of({
    resolve: system,
    admits: (_host, address) => isPublicAddress(address),
    destination: ({ address, port }) => ({ address, port }),
    ca: () => undefined
  })
);

/**
 * A mail server on this machine, under the host an admin types for it: the local port answering
 * for each port an admin may type, and the PEM certificate authority that signed its certificate.
 */
export const LoopbackServer = Schema.Struct({
  host: Schema.String,
  ports: Schema.Struct({
    993: Schema.optionalKey(Schema.Int),
    143: Schema.optionalKey(Schema.Int)
  }),
  ca: Schema.String
});
export type LoopbackServer = typeof LoopbackServer.Type;

const isLoopback = (address: string) =>
  address === "::1" || (isIP(address) === 4 && address.startsWith("127."));

/**
 * Dev's and tests' network: each of `servers` resolves to loopback and is dialled at its own local
 * port for the port typed, with its CA trusted beside the system's. Every other host resolves and
 * is checked as in production. `servers` is asked again for every session, so the dev runner can
 * add a mailbox to a running instance.
 *
 * A layer, never configuration: production's entrypoint never provides it, and nothing a
 * production host reads can turn it on.
 */
export const loopback = (servers: () => ReadonlyArray<LoopbackServer>) => {
  const find = (host: string) => servers().find((server) => server.host === host);
  return Layer.succeed(
    Network,
    Network.of({
      resolve: (host) =>
        find(host) === undefined ? system(host) : Effect.succeed(["127.0.0.1"] as const),
      admits: (host, address) =>
        isPublicAddress(address) || (isLoopback(address) && find(host) !== undefined),
      destination: ({ host, address, port }) => {
        const local = find(host)?.ports[port];
        return local !== undefined && isLoopback(address)
          ? { address, port: local }
          : { address, port };
      },
      ca: (host) => {
        const server = find(host);
        return server === undefined ? undefined : [server.ca];
      }
    })
  );
};
