import {
  type ConnectionDeclaration,
  type ConnectionDetail,
  type Integration,
  PostHogSnapshot,
  ShopifySnapshot
} from "@patchy/api";
import { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Companies from "@patchy/companies/Companies";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as CredentialKeys from "./CredentialKeys.js";
import * as PostgresSource from "./postgres/Source.js";
import * as PostHogSource from "./posthog/Source.js";
import * as ShopifySource from "./shopify/Source.js";

export const Description = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.makeFilter((value) => !/[\r\n]/.test(value))
);
const fields = {
  id: Schema.String,
  companyId: Schema.String,
  handle: Companies.Handle,
  description: Description,
  mode: Schema.Literal("company"),
  status: Schema.Literals(["connected", "disconnected"]),
  credentialRevision: Schema.Int,
  metadataRevision: Schema.Int,
  lastTestedAt: Schema.NullOr(Schema.String),
  lastDiscoveredAt: Schema.NullOr(Schema.String),
  createdBy: Schema.String
};
export const PostgresConnection = Schema.Struct({
  ...fields,
  integration: Schema.Literal("postgres"),
  display: PostgresSource.Display
});
export const PostHogConnection = Schema.Struct({
  ...fields,
  integration: Schema.Literal("posthog"),
  display: PostHogSource.Display
});
export const ShopifyConnection = Schema.Struct({
  ...fields,
  integration: Schema.Literal("shopify"),
  display: ShopifySource.Display
});
/** A company connection; its integration decides what its display says. */
export const Connection = Schema.Union([PostgresConnection, PostHogConnection, ShopifyConnection]);
export type Connection = typeof Connection.Type;
/** Where a connection reads, in its integration's terms; credentials of one target share it. */
export type Target = {
  readonly [C in Connection as C["integration"]]: Pick<C, "integration" | "display">;
}[Integration];

/** A stored snapshot, decoded by the integration its own row names. */
export const Metadata = Schema.Union([
  Schema.Struct({ integration: Schema.Literal("postgres"), snapshot: Snapshot }),
  Schema.Struct({ integration: Schema.Literal("posthog"), snapshot: PostHogSnapshot }),
  Schema.Struct({ integration: Schema.Literal("shopify"), snapshot: ShopifySnapshot })
]);
export type Metadata = typeof Metadata.Type;

export class ConnectionNotFound extends Schema.TaggedError<ConnectionNotFound>()(
  "ConnectionNotFound",
  {
    companyId: Schema.String,
    lookup: Schema.Union([
      Schema.Struct({ id: Schema.String, revision: Schema.optionalKey(Schema.Int) }),
      // The integration as asked for, which may be one Patchy doesn't ship.
      Schema.Struct({ integration: Schema.String, handle: Schema.String })
    ])
  }
) {
  readonly code = "connection_not_found";
  readonly status = 404;
  override get message() {
    return "This connection could not be found.";
  }
}
export class ConnectionNotConnected extends Schema.TaggedError<ConnectionNotConnected>()(
  "ConnectionNotConnected",
  {}
) {
  readonly code = "connection_not_connected";
  readonly status = 409;
  override get message() {
    return "This connection is not connected. Ask a company administrator to reconnect it.";
  }
}
export class StaleGenerated extends Schema.TaggedError<StaleGenerated>()("StaleGenerated", {}) {
  readonly code = "stale_generated";
  readonly status = 409;
  override get message() {
    return "the warehouse schema changed; run `patchy refresh`";
  }
}
export class ConnectionChanged extends Schema.TaggedError<ConnectionChanged>()(
  "ConnectionChanged",
  {}
) {
  readonly code = "connection_changed";
  readonly status = 409;
  override get message() {
    return "This connection changed while the operation was running. Reload the page and try again.";
  }
}
export class ConnectionHandleTaken extends Schema.TaggedError<ConnectionHandleTaken>()(
  "ConnectionHandleTaken",
  {}
) {
  readonly code = "connection_handle_taken";
  readonly status = 409;
  override get message() {
    return "This company already has a connection with that name.";
  }
}
export class InvalidConnectionHandle extends Schema.TaggedError<InvalidConnectionHandle>()(
  "InvalidConnectionHandle",
  {}
) {
  readonly code = "invalid_connection_handle";
  readonly status = 400;
  override get message() {
    return "Use 3–32 lowercase letters, digits or hyphens for the handle, starting and ending with a letter or digit.";
  }
}
export class InvalidConnectionDescription extends Schema.TaggedError<InvalidConnectionDescription>()(
  "InvalidConnectionDescription",
  {}
) {
  readonly code = "invalid_connection_description";
  readonly status = 400;
  override get message() {
    return "Use a one-line description of at most 500 characters.";
  }
}
export class ConnectionRetargetRequired extends Schema.TaggedError<ConnectionRetargetRequired>()(
  "ConnectionRetargetRequired",
  {}
) {
  readonly code = "connection_retarget_required";
  readonly status = 409;
  override get message() {
    return "These credentials name a different database. Point the connection elsewhere to discover its schema before switching.";
  }
}
export class ConnectionInUse extends Schema.TaggedError<ConnectionInUse>()("ConnectionInUse", {}) {
  readonly code = "connection_in_use";
  readonly status = 409;
  override get message() {
    return "A stored patch version declares this connection. Disconnect it instead of deleting it.";
  }
}
export class ConnectionMutationUnavailable extends Schema.TaggedError<ConnectionMutationUnavailable>()(
  "ConnectionMutationUnavailable",
  {}
) {
  readonly code = "connection_mutation_unavailable";
  readonly status = 503;
  override get message() {
    return "Connection administration is unavailable in the local development runtime. Use the company's connections page.";
  }
}
export class ConnectionStorageFailed extends Schema.TaggedError<ConnectionStorageFailed>()(
  "ConnectionStorageFailed",
  {
    operation: Schema.Literals([
      "list",
      "get",
      "usage",
      "versions",
      "detail",
      "snapshot",
      "connect",
      "test",
      "rotate",
      "refresh",
      "retarget",
      "disconnect",
      "reconnect",
      "describe",
      "delete",
      "resolve",
      "poolCredentials"
    ]),
    cause: Schema.Redacted(Schema.Defect())
  }
) {
  readonly code = "connection_storage_failed";
  readonly status = 503;
  override get message() {
    return "The connection could not be read or saved. Please try again.";
  }
}

export type ResolveError = ConnectionNotConnected | StaleGenerated | ConnectionStorageFailed;
export type ConnectionError =
  | ResolveError
  | ConnectionNotFound
  | ConnectionChanged
  | ConnectionHandleTaken
  | InvalidConnectionHandle
  | InvalidConnectionDescription
  | ConnectionRetargetRequired
  | ConnectionInUse
  | ConnectionMutationUnavailable
  | CredentialKeys.CredentialError
  | PostgresSource.SourceError
  | PostHogSource.SourceError
  | ShopifySource.SourceError;

/** Who declares a connection, by the rule that decides whether it may be deleted. */
export interface Usage {
  /** Live patches whose current version declares it, by name. */
  readonly usedBy: ReadonlyArray<string>;
  /** Declaring versions of live patches that are not their current version. */
  readonly olderVersions: number;
  /** Retired, deleted (not yet reclaimed) and disabled patches with a declaring version. */
  readonly retired: number;
  readonly deleted: number;
  readonly disabled: number;
  /** Some stored version of a company patch declares it, so it cannot be deleted. */
  readonly declared: boolean;
}
export const unused: Usage = {
  usedBy: [],
  olderVersions: 0,
  retired: 0,
  deleted: 0,
  disabled: 0,
  declared: false
};

export interface Identity {
  readonly companyId: string;
  readonly userId: string;
  readonly id: string;
}
export interface ConnectInput {
  readonly integration: Integration;
  readonly companyId: string;
  readonly userId: string;
  readonly handle: string;
  readonly description: string;
  readonly credentials: Redacted.Redacted<string>;
}
export interface CredentialsInput extends Identity {
  readonly credentials: Redacted.Redacted<string>;
}

/** Callers authorize company membership and admin actions before entering this service. */
export class ConnectionStore extends Context.Service<
  ConnectionStore,
  {
    readonly list: (companyId: string) => Effect.Effect<ReadonlyArray<Connection>, ConnectionError>;
    readonly get: (companyId: string, id: string) => Effect.Effect<Connection, ConnectionError>;
    /** Each declared connection's usage by id; a connection with no entry is `unused`. */
    readonly usage: (
      companyId: string
    ) => Effect.Effect<ReadonlyMap<string, Usage>, ConnectionError>;
    /** The patch and number of stored versions, so recent calls name where they came from. */
    readonly versions: (
      companyId: string,
      ids: ReadonlyArray<string>
    ) => Effect.Effect<
      ReadonlyMap<string, { readonly patch: string; readonly number: number }>,
      ConnectionError
    >;
    /** A handle names a connection only within its integration. */
    readonly detail: (
      companyId: string,
      integration: Integration,
      handle: string
    ) => Effect.Effect<ConnectionDetail, ConnectionNotFound | ConnectionStorageFailed>;
    /** A stored snapshot, by the integration its own row names, even after its connection is gone. */
    readonly snapshot: (
      companyId: string,
      id: string,
      revision: number
    ) => Effect.Effect<Metadata, ConnectionError>;
    /**
     * `report` runs with the commit, after discovery: a disconnect during COMMIT
     * still reports, and a refusal or rollback never does.
     */
    readonly connect: (
      input: ConnectInput,
      report?: (connection: Connection) => Effect.Effect<void>
    ) => Effect.Effect<Connection, ConnectionError>;
    readonly test: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly rotate: (input: CredentialsInput) => Effect.Effect<Connection, ConnectionError>;
    readonly retarget: (input: CredentialsInput) => Effect.Effect<Connection, ConnectionError>;
    readonly refresh: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly disconnect: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly reconnect: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly describe: (
      input: Identity & { readonly description: string }
    ) => Effect.Effect<Connection, ConnectionError>;
    /** Returns the connection as it was before deletion; `report` runs as `connect`'s does. */
    readonly delete: (
      input: Identity,
      report?: (connection: Connection) => Effect.Effect<void>
    ) => Effect.Effect<Connection, ConnectionError>;
    /** Hold the connection lock until the declaring version commits in the caller's platform transaction. */
    readonly resolve: (
      companyId: string,
      declaration: ConnectionDeclaration
    ) => Effect.Effect<ConnectionDeclaration, ResolveError>;
    /** Live identity and credential revision, never the published metadata stamp. Decrypt only to create a pool. */
    readonly poolCredentials: (
      companyId: string,
      declaration: ConnectionDeclaration,
      credentialRevision: number
    ) => Effect.Effect<Redacted.Redacted<string>, ConnectionError>;
  }
>()("@patchy/integrations/ConnectionStore") {}
