/**
 * One schema per wire shape. Everything the server sends or accepts on
 * `/api/*` is described here and nowhere else: the server encodes through
 * these, the CLI decodes through them, and `docs/API.md` is rendered from
 * them. Field names use `patch` naming — the wire renamed `draft → patch` when
 * this package was created, ahead of the tables and the code.
 */
import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { isDraftId } from "@patchy/core";

/** A patch's public id: twelve lowercase letters or digits. */
export const PatchId = Schema.String.check(
  Schema.makeFilter((value: string) => isDraftId(value) || "Invalid patch ID.", {
    title: "PatchId"
  })
);

/** A moment on the wire is an ISO-8601 string, as the database already hands it out. */
const Timestamp = Schema.String.annotate({ title: "Timestamp" });

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
export const Unauthorized = failure(401, {});
export const Forbidden = failure(403, {});
export const NotFound = failure(404, {});
export const Conflict = failure(409, {});
export const PayloadTooLarge = failure(413, {});
export const RequestTargetTooLong = failure(414, {});

/** A per-minute bucket ran dry; `Retry-After` carries the same number of seconds. */
export const RateLimited = failure(429, {
  code: Schema.Literal("rate_limited"),
  retryAfterSeconds: Schema.Int
});

/** The instance keeps its tokens to itself. Ask its operator for one. */
export const SelfServiceDisabled = failure(403, {
  code: Schema.Literal("self_service_disabled")
});

/** This address has minted `quota` tokens in the last 24 hours. */
export const MintQuotaExceeded = failure(429, {
  code: Schema.Literal("mint_quota_exceeded"),
  quota: Schema.Int
});

/** The token already holds `quota` live patches. Delete one or let one expire. */
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
  accountId: Schema.String,
  accountName: Schema.String,
  apiTokenId: Schema.String,
  apiTokenName: Schema.String,
  scopes: Schema.Array(Schema.String)
}) {}

/** The plaintext appears here exactly once; only its hash is stored. */
export class MintedToken extends Schema.Class<MintedToken>("MintedToken")(
  {
    ok: Schema.Literal(true),
    token: Schema.String
  },
  { httpApiStatus: 201 }
) {}

export class CreateTokenRequest extends Schema.Class<CreateTokenRequest>("CreateTokenRequest")({
  name: OptionalText,
  scopes: Schema.optionalKey(Schema.Array(Schema.String))
}) {}

export class CreatedToken extends Schema.Class<CreatedToken>("CreatedToken")(
  {
    ok: Schema.Literal(true),
    apiToken: Schema.Struct({ id: Schema.String, name: Schema.String }),
    token: Schema.String
  },
  { httpApiStatus: 201 }
) {}

/** Idempotent: revoking twice answers the same, with the first moment intact. */
export class RevokedToken extends Schema.Class<RevokedToken>("RevokedToken")({
  ok: Schema.Literal(true),
  alreadyRevoked: Schema.Boolean,
  apiToken: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    principalId: Schema.String,
    revokedAt: Timestamp
  })
}) {}

// --- patches --------------------------------------------------------------

/** What the CLI knows about where a document came from. Every field is optional. */
export class UploadMetadata extends Schema.Class<UploadMetadata>("UploadMetadata")({
  repoOrg: OptionalText,
  repoName: OptionalText,
  gitBranch: OptionalText,
  gitCommitSha: OptionalText,
  cliVersion: OptionalText,
  fileSha256: OptionalText
}) {}

/** `POST /api/uploads`: with a `patchId` it updates that patch, without one it creates. */
export class UploadRequest extends Schema.Class<UploadRequest>("UploadRequest")({
  html: Schema.String,
  filename: OptionalText,
  patchId: Schema.optionalKey(Schema.NullOr(PatchId)),
  metadata: Schema.optionalKey(UploadMetadata)
}) {}

const uploadFields = {
  ok: Schema.Literal(true),
  patchId: PatchId,
  versionId: Schema.String,
  versionNumber: Schema.Int,
  title: Schema.String,
  publicUrl: Schema.String,
  warnings: Schema.Array(Schema.String)
};

/** A create: 201, and the patch is new. */
export class UploadCreated extends Schema.Class<UploadCreated>("UploadCreated")(uploadFields, {
  httpApiStatus: 201
}) {}
/** An update: 200, and `versionNumber` moved. */
export class UploadUpdated extends Schema.Class<UploadUpdated>("UploadUpdated")(uploadFields) {}

export class DisableRequest extends Schema.Class<DisableRequest>("DisableRequest")({
  reason: OptionalText
}) {}

export class Ok extends Schema.Class<Ok>("Ok")({ ok: Schema.Literal(true) }) {}

export class Pinned extends Schema.Class<Pinned>("Pinned")({
  ok: Schema.Literal(true),
  pinned: Schema.Boolean
}) {}

/**
 * A patch as the moderation surface reports it: the principal behind it and
 * the token that created it, which is what revocation acts on. Answers for
 * disabled, deleted and expired patches too — an operator is asked about pages
 * that are off as often as pages that are on.
 */
export class ModeratedPatch extends Schema.Class<ModeratedPatch>("ModeratedPatch")({
  id: PatchId,
  principalId: Schema.String,
  createdByApiTokenId: Schema.NullOr(Schema.String),
  title: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: Timestamp,
  pinnedAt: Schema.NullOr(Timestamp),
  deletedAt: Schema.NullOr(Timestamp),
  disabledAt: Schema.NullOr(Timestamp),
  disabledReason: Schema.NullOr(Schema.String)
}) {}

export class PatchView extends Schema.Class<PatchView>("PatchView")({
  ok: Schema.Literal(true),
  patch: ModeratedPatch
}) {}

/** Newest first, deleted patches omitted. `truncated` says the list is not whole. */
export class PrincipalPatches extends Schema.Class<PrincipalPatches>("PrincipalPatches")({
  ok: Schema.Literal(true),
  principalId: Schema.String,
  patches: Schema.Array(ModeratedPatch),
  truncated: Schema.Boolean
}) {}
