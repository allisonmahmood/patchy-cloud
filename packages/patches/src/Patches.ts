/**
 * Patches and their versions: every row the capability keeps, read and
 * written here and nowhere else. Rows are decoded through `SqlSchema` in this
 * module only, so a client type change lands in one place.
 *
 * Lifecycle changes and the deletion window use the Effect clock. Retired and
 * deleted rows retain their versions and company inventory until reclamation.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  DescriptionText,
  Manifest,
  PatchInventory,
  PatchName,
  PatchState as PatchStateSchema,
  PatchSourceState,
  PublishCreated,
  PublishUpdated,
  SharingScope,
  type SharedTableDeclaration,
  TableDefinition,
  sharedTableId
} from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { Tables } from "@patchy/primitives";
import { ConnectionStore } from "@patchy/integrations";

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Manifest));
const encodePublishCreated = Schema.encodeSync(Schema.fromJsonString(PublishCreated));
const encodePublishUpdated = Schema.encodeSync(Schema.fromJsonString(PublishUpdated));
const decodeDescription = Schema.decodeUnknownEffect(DescriptionText);
const decodeResponseBodies = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ responseBody: Schema.String }))
);

/** Deleted patches can be restored strictly before this window closes. */
export const RECOVERY_WINDOW = Duration.days(30);

/** Allows the bounded put and 60-second record transaction to finish before reclamation. */
export const PENDING_OBJECT_LEASE = Duration.minutes(5);

/** The first publish starts a patch's version sequence. */
const FIRST_VERSION_NUMBER = 1;

const isName = Schema.is(PatchName);

/** A title or extension-free filename, normalized and bounded for this collision ordinal. */
export const deriveName = (source: string, ordinal = 1): string => {
  const normalized = source
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = ordinal === 1 ? "" : `-${ordinal}`;
  const base = (normalized.length < 3 ? "patch" : normalized)
    .slice(0, 32 - suffix.length)
    .replace(/-+$/, "");
  const candidate = `${base}${suffix}`;
  return isName(candidate) ? candidate : `patch${suffix}`;
};

/** An absolute address is independent of the patch's current sharing scope. */
export const address = (publicBaseUrl: string, companyHandle: string, name: string) =>
  `${publicBaseUrl.replace(/\/+$/, "")}/${companyHandle}/${name}`;

/** Unknown, disabled or outside the actor's company. */
export class PatchUnavailable extends Schema.TaggedError<PatchUnavailable>()("PatchUnavailable", {
  patchId: Schema.String
}) {
  override get message() {
    return "Patch not found.";
  }
}

/** A create landed on an id that already exists. */
export class PatchConflict extends Schema.TaggedError<PatchConflict>()("PatchConflict", {
  patchId: Schema.String
}) {
  override get message() {
    return "Patch already exists.";
  }
}

export class NameTaken extends Schema.TaggedError<NameTaken>()("NameTaken", {
  name: PatchName
}) {
  override get message() {
    return `Patch name "${this.name}" is already taken.`;
  }
}

export type PatchState = typeof PatchStateSchema.Type;
export interface Actor {
  readonly userId: string;
  readonly admin: boolean;
}
const Owner = Schema.Struct({ id: Schema.String, name: Schema.String });
const Dependant = Schema.Struct({ patchId: Schema.String, name: Schema.String, owner: Owner });
const OffSource = Schema.Struct({
  patchId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  table: Schema.String,
  state: PatchSourceState
});

export class NotOwner extends Schema.TaggedError<NotOwner>()("NotOwner", {
  owner: Owner
}) {
  override get message() {
    return `This patch belongs to ${this.owner.name}. Ask them, or an admin, to reassign it.`;
  }
}
export class WrongState extends Schema.TaggedError<WrongState>()("WrongState", {
  state: PatchStateSchema
}) {
  override get message() {
    return `This patch is ${this.state}; this action is not available in that state.`;
  }
}
export class StaleAction extends Schema.TaggedError<StaleAction>()("StaleAction", {
  patchId: Schema.String
}) {
  override get message() {
    return "This patch changed while you had this page open. Nothing was done.";
  }
}
export class PatchRetired extends Schema.TaggedError<PatchRetired>()("PatchRetired", {}) {
  override get message() {
    return "This patch is retired. Restore it through the lifecycle API or ask an admin.";
  }
}
export class PatchDeleted extends Schema.TaggedError<PatchDeleted>()("PatchDeleted", {
  purgeAt: Schema.String
}) {
  override get message() {
    return `This patch is deleted and will be gone for good at ${this.purgeAt}. Restore it through the lifecycle API before then or ask an admin.`;
  }
}
export class HasDependants extends Schema.TaggedError<HasDependants>()("HasDependants", {
  dependants: Schema.Array(Dependant)
}) {
  override get message() {
    return "Other live patches read these tables. Ask the person you are working for before forcing.";
  }
}
export class SourcesOff extends Schema.TaggedError<SourcesOff>()("SourcesOff", {
  sources: Schema.Array(OffSource)
}) {
  override get message() {
    return "This patch reads sources that are off. Ask the person you are working for before forcing.";
  }
}
export class ReservedName extends Schema.TaggedError<ReservedName>()("ReservedName", {
  name: Schema.String
}) {
  override get message() {
    return `Patch name "${this.name}" is reserved.`;
  }
}
export class InvalidDescription extends Schema.TaggedError<InvalidDescription>()(
  "InvalidDescription",
  { cause: Schema.Defect() }
) {
  override get message() {
    return "Use one paragraph of at most 500 Unicode code points, without control characters.";
  }
}
export class VersionUnavailable extends Schema.TaggedError<VersionUnavailable>()(
  "VersionUnavailable",
  { versionNumber: Schema.Number }
) {
  override get message() {
    return `Version ${this.versionNumber} is not retained by this patch.`;
  }
}
export class InvalidOwner extends Schema.TaggedError<InvalidOwner>()("InvalidOwner", {
  userId: Schema.String
}) {
  override get message() {
    return "The new owner must be an active member of this company.";
  }
}
export class AdminRequired extends Schema.TaggedError<AdminRequired>()("AdminRequired", {
  userId: Schema.String
}) {
  override get message() {
    return "Only a company administrator can reassign a patch.";
  }
}
export type LifecycleError =
  | PatchUnavailable
  | NotOwner
  | WrongState
  | StaleAction
  | PatchRetired
  | PatchDeleted
  | HasDependants
  | SourcesOff
  | ReservedName
  | InvalidDescription
  | VersionUnavailable
  | InvalidOwner;

const normalizeDescription = Effect.fn("Patches.normalizeDescription")(function* (text: string) {
  return yield* decodeDescription(text).pipe(
    Effect.mapError((cause) => new InvalidDescription({ cause }))
  );
});
const reservedName = (name: string) => name === "patches" || name === "connections";

export interface Patch {
  readonly id: string;
  readonly companyId: string;
  readonly companyHandle: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly scope: typeof SharingScope.Type;
  readonly title: string;
  readonly currentVersionId: string | null;
  readonly repoOrg: string | null;
  readonly repoName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: PatchState;
  readonly retiredAt: string | null;
  readonly retiredBy: string | null;
  readonly deletedAt: string | null;
  readonly deletedBy: string | null;
  readonly purgeAt: string | null;
  readonly reassignedAt: string | null;
  readonly reassignedBy: string | null;
  readonly description: string;
  readonly descriptionUpdatedAt: string | null;
  readonly descriptionUpdatedBy: string | null;
  readonly lastChangedAt: string | null;
  readonly lastChangedBy: string | null;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
}

export interface ReadAccess {
  readonly companyId: string;
  readonly userId: string;
  readonly canOpen: (patch: Patch) => boolean;
}

export interface ReadOptions extends ReadAccess {
  readonly state: "live" | "retired" | "all";
  readonly mine?: boolean;
  readonly patchRef?: string;
}

export interface ReadPatch {
  readonly patch: Patch;
  readonly owner: { readonly id: string; readonly name: string; readonly deactivated: boolean };
  readonly currentVersion: number;
  readonly tier: number;
  readonly publishedAt: string;
  readonly reads: readonly {
    readonly alias: string;
    readonly patchId: string;
    readonly name?: string;
    readonly table: string;
    readonly state: "live" | "retired" | "deleted" | "gone";
  }[];
  readonly dependants: readonly {
    readonly patchId: string;
    readonly name: string;
    readonly owner: { readonly id: string; readonly name: string };
    readonly table: string;
  }[];
}

export interface PortalCard extends ReadPatch {
  readonly versions: readonly {
    readonly id: string;
    readonly versionNumber: number;
    readonly createdAt: string;
    readonly publisherName: string;
  }[];
  readonly offSources: readonly {
    readonly patchId: string;
    readonly name?: string;
    readonly table: string;
    readonly state: "live" | "retired" | "deleted" | "gone";
  }[];
  readonly actorNames: {
    readonly description: string | null;
    readonly retired: string | null;
    readonly deleted: string | null;
    readonly lastChanged: string | null;
  };
  readonly lastChangedAction: string | null;
}

/** Credential reach narrows the mandatory same-company, not-disabled read gate. */
export const Openability = Context.Reference<(patch: Patch, userId: string) => boolean>(
  "@patchy/patches/Openability",
  { defaultValue: () => () => true }
);

export interface PatchVersion {
  readonly id: string;
  readonly patchId: string;
  readonly versionNumber: number;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly fileSize: number;
  readonly createdByMachineTokenId: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly cliVersion: string | null;
  readonly gitBranch: string | null;
  readonly gitCommitSha: string | null;
  readonly originalFilename: string | null;
  readonly createdAt: string;
  readonly tier: number;
  readonly release: string;
  readonly manifestVersion: number;
  readonly wireVersion: number;
  readonly schemaRevision: number;
  readonly manifest: typeof Manifest.Type;
  readonly publishKey: string;
  readonly payloadDigest: string;
  // PROTOTYPE for #314: the tier 2 server bundle's object and content hash, null below tier 2.
  readonly serverObjectKey: string | null;
  readonly serverHash: string | null;
}

export class PublishKeyTaken extends Schema.TaggedError<PublishKeyTaken>()("PublishKeyTaken", {
  ownerUserId: Schema.String,
  /** The arbitrary client-supplied key is summarized, never echoed. */
  publishKey: Schema.Struct({ length: Schema.Int })
}) {
  override get message() {
    return `Publish key (${this.publishKey.length} characters) already recorded for owner ${this.ownerUserId}.`;
  }
}
export class PatchQuotaReached extends Schema.TaggedError<PatchQuotaReached>()(
  "PatchQuotaReached",
  {
    quota: Schema.Int
  }
) {
  override get message() {
    return `Patch quota reached: ${this.quota} live patches per user.`;
  }
}

/** The sweep already owns these bytes, or their publication lease has elapsed. */
export class PendingObjectExpired extends Schema.TaggedError<PendingObjectExpired>()(
  "PendingObjectExpired",
  { objectKey: Schema.String }
) {
  override get message() {
    return `Publication lease expired for ${this.objectKey}.`;
  }
}

export class HasPrimitives extends Schema.TaggedError<HasPrimitives>()("HasPrimitives", {
  patchId: Schema.String
}) {
  readonly code = "has_primitives";
  override get message() {
    return "This patch has provisioned tables or file stores; publish from its repo instead of a single HTML file.";
  }
}

/** A declaration never reveals whether its source is missing, private or unshared. */
export class PatchNotOpenable extends Schema.TaggedError<PatchNotOpenable>()("PatchNotOpenable", {
  patchId: Schema.String,
  table: Schema.String
}) {
  readonly code = "patch_not_openable" as const;
  override get message() {
    return `Shared table ${this.patchId}/${this.table} is not openable.`;
  }
}

export interface SharedTable {
  readonly id: string;
  readonly patchId: string;
  readonly table: string;
  readonly schemaRevision: number;
  readonly definition: typeof TableDefinition.Type;
  readonly tables: Readonly<Record<string, typeof TableDefinition.Type>>;
  readonly uses: Readonly<Record<string, typeof SharedTableDeclaration.Type>>;
}

export type DatabaseError =
  | CompanyDatabases.Busy
  | CompanyDatabases.CompanyDatabaseError
  | CompanyDatabases.CompanyDatabaseNotReady
  | CompanyDatabases.CompanyIdentityMismatch;

export type ResourceError =
  | HasPrimitives
  | PatchNotOpenable
  | Tables.NotAdditive
  | DatabaseError
  | ConnectionStore.ResolveError;

export interface PublishTarget {
  readonly intent: "create" | "update";
  readonly patchId: string;
  readonly ownerUserId: string;
}

export interface PublishPreflight extends PublishTarget {
  readonly companyId: string;
  readonly manifest: typeof Manifest.Type;
  readonly filename: string | null;
  readonly force?: boolean;
  readonly description?: string;
}

const hasOwnedDefinitions = (manifest: typeof Manifest.Type) =>
  Object.keys(manifest.tables).length > 0 || Object.keys(manifest.files).length > 0;

/** File requests may carry --name; empty named repo manifests are not file requests. */
const isFileMode = (input: PublishPreflight) =>
  !hasOwnedDefinitions(input.manifest) &&
  (input.filename !== null ||
    (Object.keys(input.manifest.uses).length === 0 && input.manifest.name === undefined));

export interface RecordInput extends PublishTarget {
  readonly companyId: string;
  readonly versionId: string;
  readonly machineTokenId: string;
  /** Omitted creates are company-scoped; omitted updates retain the scope under the row lock. */
  readonly scope?: Patch["scope"] | undefined;
  readonly title: string;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly fileSize: number;
  readonly filename: string | null;
  readonly repoOrg: string | null;
  readonly repoName: string | null;
  readonly cliVersion: string | null;
  readonly gitBranch: string | null;
  readonly gitCommitSha: string | null;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly manifest: typeof Manifest.Type;
  readonly wireVersion: number;
  readonly publishKey: string;
  readonly payloadDigest: string;
  readonly publicBaseUrl: string;
  readonly warnings: ReadonlyArray<string>;
  // PROTOTYPE for #314
  readonly serverObjectKey?: string | undefined;
  readonly serverHash?: string | undefined;
  readonly livePatchQuota?: number;
  readonly force?: boolean;
  readonly description?: string;
}

export interface Recorded extends PublishUpdated {
  readonly status: 200 | 201;
  /** PostgreSQL's persisted JSONB representation, sent unchanged on the wire. */
  readonly responseBody: string;
}

const Replay = Schema.Struct({
  payloadDigest: Schema.String,
  response: Schema.JsonObject,
  body: Schema.String,
  status: Schema.Literals([200, 201])
});

// Today's client hands back a Date; when it becomes epoch ms only these lines move.
const Stamp = Schema.Date;
const NullableStamp = Schema.NullOr(Schema.Date);

class PatchRow extends Schema.Class<PatchRow>("PatchRow")({
  id: Schema.String,
  companyId: Schema.String,
  companyHandle: Schema.String,
  name: PatchName,
  ownerUserId: Schema.String,
  scope: SharingScope,
  title: Schema.String,
  currentVersionId: Schema.NullOr(Schema.String),
  repoOrg: Schema.NullOr(Schema.String),
  repoName: Schema.NullOr(Schema.String),
  createdAt: Stamp,
  updatedAt: Stamp,
  retiredAt: NullableStamp,
  retiredBy: Schema.NullOr(Schema.String),
  deletedAt: NullableStamp,
  deletedBy: Schema.NullOr(Schema.String),
  reassignedAt: NullableStamp,
  reassignedBy: Schema.NullOr(Schema.String),
  description: Schema.String,
  descriptionUpdatedAt: NullableStamp,
  descriptionUpdatedBy: Schema.NullOr(Schema.String),
  lastChangedAt: NullableStamp,
  lastChangedBy: Schema.NullOr(Schema.String),
  disabledAt: NullableStamp,
  disabledReason: Schema.NullOr(Schema.String)
}) {}

class VersionRow extends Schema.Class<VersionRow>("VersionRow")({
  id: Schema.String,
  patchId: Schema.String,
  versionNumber: Schema.Int,
  objectKey: Schema.String,
  contentHash: Schema.String,
  fileSize: Schema.Int,
  createdByMachineTokenId: Schema.String,
  sourceIp: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  cliVersion: Schema.NullOr(Schema.String),
  gitBranch: Schema.NullOr(Schema.String),
  gitCommitSha: Schema.NullOr(Schema.String),
  originalFilename: Schema.NullOr(Schema.String),
  tier: Schema.Int,
  release: Schema.String,
  manifestVersion: Schema.Int,
  wireVersion: Schema.Int,
  schemaRevision: Schema.Int,
  manifest: Manifest,
  publishKey: Schema.String,
  payloadDigest: Schema.String,
  serverObjectKey: Schema.NullOr(Schema.String),
  serverHash: Schema.NullOr(Schema.String),
  createdAt: Stamp
}) {}

class Id extends Schema.Class<Id>("Id")({ id: Schema.String }) {}
class Count extends Schema.Class<Count>("Count")({ count: Schema.Int }) {}
class NextVersion extends Schema.Class<NextVersion>("NextVersion")({ nextVersion: Schema.Int }) {}
class ObjectKey extends Schema.Class<ObjectKey>("ObjectKey")({ objectKey: Schema.String }) {}
class DeclaringPatches extends Schema.Class<DeclaringPatches>("DeclaringPatches")({
  table: Schema.String,
  count: Schema.Int
}) {}
class ManagedPatchRow extends Schema.Class<ManagedPatchRow>("ManagedPatchRow")({
  ...PatchRow.fields,
  ownerName: Schema.String
}) {}
class ReadPatchRow extends Schema.Class<ReadPatchRow>("ReadPatchRow")({
  ...ManagedPatchRow.fields,
  ownerDeactivated: Schema.Boolean,
  currentVersion: Schema.Int,
  tier: Schema.Int,
  publishedAt: Stamp,
  reads: Schema.Array(
    Schema.Struct({ alias: Schema.String, patchId: Schema.String, table: Schema.String })
  )
}) {}
class PortalMetadataRow extends Schema.Class<PortalMetadataRow>("PortalMetadataRow")({
  description: Schema.NullOr(Schema.String),
  retired: Schema.NullOr(Schema.String),
  deleted: Schema.NullOr(Schema.String),
  lastChanged: Schema.NullOr(Schema.String),
  lastChangedAction: Schema.NullOr(Schema.String)
}) {}
class PortalVersionRow extends Schema.Class<PortalVersionRow>("PortalVersionRow")({
  id: Schema.String,
  versionNumber: Schema.Int,
  createdAt: Stamp,
  publisherName: Schema.String
}) {}
class NameRow extends Schema.Class<NameRow>("NameRow")({ name: PatchName }) {}
class ResolvedName extends Schema.Class<ResolvedName>("ResolvedName")({
  patchId: Schema.String,
  name: PatchName,
  current: Schema.Boolean
}) {}
class CompanyHandle extends Schema.Class<CompanyHandle>("CompanyHandle")({
  handle: Schema.String
}) {}
class UnnamedPatch extends Schema.Class<UnnamedPatch>("UnnamedPatch")({
  id: Schema.String,
  companyId: Schema.String,
  title: Schema.String
}) {}

export class Patches extends Context.Service<
  Patches,
  {
    /** Non-deleted, enabled patches owned by this user, including retired patches. */
    readonly countQuotaPatches: (ownerUserId: string) => Effect.Effect<number, SqlError>;
    readonly authorizePublish: (
      target: PublishTarget
    ) => Effect.Effect<
      void,
      PatchUnavailable | PatchConflict | NotOwner | PatchRetired | PatchDeleted | SqlError
    >;
    readonly replay: (
      ownerUserId: string,
      publishKey: string
    ) => Effect.Effect<Option.Option<typeof Replay.Type>, SqlError>;
    /**
     * The publish contract's preflight, before any bytes are written: an
     * update needs a patch the caller may write, a create needs a free id.
     */
    readonly preflight: (
      input: PublishPreflight
    ) => Effect.Effect<void, LifecycleError | PatchConflict | NameTaken | ResourceError | SqlError>;
    readonly inventory: (
      patchId: string,
      actorUserId: string
    ) => Effect.Effect<PatchInventory, PatchUnavailable | DatabaseError | SqlError>;
    readonly read: (
      options: ReadOptions
    ) => Effect.Effect<readonly ReadPatch[], PatchUnavailable | WrongState | SqlError>;
    readonly portalCard: (
      patchId: string,
      access: ReadAccess
    ) => Effect.Effect<PortalCard, PatchUnavailable | SqlError>;
    /** Retained metadata for the address notice, never content or inventory. */
    readonly addressNotice: (
      patchId: string,
      access: ReadAccess
    ) => Effect.Effect<
      Option.Option<{ patch: Patch; actorName: string | null; sourcesOff: boolean }>,
      SqlError
    >;
    /** Hold the company's dependency advisory lock in a transaction, without locking patch rows. */
    readonly withDependencyLock: (
      actorUserId: string
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
    /** Company-readable inventory; unavailable company-database inventory is null, not empty. */
    readonly companyInventory: (
      patchId: string,
      access: ReadAccess
    ) => Effect.Effect<PatchInventory | null, PatchUnavailable | SqlError>;
    /** Cumulative metadata from live same-company shared inventory. */
    readonly sharedTable: (
      patchId: string,
      table: string,
      companyId: string
    ) => Effect.Effect<SharedTable, PatchNotOpenable | DatabaseError | SqlError>;
    /** Durably reserves a fresh object key before any bytes can be written. */
    readonly prepareObject: (objectKey: string) => Effect.Effect<void, SqlError>;
    /**
     * Fences expired, unreferenced objects against publication. Claimed rows
     * remain eligible until deletion succeeds, so interrupted sweeps retry.
     */
    readonly claimObjects: (limit: number) => Effect.Effect<ReadonlyArray<string>, SqlError>;
    /** Forgets a claimed object only after its bytes have been deleted. */
    readonly completeObject: (objectKey: string) => Effect.Effect<void, SqlError>;
    /**
     * Records a publish whose bytes are already stored: the version row, the
     * patch row it creates or moves forward,
     * in one transaction. Consumes the pending-object intent under a lock;
     * a sweep that claimed it first prevents the version from being recorded.
     * Re-checks the target, so the preflight's answer can still change here.
     */
    readonly record: (
      input: RecordInput
    ) => Effect.Effect<
      Recorded,
      | PatchUnavailable
      | PatchConflict
      | NameTaken
      | PublishKeyTaken
      | PatchQuotaReached
      | PendingObjectExpired
      | ResourceError
      | LifecycleError
      | SqlError
    >;
    /** Changes a live patch's audience without creating a version. */
    readonly setScope: (
      patchId: string,
      actor: Actor,
      scope: Patch["scope"],
      expectedScope?: Patch["scope"]
    ) => Effect.Effect<
      { scope: Patch["scope"]; name: string; companyHandle: string },
      LifecycleError | SqlError
    >;
    /** A retained name or redirect, including off and operator-disabled patches. */
    readonly resolveName: (
      companyHandle: string,
      name: string
    ) => Effect.Effect<
      Option.Option<{ patchId: string; name: string; current: boolean }>,
      SqlError
    >;
    /**
     * A patch in service and one of its versions — the current one, or the
     * numbered one asked for. Retired, deleted and disabled patches are absent.
     */
    readonly find: (
      patchId: string,
      versionNumber?: number,
      versionId?: string
    ) => Effect.Effect<Option.Option<{ patch: Patch; version: PatchVersion }>, SqlError>;
    /** Address admission inspects retained metadata before choosing a notice, door or 404. */
    readonly findRetained: (
      patchId: string,
      versionNumber?: number,
      versionId?: string
    ) => Effect.Effect<Option.Option<{ patch: Patch; version: PatchVersion }>, SqlError>;
    /** Counts a visit to a serving patch without changing its lifecycle. */
    readonly recordVisit: (patchId: string) => Effect.Effect<void, SqlError>;
    readonly retire: (
      patchId: string,
      actor: Actor,
      force?: boolean,
      expectedOwnerUserId?: string
    ) => Effect.Effect<Patch, LifecycleError | SqlError>;
    readonly delete: (
      patchId: string,
      actor: Actor,
      force?: boolean
    ) => Effect.Effect<Patch, LifecycleError | SqlError>;
    readonly restore: (
      patchId: string,
      actor: Actor,
      force?: boolean,
      expectedState?: PatchState,
      expectedOwnerUserId?: string
    ) => Effect.Effect<Patch, LifecycleError | SqlError>;
    readonly rollback: (
      patchId: string,
      actor: Actor,
      versionNumber: number,
      expectedCurrentVersionId?: string | null
    ) => Effect.Effect<{ patch: Patch; currentVersion: number }, LifecycleError | SqlError>;
    readonly reassign: (
      patchId: string,
      actor: Actor,
      newOwnerUserId: string,
      expectedOwnerUserId?: string
    ) => Effect.Effect<Patch, LifecycleError | AdminRequired | SqlError>;
    readonly setDescription: (
      patchId: string,
      actor: Actor,
      description: string,
      expectedDescriptionUpdatedAt?: string | null
    ) => Effect.Effect<Patch, LifecycleError | SqlError>;
    readonly listDeleted: (limit: number) => Effect.Effect<ReadonlyArray<string>, SqlError>;
    /** Locks platform then company inventory; reclamation follows the platform commit. */
    readonly purgeDeleted: (
      patchId: string
    ) => Effect.Effect<
      Option.Option<{ companyId: string; objectKeys: ReadonlyArray<string> }>,
      SqlError | DatabaseError
    >;
  }
>()("@patchy/patches/Patches") {}

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date === null ? null : date.toISOString());
const stateOf = (row: PatchRow): PatchState =>
  row.deletedAt !== null ? "deleted" : row.retiredAt !== null ? "retired" : "live";
const purgeAtOf = (row: PatchRow): string | null =>
  row.deletedAt === null
    ? null
    : DateTime.formatIso(
        DateTime.makeUnsafe(row.deletedAt.getTime() + Duration.toMillis(RECOVERY_WINDOW))
      );

const toPatch = (row: PatchRow): Patch => ({
  id: row.id,
  companyId: row.companyId,
  companyHandle: row.companyHandle,
  name: row.name,
  ownerUserId: row.ownerUserId,
  scope: row.scope,
  title: row.title,
  currentVersionId: row.currentVersionId,
  repoOrg: row.repoOrg,
  repoName: row.repoName,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  state: stateOf(row),
  retiredAt: isoOrNull(row.retiredAt),
  retiredBy: row.retiredBy,
  deletedAt: isoOrNull(row.deletedAt),
  deletedBy: row.deletedBy,
  purgeAt: purgeAtOf(row),
  reassignedAt: isoOrNull(row.reassignedAt),
  reassignedBy: row.reassignedBy,
  description: row.description,
  descriptionUpdatedAt: isoOrNull(row.descriptionUpdatedAt),
  descriptionUpdatedBy: row.descriptionUpdatedBy,
  lastChangedAt: isoOrNull(row.lastChangedAt),
  lastChangedBy: row.lastChangedBy,
  disabledAt: isoOrNull(row.disabledAt),
  disabledReason: row.disabledReason
});

const toVersion = (row: VersionRow): PatchVersion => ({
  id: row.id,
  patchId: row.patchId,
  versionNumber: row.versionNumber,
  objectKey: row.objectKey,
  contentHash: row.contentHash,
  fileSize: row.fileSize,
  createdByMachineTokenId: row.createdByMachineTokenId,
  sourceIp: row.sourceIp,
  userAgent: row.userAgent,
  cliVersion: row.cliVersion,
  gitBranch: row.gitBranch,
  gitCommitSha: row.gitCommitSha,
  originalFilename: row.originalFilename,
  tier: row.tier,
  release: row.release,
  manifestVersion: row.manifestVersion,
  wireVersion: row.wireVersion,
  schemaRevision: row.schemaRevision,
  manifest: row.manifest,
  publishKey: row.publishKey,
  payloadDigest: row.payloadDigest,
  serverObjectKey: row.serverObjectKey,
  serverHash: row.serverHash,
  createdAt: iso(row.createdAt)
});

/** A `SchemaError` on a row is a bug in the query or the schema, never a caller's fault. */
const dieOnSchemaError = { SchemaError: Effect.die } as const;

/** The columns of `patches`, aliased to the record's names. */
const PATCH_COLUMNS = `
  patches.id, patches.company_id AS "companyId",
  companies.handle AS "companyHandle", patches.name,
  patches.owner_user_id AS "ownerUserId", patches.scope, patches.title,
  patches.current_version_id AS "currentVersionId",
  patches.repo_org AS "repoOrg", patches.repo_name AS "repoName",
  patches.created_at AS "createdAt", patches.updated_at AS "updatedAt",
  patches.retired_at AS "retiredAt", patches.retired_by AS "retiredBy",
  patches.deleted_at AS "deletedAt", patches.deleted_by AS "deletedBy",
  patches.reassigned_at AS "reassignedAt", patches.reassigned_by AS "reassignedBy",
  patches.description, patches.description_updated_at AS "descriptionUpdatedAt",
  patches.description_updated_by AS "descriptionUpdatedBy",
  patches.last_changed_at AS "lastChangedAt", patches.last_changed_by AS "lastChangedBy",
  patches.disabled_at AS "disabledAt",
  patches.disabled_reason AS "disabledReason"`;

const VERSION_COLUMNS = `
  id, patch_id AS "patchId", version_number AS "versionNumber",
  object_key AS "objectKey", content_hash AS "contentHash", file_size AS "fileSize",
  created_by_machine_token_id AS "createdByMachineTokenId", source_ip AS "sourceIp",
  user_agent AS "userAgent", cli_version AS "cliVersion", git_branch AS "gitBranch",
  git_commit_sha AS "gitCommitSha", original_filename AS "originalFilename",
  tier, release, manifest_version AS "manifestVersion", wire_version AS "wireVersion",
  schema_revision AS "schemaRevision", manifest, publish_key AS "publishKey", payload_digest AS "payloadDigest",
  server_object_key AS "serverObjectKey", server_hash AS "serverHash",
  created_at AS "createdAt"`;

/** Seeds legacy patches' names from titles in creation order, without changing existing claims. */
export const backfillNames = Effect.fn("Patches.backfillNames")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const unnamed = SqlSchema.findAll({
    Request: Schema.Void,
    Result: UnnamedPatch,
    execute: () => sql`
      SELECT patches.id, patches.company_id AS "companyId", patches.title FROM patches
      WHERE patches.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM patch_names WHERE patch_names.patch_id = patches.id AND patch_names.current
      )
      ORDER BY patches.created_at, patches.id FOR UPDATE OF patches`
  });
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const patch of yield* unnamed(undefined)) {
        // Another seed may have completed while this one waited for the patch row.
        const current =
          yield* sql`SELECT 1 FROM patch_names WHERE patch_id = ${patch.id} AND current`;
        if (current.length > 0) continue;
        const baseName = deriveName(patch.title);
        let ordinal = 1;
        let name = baseName;
        while (true) {
          const claimed = yield* sql`
          INSERT INTO patch_names (company_id, name, patch_id, current)
          VALUES (${patch.companyId}, ${name}, ${patch.id}, true)
          ON CONFLICT (company_id, name) DO UPDATE
          SET patch_id = EXCLUDED.patch_id, current = true
          WHERE NOT patch_names.current
          RETURNING name`;
          if (claimed.length > 0) break;
          name = deriveName(baseName, ++ordinal);
        }
        yield* sql`UPDATE patches SET name = ${name} WHERE id = ${patch.id}`;
      }
    }).pipe(Effect.catchTags(dieOnSchemaError))
  );
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const inventoryStore = yield* Inventory.Inventory;
  const tables = yield* Tables.Tables;
  const connections = yield* ConnectionStore.ConnectionStore;

  /** An Effect-clock instant represented as a Postgres timestamp. */
  const stamp = (millis: number) => sql`to_timestamp(${millis / 1_000})`;
  /** The clock's reading now, as that value. */
  const now = Effect.map(Clock.currentTimeMillis, stamp);

  const serving = sql`patches.deleted_at IS NULL AND patches.retired_at IS NULL AND patches.disabled_at IS NULL`;

  const countQuotaPatchesRow = SqlSchema.findOne({
    Request: Schema.String,
    Result: Count,
    execute: (ownerUserId) => sql`
      SELECT count(*)::int AS count
      FROM patches
      WHERE patches.owner_user_id = ${ownerUserId}
        AND patches.deleted_at IS NULL AND patches.disabled_at IS NULL`
  });

  const findPatch = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: PatchRow,
    execute: (patchId) => sql`
      SELECT ${sql.unsafe(PATCH_COLUMNS)}
      FROM patches JOIN companies ON companies.id = patches.company_id
      WHERE patches.id = ${patchId}`
  });

  const companyPatchRows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, userId: Schema.String }),
    Result: ReadPatchRow,
    execute: ({ companyId, userId }) => sql`
      SELECT ${sql.unsafe(PATCH_COLUMNS)}, owner.name AS "ownerName",
        owner.deactivated_at IS NOT NULL AS "ownerDeactivated",
        current_version.version_number AS "currentVersion", current_version.tier,
        current_version.created_at AS "publishedAt",
        COALESCE((
          SELECT jsonb_agg(declarations ORDER BY declarations.alias, declarations."patchId", declarations."table")
          FROM (
            SELECT DISTINCT declaration.key AS alias,
              declaration.value->>'patchId' AS "patchId", declaration.value->>'table' AS "table"
            FROM patch_versions
            CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
            WHERE patch_versions.patch_id = patches.id
              AND declaration.value->>'kind' = 'sharedTable'
              AND declaration.value->>'id' =
                (declaration.value->>'patchId') || '/' || (declaration.value->>'table')
          ) declarations
        ), '[]'::jsonb) AS reads
      FROM patches
      JOIN companies ON companies.id = patches.company_id
      JOIN users owner ON owner.id = patches.owner_user_id
      JOIN patch_versions current_version ON current_version.id = patches.current_version_id
        AND current_version.patch_id = patches.id
      WHERE patches.company_id = ${companyId}
      ORDER BY (patches.owner_user_id = ${userId}) DESC, patches.name, patches.id`
  });

  const companyPatchRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, patchId: Schema.String }),
    Result: PatchRow,
    execute: ({ companyId, patchId }) => sql`
      SELECT ${sql.unsafe(PATCH_COLUMNS)}
      FROM patches JOIN companies ON companies.id = patches.company_id
      WHERE patches.id = ${patchId} AND patches.company_id = ${companyId}
        AND patches.disabled_at IS NULL`
  });

  const portalMetadataRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, patchId: Schema.String }),
    Result: PortalMetadataRow,
    execute: ({ companyId, patchId }) => sql`
      SELECT description_actor.name AS description, retired_actor.name AS retired,
        deleted_actor.name AS deleted, last_actor.name AS "lastChanged",
        patches.last_changed_action AS "lastChangedAction"
      FROM patches
      LEFT JOIN users description_actor ON description_actor.id = patches.description_updated_by
      LEFT JOIN users retired_actor ON retired_actor.id = patches.retired_by
      LEFT JOIN users deleted_actor ON deleted_actor.id = patches.deleted_by
      LEFT JOIN users last_actor ON last_actor.id = patches.last_changed_by
      WHERE patches.id = ${patchId} AND patches.company_id = ${companyId}
        AND patches.disabled_at IS NULL`
  });

  const portalVersionRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: PortalVersionRow,
    execute: (patchId) => sql`
      SELECT version.id, version.version_number AS "versionNumber",
        version.created_at AS "createdAt", publisher.name AS "publisherName"
      FROM patch_versions version
      JOIN users publisher ON publisher.id = version.owner_user_id
      WHERE version.patch_id = ${patchId}
      ORDER BY version.version_number DESC`
  });

  const findVersionByNumber = SqlSchema.findOneOption({
    Request: Schema.Struct({ patchId: Schema.String, versionNumber: Schema.Number }),
    Result: VersionRow,
    execute: ({ patchId, versionNumber }) => sql`
      SELECT ${sql.unsafe(VERSION_COLUMNS)} FROM patch_versions
      WHERE patch_id = ${patchId} AND version_number = ${versionNumber}`
  });

  const findVersionById = SqlSchema.findOneOption({
    Request: Schema.Struct({ patchId: Schema.String, versionId: Schema.String }),
    Result: VersionRow,
    execute: ({ patchId, versionId }) => sql`
      SELECT ${sql.unsafe(VERSION_COLUMNS)} FROM patch_versions
      WHERE id = ${versionId} AND patch_id = ${patchId}`
  });

  const resolveNameRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyHandle: Schema.String,
      name: Schema.String
    }),
    Result: ResolvedName,
    execute: ({ companyHandle, name }) => sql`
      SELECT patches.id AS "patchId", patches.name, patch_names.current
      FROM patch_names
      JOIN companies ON companies.id = patch_names.company_id
      JOIN patches ON patches.id = patch_names.patch_id
      WHERE companies.handle = ${companyHandle} AND patch_names.name = ${name}`
  });

  const companyHandleRow = SqlSchema.findOne({
    Request: Schema.String,
    Result: CompanyHandle,
    execute: (companyId) => sql`SELECT handle FROM companies WHERE id = ${companyId}`
  });

  /**
   * Whether the existing `patch_names` row may go to `patchId`: its own, or another
   * live patch's former name. Retired and deleted patches keep every name until
   * reclamation removes their rows. Shared by publish preflight and `claimName`.
   */
  const nameAvailable = (patchId: string) => sql`(patch_names.patch_id = ${patchId}
    OR NOT patch_names.current AND EXISTS (
      SELECT 1 FROM patches holder WHERE holder.id = patch_names.patch_id
        AND holder.retired_at IS NULL AND holder.deleted_at IS NULL))`;

  const claimName = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, patchId: Schema.String, name: PatchName }),
    Result: NameRow,
    execute: ({ companyId, patchId, name }) => sql`
      INSERT INTO patch_names (company_id, name, patch_id, current)
      VALUES (${companyId}, ${name}, ${patchId}, true)
      ON CONFLICT (company_id, name) DO UPDATE
      SET patch_id = EXCLUDED.patch_id, current = true
      WHERE ${nameAvailable(patchId)}
      RETURNING name`
  });

  const listDeletedRows = SqlSchema.findAll({
    Request: Schema.Struct({ nowMillis: Schema.Number, limit: Schema.Number }),
    Result: Id,
    execute: ({ limit, nowMillis }) => sql`
      SELECT id FROM patches
      WHERE deleted_at <= ${stamp(nowMillis - Duration.toMillis(RECOVERY_WINDOW))}
      ORDER BY deleted_at, id
      LIMIT ${limit}`
  });

  const nextVersionNumber = SqlSchema.findOne({
    Request: Schema.String,
    Result: NextVersion,
    execute: (patchId) => sql`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS "nextVersion"
      FROM patch_versions WHERE patch_id = ${patchId}`
  });

  const objectKeysOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: ObjectKey,
    execute: (patchId) =>
      sql`SELECT object_key AS "objectKey" FROM patch_versions WHERE patch_id = ${patchId}
        UNION ALL
        SELECT server_object_key AS "objectKey" FROM patch_versions
        WHERE patch_id = ${patchId} AND server_object_key IS NOT NULL`
  });

  // Company/public sharing admits every member of this company in any lifecycle
  // state. Disabled patches remain hidden; serving reads use the stricter gate.
  const lockOpenable = SqlSchema.findOneOption({
    Request: Schema.Struct({ patchId: Schema.String, userId: Schema.String }),
    Result: ManagedPatchRow,
    execute: Effect.fn("Patches.lockOpenable")(function* ({ patchId, userId }) {
      // Lock the patch before joining its owner. A join planned before a lock
      // wait can lose the row when PostgreSQL rechecks a concurrent reassignment.
      // Callers keep both statements in one transaction; its patch lock preserves
      // the company and disabled-state checks through the owner lookup.
      const locked = yield* sql`SELECT id FROM patches
        WHERE id = ${patchId} AND disabled_at IS NULL
          AND company_id = (SELECT company_id FROM users WHERE id = ${userId})
        FOR UPDATE`;
      if (locked.length === 0) return [];
      return yield* sql`
        SELECT ${sql.unsafe(PATCH_COLUMNS)}, owner.name AS "ownerName"
        FROM patches JOIN companies ON companies.id = patches.company_id
        JOIN users owner ON owner.id = patches.owner_user_id
        WHERE patches.id = ${patchId}`;
    })
  });
  // Serialize dependency admissions and source changes before taking patch rows.
  // This prevents cross-patch write skew without lock-order cycles in shared reads.
  const lockDependencies = Effect.fn("Patches.lockDependencies")(
    (userId: string) =>
      sql`SELECT pg_advisory_xact_lock(hashtextextended('patchy:dependencies:' || company_id, 0))
      FROM users WHERE id = ${userId}`
  );
  const withDependencyLock: Patches["Service"]["withDependencyLock"] = (actorUserId) => (effect) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* lockDependencies(actorUserId);
        return yield* effect;
      })
    );
  const manageable = Effect.fn("Patches.manageable")(function* (patchId: string, actor: Actor) {
    const row = yield* lockOpenable({ patchId, userId: actor.userId });
    if (Option.isNone(row)) return yield* new PatchUnavailable({ patchId });
    if (row.value.ownerUserId !== actor.userId && !actor.admin)
      return yield* new NotOwner({
        owner: { id: row.value.ownerUserId, name: row.value.ownerName }
      });
    return row.value;
  }, Effect.catchTags(dieOnSchemaError));
  const publishable = Effect.fn("Patches.publishable")(function* (target: PublishTarget) {
    const row = yield* manageable(target.patchId, { userId: target.ownerUserId, admin: false });
    if (row.deletedAt !== null) return yield* new PatchDeleted({ purgeAt: purgeAtOf(row)! });
    if (row.retiredAt !== null) return yield* new PatchRetired();
    return row;
  });

  const replayRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ ownerUserId: Schema.String, publishKey: Schema.String }),
    Result: Replay,
    execute: ({ ownerUserId, publishKey }) => sql`
      SELECT payload_digest AS "payloadDigest", publish_response AS response,
        publish_response::text AS body, publish_status AS status
      FROM patch_versions WHERE owner_user_id = ${ownerUserId} AND publish_key = ${publishKey}`
  });
  const replay = Effect.fn("Patches.replay")((ownerUserId: string, publishKey: string) =>
    replayRow({ ownerUserId, publishKey }).pipe(Effect.catchTags(dieOnSchemaError))
  );
  const countQuotaPatches = Effect.fn("Patches.countQuotaPatches")((ownerUserId: string) =>
    countQuotaPatchesRow(ownerUserId).pipe(
      Effect.map((row) => row.count),
      // `count(*)` always answers one row; no row is a bug, not a state.
      Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
    )
  );
  const findRetained = Effect.fn("Patches.findRetained")(function* (
    patchId: string,
    versionNumber?: number,
    versionId?: string
  ) {
    const patch = yield* findPatch(patchId);
    if (Option.isNone(patch)) return Option.none();
    const selectedId = versionId ?? patch.value.currentVersionId;
    const version =
      versionId === undefined && versionNumber !== undefined
        ? yield* findVersionByNumber({ patchId, versionNumber })
        : selectedId === null
          ? Option.none()
          : yield* findVersionById({ patchId, versionId: selectedId });
    return Option.map(version, (row) => ({ patch: toPatch(patch.value), version: toVersion(row) }));
  }, Effect.catchTags(dieOnSchemaError));

  const find = Effect.fn("Patches.find")(function* (
    patchId: string,
    versionNumber?: number,
    versionId?: string
  ) {
    return (yield* findRetained(patchId, versionNumber, versionId)).pipe(
      Option.filter(({ patch }) => patch.state === "live" && patch.disabledAt === null)
    );
  });

  const authorizePublish = Effect.fn("Patches.authorizePublish")((target: PublishTarget) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (target.intent === "update") {
          yield* publishable(target);
          return;
        }
        const rows = yield* sql`SELECT 1 FROM patches WHERE id = ${target.patchId}`;
        if (rows.length > 0) return yield* new PatchConflict({ patchId: target.patchId });
      })
    )
  );

  // Probe without starting a company transaction. A platform version is not
  // evidence of absence: company DDL may have committed before platform failure.
  const readInventory = Effect.fn("Patches.readInventory")((companyId: string, patchId: string) =>
    databases
      .withCompany(companyId)(
        Effect.gen(function* () {
          if (!(yield* inventoryStore.exists(patchId))) return null;
          return yield* inventoryStore.read(patchId);
        })
      )
      .pipe(
        Effect.catchTags({
          CompanyDatabaseNotReady: (error) =>
            error.status === null ? Effect.succeed(null) : Effect.fail(error)
        })
      )
  );

  const companyInventory = Effect.fn("Patches.companyInventory")(function* (
    patchId: string,
    access: ReadAccess
  ) {
    const row = yield* companyPatchRow({ companyId: access.companyId, patchId });
    if (Option.isNone(row) || !access.canOpen(toPatch(row.value)))
      return yield* new PatchUnavailable({ patchId });
    // Recover company inventory failures, not platform patch-query failures.
    return yield* databases
      .withCompany(access.companyId)(
        inventoryStore.read(patchId).pipe(
          Effect.map(
            (snapshot) =>
              new PatchInventory(
                snapshot === null
                  ? { schemaRevision: 0, tables: {}, files: {} }
                  : {
                      schemaRevision: snapshot.schemaRevision,
                      ...Tables.inventoryManifest(snapshot)
                    }
              )
          ),
          Effect.catchTags({ SqlError: () => Effect.succeed(null) })
        )
      )
      .pipe(
        Effect.catchTags({
          Busy: () => Effect.succeed(null),
          CompanyDatabaseNotReady: () => Effect.succeed(null),
          CompanyDatabaseError: () => Effect.succeed(null),
          CompanyIdentityMismatch: Effect.die
        })
      );
  }, Effect.catchTags(dieOnSchemaError));

  const read = Effect.fn("Patches.read")(function* (options: ReadOptions) {
    const rows = yield* companyPatchRows(options);
    const sourceStates = new Map<string, PatchState>();
    const openable = new Map<string, { row: ReadPatchRow; patch: Patch }>();
    for (const row of rows) {
      const patch = toPatch(row);
      sourceStates.set(patch.id, patch.state);
      if (patch.disabledAt === null && options.canOpen(patch))
        openable.set(patch.id, { row, patch });
    }
    let selected: Array<{ row: ReadPatchRow; patch: Patch }>;
    if (options.patchRef !== undefined) {
      const resolved =
        rows.find((row) => row.id === options.patchRef) ??
        rows.find((row) => row.name === options.patchRef && row.deletedAt === null);
      const found = resolved === undefined ? undefined : openable.get(resolved.id);
      if (found === undefined) return yield* new PatchUnavailable({ patchId: options.patchRef });
      if (options.state !== "all" && found.patch.state !== options.state)
        return yield* new WrongState({ state: found.patch.state });
      selected = [found];
    } else {
      selected = [];
      for (const entry of openable.values()) {
        if (
          (options.state === "all" || entry.patch.state === options.state) &&
          (!options.mine || entry.patch.ownerUserId === options.userId)
        )
          selected.push(entry);
      }
    }
    if (selected.length === 0) return [];

    const dependants = new Map<string, Array<ReadPatch["dependants"][number]>>();
    for (const { patch } of selected) dependants.set(patch.id, []);
    for (const { row, patch } of openable.values()) {
      if (patch.state !== "live" || row.reads.length === 0) continue;
      const seen = new Set<string>();
      for (const declaration of row.reads) {
        const edges = dependants.get(declaration.patchId);
        if (edges === undefined) continue;
        const key = sharedTableId(declaration.patchId, declaration.table);
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          patchId: patch.id,
          name: patch.name,
          owner: { id: patch.ownerUserId, name: row.ownerName },
          table: declaration.table
        });
      }
    }
    return selected.map(({ row, patch }): ReadPatch => ({
      patch,
      owner: {
        id: patch.ownerUserId,
        name: row.ownerName,
        deactivated: row.ownerDeactivated
      },
      currentVersion: row.currentVersion,
      tier: row.tier,
      publishedAt: iso(row.publishedAt),
      reads: row.reads.map((declaration): ReadPatch["reads"][number] => {
        const source = openable.get(declaration.patchId)?.patch;
        return {
          ...declaration,
          state: sourceStates.get(declaration.patchId) ?? "gone",
          ...(source === undefined ? {} : { name: source.name })
        };
      }),
      dependants: dependants
        .get(patch.id)!
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name) ||
            a.patchId.localeCompare(b.patchId) ||
            a.table.localeCompare(b.table)
        )
    }));
  }, Effect.catchTags(dieOnSchemaError));

  const sharedTable = Effect.fn("Patches.sharedTable")(function* (
    patchId: string,
    table: string,
    companyId: string
  ) {
    // Never nest platform patch locks: source liveness is read before the company inventory lock.
    const source = yield* find(patchId);
    if (Option.isNone(source) || source.value.patch.companyId !== companyId)
      return yield* new PatchNotOpenable({ patchId, table });
    const snapshot = yield* readInventory(companyId, patchId);
    if (snapshot === null || !snapshot.tables.some((entry) => entry.name === table && entry.shared))
      return yield* new PatchNotOpenable({ patchId, table });
    const definitions = Tables.inventoryManifest(snapshot).tables;
    const tables: Record<string, typeof TableDefinition.Type> = Object.create(null);
    const pending = [table];
    while (pending.length > 0) {
      const name = pending.pop()!;
      if (Object.hasOwn(tables, name)) continue;
      const definition = definitions[name]!;
      tables[name] = definition;
      for (const column of Object.values(definition.columns)) {
        if (column.kind !== "ref") continue;
        if (Object.hasOwn(definitions, column.table)) pending.push(column.table);
      }
    }
    const uses = Tables.inventoryReferences(tables);
    return {
      id: sharedTableId(patchId, table),
      patchId,
      table,
      schemaRevision: snapshot.schemaRevision,
      definition: tables[table]!,
      tables,
      uses
    } satisfies SharedTable;
  });

  const resolveDeclarations = Effect.fn("Patches.resolveDeclarations")(function* (
    manifest: typeof Manifest.Type,
    companyId: string
  ) {
    const warnings: string[] = [];
    // Lock connections in stable order when called inside the publish transaction.
    const declarations = Object.values(manifest.uses).sort((a, b) => a.id.localeCompare(b.id));
    for (const declaration of declarations) {
      if (declaration.kind === "postgres") {
        yield* connections.resolve(companyId, declaration);
        continue;
      }
      if (declaration.kind !== "sharedTable") continue;
      if (declaration.id !== sharedTableId(declaration.patchId, declaration.table))
        return yield* new PatchNotOpenable({
          patchId: declaration.patchId,
          table: declaration.table
        });
      const source = yield* sharedTable(declaration.patchId, declaration.table, companyId);
      if (declaration.revision < source.schemaRevision)
        warnings.push(
          `Shared table \`${source.id}\`: declared schema revision ${declaration.revision} is behind source schema revision ${source.schemaRevision}.`
        );
    }
    return warnings;
  });

  const declaringPatchRows = SqlSchema.findAll({
    Request: Schema.Struct({
      patchId: Schema.String,
      companyId: Schema.String
    }),
    Result: DeclaringPatches,
    execute: ({ patchId, companyId }) => sql`
      SELECT declaration.value->>'table' AS "table", count(DISTINCT patches.id)::int AS count
      FROM patches
      JOIN patch_versions ON patch_versions.patch_id = patches.id
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
      WHERE patches.company_id = ${companyId}
        AND ${serving}
        AND declaration.value->>'kind' = 'sharedTable'
        AND declaration.value->>'patchId' = ${patchId}
        AND declaration.value->>'id' = ${patchId} || '/' || (declaration.value->>'table')
      GROUP BY declaration.value->>'table'`
  });

  const dependantRows = SqlSchema.findAll({
    Request: Schema.Struct({
      patchId: Schema.String,
      companyId: Schema.String,
      tables: Schema.NullOr(Schema.Array(Schema.String))
    }),
    Result: Dependant,
    execute: ({ patchId, companyId, tables: affected }) => sql`
      SELECT DISTINCT patches.id AS "patchId", patches.name,
        jsonb_build_object('id', owner.id, 'name', owner.name) AS owner
      FROM patches JOIN users owner ON owner.id = patches.owner_user_id
      JOIN patch_versions ON patch_versions.patch_id = patches.id
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
      WHERE patches.company_id = ${companyId} AND ${serving}
        AND declaration.value->>'kind' = 'sharedTable'
        AND declaration.value->>'patchId' = ${patchId}
        AND declaration.value->>'id' = ${patchId} || '/' || (declaration.value->>'table')
        AND ${affected === null ? sql`true` : sql`declaration.value->>'table' IN ${sql.in(affected)}`}
      ORDER BY patches.name, patches.id`
  });
  const refuseDependants = Effect.fn("Patches.refuseDependants")(function* (
    patchId: string,
    companyId: string,
    force: boolean | undefined,
    affected: readonly string[] | null = null
  ) {
    if (force || affected?.length === 0) return;
    const dependants = yield* dependantRows({ patchId, companyId, tables: affected });
    if (dependants.length > 0) return yield* new HasDependants({ dependants });
  }, Effect.catchTags(dieOnSchemaError));
  const offSources = SqlSchema.findAll({
    Request: Schema.Struct({ patchId: Schema.String, companyId: Schema.String }),
    Result: Schema.Struct({ ...OffSource.fields, name: Schema.NullOr(Schema.String) }),
    execute: ({ patchId, companyId }) => sql`
      SELECT DISTINCT declaration.value->>'patchId' AS "patchId", source.name,
        declaration.value->>'table' AS "table",
        CASE WHEN source.id IS NULL THEN 'gone'
          WHEN source.deleted_at IS NOT NULL THEN 'deleted'
          WHEN source.retired_at IS NOT NULL THEN 'retired'
          ELSE 'live' END AS state
      FROM patches
      JOIN patch_versions ON patch_versions.id = patches.current_version_id AND patch_versions.patch_id = patches.id
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
      LEFT JOIN patches source ON source.id = declaration.value->>'patchId'
        AND source.company_id = ${companyId} AND source.disabled_at IS NULL
      WHERE patches.id = ${patchId} AND declaration.value->>'kind' = 'sharedTable'
        AND (source.id IS NULL OR source.deleted_at IS NOT NULL OR source.retired_at IS NOT NULL)
      ORDER BY "patchId", "table"`
  });

  const addressNotice = Effect.fn("Patches.addressNotice")(function* (
    patchId: string,
    access: ReadAccess
  ) {
    const row = yield* companyPatchRow({ patchId, companyId: access.companyId });
    if (Option.isNone(row)) return Option.none();
    const patch = toPatch(row.value);
    if (patch.state === "live" || !access.canOpen(patch)) return Option.none();
    const metadata = yield* portalMetadataRow({ patchId, companyId: access.companyId });
    if (Option.isNone(metadata)) return Option.none();
    const sources = yield* offSources({ patchId, companyId: access.companyId });
    return Option.some({
      patch,
      actorName: patch.state === "retired" ? metadata.value.retired : metadata.value.deleted,
      sourcesOff: sources.length > 0
    });
  }, Effect.catchTags(dieOnSchemaError));

  const portalCard = Effect.fn("Patches.portalCard")(
    function* (patchId: string, access: ReadAccess) {
      const [card] = yield* read({ ...access, state: "all", patchRef: patchId });
      if (card === undefined) return yield* new PatchUnavailable({ patchId });
      const metadata = yield* portalMetadataRow({ companyId: access.companyId, patchId });
      if (Option.isNone(metadata)) return yield* new PatchUnavailable({ patchId });
      const versions = yield* portalVersionRows(patchId);
      const sources = yield* offSources({ patchId, companyId: access.companyId });
      const { lastChangedAction, ...actorNames } = metadata.value;
      return {
        ...card,
        versions: versions.map((version) => ({ ...version, createdAt: iso(version.createdAt) })),
        offSources: sources.map(({ patchId: sourceId, table, state }) => {
          const name = card.reads.find((read) => read.patchId === sourceId)?.name;
          const source = { patchId: sourceId, table, state };
          return name === undefined ? source : { ...source, name };
        }),
        actorNames,
        lastChangedAction
      } satisfies PortalCard;
    },
    Effect.catchTags({ ...dieOnSchemaError, WrongState: Effect.die })
  );

  const preflight = Effect.fn("Patches.preflight")(function* (input: PublishPreflight) {
    yield* authorizePublish(input);
    const description = input.description ?? input.manifest.description;
    if (description !== undefined) yield* normalizeDescription(description);
    if (input.manifest.name !== undefined && reservedName(input.manifest.name))
      return yield* new ReservedName({ name: input.manifest.name });
    if (input.manifest.name !== undefined) {
      const occupied = yield* sql`
        SELECT 1 FROM patch_names WHERE company_id = ${input.companyId}
          AND name = ${input.manifest.name} AND NOT ${nameAvailable(input.patchId)}`;
      if (occupied.length > 0) return yield* new NameTaken({ name: input.manifest.name });
    }
    yield* resolveDeclarations(input.manifest, input.companyId);
    if (hasOwnedDefinitions(input.manifest)) {
      yield* databases.ensureReady(input.companyId);
    }
    const { companyId, snapshot } =
      input.intent === "create"
        ? { companyId: input.companyId, snapshot: null }
        : yield* sql.withTransaction(
            Effect.gen(function* () {
              const locked = yield* publishable(input);
              return {
                companyId: locked.companyId,
                snapshot: yield* readInventory(locked.companyId, input.patchId)
              };
            })
          );
    if (snapshot !== null && isFileMode(input)) {
      return yield* new HasPrimitives({ patchId: input.patchId });
    }
    const plan = yield* tables.diff(input.manifest, snapshot);
    yield* refuseDependants(
      input.patchId,
      companyId,
      input.force,
      plan.sharing.filter((table) => input.manifest.tables[table]!.shared !== true)
    );
    if (snapshot !== null) {
      yield* databases.withCompany(companyId)(
        tables.validate(input.patchId, input.manifest, snapshot)
      );
    }
  });

  const inventory = Effect.fn("Patches.inventory")((patchId: string, actorUserId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const locked = yield* lockOpenable({ patchId, userId: actorUserId });
        if (Option.isNone(locked)) return yield* new PatchUnavailable({ patchId });
        const snapshot = yield* readInventory(locked.value.companyId, patchId);
        return new PatchInventory(
          snapshot === null
            ? { schemaRevision: 0, tables: {}, files: {} }
            : { schemaRevision: snapshot.schemaRevision, ...Tables.inventoryManifest(snapshot) }
        );
      }).pipe(Effect.catchTags(dieOnSchemaError))
    )
  );

  const provision = Effect.fn("Patches.provision")(function* (input: RecordInput) {
    const hasDefinitions = hasOwnedDefinitions(input.manifest);
    if (input.intent === "create" && !hasDefinitions) {
      return yield* tables.diff(input.manifest, null);
    }
    return yield* databases
      .withCompany(input.companyId)(
        Effect.gen(function* () {
          if (!hasDefinitions && !(yield* inventoryStore.exists(input.patchId))) {
            return yield* tables.diff(input.manifest, null);
          }
          return yield* databases.withPatchLock(input.patchId)(
            Effect.gen(function* () {
              if (isFileMode(input)) return yield* new HasPrimitives({ patchId: input.patchId });
              const snapshot = yield* inventoryStore.read(input.patchId);
              const plan = yield* tables.diff(input.manifest, snapshot);
              yield* refuseDependants(
                input.patchId,
                input.companyId,
                input.force,
                plan.sharing.filter((table) => input.manifest.tables[table]!.shared !== true)
              );
              return yield* tables.provision(input.patchId, input.manifest);
            })
          );
        })
      )
      .pipe(
        Effect.catchTags({
          CompanyDatabaseNotReady: (error) =>
            !hasDefinitions && error.status === null
              ? tables.diff(input.manifest, null)
              : Effect.fail(error)
        })
      );
  });

  const prepareObject = Effect.fn("Patches.prepareObject")(function* (objectKey: string) {
    const expiresAt = stamp(
      (yield* Clock.currentTimeMillis) + Duration.toMillis(PENDING_OBJECT_LEASE)
    );
    yield* sql`
      INSERT INTO pending_patch_objects (object_key, expires_at)
      VALUES (${objectKey}, ${expiresAt})`;
  });

  const claimObjectRows = SqlSchema.findAll({
    Request: Schema.Struct({ nowMillis: Schema.Number, limit: Schema.Number }),
    Result: ObjectKey,
    execute: ({ nowMillis, limit }) => sql`
      WITH candidates AS (
        SELECT object_key FROM pending_patch_objects
        WHERE expires_at <= ${stamp(nowMillis)}
          AND NOT EXISTS (
            SELECT 1 FROM patch_versions
            WHERE patch_versions.object_key = pending_patch_objects.object_key
              OR patch_versions.server_object_key = pending_patch_objects.object_key
          )
        ORDER BY expires_at, object_key
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE pending_patch_objects SET claimed = true
      FROM candidates
      WHERE pending_patch_objects.object_key = candidates.object_key
      RETURNING pending_patch_objects.object_key AS "objectKey"`
  });
  const claimObjects = Effect.fn("Patches.claimObjects")(function* (limit: number) {
    if (limit <= 0) return [];
    const rows = yield* claimObjectRows({ nowMillis: yield* Clock.currentTimeMillis, limit });
    return rows.map((row) => row.objectKey);
  }, Effect.catchTags(dieOnSchemaError));

  const completeObject = Effect.fn("Patches.completeObject")(function* (objectKey: string) {
    yield* sql`DELETE FROM pending_patch_objects WHERE object_key = ${objectKey} AND claimed`;
  });

  const record = Effect.fn("Patches.record")((input: RecordInput) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL statement_timeout = '60s'`;
          yield* lockDependencies(input.ownerUserId);
          const millis = yield* Clock.currentTimeMillis;
          const existing = input.intent === "update" ? yield* publishable(input) : null;
          const incomingDescription = input.description ?? input.manifest.description;
          const normalizedDescription =
            incomingDescription === undefined
              ? undefined
              : yield* normalizeDescription(incomingDescription);
          const description = normalizedDescription ?? existing?.description ?? "";
          const descriptionChanged = description !== (existing?.description ?? "");
          const descriptionUpdatedAt = descriptionChanged
            ? DateTime.formatIso(DateTime.makeUnsafe(millis))
            : isoOrNull(existing?.descriptionUpdatedAt ?? null);
          const descriptionUpdatedBy = descriptionChanged
            ? input.ownerUserId
            : (existing?.descriptionUpdatedBy ?? null);
          // DELETE holds the intent's row lock until commit. A concurrent sweep
          // skips it; rollback restores it; a lost commit reply cannot orphan
          // live bytes because the version and intent change atomically.
          const pending = yield* sql`
            DELETE FROM pending_patch_objects
            WHERE object_key = ${input.objectKey} AND NOT claimed
              AND expires_at > ${stamp(millis)}
            RETURNING object_key`;
          if (pending.length === 0)
            return yield* new PendingObjectExpired({ objectKey: input.objectKey });
          // PROTOTYPE for #314: the server object's intent is consumed in the same transaction.
          if (input.serverObjectKey !== undefined) {
            const pendingServer = yield* sql`
              DELETE FROM pending_patch_objects
              WHERE object_key = ${input.serverObjectKey} AND NOT claimed
                AND expires_at > ${stamp(millis)}
              RETURNING object_key`;
            if (pendingServer.length === 0)
              return yield* new PendingObjectExpired({ objectKey: input.serverObjectKey });
          }
          let versionNumber: number;
          let scope: Patch["scope"] = input.scope ?? "company";
          let companyId = input.companyId;
          let companyHandle: string;
          let name: string;
          let rename = false;

          if (input.intent === "update") {
            // The row lock serialises concurrent updates of one patch: the
            // version number is allocated after it, so each waits its turn and
            // then sees the committed version before it.
            const locked = existing!;
            scope = input.scope ?? locked.scope;
            companyId = locked.companyId;
            companyHandle = locked.companyHandle;
            name = input.manifest.name ?? locked.name;
            rename = name !== locked.name;
            versionNumber = (yield* nextVersionNumber(input.patchId)).nextVersion;
          } else {
            // Serialise quota accounting across distinct creates by the same owner.
            const owner = yield* sql`SELECT id FROM users
              WHERE id = ${input.ownerUserId} AND company_id = ${companyId} AND deactivated_at IS NULL
              FOR UPDATE`;
            if (owner.length === 0) return yield* new PatchUnavailable({ patchId: input.patchId });
            if (
              input.livePatchQuota !== undefined &&
              (yield* countQuotaPatches(input.ownerUserId)) >= input.livePatchQuota
            ) {
              return yield* new PatchQuotaReached({ quota: input.livePatchQuota });
            }
            versionNumber = FIRST_VERSION_NUMBER;
            companyHandle = (yield* companyHandleRow(companyId)).handle;
            name =
              input.manifest.name ??
              deriveName(
                input.filename === null ? input.title : input.filename.replace(/\.[^.]*$/, "")
              );
            if (reservedName(name)) return yield* new ReservedName({ name });
            const created = yield* sql`
            INSERT INTO patches (id, company_id, owner_user_id, scope, title, name, current_version_id, repo_org, repo_name, created_at, updated_at)
            VALUES (${input.patchId}, ${companyId}, ${input.ownerUserId}, ${scope},
                    ${input.title}, ${name}, ${input.versionId}, ${input.repoOrg}, ${input.repoName}, ${stamp(millis)}, ${stamp(millis)})
            ON CONFLICT (id) DO NOTHING
            RETURNING id`;
            if (created.length === 0) return yield* new PatchConflict({ patchId: input.patchId });
          }
          if (input.intent === "create" || rename) {
            if (reservedName(name)) return yield* new ReservedName({ name });
            const baseName = name;
            let ordinal = 1;
            while (Option.isNone(yield* claimName({ companyId, patchId: input.patchId, name }))) {
              if (input.manifest.name !== undefined) return yield* new NameTaken({ name });
              name = deriveName(baseName, ++ordinal);
            }
          }
          if (rename) {
            // Claim before retiring: opposing renames must refuse occupied names,
            // not each hold their source name while waiting for the other's.
            yield* sql`UPDATE patch_names SET current = false
              WHERE patch_id = ${input.patchId} AND current AND name <> ${name}`;
          }
          const declarationWarnings = yield* resolveDeclarations(input.manifest, companyId);
          const resources = yield* provision({ ...input, companyId });
          const declaringPatches = resources.sharing.some(
            (table) => input.manifest.tables[table]!.shared !== true
          )
            ? new Map(
                (yield* declaringPatchRows({
                  patchId: input.patchId,
                  companyId
                })).map((row) => [row.table, row.count])
              )
            : new Map<string, number>();
          const sharingWarnings = resources.sharing.map((table) =>
            input.manifest.tables[table]!.shared === true
              ? `\`${table}\` is now shared.`
              : `\`${table}\` is no longer shared; ${declaringPatches.get(table) ?? 0} declaring patches are affected.`
          );
          const publicUrl = address(input.publicBaseUrl, companyHandle, name);
          const response = new (input.intent === "create" ? PublishCreated : PublishUpdated)({
            ok: true,
            patchId: input.patchId,
            versionId: input.versionId,
            versionNumber,
            title: input.title,
            scope,
            name,
            description,
            descriptionUpdatedAt,
            address: publicUrl,
            publicUrl,
            tier: input.manifest.tier,
            schemaRevision: resources.schemaRevision,
            provisioned: resources.provisioned,
            unused: resources.unused,
            warnings: [
              ...input.warnings,
              ...declarationWarnings,
              ...resources.warnings,
              ...sharingWarnings
            ]
          });
          const status = input.intent === "create" ? (201 as const) : (200 as const);
          const responseJson =
            input.intent === "create"
              ? encodePublishCreated(response)
              : encodePublishUpdated(response);

          const [inserted] = yield* sql`
          INSERT INTO patch_versions (
            id, patch_id, version_number, object_key, content_hash, file_size,
            created_by_machine_token_id, source_ip, user_agent, cli_version,
            git_branch, git_commit_sha, original_filename,
            owner_user_id, tier, release, manifest_version, wire_version, schema_revision,
            manifest, publish_key, payload_digest, publish_response, publish_status, created_at,
            server_object_key, server_hash
          ) VALUES (
            ${input.versionId}, ${input.patchId}, ${versionNumber}, ${input.objectKey},
            ${input.contentHash}, ${input.fileSize}, ${input.machineTokenId}, ${input.sourceIp},
            ${input.userAgent}, ${input.cliVersion}, ${input.gitBranch}, ${input.gitCommitSha},
            ${input.filename}, ${input.ownerUserId}, ${input.manifest.tier}, ${input.manifest.release},
            ${input.manifest.manifestVersion}, ${input.wireVersion}, ${resources.schemaRevision},
            ${encodeManifest(input.manifest)}::jsonb, ${input.publishKey}, ${input.payloadDigest},
            ${responseJson}::jsonb, ${status}, ${stamp(millis)},
            ${input.serverObjectKey ?? null}, ${input.serverHash ?? null}
          ) ON CONFLICT (owner_user_id, publish_key) DO NOTHING
          RETURNING publish_response::text AS "responseBody"`.pipe(
            Effect.flatMap(decodeResponseBodies)
          );
          if (inserted === undefined)
            return yield* new PublishKeyTaken({
              ownerUserId: input.ownerUserId,
              publishKey: { length: input.publishKey.length }
            });
          yield* sql`
          UPDATE patches
          SET current_version_id = ${input.versionId}, title = ${input.title}, scope = ${scope},
              name = ${name},
              repo_org = COALESCE(${input.repoOrg}, repo_org),
              repo_name = COALESCE(${input.repoName}, repo_name),
              description = ${description},
              description_updated_at = ${descriptionUpdatedAt}::timestamptz,
              description_updated_by = ${descriptionUpdatedBy},
              updated_at = ${stamp(millis)}, last_changed_at = ${stamp(millis)},
              last_changed_by = ${input.ownerUserId},
              last_changed_action = ${`published v${versionNumber}`}
          WHERE id = ${input.patchId}`;

          return { ...response, status, responseBody: inserted.responseBody } satisfies Recorded;
        }).pipe(Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die }))
      )
      .pipe(Effect.timeout("60 seconds"), Effect.catchTags({ TimeoutError: Effect.die }))
  );

  const changedPatch = SqlSchema.findOne({
    Request: Schema.String,
    Result: PatchRow,
    execute: (patchId) => sql`SELECT ${sql.unsafe(PATCH_COLUMNS)}
      FROM patches JOIN companies ON companies.id = patches.company_id
      WHERE patches.id = ${patchId}`
  });
  const afterChange = Effect.fn("Patches.afterChange")((patchId: string) =>
    changedPatch(patchId).pipe(
      Effect.map(toPatch),
      Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
    )
  );
  const setScope = Effect.fn("Patches.setScope")(function* (
    patchId: string,
    actor: Actor,
    scope: Patch["scope"],
    expectedScope?: Patch["scope"]
  ) {
    const row = yield* manageable(patchId, actor);
    if (stateOf(row) !== "live") return yield* new WrongState({ state: stateOf(row) });
    if (expectedScope !== undefined && row.scope !== expectedScope)
      return yield* new StaleAction({ patchId });
    const at = yield* now;
    yield* sql`UPDATE patches SET scope = ${scope}, updated_at = ${at},
        last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'sharing changed' WHERE id = ${patchId}`;
    return { scope, name: row.name, companyHandle: row.companyHandle };
  }, sql.withTransaction);

  const retire = Effect.fn("Patches.retire")(function* (
    patchId: string,
    actor: Actor,
    force?: boolean,
    expectedOwnerUserId?: string
  ) {
    yield* lockDependencies(actor.userId);
    const row = yield* manageable(patchId, actor);
    if (expectedOwnerUserId !== undefined && row.ownerUserId !== expectedOwnerUserId)
      return yield* new StaleAction({ patchId });
    if (stateOf(row) !== "live") return yield* new WrongState({ state: stateOf(row) });
    yield* refuseDependants(patchId, row.companyId, force);
    const at = yield* now;
    yield* sql`UPDATE patches SET retired_at = ${at}, retired_by = ${actor.userId},
        updated_at = ${at}, last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'retired'
        WHERE id = ${patchId}`;
    return yield* afterChange(patchId);
  }, sql.withTransaction);
  const delete_ = Effect.fn("Patches.delete")(function* (
    patchId: string,
    actor: Actor,
    force?: boolean
  ) {
    yield* lockDependencies(actor.userId);
    const row = yield* manageable(patchId, actor);
    const state = stateOf(row);
    if (state === "deleted") return yield* new WrongState({ state });
    if (state === "live") yield* refuseDependants(patchId, row.companyId, force);
    const at = yield* now;
    yield* sql`UPDATE patches SET deleted_at = ${at}, deleted_by = ${actor.userId},
        updated_at = ${at}, last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'deleted'
        WHERE id = ${patchId}`;
    return yield* afterChange(patchId);
  }, sql.withTransaction);
  const restore = Effect.fn("Patches.restore")(function* (
    patchId: string,
    actor: Actor,
    force?: boolean,
    expectedState?: PatchState,
    expectedOwnerUserId?: string
  ) {
    yield* lockDependencies(actor.userId);
    const row = yield* manageable(patchId, actor);
    if (expectedOwnerUserId !== undefined && row.ownerUserId !== expectedOwnerUserId)
      return yield* new StaleAction({ patchId });
    if (stateOf(row) === "live") return yield* new WrongState({ state: "live" });
    const millis = yield* Clock.currentTimeMillis;
    const purgeMillis =
      row.deletedAt === null ? null : row.deletedAt.getTime() + Duration.toMillis(RECOVERY_WINDOW);
    if (purgeMillis !== null && millis >= purgeMillis)
      return yield* new PatchDeleted({
        purgeAt: DateTime.formatIso(DateTime.makeUnsafe(purgeMillis))
      });
    if (expectedState !== undefined && stateOf(row) !== expectedState)
      return yield* new StaleAction({ patchId });
    if (!force) {
      const rows = yield* offSources({ patchId, companyId: row.companyId }).pipe(
        Effect.catchTags(dieOnSchemaError)
      );
      if (rows.length > 0)
        return yield* new SourcesOff({
          sources: rows.map(({ name, ...source }) => (name === null ? source : { ...source, name }))
        });
    }
    const at = stamp(millis);
    yield* sql`UPDATE patches SET retired_at = NULL, retired_by = NULL,
        deleted_at = NULL, deleted_by = NULL, updated_at = ${at},
        last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'restored' WHERE id = ${patchId}`;
    return yield* afterChange(patchId);
  }, sql.withTransaction);
  const rollback = Effect.fn("Patches.rollback")(function* (
    patchId: string,
    actor: Actor,
    versionNumber: number,
    expectedCurrentVersionId?: string | null
  ) {
    const row = yield* manageable(patchId, actor);
    if (stateOf(row) !== "live") return yield* new WrongState({ state: stateOf(row) });
    if (expectedCurrentVersionId !== undefined && row.currentVersionId !== expectedCurrentVersionId)
      return yield* new StaleAction({ patchId });
    const version = yield* findVersionByNumber({ patchId, versionNumber }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
    if (Option.isNone(version)) return yield* new VersionUnavailable({ versionNumber });
    const at = yield* now;
    yield* sql`UPDATE patches SET current_version_id = ${version.value.id}, updated_at = ${at},
        last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = ${`rolled back to v${versionNumber}`} WHERE id = ${patchId}`;
    return { patch: yield* afterChange(patchId), currentVersion: versionNumber };
  }, sql.withTransaction);
  const reassign = Effect.fn("Patches.reassign")(function* (
    patchId: string,
    actor: Actor,
    newOwnerUserId: string,
    expectedOwnerUserId?: string
  ) {
    const row = yield* manageable(patchId, actor);
    if (!actor.admin) return yield* new AdminRequired({ userId: actor.userId });
    if (expectedOwnerUserId !== undefined && row.ownerUserId !== expectedOwnerUserId)
      return yield* new StaleAction({ patchId });
    const target = yield* sql`SELECT id FROM users
        WHERE id = ${newOwnerUserId} AND company_id = ${row.companyId} AND deactivated_at IS NULL
        FOR SHARE`;
    if (target.length === 0) return yield* new InvalidOwner({ userId: newOwnerUserId });
    if (row.ownerUserId === newOwnerUserId) return toPatch(row);
    const at = yield* now;
    yield* sql`UPDATE patches SET owner_user_id = ${newOwnerUserId},
        reassigned_at = ${at}, reassigned_by = ${actor.userId}, updated_at = ${at},
        last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'reassigned' WHERE id = ${patchId}`;
    return yield* afterChange(patchId);
  }, sql.withTransaction);
  const setDescription = Effect.fn("Patches.setDescription")(function* (
    patchId: string,
    actor: Actor,
    description: string,
    expectedDescriptionUpdatedAt?: string | null
  ) {
    const row = yield* manageable(patchId, actor);
    if (stateOf(row) === "deleted") return yield* new WrongState({ state: "deleted" });
    if (
      expectedDescriptionUpdatedAt !== undefined &&
      isoOrNull(row.descriptionUpdatedAt) !== expectedDescriptionUpdatedAt
    )
      return yield* new StaleAction({ patchId });
    const normalized = yield* normalizeDescription(description);
    if (row.description === normalized) return toPatch(row);
    const at = yield* now;
    yield* sql`UPDATE patches SET description = ${normalized},
        description_updated_at = ${at}, description_updated_by = ${actor.userId},
        updated_at = ${at}, last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'description changed'
        WHERE id = ${patchId}`;
    return yield* afterChange(patchId);
  }, sql.withTransaction);

  const resolveName = Effect.fn("Patches.resolveName")(function* (
    companyHandle: string,
    name: string
  ) {
    return yield* resolveNameRow({
      companyHandle,
      name
    });
  }, Effect.catchTags(dieOnSchemaError));

  const recordVisit = Effect.fn("Patches.recordVisit")(function* (patchId: string) {
    yield* sql`UPDATE patches SET visit_count = visit_count + 1
      WHERE patches.id = ${patchId} AND ${serving}`;
  });

  const listDeleted = Effect.fn("Patches.listDeleted")(function* (limit: number) {
    if (limit <= 0) return [];
    const rows = yield* listDeletedRows({ nowMillis: yield* Clock.currentTimeMillis, limit });
    return rows.map((row) => row.id);
  }, Effect.catchTags(dieOnSchemaError));

  const purgeTarget = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ companyId: Schema.String, deletedAt: NullableStamp }),
    execute: (patchId) => sql`SELECT company_id AS "companyId", deleted_at AS "deletedAt"
      FROM patches WHERE id = ${patchId} FOR UPDATE`
  });
  const purgeDeleted = Effect.fn("Patches.purgeDeleted")(
    function* (patchId: string) {
      const target = yield* purgeTarget(patchId);
      if (Option.isNone(target) || target.value.deletedAt === null) return Option.none();
      const millis = yield* Clock.currentTimeMillis;
      if (target.value.deletedAt.getTime() + Duration.toMillis(RECOVERY_WINDOW) > millis)
        return Option.none();
      const companyId = target.value.companyId;
      const removeRows = Effect.gen(function* () {
        const keys = yield* objectKeysOf(patchId);
        yield* sql`INSERT INTO pending_patch_objects (object_key, expires_at, claimed)
          SELECT object_key, ${stamp(millis)}, true FROM patch_versions WHERE patch_id = ${patchId}`;
        yield* sql`DELETE FROM patch_versions WHERE patch_id = ${patchId}`;
        yield* sql`DELETE FROM patch_names WHERE patch_id = ${patchId}`;
        yield* sql`DELETE FROM patches WHERE id = ${patchId}`;
        return Option.some({ companyId, objectKeys: keys.map((row) => row.objectKey) });
      });
      // No platform row disappears while a publisher holds its company inventory.
      // An absent placement means this patch never provisioned a namespace.
      return yield* databases
        .withCompany(companyId)(
          Effect.gen(function* () {
            if (!(yield* inventoryStore.exists(patchId))) return yield* removeRows;
            return yield* databases.withPatchLock(patchId)(removeRows);
          })
        )
        .pipe(
          Effect.catchTags({
            CompanyDatabaseNotReady: (error) =>
              error.status === null ? removeRows : Effect.fail(error)
          })
        );
    },
    sql.withTransaction,
    Effect.catchTags(dieOnSchemaError)
  );

  return Patches.of({
    countQuotaPatches,
    authorizePublish,
    replay,
    preflight,
    inventory,
    read,
    portalCard,
    addressNotice,
    withDependencyLock,
    companyInventory,
    sharedTable,
    prepareObject,
    claimObjects,
    completeObject,
    record,
    setScope,
    resolveName,
    find,
    findRetained,
    recordVisit,
    retire,
    restore,
    rollback,
    reassign,
    setDescription,
    listDeleted,
    purgeDeleted,
    delete: delete_
  });
});

/** Over the Postgres client. */
export const layer = Layer.effect(Patches, make);
