import { Schema } from "effect";

const StringArraySchema = Schema.Array(Schema.String);
const NullableStringSchema = Schema.NullOr(Schema.String);

export const UploadMetadataSchema = Schema.Struct({
  repoOrg: Schema.optionalKey(NullableStringSchema),
  repoName: Schema.optionalKey(NullableStringSchema),
  gitBranch: Schema.optionalKey(NullableStringSchema),
  gitCommitSha: Schema.optionalKey(NullableStringSchema),
  cliVersion: Schema.optionalKey(NullableStringSchema),
  fileSha256: Schema.optionalKey(NullableStringSchema)
});
export type UploadMetadata = typeof UploadMetadataSchema.Type;

export const HtmlValidationResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  errors: StringArraySchema,
  warnings: StringArraySchema,
  title: NullableStringSchema
});
export type HtmlValidationResult = typeof HtmlValidationResultSchema.Type;

export const ApiErrorResponseSchema = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(StringArraySchema),
  warnings: Schema.optionalKey(StringArraySchema),
  code: Schema.optionalKey(Schema.String),
  quota: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
  retryAfterSeconds: Schema.optionalKey(Schema.Number)
});
export type ApiErrorResponse = typeof ApiErrorResponseSchema.Type;

export const OkResponseSchema = Schema.Struct({ ok: Schema.Literal(true) });
export type OkResponse = typeof OkResponseSchema.Type;

export const MeResponseSchema = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.String,
  apiTokenId: Schema.String,
  apiTokenName: Schema.String,
  scopes: StringArraySchema
});
export type MeResponse = typeof MeResponseSchema.Type;

export const TokenCreateRequestSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  scopes: Schema.optionalKey(StringArraySchema)
});
export type TokenCreateRequest = typeof TokenCreateRequestSchema.Type;

const ApiTokenSummarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String
});

export const TokenCreateResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  apiToken: ApiTokenSummarySchema,
  token: Schema.String
});
export type TokenCreateResponse = typeof TokenCreateResponseSchema.Type;

export const SelfServiceTokenRequestSchema = Schema.Record(Schema.String, Schema.Never);
export type SelfServiceTokenRequest = typeof SelfServiceTokenRequestSchema.Type;

export const SelfServiceTokenResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  token: Schema.String
});
export type SelfServiceTokenResponse = typeof SelfServiceTokenResponseSchema.Type;

const RevokedApiTokenSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  principalId: Schema.String,
  revokedAt: Schema.String
});

export const TokenRevokeResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  alreadyRevoked: Schema.Boolean,
  apiToken: RevokedApiTokenSchema
});
export type TokenRevokeResponse = typeof TokenRevokeResponseSchema.Type;

export const ModerationDraftSchema = Schema.Struct({
  id: Schema.String,
  principalId: Schema.String,
  createdByApiTokenId: NullableStringSchema,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
  pinnedAt: NullableStringSchema,
  deletedAt: NullableStringSchema,
  disabledAt: NullableStringSchema,
  disabledReason: NullableStringSchema
});
export type ModerationDraft = typeof ModerationDraftSchema.Type;

export const ModerationDraftResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  draft: ModerationDraftSchema
});
export type ModerationDraftResponse = typeof ModerationDraftResponseSchema.Type;

export const PrincipalDraftsResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  principalId: Schema.String,
  drafts: Schema.Array(ModerationDraftSchema),
  truncated: Schema.Boolean
});
export type PrincipalDraftsResponse = typeof PrincipalDraftsResponseSchema.Type;

export const UploadRequestSchema = Schema.Struct({
  html: Schema.String,
  filename: Schema.optionalKey(Schema.String),
  draftId: Schema.optionalKey(NullableStringSchema),
  metadata: Schema.optionalKey(UploadMetadataSchema)
});
export type UploadRequest = typeof UploadRequestSchema.Type;

export const UploadResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  draftId: Schema.String,
  versionId: Schema.String,
  versionNumber: Schema.Number,
  title: Schema.String,
  publicUrl: Schema.String,
  warnings: StringArraySchema
});
export type UploadResponse = typeof UploadResponseSchema.Type;

export const DisableDraftRequestSchema = Schema.Struct({
  reason: Schema.optionalKey(Schema.String)
});
export type DisableDraftRequest = typeof DisableDraftRequestSchema.Type;

export const PinDraftResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  pinned: Schema.Boolean
});
export type PinDraftResponse = typeof PinDraftResponseSchema.Type;

export const AuthSetOutputSchema = Schema.Struct({
  ok: Schema.Literal(true),
  instanceUrl: Schema.String
});
export type AuthSetOutput = typeof AuthSetOutputSchema.Type;

export const StatusReportSchema = Schema.Struct({
  instanceUrl: Schema.String,
  instanceSource: Schema.Literals(["flag", "env", "config", "default"]),
  hasToken: Schema.Boolean,
  tokenSource: Schema.NullOr(Schema.Literals(["mint", "auth-set"])),
  stateDir: Schema.String,
  hasDefaultStyle: Schema.Boolean,
  cliVersion: Schema.String
});
export type StatusReport = typeof StatusReportSchema.Type;

const strictWireOptions = { onExcessProperty: "error" } as const;

export function makeWireDecoder<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  return Schema.decodeUnknownSync(schema, strictWireOptions);
}

export function makeWireEncoder<S extends Schema.ConstraintEncoder<unknown>>(schema: S) {
  return Schema.encodeSync(schema, strictWireOptions);
}

export function decodeWire<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown
): S["Type"] {
  return makeWireDecoder(schema)(input);
}

export function encodeWire<S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  input: S["Type"]
): S["Encoded"] {
  return makeWireEncoder(schema)(input);
}

type WireContract = {
  readonly summary: string;
  readonly schema: Schema.Constraint;
};

type ApiRouteContract = WireContract & {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly authentication: "None" | "Bearer token" | "Bearer token with admin scope";
  readonly successStatus: number | string;
  readonly request?: Schema.Constraint;
};

export const apiRoutes = [
  {
    method: "GET",
    path: "/healthz",
    authentication: "None",
    successStatus: 200,
    summary: "Report whether the instance process is healthy.",
    schema: OkResponseSchema
  },
  {
    method: "GET",
    path: "/api/me",
    authentication: "Bearer token",
    successStatus: 200,
    summary: "Return the principal and API token represented by the credential.",
    schema: MeResponseSchema
  },
  {
    method: "POST",
    path: "/api/tokens",
    authentication: "Bearer token with admin scope",
    successStatus: 201,
    summary: "Mint an API token for the authenticated principal.",
    request: TokenCreateRequestSchema,
    schema: TokenCreateResponseSchema
  },
  {
    method: "POST",
    path: "/api/tokens/self-service",
    authentication: "None",
    successStatus: 201,
    summary: "Mint a self-service principal and its first publishing token.",
    request: SelfServiceTokenRequestSchema,
    schema: SelfServiceTokenResponseSchema
  },
  {
    method: "POST",
    path: "/api/tokens/:apiTokenId/revoke",
    authentication: "Bearer token with admin scope",
    successStatus: 200,
    summary: "Revoke an API token without deleting its record.",
    schema: TokenRevokeResponseSchema
  },
  {
    method: "GET",
    path: "/api/drafts/:draftId",
    authentication: "Bearer token with admin scope",
    successStatus: 200,
    summary: "Read one draft through the moderation view.",
    schema: ModerationDraftResponseSchema
  },
  {
    method: "GET",
    path: "/api/principals/:principalId/drafts",
    authentication: "Bearer token with admin scope",
    successStatus: 200,
    summary: "List the drafts owned by one principal for moderation.",
    schema: PrincipalDraftsResponseSchema
  },
  {
    method: "POST",
    path: "/api/uploads",
    authentication: "Bearer token",
    successStatus: "200 for an update; 201 for a create",
    summary: "Create a draft or add a version to an existing draft.",
    request: UploadRequestSchema,
    schema: UploadResponseSchema
  },
  {
    method: "POST",
    path: "/api/drafts/:draftId/disable",
    authentication: "Bearer token",
    successStatus: 200,
    summary: "Take a draft out of service while retaining it.",
    request: DisableDraftRequestSchema,
    schema: OkResponseSchema
  },
  {
    method: "POST",
    path: "/api/drafts/:draftId/pin",
    authentication: "Bearer token with admin scope",
    successStatus: 200,
    summary: "Exempt an active draft from expiry.",
    schema: PinDraftResponseSchema
  },
  {
    method: "POST",
    path: "/api/drafts/:draftId/unpin",
    authentication: "Bearer token with admin scope",
    successStatus: 200,
    summary: "Return a draft to ordinary expiry behavior.",
    schema: PinDraftResponseSchema
  },
  {
    method: "DELETE",
    path: "/api/drafts/:draftId",
    authentication: "Bearer token",
    successStatus: 200,
    summary: "Permanently delete a draft.",
    schema: OkResponseSchema
  }
] as const satisfies ReadonlyArray<ApiRouteContract>;

export const cliJsonOutputs = [
  {
    command: "auth set",
    summary: "Confirm where the credential was stored without exposing it.",
    schema: AuthSetOutputSchema
  },
  {
    command: "whoami",
    summary: "Print the exact identity response returned by the instance.",
    schema: MeResponseSchema
  },
  {
    command: "status",
    summary: "Report local publishing state for the resolved instance.",
    schema: StatusReportSchema
  },
  {
    command: "validate",
    summary: "Report the complete local HTML validation result.",
    schema: HtmlValidationResultSchema
  },
  {
    command: "upload",
    summary: "Print the exact successful upload response returned by the instance.",
    schema: UploadResponseSchema
  }
] as const satisfies ReadonlyArray<WireContract & { readonly command: string }>;

function jsonSchema(schema: Schema.Constraint): string {
  return JSON.stringify(Schema.toJsonSchemaDocument(schema).schema, null, 2);
}

export function renderApiReference(): string {
  const lines = [
    "# Patchy Cloud API",
    "",
    "<!-- Generated from packages/core/src/wire.ts. Do not edit by hand. -->",
    "",
    "Every JSON shape below is generated from the Effect Schema used at runtime by the server and CLI.",
    "API errors use the shared error shape after the route-specific success response.",
    "",
    "## HTTP API",
    ""
  ];

  for (const route of apiRoutes) {
    lines.push(
      `### \`${route.method} ${route.path}\``,
      "",
      route.summary,
      "",
      `Authentication: ${route.authentication}.`,
      ""
    );
    if ("request" in route) {
      lines.push(
        "Request body:",
        "",
        "<!-- prettier-ignore -->",
        "```json",
        jsonSchema(route.request),
        "```",
        ""
      );
    }
    lines.push(
      `Success response (${route.successStatus}):`,
      "",
      "<!-- prettier-ignore -->",
      "```json",
      jsonSchema(route.schema),
      "```",
      ""
    );
  }

  lines.push(
    "### API error response",
    "",
    "Routes can return the following shared error shape with a non-2xx status. Fields beyond `ok` are present when relevant to the failure.",
    "",
    "<!-- prettier-ignore -->",
    "```json",
    jsonSchema(ApiErrorResponseSchema),
    "```",
    "",
    "## CLI `--json` output",
    "",
    "Each command keeps its human-readable default and prints only the documented shape when `--json` is supplied.",
    ""
  );

  for (const output of cliJsonOutputs) {
    lines.push(
      `### \`patchy ${output.command} --json\``,
      "",
      output.summary,
      "",
      "<!-- prettier-ignore -->",
      "```json",
      jsonSchema(output.schema),
      "```",
      ""
    );
  }

  return `${lines.join("\n")}\n`;
}
