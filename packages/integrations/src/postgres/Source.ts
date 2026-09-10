// @effect-diagnostics nodeBuiltinImport:off -- DNS pinning, IP classification and certificate hostname checks require Node's network APIs.
import { lookup } from "node:dns/promises";
import { BlockList, isIP, Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Pg from "pg";
import * as Metadata from "./Snapshot.js";

const SecretCause = Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true });
export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "InvalidCredentials",
  { cause: Schema.optionalKey(SecretCause) }
) {
  readonly code = "invalid_credentials";
  readonly status = 422;
  override get message() {
    return "Use a Postgres URL with only host, port, database, user, password and sslmode options.";
  }
}
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
export class SuperuserRefused extends Schema.TaggedError<SuperuserRefused>()(
  "SuperuserRefused",
  {}
) {
  readonly code = "superuser_refused";
  readonly status = 422;
  override get message() {
    return "This role is a superuser. Connect a role without superuser privileges.";
  }
}
export class CreateDatabaseRefused extends Schema.TaggedError<CreateDatabaseRefused>()(
  "CreateDatabaseRefused",
  {}
) {
  readonly code = "createdb_refused";
  readonly status = 422;
  override get message() {
    return "This role can create databases. Connect a role without CREATEDB.";
  }
}
export class CreateRoleRefused extends Schema.TaggedError<CreateRoleRefused>()(
  "CreateRoleRefused",
  {}
) {
  readonly code = "createrole_refused";
  readonly status = 422;
  override get message() {
    return "This role can create roles. Connect a role without CREATEROLE.";
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
export class SourceTimeout extends Schema.TaggedError<SourceTimeout>()("SourceTimeout", {}) {
  readonly code = "timeout";
  readonly status = 504;
  override get message() {
    return "The database did not finish within the 15 second deadline.";
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
  | InvalidCredentials
  | TlsRequired
  | PublicAddressRequired
  | SuperuserRefused
  | CreateDatabaseRefused
  | CreateRoleRefused
  | SourceUnavailable
  | SourceTimeout
  | DiscoveryTooLarge;

export const Credentials = Schema.Redacted(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  { disallowJsonEncode: true }
);
export const Display = Schema.Struct({
  host: Schema.String,
  port: Schema.Int,
  database: Schema.String,
  role: Schema.String
});
const Settings = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
  port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65_535)),
  database: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(63)),
  role: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(63)),
  password: Schema.Redacted(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
    { disallowJsonEncode: true }
  )
});

/** This is an administration source, not an operation handler or a platform database client. */
export class Source extends Context.Service<
  Source,
  {
    readonly inspect: (credentials: Redacted.Redacted<string>) => Effect.Effect<
      {
        readonly display: typeof Display.Type;
        readonly snapshot: typeof Metadata.Snapshot.Type;
      },
      SourceError
    >;
    readonly test: (
      credentials: Redacted.Redacted<string>
    ) => Effect.Effect<typeof Display.Type, SourceError>;
  }
>()("@patchy/integrations/postgres/Source") {}

/** A scoped connection to the source; discovery tests can supply a real, isolated Postgres client. */
export class SourceClient extends Context.Service<
  SourceClient,
  {
    readonly query: (
      statement: string,
      parameters?: ReadonlyArray<unknown>
    ) => Effect.Effect<ReadonlyArray<unknown>, SourceError>;
  }
>()("@patchy/integrations/postgres/Source/SourceClient") {}

/** Only DNS and socket creation are replaceable; admission and TLS remain in Source. */
export class SourceNetwork extends Context.Service<
  SourceNetwork,
  {
    readonly resolve: (
      host: string
    ) => Effect.Effect<ReadonlyArray<{ readonly address: string }>, SourceUnavailable>;
    readonly socket: Effect.Effect<Socket>;
  }
>()("@patchy/integrations/postgres/Source/SourceNetwork") {}

const nativeNetwork = Layer.effect(
  SourceNetwork,
  Effect.sync(() =>
    SourceNetwork.of({
      resolve: Effect.fn("Postgres.lookup")((host: string) =>
        Effect.tryPromise({
          try: () => lookup(host, { all: true, verbatim: true }),
          catch: (cause) => new SourceUnavailable({ stage: "dns", cause: Redacted.make(cause) })
        })
      ),
      socket: Effect.sync(() => new Socket())
    })
  )
);

const decodeCredentials = Schema.decodeUnknownEffect(Credentials);
const decodeSettings = Schema.decodeUnknownEffect(Settings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isInvalidCredentials = Schema.is(InvalidCredentials);
const isTlsRequired = Schema.is(TlsRequired);

export const parseCredentials = Effect.fn("Postgres.parseCredentials")(function* (
  credentials: Redacted.Redacted<string>
) {
  yield* decodeCredentials(credentials).pipe(
    Effect.mapError((cause) => new InvalidCredentials({ cause: Redacted.make(cause) }))
  );
  const parsed = yield* Effect.try({
    try: () => {
      const raw = Redacted.value(credentials);
      if (raw.trim() !== raw || /[\u0000-\u0020\u007f]/u.test(raw))
        throw new InvalidCredentials({});
      const url = new URL(raw);
      if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || url.hash !== "") {
        throw new InvalidCredentials({});
      }
      const options: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (
          !["host", "port", "database", "user", "password", "sslmode"].includes(key) ||
          Object.hasOwn(options, key)
        ) {
          throw new InvalidCredentials({});
        }
        options[key] = value;
      }
      if (options.sslmode !== undefined && options.sslmode !== "verify-full")
        throw new TlsRequired({});
      let host = options.host ?? url.hostname;
      if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
      // Never let pg interpret a socket path, multiple hosts, or percent-encoded host options.
      if (
        /[\s,/%\\@?#\u0000-\u001f\u007f]/u.test(host) ||
        (isIP(host) === 0 && !/^[a-zA-Z0-9.-]+$/u.test(host))
      ) {
        throw new InvalidCredentials({});
      }
      const port = options.port ?? (url.port || "5432");
      if (!/^[0-9]{1,5}$/u.test(port)) throw new InvalidCredentials({});
      const database = options.database ?? decodeURIComponent(url.pathname.slice(1));
      const role = options.user ?? decodeURIComponent(url.username);
      const password = options.password ?? decodeURIComponent(url.password);
      if (
        [database, role, password].some((value) => /[\u0000-\u001f\u007f]/u.test(value)) ||
        database.includes("/")
      ) {
        throw new InvalidCredentials({});
      }
      return {
        host: host.toLowerCase(),
        port: Number(port),
        database,
        role,
        password: Redacted.make(password)
      };
    },
    catch: (cause) =>
      isInvalidCredentials(cause) || isTlsRequired(cause)
        ? cause
        : new InvalidCredentials({ cause: Redacted.make(cause) })
  });
  return yield* decodeSettings(parsed).pipe(
    Effect.mapError((cause) => new InvalidCredentials({ cause: Redacted.make(cause) }))
  );
});

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
  const network = yield* SourceNetwork;
  const addresses = isIP(host) !== 0 ? [{ address: host }] : yield* network.resolve(host);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    return yield* new PublicAddressRequired({});
  }
  return addresses[0]!.address;
});

const tlsFailure = Schema.is(Schema.Struct({ code: Schema.String }));
const open = Effect.fn("Postgres.open")(function* (settings: typeof Settings.Type) {
  // No pool caches DNS. Each inspect/test/refresh/rotation resolves and validates anew.
  const address = yield* resolve(settings.host);
  const network = yield* SourceNetwork;
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

const Role = Schema.Struct({
  superuser: Schema.Boolean,
  createDatabase: Schema.Boolean,
  createRole: Schema.Boolean
});
const decodeRole = Schema.decodeUnknownEffect(
  Schema.Array(Role).check(Schema.isMinLength(1), Schema.isMaxLength(1))
);
export const checkRole = Effect.gen(function* () {
  const client = yield* SourceClient;
  const rows = yield* client.query(`SELECT rolsuper AS superuser, rolcreatedb AS "createDatabase",
    rolcreaterole AS "createRole" FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER`);
  const roles = yield* decodeRole(rows).pipe(
    Effect.mapError(
      (cause) => new SourceUnavailable({ stage: "query", cause: Redacted.make(cause) })
    )
  );
  const role = roles[0]!;
  if (role.superuser) return yield* new SuperuserRefused({});
  if (role.createDatabase) return yield* new CreateDatabaseRefused({});
  if (role.createRole) return yield* new CreateRoleRefused({});
});

const CatalogRelation = Schema.Struct({
  oid: Schema.Int,
  schema: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["table", "view"])
});
const CatalogColumn = Schema.Struct({
  ...Metadata.Column.fields,
  enumOid: Schema.NullOr(Schema.Int)
});
const CatalogDetails = Schema.Struct({
  oid: Schema.Int,
  columns: Schema.Array(CatalogColumn),
  primaryKey: Schema.NullOr(Metadata.PrimaryKey),
  foreignKeys: Schema.Array(Metadata.ForeignKey)
});
const metadataDecoder = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S
) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: unknown) =>
    decode(value).pipe(
      Effect.mapError(
        (cause) => new SourceUnavailable({ stage: "metadata", cause: Redacted.make(cause) })
      )
    );
};
const decodeRelations = metadataDecoder(Schema.Array(CatalogRelation));
const decodeDetails = metadataDecoder(Schema.Array(CatalogDetails));
const decodeEnums = metadataDecoder(
  Schema.Array(
    Schema.Struct({
      oid: Schema.Int,
      schema: Schema.String,
      name: Schema.String,
      labels: Schema.Array(Schema.String)
    })
  )
);
const decodeSnapshot = metadataDecoder(Metadata.Snapshot);

/** Reads catalog metadata only. Caller owns a repeatable-read, read-only source transaction. */
export const discover = Effect.gen(function* () {
  const client = yield* SourceClient;
  const all = yield* client.query(`SELECT c.oid::int, n.nspname AS schema, c.relname AS name,
    CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS kind
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
      AND (pg_catalog.has_table_privilege(c.oid, 'SELECT') OR pg_catalog.has_any_column_privilege(c.oid, 'SELECT'))
    ORDER BY n.nspname, c.relname LIMIT 10501`);
  if (all.length > Metadata.MAX_RELATIONS + Metadata.MAX_EXCLUSIONS)
    return yield* new DiscoveryTooLarge({});
  const catalog = yield* decodeRelations(all);
  const schemaNames = new Set(
    catalog.filter((relation) => relation.schema !== "public").map((relation) => relation.schema)
  );
  const selected: Array<typeof CatalogRelation.Type> = [];
  const exclusions: Array<typeof Metadata.Exclusion.Type> = [];
  for (const relation of catalog) {
    if (
      relation.name === "query" ||
      relation.schema === "query" ||
      (relation.schema === "public" && schemaNames.has(relation.name))
    ) {
      exclusions.push({
        schema: relation.schema,
        relation: relation.name,
        reason: "reserved_name"
      });
    } else if (selected.length >= Metadata.MAX_RELATIONS) {
      exclusions.push({
        schema: relation.schema,
        relation: relation.name,
        reason: "relation_limit"
      });
    } else selected.push(relation);
  }
  const raw =
    selected.length === 0
      ? []
      : yield* client.query(
          `SELECT c.oid::int,
    COALESCE((SELECT jsonb_agg(column_info ORDER BY ordinal) FROM (
      SELECT a.attnum AS ordinal, jsonb_build_object('name', a.attname, 'nullable',
        CASE WHEN c.relkind IN ('v', 'm') THEN true ELSE NOT (a.attnotnull OR base.domain_not_null) END,
        'type', jsonb_build_object('schema', original_ns.nspname, 'name', original.typname,
          'sql', pg_catalog.format_type(a.atttypid, a.atttypmod), 'baseSchema', base_ns.nspname,
          'baseName', base.typname, 'kind', CASE WHEN base.typtype = 'e' THEN 'enum'
            WHEN base.typcategory = 'A' THEN 'array' ELSE 'base' END),
        'enumOid', CASE WHEN base.typtype = 'e' THEN base.oid::int
          WHEN element.typtype = 'e' THEN element.oid::int ELSE NULL END) AS column_info
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type original ON original.oid = a.atttypid
      JOIN pg_catalog.pg_namespace original_ns ON original_ns.oid = original.typnamespace
      JOIN LATERAL (WITH RECURSIVE chain AS (
        SELECT original.oid, original.typbasetype, original.typnotnull AS domain_not_null, 0 AS depth UNION ALL
        SELECT t.oid, t.typbasetype, chain.domain_not_null OR t.typnotnull, chain.depth + 1
        FROM chain JOIN pg_catalog.pg_type t ON t.oid = chain.typbasetype
        WHERE chain.typbasetype <> 0 AND chain.depth < 32
      ) SELECT t.*, chain.domain_not_null FROM chain JOIN pg_catalog.pg_type t ON t.oid = chain.oid
        ORDER BY chain.depth DESC LIMIT 1) base ON true
      JOIN pg_catalog.pg_namespace base_ns ON base_ns.oid = base.typnamespace
      LEFT JOIN pg_catalog.pg_type element ON element.oid = base.typelem
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_catalog.has_column_privilege(c.oid, a.attnum, 'SELECT')
      ORDER BY a.attnum LIMIT 201
    ) columns), '[]'::jsonb) AS columns,
    (SELECT jsonb_build_object('name', k.conname, 'columns',
      (SELECT jsonb_agg(a.attname ORDER BY u.ordinality) FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ordinality)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.attnum))
      FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p' LIMIT 1) AS "primaryKey",
    COALESCE((SELECT jsonb_agg(key_info ORDER BY name) FROM (
      SELECT k.conname AS name, jsonb_build_object('name', k.conname, 'columns',
        (SELECT jsonb_agg(a.attname ORDER BY u.ordinality) FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ordinality)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.attnum),
        'target', jsonb_build_object('schema', target_ns.nspname, 'relation', target.relname, 'columns',
          (SELECT jsonb_agg(a.attname ORDER BY u.ordinality) FROM unnest(k.confkey) WITH ORDINALITY u(attnum, ordinality)
            JOIN pg_catalog.pg_attribute a ON a.attrelid = target.oid AND a.attnum = u.attnum))) AS key_info
      FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class target ON target.oid = k.confrelid
      JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
      WHERE k.conrelid = c.oid AND k.contype = 'f' ORDER BY k.conname LIMIT 201
    ) keys), '[]'::jsonb) AS "foreignKeys"
    FROM pg_catalog.pg_class c WHERE c.oid = ANY($1::oid[]) ORDER BY c.oid`,
          [selected.map((relation) => relation.oid)]
        );
  const details = yield* decodeDetails(raw);
  const byOid = new Map(details.map((detail) => [detail.oid, detail]));
  const enumOids = [
    ...new Set(
      details.flatMap((detail) =>
        detail.columns.flatMap((column) => (column.enumOid === null ? [] : [column.enumOid]))
      )
    )
  ];
  const enumRows =
    enumOids.length === 0
      ? []
      : yield* client.query(
          `SELECT t.oid::int, n.nspname AS schema, t.typname AS name,
    COALESCE((SELECT jsonb_agg(label ORDER BY position) FROM (
      SELECT e.enumlabel AS label, e.enumsortorder AS position FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid
      ORDER BY e.enumsortorder LIMIT 1001) labels), '[]'::jsonb) AS labels
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE t.oid = ANY($1::oid[]) ORDER BY n.nspname, t.typname LIMIT 1001`,
          [enumOids]
        );
  const parsedEnums = yield* decodeEnums(enumRows);
  const allowedEnums = parsedEnums.filter(
    (value, index) => index < Metadata.MAX_ENUMS && value.labels.length <= Metadata.MAX_ENUM_LABELS
  );
  const allowedEnumOids = new Set(allowedEnums.map((value) => value.oid));
  const relations: Array<typeof Metadata.Relation.Type> = [];
  for (const relation of selected) {
    const detail = byOid.get(relation.oid);
    if (!detail)
      return yield* new SourceUnavailable({ stage: "metadata", cause: Redacted.make(raw) });
    if (
      detail.columns.length > Metadata.MAX_COLUMNS ||
      detail.foreignKeys.length > Metadata.MAX_COLUMNS
    ) {
      exclusions.push({
        schema: relation.schema,
        relation: relation.name,
        reason: detail.columns.length > Metadata.MAX_COLUMNS ? "column_limit" : "key_limit"
      });
      continue;
    }
    const columns: Array<typeof Metadata.Column.Type> = [];
    for (const column of detail.columns) {
      const reason = !Metadata.supportedType(column.type)
        ? "unsupported_type"
        : column.enumOid !== null && !allowedEnumOids.has(column.enumOid)
          ? "enum_limit"
          : undefined;
      if (reason)
        exclusions.push({
          schema: relation.schema,
          relation: relation.name,
          column: column.name,
          reason
        });
      else columns.push({ name: column.name, type: column.type, nullable: column.nullable });
    }
    const names = new Set(columns.map((column) => column.name));
    relations.push({
      schema: relation.schema,
      name: relation.name,
      kind: relation.kind,
      columns,
      primaryKey: detail.primaryKey?.columns.every((name) => names.has(name))
        ? detail.primaryKey
        : null,
      foreignKeys: detail.foreignKeys.filter((key) => key.columns.every((name) => names.has(name)))
    });
  }
  const snapshot = {
    version: 1 as const,
    relations,
    enums: allowedEnums.map(({ schema, name, labels }) => ({ schema, name, labels })),
    exclusions
  };
  if (
    exclusions.length > Metadata.MAX_EXCLUSIONS ||
    Buffer.byteLength(encodeJson(snapshot)) > Metadata.MAX_SNAPSHOT_BYTES
  ) {
    return yield* new DiscoveryTooLarge({});
  }
  return yield* decodeSnapshot(snapshot);
});

export const make = Effect.gen(function* () {
  const network = yield* SourceNetwork;
  const run = Effect.fn("Postgres.withSource")(
    function* <A>(
      credentials: Redacted.Redacted<string>,
      work: Effect.Effect<A, SourceError, SourceClient>
    ) {
      const settings = yield* parseCredentials(credentials);
      const client = yield* open(settings).pipe(Effect.provideService(SourceNetwork, network));
      yield* client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      yield* client.query("SET LOCAL statement_timeout = '10s'");
      yield* client.query("SET LOCAL search_path = pg_catalog");
      yield* checkRole.pipe(Effect.provideService(SourceClient, client));
      const value = yield* work.pipe(Effect.provideService(SourceClient, client));
      yield* client.query("ROLLBACK");
      const display = {
        host: settings.host,
        port: settings.port,
        database: settings.database,
        role: settings.role
      };
      return { display, value };
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(new SourceTimeout({}))
    })
  );
  const inspect = Effect.fn("Postgres.inspect")(function* (credentials: Redacted.Redacted<string>) {
    const result = yield* run(credentials, discover);
    return { display: result.display, snapshot: result.value };
  });
  const test = Effect.fn("Postgres.test")(function* (credentials: Redacted.Redacted<string>) {
    return (yield* run(credentials, Effect.void)).display;
  });
  return Source.of({ inspect, test });
});
export const layer = Layer.effect(Source, make).pipe(Layer.provide(nativeNetwork));
