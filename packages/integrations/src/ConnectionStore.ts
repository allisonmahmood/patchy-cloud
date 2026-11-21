import type * as PatchVisibility from "./PatchVisibility.js";
import {
  AttioSnapshot,
  type ConnectionDeclaration,
  type ConnectionDetail,
  GithubSnapshot,
  ImapSnapshot,
  type Integration,
  ModelRoleKind,
  ModelsSnapshot,
  PidgeonSnapshot,
  PostHogSnapshot
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
import type * as PidgeonKeys from "./pidgeon/Keys.js";
import type * as PidgeonLedger from "./pidgeon/Ledger.js";
import * as PidgeonSource from "./pidgeon/Source.js";
import * as AttioSource from "./attio/Source.js";
import * as ImapSource from "./imap/Source.js";
import type * as GithubAccess from "./github/Access.js";
import * as GithubConnection from "./github/Connection.js";
import type * as GithubSource from "./github/Source.js";
import * as Models from "./models/Models.js";

export const Description = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.makeFilter((value) => !/[\r\n]/.test(value))
);
/** Who may build patches with a connection: everyone in the company, or the people on its teams. */
export const Audience = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("company") }),
  Schema.Struct({
    kind: Schema.Literal("teams"),
    teamIds: Schema.Array(Schema.String).check(Schema.isMinLength(1))
  })
]);
export type Audience = typeof Audience.Type;

const fields = {
  id: Schema.String,
  companyId: Schema.String,
  handle: Companies.Handle,
  description: Description,
  mode: Schema.Literal("company"),
  status: Schema.Literals(["connected", "disconnected"]),
  /** Patches that declare it turn their guests away while it's set; an admin's choice. */
  blockGuests: Schema.Boolean,
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
export const PidgeonConnection = Schema.Struct({
  ...fields,
  integration: Schema.Literal("pidgeon"),
  display: PidgeonSource.Display
});
export const AttioConnection = Schema.Struct({
  ...fields,
  integration: Schema.Literal("attio"),
  display: AttioSource.Display
});
export const ImapConnection = Schema.Struct({
  ...fields,
  integration: Schema.Literal("imap"),
  display: ImapSource.Display
});
export const GithubConnectionRow = Schema.Struct({
  ...fields,
  integration: Schema.Literal("github"),
  display: GithubConnection.Display,
  /**
   * When a mint last found the App suspended on the connection's account, from its installation's
   * row, which every connection on it shares; null once a mint or check works again.
   */
  suspendedAt: Schema.NullOr(Schema.String)
});
const Status = Schema.Literals(["connected", "disconnected"]);
/**
 * A model role: its fixed kind, and the provider and model an admin mapped it to, which change.
 * It holds no credential of its own; its provider does.
 */
export const ModelsConnection = Schema.Struct({
  ...fields,
  integration: Schema.Literal("models"),
  display: Schema.Struct({}),
  role: Schema.Struct({
    kind: ModelRoleKind,
    model: Schema.String,
    providerId: Schema.String,
    /** Its provider as this release reads it; null when this release doesn't know its integration. */
    provider: Schema.NullOr(
      Schema.Struct({ integration: Models.Provider, handle: Companies.Handle, status: Status })
    )
  })
});
export type ModelsConnection = typeof ModelsConnection.Type;
/** A company connection; its integration decides what its display says. */
export const Connection = Schema.Union([
  PostgresConnection,
  PostHogConnection,
  PidgeonConnection,
  AttioConnection,
  ImapConnection,
  GithubConnectionRow,
  ModelsConnection
]);
export type Connection = typeof Connection.Type;
/**
 * Whether patches that declare it can reach it now: connected and, for a role, mapped to a
 * provider that is connected and of an integration this release knows. A paused provider stops
 * every role on it this way: discovery and a role's detail read it as paused, while the role's own
 * status stays the admin's.
 */
export const serving = (connection: Connection) =>
  connection.status === "connected" &&
  (connection.integration !== "models" || connection.role.provider?.status === "connected");

/**
 * A model provider: the company's key for one provider, a connection of that provider's own
 * integration. Never a `Connection`: no builder lists, declares or reads one, and only an admin's
 * Models changes reach it. The first of each integration is `main`.
 */
export const ModelProvider = Schema.Struct({
  id: Schema.String,
  companyId: Schema.String,
  integration: Models.Provider,
  handle: Companies.Handle,
  status: Status,
  credentialRevision: Schema.Int,
  createdBy: Schema.String
});
export type ModelProvider = typeof ModelProvider.Type;
/** Where a connection reads, in its integration's terms; credentials of one target share it. */
export type Target = {
  readonly [C in Connection as C["integration"]]: Pick<C, "integration" | "display">;
}[Integration];

/** A stored snapshot, decoded by the integration its own row names. */
export const Metadata = Schema.Union([
  Schema.Struct({ integration: Schema.Literal("postgres"), snapshot: Snapshot }),
  Schema.Struct({ integration: Schema.Literal("posthog"), snapshot: PostHogSnapshot }),
  Schema.Struct({ integration: Schema.Literal("pidgeon"), snapshot: PidgeonSnapshot }),
  Schema.Struct({ integration: Schema.Literal("attio"), snapshot: AttioSnapshot }),
  Schema.Struct({ integration: Schema.Literal("imap"), snapshot: ImapSnapshot }),
  Schema.Struct({ integration: Schema.Literal("github"), snapshot: GithubSnapshot }),
  Schema.Struct({ integration: Schema.Literal("models"), snapshot: ModelsSnapshot })
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
    return "This connection is paused. Ask a company administrator to resume it.";
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
/** A Pidgeon connection is one inbox: another inbox is another connection. */
export class ConnectionRetargetUnavailable extends Schema.TaggedError<ConnectionRetargetUnavailable>()(
  "ConnectionRetargetUnavailable",
  {}
) {
  readonly code = "connection_retarget_unavailable";
  readonly status = 409;
  override get message() {
    return "A Pidgeon connection is one inbox and can't move to another. Connect the other inbox as a new connection.";
  }
}
/** A connect by this name is still running in this process; a second submit doesn't start another. */
export class ConnectInProgress extends Schema.TaggedError<ConnectInProgress>()(
  "ConnectInProgress",
  {
    name: Schema.String,
    startedAt: Schema.String
  }
) {
  readonly code = "connect_in_progress";
  readonly status = 409;
  override get message() {
    return `${this.name} is already connecting: another connect with this name started at ${this.startedAt.slice(11, 16)} UTC and is still running. Wait for it, at most a minute, then look for it in Integrations.`;
  }
}
export class ConnectionInUse extends Schema.TaggedError<ConnectionInUse>()("ConnectionInUse", {}) {
  readonly code = "connection_in_use";
  readonly status = 409;
  override get message() {
    return "A stored patch version declares this connection, so it can't be disconnected. Pause it instead.";
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
/** A form that names no audience or no team, or a team that isn't the company's. */
export class InvalidConnectionAudience extends Schema.TaggedError<InvalidConnectionAudience>()(
  "InvalidConnectionAudience",
  { cause: Schema.optional(Schema.Defect()) }
) {
  readonly code = "invalid_connection_audience";
  readonly status = 422;
  override get message() {
    return "Select Company or one or more existing company teams.";
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
      "blockGuests",
      "blockingGuests",
      "audience",
      "delete",
      "resolve",
      "poolCredentials",
      "drafts",
      "sends",
      "pauseLogin",
      "providers",
      "models"
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

/** A publish whose owner can't build with a connection it declares. */
export class ConnectionAccessDenied extends Schema.TaggedError<ConnectionAccessDenied>()(
  "ConnectionAccessDenied",
  {}
) {
  readonly code = "connection_access_denied";
  readonly status = 403;
  override get message() {
    return "The patch owner cannot build with a declared connection. Restore their connection team access or reassign the patch.";
  }
}
/** The actor stopped being an active admin before the change committed. */
export class ConnectionAdministrationDenied extends Schema.TaggedError<ConnectionAdministrationDenied>()(
  "ConnectionAdministrationDenied",
  { cause: Schema.Defect() }
) {
  readonly code = "access_denied";
  readonly status = 403;
  override get message() {
    return "Only an admin can change connection audiences.";
  }
}
/**
 * The audience an admin chose stops live patches' owners building with the connection, by name;
 * saving again with acknowledgement goes ahead.
 */
export class ConnectionCutsOff extends Schema.TaggedError<ConnectionCutsOff>()(
  "ConnectionCutsOff",
  { patches: Schema.Array(Schema.String) }
) {
  readonly code = "connection_cuts_off";
  readonly status = 409;
  override get message() {
    return `This stops ${this.patches.join(", ")} from using the connection. Nothing was changed.`;
  }
}
/** The host's Models switch is off, or its release has no Models: no provider or role is made. */
export class ModelsUnavailable extends Schema.TaggedError<ModelsUnavailable>()(
  "ModelsUnavailable",
  {}
) {
  readonly code = "models_unavailable";
  readonly status = 404;
  override get message() {
    return "Models isn't available on this server.";
  }
}
/** A provider roles still point at, named by their handles. */
export class ProviderInUse extends Schema.TaggedError<ProviderInUse>()("ProviderInUse", {
  roles: Schema.Array(Schema.String)
}) {
  readonly code = "provider_in_use";
  readonly status = 409;
  override get message() {
    return `${this.roles.map((role) => `models/${role}`).join(", ")} use this provider, so it can't be deleted. Map them to another provider or delete them first, or pause it instead.`;
  }
}
export class InvalidModelId extends Schema.TaggedError<InvalidModelId>()("InvalidModelId", {}) {
  readonly code = "invalid_model_id";
  readonly status = 400;
  override get message() {
    return "Use the model's id as its provider names it, with no spaces and at most 200 characters.";
  }
}
export type ResolveError =
  ConnectionAccessDenied | ConnectionNotConnected | StaleGenerated | ConnectionStorageFailed;
export type ConnectionError =
  | ConnectionAdministrationDenied
  | InvalidConnectionAudience
  | ResolveError
  | ConnectionNotFound
  | ConnectionChanged
  | ConnectionHandleTaken
  | InvalidConnectionHandle
  | InvalidConnectionDescription
  | ConnectionRetargetRequired
  | ConnectionRetargetUnavailable
  | ConnectionInUse
  | ConnectInProgress
  | ConnectionMutationUnavailable
  | ModelsUnavailable
  | ProviderInUse
  | InvalidModelId
  | CredentialKeys.CredentialError
  | PostgresSource.SourceError
  | PostHogSource.SourceError
  | PidgeonSource.CallError
  | PidgeonKeys.KeysError
  | AttioSource.InspectError
  | AttioSource.OtherWorkspace
  | ImapSource.InspectError
  | ImapSource.ConnectionPaused
  | GithubConnection.ConnectError
  | GithubAccess.CheckError
  | GithubSource.UserError
  | GithubSource.SignInFailed;

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
  /**
   * The other patches with a declaring version, by name: retired, deleted or disabled ones, and
   * live ones whose served version no longer declares it. With `usedBy`, every patch that keeps
   * it from being deleted.
   */
  readonly declaredBy: ReadonlyArray<string>;
  /** Some stored version of a company patch declares it, so it cannot be deleted. */
  readonly declared: boolean;
}
export const unused: Usage = {
  usedBy: [],
  olderVersions: 0,
  retired: 0,
  deleted: 0,
  disabled: 0,
  declaredBy: [],
  declared: false
};

export interface Identity {
  readonly companyId: string;
  readonly userId: string;
  readonly id: string;
}
export interface ConnectInput {
  /** A role is made by `createRole`, mapped to a provider, never connected on its own. */
  readonly integration: Exclude<Integration, "models">;
  readonly companyId: string;
  readonly userId: string;
  readonly handle: string;
  readonly description: string;
  readonly credentials: Redacted.Redacted<string>;
}
export interface CredentialsInput extends Identity {
  readonly credentials: Redacted.Redacted<string>;
}
/** A deleted connection, as it was before it went. */
export interface Deleted {
  readonly connection: Connection;
}

/** A provider an admin connects; the first of its integration is `main` unless named. */
export interface ProviderInput {
  readonly companyId: string;
  readonly userId: string;
  readonly provider: Models.Provider;
  readonly handle?: string;
  readonly credentials: Redacted.Redacted<string>;
}
/** A role an admin makes from its provider: its handle and kind never change. */
export interface RoleInput {
  readonly companyId: string;
  readonly userId: string;
  readonly handle: string;
  readonly kind: ModelRoleKind;
  readonly description: string;
  readonly providerId: string;
  readonly model: string;
}
/** One change to a provider or a role. */
export type ModelsChange =
  /** Either; pausing a provider stops every role on it, and resuming starts them again. */
  | { readonly kind: "pause" | "resume" | "delete" }
  /** A provider's new key; a paused provider stays paused. */
  | { readonly kind: "replaceKey"; readonly credentials: Redacted.Redacted<string> }
  /** A role's provider and model; patches that declare it follow from their next call. */
  | { readonly kind: "remap"; readonly providerId: string; readonly model: string };
/** A provider's or role's change, as its commit reports it. */
export interface ModelsChanged {
  readonly id: string;
  readonly integration: Models.Provider | "models";
  readonly change:
    "connected" | "created" | "paused" | "resumed" | "deleted" | "key_replaced" | "remapped";
  /**
   * The live patches whose next call the change reaches, by name. A pause or resume names those
   * whose role it makes unavailable or available again: a provider's, those of its roles that
   * aren't paused themselves; a role's, its own while its provider is connected. A remap names
   * the role's, a new key those of every role on the provider, and a change to the state it
   * already has, none.
   */
  readonly affected: ReadonlyArray<string>;
}
/** Runs with a Models change's commit; a refusal, a no-op or a rollback never runs it. */
export type ModelsReport = (changed: ModelsChanged) => Effect.Effect<void>;

/**
 * Callers authorize company membership and admin actions before entering this service. Its
 * connection reads and changes reach only the public integrations it knows, never a provider. A
 * role, while Models is on, is read, described, given an audience and blocked to guests as any
 * connection is; it is made, remapped, paused, resumed and deleted only by the Models methods.
 */
export class ConnectionStore extends Context.Service<
  ConnectionStore,
  {
    /** The public integrations it reads: its release's, without Models while the switch is off. */
    readonly integrations: ReadonlyArray<Integration>;
    readonly audience: (companyId: string, id: string) => Effect.Effect<Audience, ConnectionError>;
    /**
     * An admin's change; the actor is rechecked as an active admin under the company lock. Under
     * that lock it refuses, unless `acknowledged`, when it stops live patches whose owners can
     * build with the connection now, so a publish landing before it can't slip past the warning.
     */
    readonly setAudience: (
      input: Identity & { readonly audience: Audience; readonly acknowledged?: boolean }
    ) => Effect.Effect<void, ConnectionError | ConnectionCutsOff>;
    /**
     * Whether this person may build with the connection: its audience admits them by their
     * recorded teams, whether or not they are active.
     */
    readonly canUse: (
      companyId: string,
      id: string,
      userId: string
    ) => Effect.Effect<boolean, ConnectionNotFound | ConnectionStorageFailed>;
    /**
     * Whether the patch's current owner may build with the connection, as every call through it
     * checks; never the handler's caller, who only needs to open the patch.
     */
    readonly ownerCanUse: (
      companyId: string,
      patchId: string,
      id: string
    ) => Effect.Effect<boolean, ConnectionNotFound | ConnectionStorageFailed>;
    readonly list: (
      companyId: string,
      userId?: string
    ) => Effect.Effect<ReadonlyArray<Connection>, ConnectionError>;
    readonly get: (companyId: string, id: string) => Effect.Effect<Connection, ConnectionError>;
    /** Each declared connection's usage by id; a connection with no entry is `unused`. */
    readonly usage: (
      companyId: string,
      userId?: string
    ) => Effect.Effect<
      ReadonlyMap<string, Usage>,
      ConnectionError,
      PatchVisibility.PatchVisibility
    >;
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
      handle: string,
      userId?: string
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
    /**
     * New credentials for the same target. A Pidgeon connection takes a new key for the same inbox
     * (Replace key), or no key and the access patches have now (Change access).
     */
    readonly rotate: (input: CredentialsInput) => Effect.Effect<Connection, ConnectionError>;
    readonly retarget: (input: CredentialsInput) => Effect.Effect<Connection, ConnectionError>;
    readonly refresh: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly disconnect: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly reconnect: (input: Identity) => Effect.Effect<Connection, ConnectionError>;
    readonly describe: (
      input: Identity & { readonly description: string }
    ) => Effect.Effect<Connection, ConnectionError>;
    /** Blocks guests from the connection, or allows them again; it applies to their next call. */
    readonly blockGuests: (
      input: Identity & { readonly block: boolean }
    ) => Effect.Effect<Connection, ConnectionError>;
    /**
     * Which of these connections block guests, in one read however many there are: what decides
     * whether a patch's guests can open it. Ids name connections across companies.
     */
    readonly blockingGuests: (
      ids: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlySet<string>, ConnectionStorageFailed>;
    /**
     * Returns the connection as it was before deletion; `report` runs as `connect`'s does. A
     * Pidgeon connection's key isn't revoked: Patchy can't, so its page tells the admin to.
     */
    readonly delete: (
      input: Identity,
      report?: (connection: Connection) => Effect.Effect<void>
    ) => Effect.Effect<Deleted, ConnectionError>;
    /** Hold the connection lock until the declaring version commits in the caller's platform transaction. */
    readonly resolve: (
      companyId: string,
      declaration: ConnectionDeclaration
    ) => Effect.Effect<ConnectionDeclaration, ResolveError>;
    /**
     * Live identity and credential revision, never the published metadata stamp. Decrypt only to
     * create a pool. A paused IMAP connection refuses `auth_failed`, so nothing logs in with it.
     */
    readonly poolCredentials: (
      companyId: string,
      declaration: ConnectionDeclaration,
      credentialRevision: number
    ) => Effect.Effect<Redacted.Redacted<string>, ConnectionError>;
    /**
     * Claims a Pidgeon email's row by its draft key before a worker talks to Pidgeon, charging a
     * new email to the connection's budget for `day` in the same transaction, so the count holds
     * across processes and restarts (`pidgeon/Ledger.ts`).
     */
    readonly claimDraft: (
      input: PidgeonLedger.ClaimInput
    ) => Effect.Effect<
      PidgeonLedger.Claim,
      ConnectionStorageFailed | ConnectionMutationUnavailable
    >;
    /** One change by the claim's holder, while it still holds it: whether it did. */
    readonly recordDraft: (
      change: PidgeonLedger.Change
    ) => Effect.Effect<boolean, ConnectionStorageFailed | ConnectionMutationUnavailable>;
    /** Ends a claim its holder still has. */
    readonly releaseDraft: (
      key: PidgeonLedger.Key & { readonly owner: string }
    ) => Effect.Effect<void, ConnectionStorageFailed | ConnectionMutationUnavailable>;
    /** A draft key's row as it stands, for a worker whose change's answer was lost. */
    readonly readDraft: (
      key: PidgeonLedger.Key
    ) => Effect.Effect<
      PidgeonLedger.Row | undefined,
      ConnectionStorageFailed | ConnectionMutationUnavailable
    >;
    /**
     * How many of a Pidgeon connection's emails may still leave without Patchy: a send issued and
     * not known sent, or one held for a member to approve.
     */
    readonly unsettledSends: (
      companyId: string,
      id: string
    ) => Effect.Effect<number, ConnectionStorageFailed>;
    /** How many sends and replies a Pidgeon connection has counted on `day` (UTC). */
    readonly sends: (
      companyId: string,
      id: string,
      day: string
    ) => Effect.Effect<number, ConnectionStorageFailed>;
    /**
     * Pauses an IMAP connection whose mail server refused its login during a patch's call, so no
     * host process logs in again until an admin's Test or Replace password succeeds. The caller
     * passes what it read before logging in: the credential revision and the connection's
     * `display.logins`. Records nothing once other credentials were saved, once a login with
     * these ones worked and was saved since, or when it's already paused.
     */
    readonly pauseLogin: (input: {
      readonly companyId: string;
      readonly id: string;
      readonly credentialRevision: number;
      readonly logins: number;
      readonly reply: ImapSource.Paused["reply"];
    }) => Effect.Effect<void, ConnectionStorageFailed>;

    // Models. Each refuses `ModelsUnavailable` while the switch is off, and a provider of an
    // integration this release doesn't know is not found, so no role is made or remapped to one.

    /** The company's providers, by integration and handle. */
    readonly providers: (
      companyId: string
    ) => Effect.Effect<ReadonlyArray<ModelProvider>, ConnectionError>;
    /** Keeps a provider's key, sealed as every connection's credentials are. Nothing is called. */
    readonly connectProvider: (
      input: ProviderInput,
      report?: ModelsReport
    ) => Effect.Effect<ModelProvider, ConnectionError>;
    /** A role on one of the company's providers, connected, for the company's builders. */
    readonly createRole: (
      input: RoleInput,
      report?: ModelsReport
    ) => Effect.Effect<ModelsConnection, ConnectionError>;
    /**
     * Changes a provider or a role under its lock and answers what it reaches. Deleting a provider
     * is refused while a role points at it, and a role while a stored version declares it, as for
     * every connection, so pausing is the way to stop one. A change to the state it already has
     * changes nothing and reports nothing.
     */
    readonly changeModels: (
      input: Identity & { readonly change: ModelsChange },
      report?: ModelsReport
    ) => Effect.Effect<ModelsChanged, ConnectionError>;
  }
>()("@patchy/integrations/ConnectionStore") {}
