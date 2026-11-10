/**
 * Patches and their versions: every row the capability keeps, read and
 * written here and nowhere else. Rows are decoded through `SqlSchema` in this
 * module only, so a client type change lands in one place.
 *
 * Lifecycle changes and the deletion window use the Effect clock. Retired and
 * deleted rows retain their versions and company inventory until reclamation.
 * Each lifecycle change reports its business event here, after the outermost
 * transaction commits, so every caller reports it once and a rollback never.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";
import { Analytics } from "@patchy/analytics";
import * as WideEvents from "@patchy/analytics/wide-events";
import {
  type AgentToolSummary,
  agentToolSummaries,
  DescriptionText,
  FileStoreDefinition,
  HandlerKind,
  Manifest,
  PatchInventory,
  PatchName,
  PatchAudience,
  PatchState as PatchStateSchema,
  PatchSourceState,
  PublishCreated,
  PublishUpdated,
  SDK_ENTRY_POINTS,
  SharingScope,
  type SharedTableDeclaration,
  TableDefinition,
  sharedTableId,
  sharedStoreId
} from "@patchy/api";
import { Teams } from "@patchy/companies";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import * as Audiences from "./Audiences.js";
import { Tables } from "@patchy/primitives";
import { Wakes } from "@patchy/runtime/core";
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
/** How long an open takes to count half as much toward a member's usual patches. */
export const OPEN_HALF_LIFE = Duration.days(7);
/** An open this close to the member's last open of the patch adds nothing to its score. */
export const REOPEN_WINDOW = Duration.minutes(10);

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

/** A request event's patch fields: the patch and, once it has one, its current version. */
export const eventFields = (patch: Pick<Patch, "id" | "currentVersionId">) => ({
  patchId: patch.id,
  ...(patch.currentVersionId === null ? {} : { versionId: patch.currentVersionId })
});

/** Unknown, disabled or outside the actor's company. */
export class PatchUnavailable extends Schema.TaggedError<PatchUnavailable>()("PatchUnavailable", {
  patchId: Schema.String
}) {
  override get message() {
    return "Patch not found.";
  }
}

export class OwnerAccessLost extends Schema.TaggedError<OwnerAccessLost>()("OwnerAccessLost", {
  patchId: Schema.String
}) {
  override get message() {
    return "You still own this patch but no longer have access. Ask an admin who can open it to restore your team access or reassign it. Do not create a replacement patch.";
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

/**
 * A publish from a copy older than the patch's newest version: it was pulled from or last
 * published as `baseVersion`, and someone has published since.
 */
export class Behind extends Schema.TaggedError<Behind>()("Behind", {
  patchId: Schema.String,
  baseVersion: Schema.Int,
  latestVersion: Schema.Int,
  publishedBy: Schema.Struct({ id: Schema.String, name: Schema.String }),
  publishedAt: Schema.String
}) {
  override get message() {
    return `This copy is from v${this.baseVersion}, but ${this.publishedBy.name} published v${this.latestVersion} since, at ${this.publishedAt}.`;
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
export type SharingMetadata = Pick<
  Patch,
  "id" | "name" | "companyId" | "companyHandle" | "state" | "scope" | "currentVersionId"
>;
/** Oversight carries management facts only, never version bodies, manifests or resource data. */
export class ManagementRecord extends Schema.Class<ManagementRecord>("ManagementRecord")({
  id: Schema.String,
  name: Schema.String,
  companyHandle: Schema.String,
  ownerId: Schema.String,
  ownerName: Schema.String,
  ownerDeactivated: Schema.Boolean,
  scope: SharingScope,
  tier: Schema.Number,
  audience: PatchAudience,
  lifecycleRevision: Schema.String,
  retiredAt: Schema.NullOr(Schema.Date),
  deletedAt: Schema.NullOr(Schema.Date),
  currentVersionId: Schema.String
}) {}
export interface ManagementView {
  readonly card: ManagementCard;
  readonly versions: PortalCard["versions"];
  readonly record: ManagementRecord;
  readonly canOpen: boolean;
  readonly canManage: boolean;
  readonly ownerCanOpen: boolean;
}
/** The facts shared by management confirmations and content cards; no protected payload. */
export interface ManagementCard {
  readonly patch: Pick<
    Patch,
    | "id"
    | "name"
    | "title"
    | "companyHandle"
    | "ownerUserId"
    | "state"
    | "scope"
    | "audience"
    | "lifecycleRevision"
    | "currentVersionId"
  >;
  readonly owner: ReadPatch["owner"];
  readonly tier: number;
  readonly dependants: readonly {
    readonly patchId: string;
    readonly name: string;
    readonly owner: { readonly id: string; readonly name: string };
    readonly table?: string;
    readonly store?: string;
  }[];
  readonly hiddenDependants?: number;
  readonly offSources: PortalCard["offSources"];
}
const Owner = Schema.Struct({ id: Schema.String, name: Schema.String });
const Dependant = Schema.Struct({ patchId: Schema.String, name: Schema.String, owner: Owner });
const OffSource = Schema.Union([
  Schema.Struct({
    patchId: Schema.String,
    name: Schema.optionalKey(Schema.String),
    table: Schema.String,
    state: PatchSourceState
  }),
  Schema.Struct({
    patchId: Schema.String,
    name: Schema.optionalKey(Schema.String),
    store: Schema.String,
    state: PatchSourceState
  })
]);
type SharedResource =
  | { readonly table: string; readonly store?: never }
  | { readonly store: string; readonly table?: never };

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
  dependants: Schema.Array(Dependant),
  hiddenCount: Schema.optionalKey(Schema.Number)
}) {
  override get message() {
    return `Other live patches read these tables or stores.${this.hiddenCount ? ` ${this.hiddenCount} others are outside your access.` : ""} Ask the person you are working for before forcing.`;
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
export class Tier2NotPublic extends Schema.TaggedError<Tier2NotPublic>()("Tier2NotPublic", {}) {
  override get message() {
    return "Tier 2 versions cannot be served publicly. Keep the patch company-scoped.";
  }
}
export type LifecycleError =
  | OwnerAccessLost
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
  readonly audience: PatchAudience;
  readonly title: string;
  readonly currentVersionId: string | null;
  readonly repoOrg: string | null;
  readonly repoName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lifecycleRevision: string;
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

/** A compatibility scope change retains guests; a full audience derives its scope. */
export type SharingChange = {
  readonly expectedDependants?: string;
  readonly patchId: string;
  readonly actor: Actor;
  readonly force?: boolean | undefined;
  readonly expectedScope?: Patch["scope"] | undefined;
  readonly expectedLifecycleRevision?: string | undefined;
  readonly expectedOwnerUserId?: string | undefined;
} & (
  | { readonly scope: Patch["scope"]; readonly audience?: never }
  | { readonly audience: PatchAudience; readonly scope?: never }
);

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
  /** Served address and content requests while live, counted for everyone together. */
  readonly visits: number;
  readonly reads: readonly (SharedResource & {
    readonly alias: string;
    readonly patchId: string;
    readonly name?: string;
    readonly state: "live" | "retired" | "deleted" | "gone";
  })[];
  readonly dependants: readonly (SharedResource & {
    readonly patchId: string;
    readonly name: string;
    readonly owner: { readonly id: string; readonly name: string };
  })[];
}

/**
 * A patch as `read` answers it, without its shared-read edges (`reads` and `dependants`): what
 * `list` answers for callers that never show them, since those edges scan every version's
 * declarations of every patch in the company.
 */
export type ListedPatch = Omit<ReadPatch, "reads" | "dependants">;

/** One member's record of opening one patch, read only to build that member's own Home. */
export interface Open {
  readonly patchId: string;
  readonly lastOpenedAt: string;
  /**
   * Each open counts 1, halving each `OPEN_HALF_LIFE` since, as of the read; one within
   * `REOPEN_WINDOW` of the last adds nothing, so reopening every few minutes counts once.
   */
  readonly score: number;
}

export interface PortalCard extends ReadPatch {
  readonly versions: readonly {
    readonly id: string;
    readonly versionNumber: number;
    readonly createdAt: string;
    readonly publisherName: string;
  }[];
  readonly offSources: readonly (SharedResource & {
    readonly patchId: string;
    readonly name?: string;
    readonly state: "live" | "retired" | "deleted" | "gone";
  })[];
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

/** Where a version's repo snapshot is stored and what it holds. */
export interface RepoSnapshotRecord {
  readonly objectKey: string;
  /** The stored JSON's `sha256:` content hash. */
  readonly contentHash: string;
  /** Decoded file bytes, as `artifacts.repo.bytes` reports them. */
  readonly bytes: number;
  readonly files: number;
}

export interface PatchVersion {
  readonly id: string;
  readonly patchId: string;
  readonly versionNumber: number;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly fileSize: number;
  readonly server: {
    readonly objectKey: string;
    readonly sha256: string;
    readonly bytes: number;
  } | null;
  /** The repo snapshot it was published from: the stored JSON's digest, decoded bytes and files. */
  readonly repo: RepoSnapshotRecord | null;
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
  table: Schema.optionalKey(Schema.String),
  store: Schema.optionalKey(Schema.String)
}) {
  readonly code = "patch_not_openable" as const;
  override get message() {
    return `Shared ${this.store === undefined ? "table" : "store"} ${this.patchId}/${this.store ?? this.table} is not openable.`;
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

export interface SharedStore {
  readonly id: string;
  readonly patchId: string;
  readonly store: string;
  readonly schemaRevision: number;
  readonly definition: typeof FileStoreDefinition.Type;
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
  /** Refused as `Behind` before any upload when the patch already has a newer version. */
  readonly baseVersion?: number | undefined;
  readonly filename: string | null;
  readonly scope?: Patch["scope"] | undefined;
  readonly audience?: PatchAudience | undefined;
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
  /** Omitted creates default to Company; omitted updates retain the audience under lock. */
  readonly scope?: Patch["scope"] | undefined;
  readonly audience?: PatchAudience | undefined;
  readonly title: string;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly fileSize: number;
  readonly server?:
    | {
        readonly objectKey: string;
        readonly sha256: string;
        readonly bytes: number;
      }
    | undefined;
  readonly repo?: RepoSnapshotRecord | undefined;
  /** The version the publishing copy came from; a newer version refuses with `Behind`. */
  readonly baseVersion?: number | undefined;
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
  readonly livePatchQuota?: number;
  readonly force?: boolean;
  readonly description?: string;
}

export interface Recorded extends PublishUpdated {
  readonly status: 200 | 201;
  /** PostgreSQL's persisted JSONB representation, sent unchanged on the wire. */
  readonly responseBody: string;
}

/** A manifest's `sdkImports` is client supplied, so analytics keeps only the SDK's entry points. */
const sdkEntryPoints = new Set(Object.values(SDK_ENTRY_POINTS).flat());

/**
 * What `patch.created` and `patch.updated` say about a recorded version.
 * Only the owner publishes, so the publisher is the owner.
 */
const publication = (input: RecordInput, versionNumber: number, scope: Patch["scope"]) => {
  const handlers = Object.values(input.manifest.handlers ?? {});
  return {
    patchId: input.patchId,
    ownerUserId: input.ownerUserId,
    machineTokenId: input.machineTokenId,
    versionNumber,
    scope,
    tier: input.manifest.tier,
    htmlBytes: input.fileSize,
    serverBytes: input.server?.bytes ?? 0,
    repoFiles: input.repo?.files ?? 0,
    repoBytes: input.repo?.bytes ?? 0,
    sdkImports: (input.manifest.sdkImports ?? []).filter((source) => sdkEntryPoints.has(source)),
    tables: Object.keys(input.manifest.tables),
    stores: Object.keys(input.manifest.files),
    integrations: Object.entries(input.manifest.uses).map(([alias, use]) => `${use.kind}:${alias}`),
    queryHandlers: handlers.filter((handler) => handler.kind === "query").length,
    mutationHandlers: handlers.filter((handler) => handler.kind === "mutation").length,
    actionHandlers: handlers.filter((handler) => handler.kind === "action").length
  };
};

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
  audience: PatchAudience,
  title: Schema.String,
  currentVersionId: Schema.NullOr(Schema.String),
  repoOrg: Schema.NullOr(Schema.String),
  repoName: Schema.NullOr(Schema.String),
  createdAt: Stamp,
  updatedAt: Stamp,
  lifecycleRevision: Schema.String,
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
  serverObjectKey: Schema.NullOr(Schema.String),
  serverContentHash: Schema.NullOr(Schema.String),
  serverFileSize: Schema.NullOr(Schema.Int),
  repoObjectKey: Schema.NullOr(Schema.String),
  repoContentHash: Schema.NullOr(Schema.String),
  repoFileBytes: Schema.NullOr(Schema.Int),
  repoFileCount: Schema.NullOr(Schema.Int),
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
  createdAt: Stamp
}) {}

class Id extends Schema.Class<Id>("Id")({ id: Schema.String }) {}
class Count extends Schema.Class<Count>("Count")({ count: Schema.Int }) {}
class NextVersion extends Schema.Class<NextVersion>("NextVersion")({ nextVersion: Schema.Int }) {}
class NewestVersion extends Schema.Class<NewestVersion>("NewestVersion")({
  versionNumber: Schema.Int,
  publisherId: Schema.String,
  publisherName: Schema.String,
  createdAt: Stamp
}) {}
class ObjectKey extends Schema.Class<ObjectKey>("ObjectKey")({ objectKey: Schema.String }) {}
class DeclaringPatches extends Schema.Class<DeclaringPatches>("DeclaringPatches")({
  resource: Schema.String,
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
  visits: Schema.Int,
  reads: Schema.Array(
    Schema.Union([
      Schema.Struct({ alias: Schema.String, patchId: Schema.String, table: Schema.String }),
      Schema.Struct({ alias: Schema.String, patchId: Schema.String, store: Schema.String })
    ])
  )
}) {}
class OpenRow extends Schema.Class<OpenRow>("OpenRow")({
  patchId: Schema.String,
  lastOpenedAt: Stamp,
  score: Schema.Number
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
/** One version's agent tools as a catalogue reads them: the marks and words, never the schemas. */
class AgentToolMarksRow extends Schema.Class<AgentToolMarksRow>("AgentToolMarksRow")({
  versionId: Schema.String,
  handlers: Schema.Record(
    Schema.String,
    Schema.Struct({
      kind: HandlerKind,
      agentTool: Schema.Literal(true),
      readOnly: Schema.optionalKey(Schema.Literal(true)),
      description: Schema.optionalKey(Schema.String)
    })
  )
}) {}
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

/** What a lifecycle transaction reports once its outermost commit lands. */
interface PendingLifecycle {
  readonly wakes: Array<string>;
  readonly events: Array<Analytics.AnalyticsEvent>;
}
const pendingLifecycle = Context.Reference<PendingLifecycle | undefined>(
  "@patchy/patches/pendingLifecycle",
  { defaultValue: () => undefined }
);

export class Patches extends Context.Service<
  Patches,
  {
    /** Non-deleted, enabled patches owned by this user, including retired patches. */
    readonly countQuotaPatches: (ownerUserId: string) => Effect.Effect<number, SqlError>;
    readonly authorizePublish: (
      target: PublishTarget
    ) => Effect.Effect<
      void,
      | OwnerAccessLost
      | PatchUnavailable
      | PatchConflict
      | NotOwner
      | PatchRetired
      | PatchDeleted
      | SqlError
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
    ) => Effect.Effect<
      void,
      | Audiences.InvalidAudience
      | LifecycleError
      | Tier2NotPublic
      | PatchConflict
      | NameTaken
      | Behind
      | ResourceError
      | SqlError
    >;
    readonly inventory: (
      patchId: string,
      actorUserId: string
    ) => Effect.Effect<PatchInventory, PatchUnavailable | DatabaseError | SqlError>;
    readonly read: (
      options: ReadOptions
    ) => Effect.Effect<readonly ReadPatch[], PatchUnavailable | WrongState | SqlError>;
    /** The same patches as `read`, by the same rule, without their shared-read edges. */
    readonly list: (
      options: ReadOptions
    ) => Effect.Effect<readonly ListedPatch[], PatchUnavailable | WrongState | SqlError>;
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
    /**
     * Hold the company's dependency advisory lock in a transaction, without locking patch rows.
     * Lifecycle changes inside it wake and report only once it commits. Compose them directly:
     * a raw `sql.withTransaction` savepoint around one that rolls back and is caught keeps them.
     */
    readonly withDependencyLock: (
      actorUserId: string
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
    /**
     * Inside `withDependencyLock`, queues the caller's own event to report with the
     * lifecycle events once the lock's transaction commits; a rollback drops it.
     * Deactivation and reactivation report their user change this way.
     */
    readonly reportOnCommit: (event: Analytics.AnalyticsEvent) => Effect.Effect<void>;
    /** Company-readable inventory; unavailable company-database inventory is null, not empty. */
    readonly companyInventory: (
      patchId: string,
      access: ReadAccess
    ) => Effect.Effect<PatchInventory | null, PatchUnavailable | SqlError>;
    /** Read-only warning data; losing management access omits the warning. */
    readonly sharingDependants: (
      patchId: string,
      actor: Actor
    ) => Effect.Effect<
      { dependants: readonly (typeof Dependant.Type)[]; hiddenCount: number },
      PatchUnavailable | SqlError
    >;
    /** Protected schema metadata requires the initiating viewer. */
    readonly sharedTable: (
      patchId: string,
      table: string,
      companyId: string,
      viewerId: string
    ) => Effect.Effect<SharedTable, PatchNotOpenable | DatabaseError | SqlError>;
    readonly sharedStore: (
      patchId: string,
      store: string,
      companyId: string,
      viewerId: string
    ) => Effect.Effect<SharedStore, PatchNotOpenable | DatabaseError | SqlError>;
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
     * in one transaction, reporting `patch.created` or `patch.updated` with its commit,
     * and `patch.shared` when an update changes the scope.
     * Consumes the pending-object intent under a lock;
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
      | Audiences.InvalidAudience
      | LifecycleError
      | Tier2NotPublic
      | Behind
      | SqlError
    >;
    /**
     * The patch, when `actor` may manage it: its owner, or an admin of its company. Any state;
     * the row stays locked until the caller's transaction ends.
     */
    readonly management: (
      companyId: string,
      userId: string,
      patchRef?: { readonly id: string } | { readonly name: string }
    ) => Effect.Effect<readonly ManagementView[], SqlError>;
    readonly managementHistory: (
      patchId: string,
      userId: string
    ) => Effect.Effect<
      readonly (Teams.MembershipChange & { readonly teamName: string })[],
      PatchUnavailable | SqlError
    >;
    readonly eligibleOwners: (
      patchId: string,
      actor: Actor
    ) => Effect.Effect<
      readonly { readonly id: string; readonly name: string }[],
      OwnerAccessLost | PatchUnavailable | NotOwner | SqlError
    >;
    readonly manage: (
      patchId: string,
      actor: Actor,
      readOnly?: boolean
    ) => Effect.Effect<SharingMetadata, OwnerAccessLost | PatchUnavailable | NotOwner | SqlError>;
    /** Changes a live patch's audience without creating a version. */
    readonly setSharing: (
      input: SharingChange
    ) => Effect.Effect<
      Pick<Patch, "id" | "scope" | "name" | "companyHandle" | "currentVersionId" | "audience">,
      LifecycleError | Audiences.InvalidAudience | Tier2NotPublic | SqlError
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
     * The agent tools each of these versions marks, in `open_patch`'s order and without their
     * schemas: what a catalogue lists of many patches at once, without loading whole manifests.
     * A version with no tools, or none by that id, is absent.
     */
    readonly agentToolSummaries: (
      versionIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyMap<string, readonly AgentToolSummary[]>, SqlError>;
    /**
     * A patch in service and one of its versions — the current one, or the
     * numbered one asked for. Retired, deleted and disabled patches are absent.
     */
    readonly findForViewer: (
      patchId: string,
      viewer: { readonly companyId: string; readonly userId: string }
    ) => Effect.Effect<
      Option.Option<{ patch: Patch; version: PatchVersion; patchTier: number }>,
      SqlError
    >;
    readonly find: (
      patchId: string,
      versionNumber?: number,
      versionId?: string
    ) => Effect.Effect<
      Option.Option<{ patch: Patch; version: PatchVersion; patchTier: number }>,
      SqlError
    >;
    /** Address admission inspects retained metadata before choosing a notice, door or 404. */
    readonly findRetained: (
      patchId: string,
      versionNumber?: number,
      versionId?: string
    ) => Effect.Effect<Option.Option<{ patch: Patch; version: PatchVersion }>, SqlError>;
    /** Counts a visit to a serving patch without changing its lifecycle. */
    readonly recordVisit: (patchId: string) => Effect.Effect<void, SqlError>;
    /**
     * Records that a member opened `versionId` at a serving patch's address, while it is current;
     * one within `REOPEN_WINDOW` of their last open of it adds nothing to its score.
     * True only for the call that made the member's first record of the patch, which concurrent
     * opens never share; a stale version or an off patch records nothing and answers false.
     */
    readonly recordOpen: (
      userId: string,
      patchId: string,
      versionId: string
    ) => Effect.Effect<boolean, SqlError>;
    /**
     * What one member has opened, for that member's own Home. Nobody else reads these
     * rows: owners and admins see only the visit count.
     */
    readonly opens: (userId: string) => Effect.Effect<ReadonlyArray<Open>, SqlError>;
    /**
     * The earliest live patch whose current version was published with one of these machine
     * tokens, by its id: the Final step panel's first publication, attributed to the publisher's
     * key rather than to whoever owns the patch now.
     */
    readonly publishedWith: (
      machineTokenIds: ReadonlyArray<string>
    ) => Effect.Effect<Option.Option<string>, SqlError>;
    readonly retire: (
      patchId: string,
      actor: Actor,
      force?: boolean,
      expectedOwnerUserId?: string
    ) => Effect.Effect<Patch, LifecycleError | SqlError>;
    readonly delete: (
      patchId: string,
      actor: Actor,
      force?: boolean,
      expectedOwnerUserId?: string
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
      expectedCurrentVersionId?: string | null,
      expectedOwnerUserId?: string
    ) => Effect.Effect<
      { patch: Patch; currentVersion: number },
      LifecycleError | Tier2NotPublic | SqlError
    >;
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
      Option.Option<{ companyId: string; ownerUserId: string; versionCount: number }>,
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
  audience: row.audience,
  title: row.title,
  currentVersionId: row.currentVersionId,
  repoOrg: row.repoOrg,
  repoName: row.repoName,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  lifecycleRevision: row.lifecycleRevision,
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
  server:
    row.serverObjectKey === null
      ? null
      : {
          objectKey: row.serverObjectKey,
          sha256: row.serverContentHash!,
          bytes: row.serverFileSize!
        },
  repo:
    row.repoObjectKey === null
      ? null
      : {
          objectKey: row.repoObjectKey,
          contentHash: row.repoContentHash!,
          bytes: row.repoFileBytes!,
          files: row.repoFileCount!
        },
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
  createdAt: iso(row.createdAt)
});

/** A `SchemaError` on a row is a bug in the query or the schema, never a caller's fault. */
const dieOnSchemaError = { SchemaError: Effect.die } as const;

const decodeLockedAudience = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      companyId: Schema.String,
      audience: PatchAudience
    })
  )
);

const AUDIENCE_COLUMN = `jsonb_build_object('members', CASE WHEN patches.scope = 'teams' THEN jsonb_build_object('kind', 'teams', 'teamIds', COALESCE((SELECT jsonb_agg(t.team_id ORDER BY t.team_id) FROM patch_audience_teams t WHERE t.patch_id = patches.id), '[]'::jsonb)) ELSE jsonb_build_object('kind', patches.scope) END)`;

/** The columns of `patches`, aliased to the record's names. */
const PATCH_COLUMNS = `
  patches.id, patches.company_id AS "companyId",
  companies.handle AS "companyHandle", patches.name,
  patches.owner_user_id AS "ownerUserId", patches.scope, ${AUDIENCE_COLUMN} AS audience, patches.title,
  patches.current_version_id AS "currentVersionId",
  patches.repo_org AS "repoOrg", patches.repo_name AS "repoName",
  patches.created_at AS "createdAt", patches.updated_at AS "updatedAt",
  patches.lifecycle_revision::text AS "lifecycleRevision",
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
  server_object_key AS "serverObjectKey", server_content_hash AS "serverContentHash",
  server_file_size AS "serverFileSize",
  repo_object_key AS "repoObjectKey", repo_content_hash AS "repoContentHash",
  repo_file_bytes AS "repoFileBytes", repo_file_count AS "repoFileCount",
  created_by_machine_token_id AS "createdByMachineTokenId", source_ip AS "sourceIp",
  user_agent AS "userAgent", cli_version AS "cliVersion", git_branch AS "gitBranch",
  git_commit_sha AS "gitCommitSha", original_filename AS "originalFilename",
  tier, release, manifest_version AS "manifestVersion", wire_version AS "wireVersion",
  schema_revision AS "schemaRevision", manifest, publish_key AS "publishKey", payload_digest AS "payloadDigest",
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
  const memberAudience = (...args: Parameters<typeof Audiences.forMember>) =>
    Audiences.forMember(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const audienceOpen = (...args: Parameters<typeof Audiences.canOpen>) =>
    Audiences.canOpen(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const validateAudience = (...args: Parameters<typeof Audiences.validate>) =>
    Audiences.validate(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const saveAudience = (...args: Parameters<typeof Audiences.save>) =>
    Audiences.save(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const inventoryStore = yield* Inventory.Inventory;
  const tables = yield* Tables.Tables;
  const connections = yield* ConnectionStore.ConnectionStore;
  const wakes = yield* Wakes.Wakes;
  const analytics = yield* Analytics.Analytics;
  const announce = (patchId: string) =>
    Effect.map(pendingLifecycle, (pending) => {
      pending!.wakes.push(`patch:${patchId}`);
    });
  /** Reports a lifecycle change once the transaction that made it commits. */
  const report = (event: Analytics.AnalyticsEvent) =>
    Effect.map(pendingLifecycle, (pending) => {
      pending!.events.push(event);
    });
  // The company dependency lock is the outer transaction for portal bulk actions.
  // Keep their notices and events until its commit; a failed batch emits none.
  const withLifecycleTransaction = Effect.fnUntraced(function* <A, E, R>(
    work: Effect.Effect<A, E, R>
  ) {
    const existing = yield* pendingLifecycle;
    if (existing !== undefined) {
      const [wakeCount, eventCount] = [existing.wakes.length, existing.events.length];
      return yield* sql.withTransaction(work).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            existing.wakes.length = wakeCount;
            existing.events.length = eventCount;
          })
        )
      );
    }
    // An unrelated SQL owner has no commit hook here. Its durable revision is
    // reconciled rather than sending a hint before that transaction settles,
    // and its business events go unreported rather than report a rollback.
    const outerTransaction = yield* Effect.serviceOption(sql.transactionService);
    const pending: PendingLifecycle = { wakes: [], events: [] };
    // Only the work is interruptible. An interrupt that arrives during COMMIT waits
    // until a committed change has reported its events.
    const result = yield* Effect.uninterruptibleMask((restore) =>
      sql
        .withTransaction(restore(work.pipe(Effect.provideService(pendingLifecycle, pending))))
        .pipe(
          Effect.tap(() =>
            Option.isSome(outerTransaction)
              ? Effect.void
              : Effect.forEach(pending.events, analytics.track, { discard: true })
          )
        )
    );
    if (Option.isSome(outerTransaction)) return result;
    if (pending.wakes.length > 0) yield* wakes.publish([...new Set(pending.wakes)]);
    return result;
  });

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

  // The shared tables and stores a patch declares it reads, in any version it ever had.
  const declaredReads = sql`
    COALESCE((
      SELECT jsonb_agg(jsonb_strip_nulls(to_jsonb(declarations))
        ORDER BY declarations.alias, declarations."patchId", declarations."table", declarations.store)
      FROM (
        SELECT DISTINCT declaration.key AS alias,
          declaration.value->>'patchId' AS "patchId",
          declaration.value->>'table' AS "table", declaration.value->>'store' AS store
        FROM patch_versions
        CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
        WHERE patch_versions.patch_id = patches.id
          AND declaration.value->>'kind' IN ('sharedTable', 'sharedStore')
          AND declaration.value->>'id' = (declaration.value->>'patchId') || '/' ||
            COALESCE(declaration.value->>'table', declaration.value->>'store')
      ) declarations
    ), '[]'::jsonb)`;

  const companyPatchRows = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      userId: Schema.String,
      /** Whether to read the shared-read declarations, across every version of every patch. */
      sharing: Schema.Boolean
    }),
    Result: ReadPatchRow,
    execute: ({ companyId, userId, sharing }) => sql`
      SELECT ${sql.unsafe(PATCH_COLUMNS)}, owner.name AS "ownerName",
        owner.deactivated_at IS NOT NULL AS "ownerDeactivated",
        current_version.version_number AS "currentVersion", current_version.tier,
        current_version.created_at AS "publishedAt",
        LEAST(patches.visit_count, 2147483647)::int AS visits,
        ${sharing ? declaredReads : sql`'[]'::jsonb`} AS reads
      FROM patches
      JOIN companies ON companies.id = patches.company_id
      JOIN users owner ON owner.id = patches.owner_user_id
      JOIN patch_versions current_version ON current_version.id = patches.current_version_id
        AND current_version.patch_id = patches.id
      WHERE patches.company_id = ${companyId}
      ORDER BY (patches.owner_user_id = ${userId}) DESC, patches.name, patches.id`
  });

  const agentToolMarksRows = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: AgentToolMarksRow,
    execute: (versionIds) => sql`
      SELECT patch_versions.id AS "versionId",
        jsonb_object_agg(handler.key, jsonb_strip_nulls(jsonb_build_object(
          'kind', handler.value->'kind', 'agentTool', handler.value->'agentTool',
          'readOnly', handler.value->'readOnly', 'description', handler.value->'description'
        ))) AS handlers
      FROM patch_versions
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'handlers') AS handler
      WHERE patch_versions.id IN ${sql.in(versionIds)}
        AND handler.value->'agentTool' = 'true'::jsonb
      GROUP BY patch_versions.id`
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

  /** Who published a patch's newest version, and when: the owner at the time, not now. */
  const newestVersion = SqlSchema.findOne({
    Request: Schema.String,
    Result: NewestVersion,
    execute: (patchId) => sql`
      SELECT patch_versions.version_number AS "versionNumber",
        patch_versions.owner_user_id AS "publisherId", users.name AS "publisherName",
        patch_versions.created_at AS "createdAt"
      FROM patch_versions JOIN users ON users.id = patch_versions.owner_user_id
      WHERE patch_versions.patch_id = ${patchId}
      ORDER BY patch_versions.version_number DESC LIMIT 1`
  });

  /** The refusal for a copy at `baseVersion` when the patch's newest version is past it. */
  const behind = Effect.fn("Patches.behind")(
    function* (patchId: string, baseVersion: number) {
      const newest = yield* newestVersion(patchId);
      return yield* new Behind({
        patchId,
        baseVersion,
        latestVersion: newest.versionNumber,
        publishedBy: { id: newest.publisherId, name: newest.publisherName },
        publishedAt: iso(newest.createdAt)
      });
    },
    Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
  );

  const nextVersionNumber = SqlSchema.findOne({
    Request: Schema.String,
    Result: NextVersion,
    execute: (patchId) => sql`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS "nextVersion"
      FROM patch_versions WHERE patch_id = ${patchId}`
  });

  const actorCompany = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ companyId: Schema.String }),
    execute: (id) => sql`SELECT company_id AS "companyId" FROM users WHERE id = ${id}`
  });
  const actorRole = Effect.fn("Patches.actorRole")(function* (userId: string) {
    const rows = yield* actorCompany(userId).pipe(Effect.catchTags(dieOnSchemaError));
    if (Option.isNone(rows)) return Option.none();
    const people = yield* Teams.people(rows.value.companyId, [userId]).pipe(
      Effect.provideService(SqlClient.SqlClient, sql)
    );
    const person = people[0];
    return person?.active
      ? Option.some({ ...person, companyId: rows.value.companyId })
      : Option.none();
  });
  // Company/public sharing admits every member of this company in any lifecycle
  // state. Disabled patches remain hidden; serving reads use the stricter gate.
  const lockOpenable = SqlSchema.findOneOption({
    Request: Schema.Struct({
      patchId: Schema.String,
      userId: Schema.String,
      oversight: Schema.optionalKey(Schema.Boolean),
      readOnly: Schema.optionalKey(Schema.Boolean)
    }),
    Result: ManagedPatchRow,
    execute: Effect.fn("Patches.lockOpenable")(function* ({
      patchId,
      userId,
      oversight,
      readOnly
    }) {
      // Companies serializes roles and memberships on this same company row.
      if (!readOnly)
        yield* sql`SELECT id FROM companies WHERE id = (SELECT company_id FROM users WHERE id = ${userId}) FOR SHARE`;
      const actor = yield* actorRole(userId);
      if (Option.isNone(actor)) return [];
      // Lock the patch before joining its owner. A join planned before a lock
      // wait can lose the row when PostgreSQL rechecks a concurrent reassignment.
      // Callers keep both statements in one transaction; its patch lock preserves
      // the company and disabled-state checks through the owner lookup.
      const locked =
        yield* sql`SELECT company_id AS "companyId", ${sql.unsafe(AUDIENCE_COLUMN)} AS audience FROM patches
        WHERE id = ${patchId} AND disabled_at IS NULL
          AND company_id = (SELECT company_id FROM users WHERE id = ${userId})
        ${sql.unsafe(readOnly ? "" : "FOR UPDATE")}`;
      if (locked.length === 0) return [];
      const facts = yield* decodeLockedAudience(locked).pipe(Effect.catchTags(dieOnSchemaError));
      const current = facts[0]!;
      if (
        !(oversight && actor.value.role === "super_admin") &&
        !(yield* audienceOpen({ ...current, disabledAt: null }, current.companyId, userId))
      )
        return [];
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
    withLifecycleTransaction(
      Effect.gen(function* () {
        yield* lockDependencies(actorUserId);
        return yield* effect;
      })
    );
  const manageable = Effect.fn("Patches.manageable")(function* (
    patchId: string,
    actor: Actor,
    access: "management" | "content" = "management",
    readOnly = false
  ) {
    const row = yield* lockOpenable({
      patchId,
      userId: actor.userId,
      oversight: access === "management" && actor.admin,
      readOnly
    });
    const role = yield* actorRole(actor.userId);
    const administrator = actor.admin && Option.isSome(role) && role.value.role !== "member";
    if (Option.isNone(row)) {
      const owned =
        yield* sql`SELECT p.id FROM patches p JOIN users u ON u.id = p.owner_user_id AND u.company_id = p.company_id
        WHERE p.id = ${patchId} AND p.owner_user_id = ${actor.userId} AND p.disabled_at IS NULL AND u.deactivated_at IS NULL`;
      if (owned.length) return yield* new OwnerAccessLost({ patchId });
      return yield* new PatchUnavailable({ patchId });
    }
    if (row.value.ownerUserId !== actor.userId && !administrator)
      return yield* new NotOwner({
        owner: { id: row.value.ownerUserId, name: row.value.ownerName }
      });
    return { ...row.value, actorRole: Option.isSome(role) ? role.value.role : ("member" as const) };
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
  const retainedRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      patchId: Schema.String,
      versionNumber: Schema.UndefinedOr(Schema.Number),
      versionId: Schema.UndefinedOr(Schema.String)
    }),
    Result: Schema.Struct({
      ...PatchRow.fields,
      patchTier: Schema.Int,
      version: Schema.Struct({ ...VersionRow.fields, createdAt: Schema.DateFromString })
    }),
    execute: ({ patchId, versionNumber, versionId }) => sql`
      SELECT ${sql.unsafe(PATCH_COLUMNS)}, served.tier AS "patchTier", to_jsonb(selected) AS version
      FROM patches JOIN companies ON companies.id = patches.company_id
      JOIN patch_versions served ON served.id = patches.current_version_id
      JOIN LATERAL (
        SELECT ${sql.unsafe(VERSION_COLUMNS)} FROM patch_versions
        WHERE patch_id = patches.id AND ${
          versionId !== undefined
            ? sql`id = ${versionId}`
            : versionNumber !== undefined
              ? sql`version_number = ${versionNumber}`
              : sql`id = patches.current_version_id`
        }
      ) selected ON true
      WHERE patches.id = ${patchId}`
  });
  const findRetained = Effect.fn("Patches.findRetained")(function* (
    patchId: string,
    versionNumber?: number,
    versionId?: string
  ) {
    const found = yield* retainedRow({ patchId, versionNumber, versionId });
    return Option.map(found, (row) => ({
      patch: toPatch(row),
      version: toVersion(row.version),
      patchTier: row.patchTier
    }));
  }, Effect.catchTags(dieOnSchemaError));

  const agentToolSummariesOf = Effect.fn("Patches.agentToolSummaries")(function* (
    versionIds: ReadonlyArray<string>
  ) {
    if (versionIds.length === 0) return new Map<string, readonly AgentToolSummary[]>();
    const rows = yield* agentToolMarksRows(versionIds);
    return new Map(rows.map((row) => [row.versionId, agentToolSummaries(row.handlers)] as const));
  }, Effect.catchTags(dieOnSchemaError));

  const find = Effect.fn("Patches.find")(function* (
    patchId: string,
    versionNumber?: number,
    versionId?: string,
    viewer?: { readonly companyId: string; readonly userId: string }
  ) {
    const found = (yield* findRetained(patchId, versionNumber, versionId)).pipe(
      Option.filter(({ patch }) => patch.state === "live" && patch.disabledAt === null)
    );
    if (
      Option.isSome(found) &&
      viewer !== undefined &&
      !(yield* audienceOpen(found.value.patch, viewer.companyId, viewer.userId))
    )
      return Option.none();
    return found;
  });

  const findForViewer = Effect.fn("Patches.findForViewer")(
    (patchId: string, viewer: { readonly companyId: string; readonly userId: string }) =>
      find(patchId, undefined, undefined, viewer)
  );
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
    if (
      Option.isNone(row) ||
      !(yield* audienceOpen(toPatch(row.value), access.companyId, access.userId)) ||
      !access.canOpen(toPatch(row.value))
    )
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

  /** The patches `options` selects that the person can open, with or without sharing edges. */
  const select = Effect.fn("Patches.select")(function* (options: ReadOptions, sharing: boolean) {
    const rows = yield* companyPatchRows({
      companyId: options.companyId,
      userId: options.userId,
      sharing
    });
    const admitted = yield* memberAudience(options.companyId, options.userId);
    const sourceStates = new Map<string, PatchState>();
    const openable = new Map<string, { row: ReadPatchRow; patch: Patch }>();
    for (const row of rows) {
      const patch = toPatch(row);
      if (patch.disabledAt === null && admitted(patch.audience) && options.canOpen(patch))
        sourceStates.set(patch.id, patch.state);
      if (patch.disabledAt === null && admitted(patch.audience) && options.canOpen(patch))
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
    return { selected, openable, sourceStates };
  });

  const listed = ({ row, patch }: { row: ReadPatchRow; patch: Patch }): ListedPatch => ({
    patch,
    owner: {
      id: patch.ownerUserId,
      name: row.ownerName,
      deactivated: row.ownerDeactivated
    },
    currentVersion: row.currentVersion,
    tier: row.tier,
    publishedAt: iso(row.publishedAt),
    visits: row.visits
  });

  const list = Effect.fn("Patches.list")(function* (options: ReadOptions) {
    return (yield* select(options, false)).selected.map(listed);
  }, Effect.catchTags(dieOnSchemaError));

  const read = Effect.fn("Patches.read")(function* (options: ReadOptions) {
    const { selected, openable, sourceStates } = yield* select(options, true);
    if (selected.length === 0) return [];

    const dependants = new Map<string, Array<ReadPatch["dependants"][number]>>();
    for (const { patch } of selected) dependants.set(patch.id, []);
    for (const { row, patch } of openable.values()) {
      if (patch.state !== "live" || row.reads.length === 0) continue;
      const seen = new Set<string>();
      for (const declaration of row.reads) {
        const edges = dependants.get(declaration.patchId);
        if (edges === undefined) continue;
        const resource =
          "table" in declaration ? { table: declaration.table } : { store: declaration.store };
        const key = `${declaration.patchId}/${"table" in declaration ? declaration.table : declaration.store}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          patchId: patch.id,
          name: patch.name,
          owner: { id: patch.ownerUserId, name: row.ownerName },
          ...resource
        });
      }
    }
    return selected.map(({ row, patch }): ReadPatch => ({
      ...listed({ row, patch }),
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
            (a.table ?? a.store).localeCompare(b.table ?? b.store)
        )
    }));
  }, Effect.catchTags(dieOnSchemaError));

  const sharedTable = Effect.fn("Patches.sharedTable")(function* (
    patchId: string,
    table: string,
    companyId: string,
    viewerId: string
  ) {
    // Never nest platform patch locks: source liveness is read before the company inventory lock.
    const source = yield* findForViewer(patchId, { companyId, userId: viewerId });
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
    const uses = Object.fromEntries(
      Object.entries(Tables.inventoryReferences(tables)).flatMap(([alias, declaration]) =>
        declaration.kind === "sharedTable" ? [[alias, declaration] as const] : []
      )
    );
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

  const sharedStore = Effect.fn("Patches.sharedStore")(function* (
    patchId: string,
    store: string,
    companyId: string,
    viewerId: string
  ) {
    const source = yield* findForViewer(patchId, { companyId, userId: viewerId });
    if (Option.isNone(source) || source.value.patch.companyId !== companyId)
      return yield* new PatchNotOpenable({ patchId, store });
    const snapshot = yield* readInventory(companyId, patchId);
    const definition = snapshot?.stores.find((entry) => entry.name === store && entry.shared);
    if (snapshot === null || definition === undefined)
      return yield* new PatchNotOpenable({ patchId, store });
    return {
      id: sharedStoreId(patchId, store),
      patchId,
      store,
      schemaRevision: snapshot.schemaRevision,
      definition: { description: definition.description, shared: definition.shared }
    } satisfies SharedStore;
  });

  const resolveDeclarations = Effect.fn("Patches.resolveDeclarations")(function* (
    manifest: typeof Manifest.Type,
    companyId: string,
    ownerUserId: string
  ) {
    const warnings: string[] = [];
    // Lock connections in stable order when called inside the publish transaction.
    const declarations = Object.values(manifest.uses)
      .filter((declaration) => declaration.kind !== "members")
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const declaration of declarations) {
      if (
        declaration.kind === "postgres" ||
        declaration.kind === "posthog" ||
        declaration.kind === "pidgeon" ||
        declaration.kind === "attio" ||
        declaration.kind === "imap"
      ) {
        if (
          !(yield* connections.canUse(companyId, declaration.id, ownerUserId).pipe(
            Effect.catchTags({
              ConnectionNotFound: () => Effect.fail(new ConnectionStore.ConnectionNotConnected())
            })
          ))
        )
          return yield* new ConnectionStore.ConnectionAccessDenied();
        yield* connections.resolve(companyId, declaration);
        continue;
      }
      const resource =
        declaration.kind === "sharedTable"
          ? { table: declaration.table }
          : { store: declaration.store };
      const id =
        declaration.kind === "sharedTable"
          ? sharedTableId(declaration.patchId, declaration.table)
          : sharedStoreId(declaration.patchId, declaration.store);
      if (declaration.id !== id)
        return yield* new PatchNotOpenable({ patchId: declaration.patchId, ...resource });
      const source = yield* declaration.kind === "sharedTable"
        ? sharedTable(declaration.patchId, declaration.table, companyId, viewerId)
        : sharedStore(declaration.patchId, declaration.store, companyId, viewerId);
      if (declaration.revision < source.schemaRevision)
        warnings.push(
          `Shared ${declaration.kind === "sharedTable" ? "table" : "store"} \`${source.id}\`: declared schema revision ${declaration.revision} is behind source schema revision ${source.schemaRevision}.`
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
      SELECT COALESCE(declaration.value->>'table', declaration.value->>'store') AS resource,
        count(DISTINCT patches.id)::int AS count
      FROM patches
      JOIN patch_versions ON patch_versions.patch_id = patches.id
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
      WHERE patches.company_id = ${companyId}
        AND ${serving}
        AND declaration.value->>'kind' IN ('sharedTable', 'sharedStore')
        AND declaration.value->>'patchId' = ${patchId}
        AND declaration.value->>'id' = ${patchId} || '/' ||
          COALESCE(declaration.value->>'table', declaration.value->>'store')
      GROUP BY COALESCE(declaration.value->>'table', declaration.value->>'store')`
  });

  const dependantRows = SqlSchema.findAll({
    Request: Schema.Struct({
      patchId: Schema.String,
      companyId: Schema.String,
      resources: Schema.NullOr(Schema.Array(Schema.String))
    }),
    Result: Schema.Struct({ ...Dependant.fields, audience: PatchAudience }),
    execute: ({ patchId, companyId, resources: affected }) => sql`
      SELECT DISTINCT patches.id AS "patchId", patches.name,
        jsonb_build_object('id', owner.id, 'name', owner.name) AS owner,
        ${sql.unsafe(AUDIENCE_COLUMN)} AS audience
      FROM patches JOIN users owner ON owner.id = patches.owner_user_id
      JOIN patch_versions ON patch_versions.patch_id = patches.id
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
      WHERE patches.company_id = ${companyId} AND ${serving}
        AND declaration.value->>'kind' IN ('sharedTable', 'sharedStore')
        AND declaration.value->>'patchId' = ${patchId}
        AND declaration.value->>'id' = ${patchId} || '/' ||
          COALESCE(declaration.value->>'table', declaration.value->>'store')
        AND ${affected === null ? sql`true` : sql`COALESCE(declaration.value->>'table', declaration.value->>'store') IN ${sql.in(affected)}`}
      ORDER BY patches.name, patches.id`
  });
  const refuseDependants = Effect.fn("Patches.refuseDependants")(function* (
    patchId: string,
    companyId: string,
    force: boolean | undefined,
    userId: string,
    affected: readonly string[] | null = null
  ) {
    if (force || affected?.length === 0) return;
    const summary = yield* visibleDependants(patchId, companyId, userId, affected);
    if (summary.dependants.length + summary.hiddenCount > 0)
      return yield* new HasDependants(summary);
  });
  const offSources = SqlSchema.findAll({
    Request: Schema.Struct({ patchId: Schema.String, companyId: Schema.String }),
    Result: Schema.Struct({
      patchId: Schema.String,
      name: Schema.NullOr(Schema.String),
      table: Schema.NullOr(Schema.String),
      store: Schema.NullOr(Schema.String),
      state: PatchSourceState
    }),
    execute: ({ patchId, companyId }) => sql`
      SELECT DISTINCT declaration.value->>'patchId' AS "patchId", source.name,
        declaration.value->>'table' AS "table", declaration.value->>'store' AS store,
        CASE WHEN source.id IS NULL THEN 'gone'
          WHEN source.deleted_at IS NOT NULL THEN 'deleted'
          WHEN source.retired_at IS NOT NULL THEN 'retired'
          ELSE 'live' END AS state
      FROM patches
      JOIN patch_versions ON patch_versions.id = patches.current_version_id AND patch_versions.patch_id = patches.id
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
      LEFT JOIN patches source ON source.id = declaration.value->>'patchId'
        AND source.company_id = ${companyId} AND source.disabled_at IS NULL
      WHERE patches.id = ${patchId} AND declaration.value->>'kind' IN ('sharedTable', 'sharedStore')
        AND (source.id IS NULL OR source.deleted_at IS NOT NULL OR source.retired_at IS NOT NULL)
      ORDER BY "patchId", "table", store`
  });

  const addressNotice = Effect.fn("Patches.addressNotice")(function* (
    patchId: string,
    access: ReadAccess
  ) {
    const row = yield* companyPatchRow({ patchId, companyId: access.companyId });
    if (Option.isNone(row)) return Option.none();
    const patch = toPatch(row.value);
    if (
      patch.state === "live" ||
      !(yield* audienceOpen(toPatch(row.value), access.companyId, access.userId)) ||
      !access.canOpen(patch)
    )
      return Option.none();
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
        offSources: sources.map(({ patchId: sourceId, table, store, state }) => {
          const name = card.reads.find((read) => read.patchId === sourceId)?.name;
          const resource = table === null ? { store: store! } : { table };
          const source = { patchId: sourceId, ...resource, state };
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
    if (input.audience !== undefined) {
      const previous =
        input.intent === "update"
          ? yield* companyPatchRow({ companyId: input.companyId, patchId: input.patchId }).pipe(
              Effect.catchTags(dieOnSchemaError)
            )
          : Option.none();
      yield* validateAudience({
        audience: input.audience,
        companyId: input.companyId,
        actorId: input.ownerUserId,
        ownerId: input.ownerUserId,
        ...(Option.isSome(previous) ? { previous: previous.value.audience } : {})
      });
      if (Option.isSome(previous))
        yield* refuseAudienceNarrowing(
          previous.value,
          input.audience,
          { userId: input.ownerUserId, admin: false },
          input.force
        );
    }
    // Before anything uploads; `record` checks again under the lock.
    if (input.intent === "update" && input.baseVersion !== undefined) {
      const { nextVersion } = yield* nextVersionNumber(input.patchId).pipe(
        Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
      );
      if (nextVersion - 1 > input.baseVersion)
        return yield* behind(input.patchId, input.baseVersion);
    }
    if (
      input.manifest.tier === 2 &&
      (input.scope === "public" || input.audience?.members.kind === "public")
    )
      return yield* new Tier2NotPublic();
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
    yield* resolveDeclarations(input.manifest, input.companyId, input.ownerUserId);
    if (hasOwnedDefinitions(input.manifest)) {
      yield* databases.ensureReady(input.companyId);
    }
    const { companyId, snapshot } =
      input.intent === "create"
        ? { companyId: input.companyId, snapshot: null }
        : yield* sql.withTransaction(
            Effect.gen(function* () {
              const locked = yield* publishable(input);
              if (
                input.manifest.tier === 2 &&
                (input.audience === undefined
                  ? (input.scope ?? locked.scope)
                  : Audiences.scopeOf(input.audience)) === "public"
              )
                return yield* new Tier2NotPublic();
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
      input.ownerUserId,
      plan.sharing.filter(
        (name) => (input.manifest.tables[name] ?? input.manifest.files[name])!.shared !== true
      )
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
        // The inventory answer carries no version, so the request event takes it from the row.
        yield* WideEvents.enrich(eventFields(locked.value));
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
                input.ownerUserId,
                plan.sharing.filter(
                  (name) =>
                    (input.manifest.tables[name] ?? input.manifest.files[name])!.shared !== true
                )
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
              OR patch_versions.repo_object_key = pending_patch_objects.object_key
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
    withLifecycleTransaction(
      Effect.gen(function* () {
        yield* sql`SET LOCAL statement_timeout = '60s'`;
        yield* lockDependencies(input.ownerUserId);
        const millis = yield* Clock.currentTimeMillis;
        // Lock company authority before any patch/user row, matching team management.
        yield* sql`SELECT id FROM companies WHERE id = ${input.companyId} FOR NO KEY UPDATE`;
        const existing = input.intent === "update" ? yield* publishable(input) : null;
        const audience =
          input.audience ??
          (existing !== null &&
          (input.scope === undefined ||
            input.scope === existing.scope ||
            (input.scope === "company" && existing.audience.members.kind === "teams"))
            ? existing.audience
            : existing !== null
              ? Audiences.company(input.scope)
              : Audiences.company(input.scope));
        yield* validateAudience({
          audience,
          companyId: input.companyId,
          actorId: input.ownerUserId,
          ownerId: input.ownerUserId,
          ...(existing === null ? {} : { previous: existing.audience })
        });
        if (existing !== null)
          yield* refuseAudienceNarrowing(
            existing,
            audience,
            { userId: input.ownerUserId, admin: false },
            input.force
          );
        if (input.manifest.tier === 2 && Audiences.scopeOf(audience) === "public")
          return yield* new Tier2NotPublic();
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
        for (const key of [
          input.objectKey,
          ...(input.server ? [input.server.objectKey] : []),
          ...(input.repo ? [input.repo.objectKey] : [])
        ]) {
          const pending = yield* sql`
              DELETE FROM pending_patch_objects
              WHERE object_key = ${key} AND NOT claimed
                AND expires_at > ${stamp(millis)}
              RETURNING object_key`;
          if (pending.length === 0) return yield* new PendingObjectExpired({ objectKey: key });
        }
        let versionNumber: number;
        let scope: Patch["scope"] = Audiences.scopeOf(audience);
        let companyId = input.companyId;
        let companyHandle: string;
        let name: string;
        let rename = false;

        if (input.intent === "update") {
          // The row lock serialises concurrent updates of one patch: the
          // version number is allocated after it, so each waits its turn and
          // then sees the committed version before it.
          const locked = existing!;
          scope = Audiences.scopeOf(audience);
          companyId = locked.companyId;
          companyHandle = locked.companyHandle;
          name = input.manifest.name ?? locked.name;
          rename = name !== locked.name;
          versionNumber = (yield* nextVersionNumber(input.patchId)).nextVersion;
          // Again under the row lock, so a second machine's publish from the same copy sees the
          // first one's version.
          if (input.baseVersion !== undefined && versionNumber - 1 > input.baseVersion)
            return yield* behind(input.patchId, input.baseVersion);
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
        yield* saveAudience(input.patchId, companyId, audience);
        const declarationWarnings = yield* resolveDeclarations(
          input.manifest,
          companyId,
          input.ownerUserId
        );
        const resources = yield* provision({ ...input, companyId });
        const declaringPatches = resources.sharing.some(
          (name) => (input.manifest.tables[name] ?? input.manifest.files[name])!.shared !== true
        )
          ? new Map(
              (yield* declaringPatchRows({
                patchId: input.patchId,
                companyId
              })).map((row) => [row.resource, row.count])
            )
          : new Map<string, number>();
        const sharingWarnings = resources.sharing.map((name) =>
          (input.manifest.tables[name] ?? input.manifest.files[name])!.shared === true
            ? `\`${name}\` is now shared.`
            : `\`${name}\` is no longer shared; ${declaringPatches.get(name) ?? 0} declaring patches are affected.`
        );
        const publicUrl = address(input.publicBaseUrl, companyHandle, name);
        const response = new (input.intent === "create" ? PublishCreated : PublishUpdated)({
          ok: true,
          patchId: input.patchId,
          versionId: input.versionId,
          versionNumber,
          title: input.title,
          scope,
          audience,
          name,
          description,
          descriptionUpdatedAt,
          address: publicUrl,
          publicUrl,
          tier: input.manifest.tier,
          schemaRevision: resources.schemaRevision,
          provisioned: resources.provisioned,
          unused: resources.unused,
          artifacts: {
            html: { sha256: input.contentHash.slice("sha256:".length), bytes: input.fileSize },
            ...(input.server
              ? { server: { sha256: input.server.sha256, bytes: input.server.bytes } }
              : {}),
            ...(input.repo ? { repo: { files: input.repo.files, bytes: input.repo.bytes } } : {})
          },
          ...(input.manifest.tier === 2
            ? {
                handlers: Object.entries(input.manifest.handlers ?? {})
                  .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                  .map(([name, descriptor]) => ({ name, kind: descriptor.kind }))
              }
            : {}),
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
            server_object_key, server_content_hash, server_file_size,
            repo_object_key, repo_content_hash, repo_file_bytes, repo_file_count,
            created_by_machine_token_id, source_ip, user_agent, cli_version,
            git_branch, git_commit_sha, original_filename,
            owner_user_id, tier, release, manifest_version, wire_version, schema_revision,
            manifest, publish_key, payload_digest, publish_response, publish_status, created_at
          ) VALUES (
            ${input.versionId}, ${input.patchId}, ${versionNumber}, ${input.objectKey},
            ${input.contentHash}, ${input.fileSize},
            ${input.server?.objectKey ?? null}, ${input.server?.sha256 ?? null}, ${input.server?.bytes ?? null},
            ${input.repo?.objectKey ?? null}, ${input.repo?.contentHash ?? null},
            ${input.repo?.bytes ?? null}, ${input.repo?.files ?? null},
            ${input.machineTokenId}, ${input.sourceIp},
            ${input.userAgent}, ${input.cliVersion}, ${input.gitBranch}, ${input.gitCommitSha},
            ${input.filename}, ${input.ownerUserId}, ${input.manifest.tier}, ${input.manifest.release},
            ${input.manifest.manifestVersion}, ${input.wireVersion}, ${resources.schemaRevision},
            ${encodeManifest(input.manifest)}::jsonb, ${input.publishKey}, ${input.payloadDigest},
            ${responseJson}::jsonb, ${status}, ${stamp(millis)}
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
              lifecycle_revision = lifecycle_revision + 1,
              last_changed_action = ${`published v${versionNumber}`}
          WHERE id = ${input.patchId}`;

        yield* announce(input.patchId);
        // The version row is new: a reused publish key failed above and reports nothing.
        yield* report({
          name: input.intent === "create" ? "patch.created" : "patch.updated",
          principalId: input.ownerUserId,
          companyId,
          properties: {
            ...publication(input, versionNumber, scope),
            ...(yield* Analytics.CurrentCli)
          }
        });
        // An update that passes another scope changes the patch's sharing, as the share action does.
        if (existing !== null && scope !== existing.scope)
          yield* report({
            name: "patch.shared",
            principalId: input.ownerUserId,
            companyId,
            properties: {
              patchId: input.patchId,
              ownerUserId: existing.ownerUserId,
              byAdmin: false,
              scope,
              previousScope: existing.scope
            }
          });
        return { ...response, status, responseBody: inserted.responseBody } satisfies Recorded;
      }).pipe(Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die }))
    ).pipe(Effect.timeout("60 seconds"), Effect.catchTags({ TimeoutError: Effect.die }))
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
  /** What every lifecycle event says about the patch row an actor changed. */
  const changed = (row: PatchRow, actor: Actor) => ({
    patchId: row.id,
    ownerUserId: row.ownerUserId,
    byAdmin: actor.admin
  });
  const managementRows = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      patchId: Schema.NullOr(Schema.String),
      patchName: Schema.NullOr(Schema.String)
    }),
    Result: ManagementRecord,
    execute: ({
      companyId,
      patchId,
      patchName
    }) => sql`SELECT p.id, p.name, c.handle AS "companyHandle", p.owner_user_id AS "ownerId", u.name AS "ownerName", u.deactivated_at IS NOT NULL AS "ownerDeactivated",
      p.scope, (v.manifest->>'tier')::int AS tier, p.lifecycle_revision::text AS "lifecycleRevision", ${sql.unsafe(AUDIENCE_COLUMN.replaceAll("patches.", "p."))} AS audience, p.retired_at AS "retiredAt", p.deleted_at AS "deletedAt",
      p.current_version_id AS "currentVersionId" FROM patches p JOIN companies c ON c.id = p.company_id JOIN users u ON u.id = p.owner_user_id JOIN patch_versions v ON v.id = p.current_version_id AND v.patch_id = p.id
      WHERE p.company_id = ${companyId} AND p.disabled_at IS NULL AND (${patchId}::text IS NULL OR p.id = ${patchId}) AND (${patchName}::text IS NULL OR p.name = ${patchName}) ORDER BY p.name, p.id`
  });
  const management = Effect.fn("Patches.management")(function* (
    companyId: string,
    userId: string,
    patchRef?: { readonly id: string } | { readonly name: string }
  ) {
    const actor = yield* actorRole(userId);
    if (Option.isNone(actor) || actor.value.companyId !== companyId) return [];
    const role = actor.value.role;
    const rows = yield* managementRows({
      companyId,
      patchId: patchRef && "id" in patchRef ? patchRef.id : null,
      patchName: patchRef && "name" in patchRef ? patchRef.name : null
    });
    const admitted = yield* memberAudience(companyId, userId);
    const ownerAdmission = yield* Audiences.forPeople(companyId, [
      ...new Set(rows.map((row) => row.ownerId))
    ]).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const result: ManagementView[] = [];
    for (const record of rows) {
      const canOpen = admitted(record.audience);
      const canManage =
        role === "super_admin" || (canOpen && (role === "admin" || record.ownerId === userId));
      if (!canManage && record.ownerId !== userId) continue;
      const ownerCanOpen = ownerAdmission(record.ownerId, record.audience);
      // Readable patches get their details from portalCard; only oversight needs them here.
      const detail = patchRef !== undefined && canManage && !canOpen;
      const sources = detail ? yield* offSources({ patchId: record.id, companyId }) : [];
      const dependencies = detail
        ? yield* visibleDependants(record.id, companyId, userId)
        : { dependants: [], hiddenCount: 0 };
      const card: ManagementCard = {
        patch: {
          id: record.id,
          name: record.name,
          title: record.name,
          companyHandle: record.companyHandle,
          ownerUserId: record.ownerId,
          state: record.deletedAt ? "deleted" : record.retiredAt ? "retired" : "live",
          scope: record.scope,
          audience: record.audience,
          lifecycleRevision: record.lifecycleRevision,
          currentVersionId: record.currentVersionId
        },
        owner: { id: record.ownerId, name: record.ownerName, deactivated: record.ownerDeactivated },
        tier: record.tier,
        hiddenDependants: dependencies.hiddenCount,
        dependants: dependencies.dependants,
        offSources: sources.map(({ patchId, name, table, store, state }) => ({
          patchId,
          ...(name === null ? {} : { name }),
          ...(table === null ? { store: store! } : { table }),
          state
        }))
      };
      const versions = detail
        ? (yield* portalVersionRows(record.id)).map((version) => ({
            ...version,
            createdAt: iso(version.createdAt)
          }))
        : [];
      result.push({ record, card, versions, canOpen, canManage, ownerCanOpen });
    }
    return result;
  }, Effect.catchTags(dieOnSchemaError));
  const managementHistory = Effect.fn("Patches.managementHistory")(function* (
    patchId: string,
    userId: string
  ) {
    const person = yield* actorRole(userId);
    if (Option.isNone(person)) return yield* new PatchUnavailable({ patchId });
    const companyId = person.value.companyId;
    const record = (yield* managementRows({ companyId, patchId, patchName: null }).pipe(
      Effect.catchTags(dieOnSchemaError)
    ))[0];
    if (!record || record.ownerId !== userId) return yield* new PatchUnavailable({ patchId });
    const audience = record.audience.members;
    if (audience.kind !== "teams") return [];
    const teams = yield* Teams.list({ companyId, actorId: userId }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags({ RoleForbidden: Effect.die })
    );
    const visible = audience.teamIds.filter(
      (id) =>
        teams.some((team) => team.id === id) &&
        (person.value.role !== "member" || person.value.teamIds.includes(id))
    );
    return yield* Teams.selfJoins(companyId, visible).pipe(
      Effect.provideService(SqlClient.SqlClient, sql)
    );
  });
  const eligibleOwnerRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String, name: Schema.String }),
    execute: (companyId) =>
      sql`SELECT id, name FROM users WHERE company_id = ${companyId} AND deactivated_at IS NULL ORDER BY name, id`
  });
  const visibleDependants = Effect.fn("Patches.visibleDependants")(function* (
    patchId: string,
    companyId: string,
    userId: string,
    resources: readonly string[] | null = null
  ) {
    const all = yield* dependantRows({ patchId, companyId, resources }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
    if (all.length === 0) return { dependants: [], hiddenCount: 0 };
    const admitted = yield* memberAudience(companyId, userId);
    const visible = all
      .filter((row) => admitted(row.audience))
      .map(({ patchId, name, owner }) => ({ patchId, name, owner }));
    return { dependants: visible, hiddenCount: all.length - visible.length };
  });
  const sharingDependants = Effect.fn("Patches.sharingDependants")(
    function* (patchId: string, actor: Actor) {
      const row = yield* manageable(patchId, actor, "management", true);
      return yield* visibleDependants(patchId, row.companyId, actor.userId);
    },
    Effect.catchTags({
      PatchUnavailable: () => Effect.succeed({ dependants: [], hiddenCount: 0 }),
      OwnerAccessLost: () => Effect.succeed({ dependants: [], hiddenCount: 0 }),
      NotOwner: () => Effect.succeed({ dependants: [], hiddenCount: 0 })
    })
  );
  const refuseAudienceNarrowing = Effect.fn("Patches.refuseAudienceNarrowing")(function* (
    row: Pick<PatchRow, "id" | "companyId" | "audience">,
    audience: PatchAudience,
    actor: Actor,
    force: boolean | undefined
  ) {
    const before = row.audience.members;
    const after = audience.members;
    if (
      !force &&
      after.kind === "teams" &&
      (before.kind !== "teams" || before.teamIds.some((id) => !after.teamIds.includes(id)))
    ) {
      const summary = yield* visibleDependants(row.id, row.companyId, actor.userId);
      if (summary.dependants.length + summary.hiddenCount > 0)
        return yield* new HasDependants(summary);
    }
  });
  const eligibleOwners = Effect.fn("Patches.eligibleOwners")(function* (
    patchId: string,
    actor: Actor
  ) {
    const patch = yield* manageable(patchId, actor, "management", true);
    const people = yield* eligibleOwnerRows(patch.companyId).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
    const admitted = yield* Audiences.forPeople(
      patch.companyId,
      people.map((person) => person.id)
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return people.filter((person) => admitted(person.id, patch.audience));
  }, withLifecycleTransaction);
  const manage = Effect.fn("Patches.manage")((patchId: string, actor: Actor, readOnly = false) =>
    manageable(patchId, actor, "management", readOnly).pipe(
      Effect.map((row): SharingMetadata => ({
        id: row.id,
        name: row.name,
        companyId: row.companyId,
        companyHandle: row.companyHandle,
        state: stateOf(row),
        scope: row.scope,
        currentVersionId: row.currentVersionId
      })),
      withLifecycleTransaction
    )
  );
  const setSharing = Effect.fn("Patches.setSharing")(function* (input: SharingChange) {
    const { patchId, actor, expectedScope, expectedLifecycleRevision } = input;
    yield* lockDependencies(actor.userId);
    yield* sql`SELECT id FROM companies WHERE id = (SELECT company_id FROM users WHERE id = ${actor.userId}) FOR NO KEY UPDATE`;
    const row = yield* manageable(patchId, actor);
    if (input.expectedOwnerUserId !== undefined && row.ownerUserId !== input.expectedOwnerUserId)
      return yield* new StaleAction({ patchId });
    if (stateOf(row) !== "live") return yield* new WrongState({ state: stateOf(row) });
    if (
      expectedLifecycleRevision !== undefined &&
      row.lifecycleRevision !== expectedLifecycleRevision
    )
      return yield* new StaleAction({ patchId });
    if (expectedScope !== undefined && row.scope !== expectedScope)
      return yield* new StaleAction({ patchId });
    let chosen =
      input.audience ??
      (input.scope === "company" && row.audience.members.kind === "teams"
        ? row.audience
        : Audiences.company(input.scope));
    if (!actor.admin && chosen.members.kind === "teams" && row.audience.members.kind === "teams") {
      const visible = new Set(
        yield* Teams.memberships(row.companyId, actor.userId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql)
        )
      );
      chosen = {
        ...chosen,
        members: {
          kind: "teams",
          teamIds: [
            ...new Set([
              ...chosen.members.teamIds,
              ...row.audience.members.teamIds.filter((id) => !visible.has(id))
            ])
          ]
        }
      };
    }
    const scope = Audiences.scopeOf(chosen);
    if (scope === "public" && row.currentVersionId !== null) {
      const served = yield* findVersionById({ patchId, versionId: row.currentVersionId }).pipe(
        Effect.catchTags(dieOnSchemaError)
      );
      if (Option.isSome(served) && served.value.tier === 2) return yield* new Tier2NotPublic();
    }
    yield* validateAudience({
      audience: chosen,
      companyId: row.companyId,
      actorId: actor.userId,
      ownerId: row.ownerUserId,
      previous: row.audience
    });
    if (input.force && input.expectedDependants !== undefined) {
      const summary = yield* visibleDependants(row.id, row.companyId, actor.userId);
      if (
        summary.dependants.map((d) => d.patchId).join(",") + ":" + summary.hiddenCount !==
        input.expectedDependants
      )
        return yield* new HasDependants(summary);
    }
    yield* refuseAudienceNarrowing(row, chosen, actor, input.force);
    yield* saveAudience(patchId, row.companyId, chosen);
    const at = yield* now;
    yield* sql`UPDATE patches SET scope = ${scope}, updated_at = ${at},
        lifecycle_revision = lifecycle_revision + 1,
        last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'sharing changed' WHERE id = ${patchId}`;
    yield* announce(patchId);
    if (scope !== row.scope)
      yield* report({
        name: "patch.shared",
        principalId: actor.userId,
        companyId: row.companyId,
        properties: { ...changed(row, actor), scope, previousScope: row.scope }
      });
    return {
      id: row.id,
      scope,
      audience: chosen,
      name: row.name,
      companyHandle: row.companyHandle,
      currentVersionId: row.currentVersionId
    };
  }, withLifecycleTransaction);

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
    yield* refuseDependants(patchId, row.companyId, force, actor.userId);
    const at = yield* now;
    yield* sql`UPDATE patches SET retired_at = ${at}, retired_by = ${actor.userId},
        lifecycle_revision = lifecycle_revision + 1,
        updated_at = ${at}, last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'retired'
        WHERE id = ${patchId}`;
    yield* announce(patchId);
    yield* report({
      name: "patch.retired",
      principalId: actor.userId,
      companyId: row.companyId,
      properties: changed(row, actor)
    });
    return yield* afterChange(patchId);
  }, withLifecycleTransaction);
  const delete_ = Effect.fn("Patches.delete")(function* (
    patchId: string,
    actor: Actor,
    force?: boolean,
    expectedOwnerUserId?: string
  ) {
    yield* lockDependencies(actor.userId);
    const row = yield* manageable(patchId, actor);
    if (expectedOwnerUserId !== undefined && row.ownerUserId !== expectedOwnerUserId)
      return yield* new StaleAction({ patchId });
    const state = stateOf(row);
    if (state === "deleted") return yield* new WrongState({ state });
    if (state === "live") yield* refuseDependants(patchId, row.companyId, force, actor.userId);
    const at = yield* now;
    yield* sql`UPDATE patches SET deleted_at = ${at}, deleted_by = ${actor.userId},
        lifecycle_revision = lifecycle_revision + 1,
        updated_at = ${at}, last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'deleted'
        WHERE id = ${patchId}`;
    yield* announce(patchId);
    yield* report({
      name: "patch.deleted",
      principalId: actor.userId,
      companyId: row.companyId,
      properties: changed(row, actor)
    });
    return yield* afterChange(patchId);
  }, withLifecycleTransaction);
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
    const from = stateOf(row);
    if (from === "live") return yield* new WrongState({ state: from });
    const millis = yield* Clock.currentTimeMillis;
    const purgeMillis =
      row.deletedAt === null ? null : row.deletedAt.getTime() + Duration.toMillis(RECOVERY_WINDOW);
    if (purgeMillis !== null && millis >= purgeMillis)
      return yield* new PatchDeleted({
        purgeAt: DateTime.formatIso(DateTime.makeUnsafe(purgeMillis))
      });
    if (expectedState !== undefined && from !== expectedState)
      return yield* new StaleAction({ patchId });
    if (!force) {
      const rows = yield* offSources({ patchId, companyId: row.companyId }).pipe(
        Effect.catchTags(dieOnSchemaError)
      );
      if (rows.length > 0)
        return yield* new SourcesOff({
          sources: rows.map(({ name, table, store, ...source }) => ({
            ...source,
            ...(table === null ? { store: store! } : { table }),
            ...(name === null ? {} : { name })
          }))
        });
    }
    const at = stamp(millis);
    yield* sql`UPDATE patches SET retired_at = NULL, retired_by = NULL,
        lifecycle_revision = lifecycle_revision + 1,
        deleted_at = NULL, deleted_by = NULL, updated_at = ${at},
        last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'restored' WHERE id = ${patchId}`;
    yield* announce(patchId);
    yield* report({
      name: "patch.restored",
      principalId: actor.userId,
      companyId: row.companyId,
      properties: { ...changed(row, actor), from }
    });
    return yield* afterChange(patchId);
  }, withLifecycleTransaction);
  const rollback = Effect.fn("Patches.rollback")(function* (
    patchId: string,
    actor: Actor,
    versionNumber: number,
    expectedCurrentVersionId?: string | null,
    expectedOwnerUserId?: string
  ) {
    const row = yield* manageable(patchId, actor);
    if (expectedOwnerUserId !== undefined && row.ownerUserId !== expectedOwnerUserId)
      return yield* new StaleAction({ patchId });
    if (stateOf(row) !== "live") return yield* new WrongState({ state: stateOf(row) });
    if (expectedCurrentVersionId !== undefined && row.currentVersionId !== expectedCurrentVersionId)
      return yield* new StaleAction({ patchId });
    const version = yield* findVersionByNumber({ patchId, versionNumber }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
    if (Option.isNone(version)) return yield* new VersionUnavailable({ versionNumber });
    if (row.scope === "public" && version.value.tier === 2) return yield* new Tier2NotPublic();
    const at = yield* now;
    // The tab shows the title that version published with.
    yield* sql`UPDATE patches SET current_version_id = ${version.value.id}, updated_at = ${at},
        title = COALESCE((SELECT publish_response->>'title' FROM patch_versions
          WHERE id = ${version.value.id}), title),
        lifecycle_revision = lifecycle_revision + 1,
        last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = ${`rolled back to v${versionNumber}`} WHERE id = ${patchId}`;
    yield* announce(patchId);
    if (version.value.id !== row.currentVersionId) {
      const from =
        row.currentVersionId === null
          ? Option.none()
          : yield* findVersionById({ patchId, versionId: row.currentVersionId }).pipe(
              Effect.catchTags(dieOnSchemaError)
            );
      yield* report({
        name: "patch.rolled_back",
        principalId: actor.userId,
        companyId: row.companyId,
        properties: {
          ...changed(row, actor),
          versionNumber,
          fromVersionNumber: Option.getOrNull(Option.map(from, (current) => current.versionNumber))
        }
      });
    }
    return { patch: yield* afterChange(patchId), currentVersion: versionNumber };
  }, withLifecycleTransaction);
  const reassign = Effect.fn("Patches.reassign")(function* (
    patchId: string,
    actor: Actor,
    newOwnerUserId: string,
    expectedOwnerUserId?: string
  ) {
    const row = yield* manageable(patchId, actor);
    if (!actor.admin || row.actorRole === "member")
      return yield* new AdminRequired({ userId: actor.userId });
    if (expectedOwnerUserId !== undefined && row.ownerUserId !== expectedOwnerUserId)
      return yield* new StaleAction({ patchId });
    if (
      row.deletedAt !== null &&
      row.deletedAt.getTime() + Duration.toMillis(RECOVERY_WINDOW) <=
        (yield* Clock.currentTimeMillis)
    )
      return yield* new PatchUnavailable({ patchId });
    const target = yield* sql`SELECT id FROM users
        WHERE id = ${newOwnerUserId} AND company_id = ${row.companyId} AND deactivated_at IS NULL
        FOR SHARE`;
    if (target.length === 0 || !(yield* audienceOpen(toPatch(row), row.companyId, newOwnerUserId)))
      return yield* new InvalidOwner({ userId: newOwnerUserId });
    if (row.ownerUserId === newOwnerUserId) return toPatch(row);
    const at = yield* now;
    yield* sql`UPDATE patches SET owner_user_id = ${newOwnerUserId},
        reassigned_at = ${at}, reassigned_by = ${actor.userId}, updated_at = ${at},
        last_changed_at = ${at}, last_changed_by = ${actor.userId},
        last_changed_action = 'reassigned' WHERE id = ${patchId}`;
    yield* report({
      name: "patch.reassigned",
      principalId: actor.userId,
      companyId: row.companyId,
      properties: { patchId, ownerUserId: newOwnerUserId, fromUserId: row.ownerUserId }
    });
    yield* announce(patchId);
    return yield* afterChange(patchId);
  }, withLifecycleTransaction);
  const setDescription = Effect.fn("Patches.setDescription")(function* (
    patchId: string,
    actor: Actor,
    description: string,
    expectedDescriptionUpdatedAt?: string | null
  ) {
    const row = yield* manageable(patchId, actor, "content");
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

  const halfLifeSeconds = Duration.toSeconds(OPEN_HALF_LIFE);
  const reopenSeconds = Duration.toSeconds(REOPEN_WINDOW);
  // 2^(−age / half-life) as float8. The age is clamped to [0, 1000 half-lives], so a decade-old
  // row reads as nearly nothing instead of underflowing, and a clock that stepped back adds nothing.
  const halving = (age: Statement.Fragment) =>
    sql`power(0.5::float8,
      LEAST(GREATEST(0, extract(epoch FROM ${age})::float8) / ${halfLifeSeconds}, 1000))`;
  const upsertOpen = SqlSchema.findOneOption({
    Request: Schema.Struct({
      userId: Schema.String,
      patchId: Schema.String,
      versionId: Schema.String,
      nowMillis: Schema.Number
    }),
    Result: Schema.Struct({ inserted: Schema.Boolean }),
    execute: ({ userId, patchId, versionId, nowMillis }) => {
      // Only while the served version is still current: a read of v1 that finishes after v2 is
      // published must not mark v2 seen. Both opens decay to the later of the two instants, so a
      // late-arriving earlier open never moves the last open back.
      const latest = sql`GREATEST(patch_opens.last_opened_at, EXCLUDED.last_opened_at)`;
      // The new open adds its point only when it is `REOPEN_WINDOW` or more from the last one,
      // on either side, so flipping between two patches counts each about once; one inside the
      // window still moves the last open. The rule goes by arrival: opens at minutes 0, 18 and 9,
      // arriving in that order, count twice, since the row keeps only the last open.
      const apart = sql`abs(extract(epoch FROM EXCLUDED.last_opened_at - patch_opens.last_opened_at))`;
      // `xmax = 0` only on a row this statement inserted: the conflict path locks the existing
      // row before updating it, which stamps the new row's xmax. Concurrent inserts of one key
      // wait on the primary key, so exactly one of them inserts.
      return sql`INSERT INTO patch_opens (user_id, patch_id, last_opened_at, score)
        SELECT ${userId}, patches.id, ${stamp(nowMillis)}, 1 FROM patches
        WHERE patches.id = ${patchId} AND patches.current_version_id = ${versionId} AND ${serving}
        ON CONFLICT (user_id, patch_id) DO UPDATE SET
          score = patch_opens.score * ${halving(sql`${latest} - patch_opens.last_opened_at`)}
            + CASE WHEN ${apart} >= ${reopenSeconds}
              THEN ${halving(sql`${latest} - EXCLUDED.last_opened_at`)} ELSE 0 END,
          last_opened_at = ${latest}
        RETURNING xmax = 0 AS inserted`;
    }
  });
  const recordOpen = Effect.fn("Patches.recordOpen")(function* (
    userId: string,
    patchId: string,
    versionId: string
  ) {
    const row = yield* upsertOpen({
      userId,
      patchId,
      versionId,
      nowMillis: yield* Clock.currentTimeMillis
    });
    return Option.isSome(row) && row.value.inserted;
  }, Effect.catchTags(dieOnSchemaError));
  const openRows = SqlSchema.findAll({
    Request: Schema.Struct({ userId: Schema.String, nowMillis: Schema.Number }),
    Result: OpenRow,
    execute: ({ userId, nowMillis }) => sql`
      SELECT patch_id AS "patchId", last_opened_at AS "lastOpenedAt",
        patch_opens.score * ${halving(sql`${stamp(nowMillis)} - patch_opens.last_opened_at`)} AS score
      FROM patch_opens WHERE user_id = ${userId}`
  });
  const opens = Effect.fn("Patches.opens")(function* (userId: string) {
    const rows = yield* openRows({ userId, nowMillis: yield* Clock.currentTimeMillis });
    return rows.map((row): Open => ({
      patchId: row.patchId,
      lastOpenedAt: iso(row.lastOpenedAt),
      score: row.score
    }));
  }, Effect.catchTags(dieOnSchemaError));

  const publishedWithRows = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: Schema.Struct({ id: Schema.String }),
    execute: (tokenIds) => sql`
      SELECT p.id FROM patches p JOIN patch_versions v ON v.id = p.current_version_id
      WHERE v.created_by_machine_token_id IN ${sql.in(tokenIds)}
        AND p.deleted_at IS NULL AND p.retired_at IS NULL AND p.disabled_at IS NULL
      ORDER BY v.created_at, p.id LIMIT 1`
  });
  const publishedWith = Effect.fn("Patches.publishedWith")(function* (
    machineTokenIds: ReadonlyArray<string>
  ) {
    if (machineTokenIds.length === 0) return Option.none<string>();
    const [row] = yield* publishedWithRows(machineTokenIds);
    return Option.fromNullishOr(row?.id);
  }, Effect.catchTags(dieOnSchemaError));

  const listDeleted = Effect.fn("Patches.listDeleted")(function* (limit: number) {
    if (limit <= 0) return [];
    const rows = yield* listDeletedRows({ nowMillis: yield* Clock.currentTimeMillis, limit });
    return rows.map((row) => row.id);
  }, Effect.catchTags(dieOnSchemaError));

  const purgeTarget = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      companyId: Schema.String,
      ownerUserId: Schema.String,
      deletedAt: NullableStamp
    }),
    execute: (patchId) => sql`SELECT company_id AS "companyId", owner_user_id AS "ownerUserId",
      deleted_at AS "deletedAt" FROM patches WHERE id = ${patchId} FOR UPDATE`
  });
  const purgeDeleted = Effect.fn("Patches.purgeDeleted")(
    function* (patchId: string) {
      const target = yield* purgeTarget(patchId);
      if (Option.isNone(target) || target.value.deletedAt === null) return Option.none();
      const millis = yield* Clock.currentTimeMillis;
      if (target.value.deletedAt.getTime() + Duration.toMillis(RECOVERY_WINDOW) > millis)
        return Option.none();
      const { companyId, ownerUserId } = target.value;
      const removeRows = Effect.gen(function* () {
        yield* sql`INSERT INTO pending_patch_objects (object_key, expires_at, claimed)
          SELECT object_key, ${stamp(millis)}, true FROM patch_versions WHERE patch_id = ${patchId}
          UNION ALL
          SELECT server_object_key, ${stamp(millis)}, true FROM patch_versions
          WHERE patch_id = ${patchId} AND server_object_key IS NOT NULL
          UNION ALL
          SELECT repo_object_key, ${stamp(millis)}, true FROM patch_versions
          WHERE patch_id = ${patchId} AND repo_object_key IS NOT NULL`;
        const removed =
          yield* sql`DELETE FROM patch_versions WHERE patch_id = ${patchId} RETURNING id`;
        yield* sql`DELETE FROM patch_names WHERE patch_id = ${patchId}`;
        yield* sql`DELETE FROM patches WHERE id = ${patchId}`;
        yield* announce(patchId);
        return Option.some({ companyId, ownerUserId, versionCount: removed.length });
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
    withLifecycleTransaction,
    Effect.catchTags(dieOnSchemaError)
  );

  return Patches.of({
    management,
    managementHistory,
    sharingDependants,
    eligibleOwners,
    countQuotaPatches,
    authorizePublish,
    replay,
    preflight,
    inventory,
    read,
    list,
    portalCard,
    addressNotice,
    withDependencyLock,
    reportOnCommit: (event) =>
      Effect.flatMap(pendingLifecycle, (pending) =>
        pending === undefined
          ? Effect.die(new Error("reportOnCommit runs only inside withDependencyLock."))
          : Effect.sync(() => void pending.events.push(event))
      ),
    companyInventory,
    sharedTable,
    sharedStore,
    prepareObject,
    claimObjects,
    completeObject,
    record,
    manage,
    setSharing,
    resolveName,
    agentToolSummaries: agentToolSummariesOf,
    find,
    findForViewer,
    findRetained,
    recordVisit,
    recordOpen,
    opens,
    publishedWith,
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
