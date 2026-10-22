// @effect-diagnostics nodeBuiltinImport:off -- DNS resolution and TLS sockets are the native transport boundary.
/**
 * The network under client metadata document fetches: resolving a host, and a TLS connection
 * to addresses ClientDocuments has already checked. Tests replace only this; ClientDocuments
 * keeps the address check, the HTTP rules, the limits and the cache.
 */
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import { checkServerIdentity, connect } from "node:tls";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class LookupFailed extends Schema.TaggedError<LookupFailed>()("LookupFailed", {
  host: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `DNS lookup failed for ${this.host}.`;
  }
}

/** One address a host resolved to. */
export interface Address {
  readonly address: string;
  readonly family: number;
}

export class ClientDocumentNetwork extends Context.Service<
  ClientDocumentNetwork,
  {
    /** Every address `host` resolves to. A fetch asks once and connects only to the answer. */
    readonly resolve: (host: string) => Effect.Effect<ReadonlyArray<Address>, LookupFailed>;
    /**
     * A TLS connection for `hostname`, verified against its certificate, made to one of
     * `addresses` and never to anything the name resolves to later. The stream reports a
     * connection or handshake failure as its error.
     */
    readonly connect: (target: {
      readonly hostname: string;
      readonly port: number;
      readonly addresses: ReadonlyArray<Address>;
    }) => Effect.Effect<Duplex>;
  }
>()("@patchy/auth/ClientDocumentNetwork") {}

/** Answers a socket's lookup with the checked addresses, so the name is never resolved again. */
const pinned =
  (addresses: ReadonlyArray<Address>): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all)
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family }))
      );
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };

export const layer = Layer.succeed(ClientDocumentNetwork, {
  resolve: Effect.fn("ClientDocumentNetwork.resolve")((host: string) =>
    Effect.tryPromise({
      try: () => lookup(host, { all: true, verbatim: true }),
      catch: (cause) => new LookupFailed({ host, cause })
    })
  ),
  connect: ({ hostname, port, addresses }) =>
    Effect.sync(() =>
      connect({
        host: hostname,
        port,
        // Node's default family autoselection asks for every address and tries them in turn,
        // so a host without IPv6 egress still connects.
        lookup: pinned(addresses),
        servername: hostname,
        ALPNProtocols: ["http/1.1"],
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        checkServerIdentity: (_, certificate) => checkServerIdentity(hostname, certificate)
      })
    )
});
