// @effect-diagnostics nodeBuiltinImport:off -- IP classification and certificate hostname checks require Node's network APIs.
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Pg from "pg";
import * as Metadata from "./Snapshot.js";
import * as SourceNetwork from "./SourceNetwork.js";

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });

export class TlsRequired extends Schema.TaggedError<TlsRequired>()("TlsRequired", {
  cause: Schema.optionalKey(SecretCause)
}) {
  readonly code = "tls_required";
  readonly status = 422;
  override get message() {
    return "The database must support TLS with certificate and hostname verification; use sslmode=verify-full.";
  }
}
export class PublicAddressRequired extends Schema.TaggedError<PublicAddressRequired>()(
  "PublicAddressRequired",
  {}
) {
  readonly code = "public_address_required";
  readonly status = 422;
  override get message() {
    return "The database must be reachable from the internet over TLS.";
  }
}

export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
  "SourceUnavailable",
  {
    stage: Schema.Literals(["dns", "connect", "query", "metadata"]),
    cause: SecretCause
  }
) {
  readonly code = "source_unavailable";
  readonly status = 503;
  override get message() {
    return "The database could not be reached or inspected. Check the connection and the role's access.";
  }
}

export class DiscoveryTooLarge extends Schema.TaggedError<DiscoveryTooLarge>()(
  "DiscoveryTooLarge",
  {}
) {
  readonly code = "too_large";
  readonly status = 422;
  override get message() {
    return "Discovery is limited to 500 relations, 200 columns per relation, 10,000 named exclusions and 8 MiB of metadata.";
  }
}
export type SourceError =
  TlsRequired | PublicAddressRequired | SourceUnavailable | DiscoveryTooLarge;

export const Settings = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
  port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65_535)),
  database: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(63)),
  role: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(63)),
  password: Schema.Redacted(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
    { disallowJsonEncode: true }
  )
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A scoped connection to the source; discovery tests can supply a real, isolated Postgres client. */
export class SourceClient extends Context.Service<
  SourceClient,
  {
    readonly query: (
      statement: string,
      parameters?: ReadonlyArray<unknown>
    ) => Effect.Effect<ReadonlyArray<unknown>, SourceError>;
  }
>()("@patchy/integrations/postgres/SourceClient") {}

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const)
  privateAddresses.addSubnet(address, prefix, "ipv4");
// Azure's platform virtual address is neither RFC1918 nor link-local.
privateAddresses.addAddress("168.63.129.16", "ipv4");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20]
] as const) {
  privateAddresses.addSubnet(address, prefix, "ipv6");
}

/** Allow global unicast only; mapped, compatible, NAT64 and other transition IPv6 are refused. */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address, "ipv4");
  return (
    family === 6 && globalIpv6.check(address, "ipv6") && !privateAddresses.check(address, "ipv6")
  );
};

const resolve = Effect.fn("Postgres.resolve")(function* (host: string) {
  const network = yield* SourceNetwork.SourceNetwork;
  const addresses =
    isIP(host) !== 0
      ? [{ address: host }]
      : yield* network
          .resolve(host)
          .pipe(
            Effect.mapError(
              (cause) => new SourceUnavailable({ stage: "dns", cause: Redacted.make(cause) })
            )
          );
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    return yield* new PublicAddressRequired({});
  }
  return addresses[0]!.address;
});

const tlsFailure = Schema.is(Schema.Struct({ code: Schema.String }));
export const make = Effect.fn("Postgres.open")(function* (settings: typeof Settings.Type) {
  // No pool caches DNS. Each inspect/test/refresh/rotation resolves and validates anew.
  const address = yield* resolve(settings.host);
  const network = yield* SourceNetwork.SourceNetwork;
  const socket = yield* Effect.acquireRelease(network.socket, (socket) =>
    Effect.sync(() => {
      socket.destroy();
    })
  );
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const client = new Pg.Client({
        host: address,
        port: settings.port,
        stream: () => socket,
        database: settings.database,
        user: settings.role,
        password: Redacted.value(settings.password),
        ssl: {
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          ...(isIP(settings.host) === 0 ? { servername: settings.host } : {}),
          checkServerIdentity: (_, certificate) => checkServerIdentity(settings.host, certificate)
        },
        connectionTimeoutMillis: 5_000,
        statement_timeout: 10_000,
        query_timeout: 10_000,
        application_name: "patchy-discovery"
      });
      // An idle socket error must neither crash Node nor expose a driver diagnostic.
      client.on("error", () => {});
      return client;
    }),
    (client) =>
      Effect.sync(() => {
        // Closing the transport cancels all server work, including interrupted acquisition.
        // There is no pooled session to reset and no finalizer waiting for a hung query.
        client.connection.stream.destroy();
        void client.end().catch(() => {});
      })
  );
  yield* Effect.tryPromise({
    try: () => client.connect(),
    catch: (cause) => {
      if (
        (tlsFailure(cause) &&
          /^(?:ERR_TLS_|CERT_|DEPTH_|SELF_SIGNED_|UNABLE_TO_|ERR_SSL_)/u.test(cause.code)) ||
        (cause instanceof Error && cause.message === "The server does not support SSL connections")
      ) {
        return new TlsRequired({ cause: Redacted.make(cause) });
      }
      return new SourceUnavailable({ stage: "connect", cause: Redacted.make(cause) });
    }
  });
  const query = Effect.fn("Postgres.query")(
    (statement: string, parameters: ReadonlyArray<unknown> = []) =>
      Effect.callback<ReadonlyArray<unknown>, SourceError>((resume) => {
        const rows: Array<unknown> = [];
        let bytes = 0;
        let settled = false;
        const query = new Pg.Query({
          text: statement,
          values: [...parameters],
          queryMode: "extended"
        } as Pg.QueryConfig);
        query.on("row", (row: unknown) => {
          if (settled) return;
          bytes += Buffer.byteLength(encodeJson(row));
          if (bytes > Metadata.MAX_SNAPSHOT_BYTES || rows.length >= 110_000) {
            settled = true;
            client.connection.stream.destroy();
            resume(Effect.fail(new DiscoveryTooLarge({})));
          } else rows.push(row);
        });
        query.on("error", (cause) => {
          if (settled) return;
          settled = true;
          resume(
            Effect.fail(new SourceUnavailable({ stage: "query", cause: Redacted.make(cause) }))
          );
        });
        query.on("end", () => {
          if (settled) return;
          settled = true;
          resume(Effect.succeed(rows));
        });
        client.query(query);
        return Effect.sync(() => {
          if (!settled) client.connection.stream.destroy();
        });
      })
  );
  return SourceClient.of({ query });
});
