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

export class Ok extends Schema.Class<Ok>("Ok")({ ok: Schema.Literal(true) }) {}
