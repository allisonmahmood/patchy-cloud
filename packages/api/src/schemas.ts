/**
 * One schema per wire shape. Everything the server sends or accepts on
 * `/api/*` is described here and nowhere else: the server encodes through
 * these, the CLI decodes through them, and `docs/API.md` is rendered from
 * them. Field names use `patch` naming — the wire renamed `draft → patch` when
 * this package was created, ahead of the tables and the code.
 */
import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { isPatchId } from "@patchy/core";

export const CURRENT_RELEASE = "0.0.1";
export const MANIFEST_VERSION = 1;
export const WIRE_VERSION = 1;

/** A patch's public id: twelve lowercase letters or digits. */
export const PatchId = Schema.String.check(
  Schema.makeFilter((value: string) => isPatchId(value) || "Invalid patch ID.", {
    title: "PatchId"
  })
);

/** A request field a client may leave out or send as null. */
const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String));

// --- errors ---------------------------------------------------------------

/**
 * Every refusal is `{ ok: false, error }` plus, on the ones a client branches
 * on, a `code` and the number it needs. Plain structs, not tagged errors: a
 * `_tag` would be a new field on the wire.
 */
const failure = <Fields extends Schema.Struct.Fields>(status: number, fields: Fields) =>
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String, ...fields }).pipe(
    HttpApiSchema.status(status)
  );

export const BadRequest = failure(400, {});
/** A missing credential and a bad one answer the same sentence, so the wire never says which. */
export const Unauthorized = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Literal("Missing or invalid API token.")
}).pipe(HttpApiSchema.status(401));
export const NotFound = failure(404, {});
export const Conflict = failure(409, {});
export const PayloadTooLarge = failure(413, {});
export const PublishKeyConflict = failure(409, { code: Schema.Literal("publish_key_conflict") });
export const NameTaken = failure(409, { code: Schema.Literal("name_taken") });
export const PublishRefused = failure(422, {
  code: Schema.Literals(["release_mismatch", "invalid_manifest", "tier_mismatch"])
});
export const RequestTargetTooLong = failure(414, {});

/** A per-minute bucket ran dry; `Retry-After` carries the same number of seconds. */
export const RateLimited = failure(429, {
  code: Schema.Literal("rate_limited"),
  retryAfterSeconds: Schema.Int
});

/** The user already holds `quota` live patches. Delete one or let one expire. */
export const PatchQuotaExceeded = failure(403, {
  code: Schema.Literal("live_patch_quota_exceeded"),
  quota: Schema.Int
});

/** The document failed the safe-HTML policy. Nothing was stored. */
export const InvalidHtml = Schema.Struct({
  ok: Schema.Literal(false),
  errors: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String)
}).pipe(HttpApiSchema.status(422));

// --- auth -----------------------------------------------------------------

/** `GET /api/me`: who the bearer token is. */
export class Identity extends Schema.Class<Identity>("Identity")({
  user: Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String }),
  company: Schema.Struct({ id: Schema.String, handle: Schema.String, name: Schema.String }),
  role: Schema.Literals(["member", "admin"]),
  machine: Schema.Struct({ id: Schema.String, name: Schema.String })
}) {}

/** The bearer revoked itself; a racing logout may have revoked it first. */
export class LoggedOut extends Schema.Class<LoggedOut>("LoggedOut")({
  ok: Schema.Literal(true),
  alreadyRevoked: Schema.Boolean
}) {}

/** Begin a browser-confirmed login for this machine; no bearer is required. */
export class StartDeviceLoginRequest extends Schema.Class<StartDeviceLoginRequest>(
  "StartDeviceLoginRequest"
)({
  machineNameHint: Schema.String,
  previousMachineTokenId: Schema.optionalKey(Schema.String)
}) {}

export class DeviceLoginStarted extends Schema.Class<DeviceLoginStarted>("DeviceLoginStarted")(
  {
    ok: Schema.Literal(true),
    deviceCode: Schema.String,
    userCode: Schema.String,
    verificationUrl: Schema.String,
    verificationUrlBare: Schema.String,
    interval: Schema.Literal(5),
    expiresAt: Schema.String
  },
  { httpApiStatus: 201 }
) {}

export class PollDeviceLoginRequest extends Schema.Class<PollDeviceLoginRequest>(
  "PollDeviceLoginRequest"
)({
  deviceCode: Schema.String
}) {}

export class DeviceLoginWaiting extends Schema.Class<DeviceLoginWaiting>("DeviceLoginWaiting")({
  ok: Schema.Literal(true),
  status: Schema.Literals(["pending", "slow_down"])
}) {}

/** The completing poll returns the plaintext token and confirming identity together. */
export class DeviceLoginComplete extends Schema.Class<DeviceLoginComplete>("DeviceLoginComplete")({
  ok: Schema.Literal(true),
  status: Schema.Literal("complete"),
  token: Schema.String,
  machine: Schema.Struct({ id: Schema.String, name: Schema.String }),
  company: Schema.Struct({ handle: Schema.String, name: Schema.String }),
  user: Schema.Struct({ email: Schema.String }),
  expiresAt: Schema.String
}) {}

export const DeviceLoginPoll = Schema.Union([DeviceLoginWaiting, DeviceLoginComplete]);

export const DeviceLoginGone = failure(410, {
  code: Schema.Literals(["expired", "denied", "unknown"])
});

// --- patches --------------------------------------------------------------

/** Who may open a patch: signed-in company members, or anyone with the link. */
export const SharingScope = Schema.Literals(["company", "public"]);

/** The company-handle grammar, in a company's patch namespace. */
export const PatchName = Schema.String.check(
  Schema.makeFilter(
    (value) => /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(value) || "Invalid patch name."
  )
);

const NonEmptyText = Schema.String.check(Schema.isMinLength(1));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const definitionName = /^[a-z][a-zA-Z0-9]*$/;
const definitions = <S extends Schema.Top>(value: S) =>
  Schema.Record(Schema.String, value).check(
    Schema.makeFilter(
      (record) =>
        Object.keys(record).every((name) => definitionName.test(name)) ||
        "Definition names must be camelCase."
    )
  );
const modifiers = { optional: Schema.optionalKey(Schema.Boolean) };
const column = <const K extends string, S extends Schema.Top>(kind: K, value: S) =>
  Schema.Struct({
    kind: Schema.Literal(kind),
    ...modifiers,
    default: Schema.optionalKey(value)
  });

/** Serializable definitions; no uploaded code is ever executed by the server. */
export const ColumnDefinition = Schema.Union([
  column("text", Schema.String),
  column("integer", Schema.Int),
  column("number", Schema.Number.check(Schema.isFinite())),
  column("boolean", Schema.Boolean),
  column(
    "timestamp",
    Schema.String.check(
      Schema.makeFilter(
        (value) =>
          value === "now" ||
          (!Number.isNaN(Date.parse(value)) && value.includes("T")) ||
          "Expected an ISO timestamp or now."
      )
    )
  ),
  column("json", Schema.Json),
  Schema.Struct({
    kind: Schema.Literal("ref"),
    table: NonEmptyText,
    ...modifiers,
    default: Schema.optionalKey(Schema.String)
  })
]).check(
  Schema.makeFilter(
    (column) =>
      !(column.optional === true && Object.hasOwn(column, "default")) ||
      "A defaulted column cannot be optional."
  )
);
export const IndexDefinition = Schema.Struct({
  columns: Schema.Array(NonEmptyText).check(Schema.isMinLength(1)),
  unique: Schema.optionalKey(Schema.Boolean)
});
export const TableDefinition = Schema.Struct({
  columns: definitions(ColumnDefinition).check(
    Schema.makeFilter(
      (columns) =>
        !["id", "createdAt", "updatedAt"].some((name) => name in columns) ||
        "System columns are reserved."
    )
  ),
  indexes: definitions(IndexDefinition),
  shared: Schema.optionalKey(Schema.Boolean)
}).check(
  Schema.makeFilter(
    (table) =>
      Object.values(table.indexes).every((index) =>
        index.columns.every(
          (name) => name in table.columns || ["id", "createdAt", "updatedAt"].includes(name)
        )
      ) || "An index names an unknown column."
  )
);
export const FileStoreDefinition = Schema.Record(Schema.String, Schema.Never);
export const PostgresDeclaration = Schema.Struct({
  kind: Schema.Literal("postgres"),
  handle: NonEmptyText,
  id: NonEmptyText,
  revision: Revision
});
export const SharedTableDeclaration = Schema.Struct({
  kind: Schema.Literal("sharedTable"),
  patchId: PatchId,
  table: NonEmptyText,
  id: NonEmptyText,
  revision: Revision
});
export const Manifest = Schema.Struct({
  manifestVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  release: NonEmptyText,
  name: Schema.optionalKey(PatchName),
  tier: Schema.Literals([0, 1, 2, 3]),
  tables: definitions(TableDefinition),
  files: definitions(FileStoreDefinition),
  uses: definitions(Schema.Union([PostgresDeclaration, SharedTableDeclaration]))
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/** Integrity is absent until the instance has a real package artifact to hash. */
export class Release extends Schema.Class<Release>("Release")({
  release: NonEmptyText,
  package: Schema.Struct({ tarball: Schema.String, integrity: Schema.NullOr(Schema.String) }),
  manifestVersion: Schema.Int,
  wireVersion: Schema.Int
}) {}

/** What the CLI knows about where a document came from. Every field is optional. */
export class PublishMetadata extends Schema.Class<PublishMetadata>("PublishMetadata")({
  filename: OptionalText,
  repoOrg: OptionalText,
  repoName: OptionalText,
  gitBranch: OptionalText,
  gitCommitSha: OptionalText,
  cliVersion: OptionalText,
  fileSha256: OptionalText
}) {}

/** One durable attempt, resent unchanged after a lost acknowledgement. */
export class PublishRequest extends Schema.Class<PublishRequest>("PublishRequest")({
  manifest: Manifest,
  html: Schema.String,
  patchId: Schema.optionalKey(PatchId),
  scope: Schema.optionalKey(SharingScope),
  publishKey: NonEmptyText,
  metadata: PublishMetadata
}) {}

export const ProvisioningReport = Schema.Struct({
  tables: Schema.Array(Schema.String),
  columns: Schema.Array(Schema.String),
  indexes: Schema.Array(Schema.String),
  stores: Schema.Array(Schema.String)
});
const publishFields = {
  ok: Schema.Literal(true),
  patchId: PatchId,
  versionId: Schema.String,
  versionNumber: Schema.Int,
  title: Schema.String,
  name: PatchName,
  address: Schema.String,
  publicUrl: Schema.String,
  scope: SharingScope,
  tier: Schema.Int,
  schemaRevision: Schema.Int,
  provisioned: ProvisioningReport,
  unused: ProvisioningReport,
  warnings: Schema.Array(Schema.String)
};

export class PublishCreated extends Schema.Class<PublishCreated>("PublishCreated")(publishFields, {
  httpApiStatus: 201
}) {}
export class PublishUpdated extends Schema.Class<PublishUpdated>("PublishUpdated")(publishFields) {}

/** Change an owned patch's sharing without publishing a version. */
export class ShareRequest extends Schema.Class<ShareRequest>("ShareRequest")({
  scope: SharingScope
}) {}

export class Shared extends Schema.Class<Shared>("Shared")({
  ok: Schema.Literal(true),
  patchId: PatchId,
  scope: SharingScope,
  publicUrl: Schema.String
}) {}

export class Ok extends Schema.Class<Ok>("Ok")({ ok: Schema.Literal(true) }) {}
