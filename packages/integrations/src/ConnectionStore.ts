import { PostgresDeclaration } from "@patchy/api";
import * as Companies from "@patchy/companies/Companies";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as CredentialKeys from "./CredentialKeys.js";
import type { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Source from "./postgres/Source.js";

export const Description = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.makeFilter((value) => !/[\r\n]/.test(value))
);
export class Connection extends Schema.Class<Connection>("Connection")({
  id: Schema.String,
  companyId: Schema.String,
  integration: Schema.Literal("postgres"),
  handle: Companies.Handle,
  description: Description,
  mode: Schema.Literal("company"),
  status: Schema.Literals(["connected", "disconnected"]),
  display: Source.Display,
  credentialRevision: Schema.Int,
  metadataRevision: Schema.Int,
  lastTestedAt: Schema.NullOr(Schema.String),
  lastDiscoveredAt: Schema.NullOr(Schema.String),
  createdBy: Schema.String
}) {}

export class ConnectionNotFound extends Schema.TaggedError<ConnectionNotFound>()(
  "ConnectionNotFound",
  { companyId: Schema.String, id: Schema.String, revision: Schema.optionalKey(Schema.Int) }
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
    return "This company already has a connection with that handle.";
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
    return "These credentials name a different database. Use Retarget to discover its schema before switching.";
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
  | Source.SourceError;

export interface Identity {
  readonly companyId: string;
  readonly userId: string;
  readonly id: string;
}
export interface ConnectInput {
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
    readonly snapshot: (
      companyId: string,
      id: string,
      revision: number
    ) => Effect.Effect<typeof Snapshot.Type, ConnectionError>;
    readonly connect: (input: ConnectInput) => Effect.Effect<Connection, ConnectionError>;
    readonly test: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly rotate: (input: CredentialsInput) => Effect.Effect<Connection, ConnectionError>;
    readonly retarget: (input: CredentialsInput) => Effect.Effect<Connection, ConnectionError>;
    readonly refresh: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly disconnect: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly reconnect: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly describe: (
      input: Identity & { readonly description: string }
    ) => Effect.Effect<Connection, ConnectionError>;
    readonly delete: (input: Identity) => Effect.Effect<void, ConnectionError>;
    /** Hold the connection lock until the declaring version commits in the caller's platform transaction. */
    readonly resolve: (
      companyId: string,
      declaration: typeof PostgresDeclaration.Type
    ) => Effect.Effect<typeof PostgresDeclaration.Type, ResolveError>;
    /** Live identity and credential revision, never the published metadata stamp. Decrypt only to create a pool. */
    readonly poolCredentials: (
      companyId: string,
      declaration: typeof PostgresDeclaration.Type,
      credentialRevision: number
    ) => Effect.Effect<Redacted.Redacted<string>, ConnectionError>;
  }
>()("@patchy/integrations/ConnectionStore") {}
