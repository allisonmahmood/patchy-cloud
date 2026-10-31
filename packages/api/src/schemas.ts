/**
 * One schema per wire shape. Everything the server sends or accepts on
 * `/api/*` is described here and nowhere else: the server encodes through
 * these, the CLI decodes through them, and `docs/API.md` is rendered from
 * them. Field names use `patch` naming — the wire renamed `draft → patch` when
 * this package was created, ahead of the tables and the code.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import { registry } from "@patchy/limits/registry";
import { Snapshot } from "./postgresSnapshot.js";
import { PostHogSnapshot } from "./posthogSnapshot.js";
import { PidgeonSnapshot } from "./pidgeonSnapshot.js";
import { AttioSnapshot } from "./attioSnapshot.js";
import { RepoKind, RepoSnapshot, RepoSummary } from "./repo.js";
import {
  HandlerDescriptors,
  HandlerModuleName,
  HandlerKind,
  HandlerName,
  handlerTablesValid,
  type HandlerSchema
} from "./handlers.js";

/** The `patchy` package version, `0.<id>.0` for the newest What's new release. */
export const CURRENT_RELEASE = "0.30.0";
export const MANIFEST_VERSION = 1;
export const WIRE_VERSION = 1;

/** A patch's public id: twelve lowercase letters or digits. */
export const PatchId = Schema.String.check(
  Schema.makeFilter((value: string) => /^[a-z0-9]{12}$/.test(value) || "Invalid patch ID.", {
    title: "PatchId"
  })
);

export const normalizeDescriptionText = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** A normalized description, with an empty string reserved for explicit clearing. */
export const DescriptionText = Schema.String.check(
  // Whitespace controls become spaces; all other controls are refused.
  Schema.makeFilter(
    (text) =>
      !/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/u.test(text) ||
      "Description contains control characters."
  ),
  Schema.makeFilter(
    (text) => text === "" || /\S/u.test(text) || "Description must not contain only whitespace."
  )
).pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter((text) => {
        let length = 0;
        for (let offset = 0; offset < text.length;) {
          if (++length > 500) return "Description must contain at most 500 Unicode code points.";
          offset += text.codePointAt(offset)! > 0xffff ? 2 : 1;
        }
        return true;
      })
    ),
    {
      decode: SchemaGetter.transform(normalizeDescriptionText),
      encode: SchemaGetter.transform((text) => text)
    }
  )
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
/** A publish from a copy older than the patch's newest version, and who published that one. */
export const Behind = failure(409, {
  code: Schema.Literal("behind"),
  baseVersion: Schema.Int,
  latestVersion: Schema.Int,
  publishedBy: Schema.Struct({ id: Schema.String, name: Schema.String }),
  publishedAt: Schema.String
});
export const PatchState = Schema.Literals(["live", "retired", "deleted"]);
export const PatchSourceState = Schema.Union([PatchState, Schema.Literal("gone")]);
const PatchOwner = Schema.Struct({ id: Schema.String, name: Schema.String });
export const NotOwner = failure(403, { code: Schema.Literal("not_owner"), owner: PatchOwner });
export const WrongState = failure(409, {
  code: Schema.Literal("wrong_state"),
  state: PatchState
});
export const PatchRetired = failure(409, { code: Schema.Literal("patch_retired") });
export const PatchDeleted = failure(409, {
  code: Schema.Literal("patch_deleted"),
  purgeAt: Schema.String
});
export const HasDependants = failure(409, {
  code: Schema.Literal("has_dependants"),
  dependants: Schema.Array(
    Schema.Struct({ patchId: PatchId, name: Schema.String, owner: PatchOwner })
  )
});
export const SourcesOff = failure(409, {
  code: Schema.Literal("sources_off"),
  sources: Schema.Array(
    Schema.Union([
      Schema.Struct({
        patchId: PatchId,
        name: Schema.optionalKey(Schema.String),
        table: Schema.String,
        state: PatchSourceState
      }),
      Schema.Struct({
        patchId: PatchId,
        name: Schema.optionalKey(Schema.String),
        store: Schema.String,
        state: PatchSourceState
      })
    ])
  )
});
export const ReservedName = failure(422, { code: Schema.Literal("reserved_name") });
export const InvalidDescription = failure(422, { code: Schema.Literal("invalid_description") });
export const VersionUnavailable = failure(422, { code: Schema.Literal("version_unavailable") });
export const Tier2NotPublic = failure(422, { code: Schema.Literal("tier2_not_public") });
export const PublishRefused = failure(422, {
  code: Schema.Literals([
    "release_mismatch",
    "invalid_manifest",
    "tier_mismatch",
    "has_primitives",
    "patch_not_openable",
    "connection_not_connected",
    "stale_generated"
  ])
});
export const NotAdditive = failure(422, {
  code: Schema.Literal("not_additive"),
  changes: Schema.Array(
    Schema.Struct({ object: Schema.String, change: Schema.String, fix: Schema.String })
  )
});
export const PublishUnavailable = failure(503, {
  code: Schema.Literals(["busy", "source_unavailable"])
});
export const RequestTargetTooLong = failure(414, {});

/** A per-minute bucket ran dry; `Retry-After` carries the same number of seconds. */
export const RateLimited = failure(429, {
  code: Schema.Literal("rate_limited"),
  retryAfterSeconds: Schema.Int
});

/** The user already holds `quota` non-deleted patches. Delete one to free a slot. */
export const PatchQuotaExceeded = failure(403, {
  code: Schema.Literal("live_patch_quota_exceeded"),
  quota: Schema.Int
});

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
  previousMachineTokenId: Schema.optionalKey(Schema.String),
  /** The `?s=` of the Final step panel's setup line, so the person's panel follows this login. */
  setupLink: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64)))
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
export const DefinitionName = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^[a-z][a-zA-Z0-9]{0,62}$/.test(value) ||
      "Definition names must be camelCase and at most 63 characters."
  )
);
const isDefinitionName = Schema.is(DefinitionName);
const definitions = <S extends Schema.Top>(value: S) =>
  Schema.Record(Schema.String, value).check(
    Schema.makeFilter(
      (record) =>
        Object.keys(record).every(isDefinitionName) ||
        "Definition names must be camelCase and at most 63 characters."
    )
  );
const modifiers = { optional: Schema.optionalKey(Schema.Boolean) };
const column = <const K extends string, S extends Schema.Top>(kind: K, value: S) =>
  Schema.Struct({
    kind: Schema.Literal(kind),
    ...modifiers,
    default: Schema.optionalKey(value)
  });

// PostgreSQL text has no NUL; jsonb also rejects unpaired UTF-16 surrogates.
const invalidPostgresText =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const everyInvalidPostgresText = new RegExp(invalidPostgresText, "g");
export const PostgresText = Schema.String.check(
  Schema.makeFilter(
    (value) => !invalidPostgresText.test(value) || "Text must be valid Unicode without NUL."
  )
);
/** Text `PostgresText` admits, with U+FFFD for what it refuses; for audit copies, never arguments. */
export const toPostgresText = (text: string) => text.replace(everyInvalidPostgresText, "\uFFFD");
const postgresJson = (value: typeof Schema.Json.Type): boolean => {
  if (typeof value === "string") return !invalidPostgresText.test(value);
  if (Array.isArray(value)) return value.every(postgresJson);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(
      ([key, item]) => !invalidPostgresText.test(key) && postgresJson(item)
    );
  }
  return true;
};
export const PostgresJson = Schema.Json.check(
  Schema.makeFilter(
    (value) => postgresJson(value) || "JSON strings and keys must be valid Unicode without NUL."
  )
);
export const IsoTimestamp = Schema.String.check(
  Schema.makeFilter((value) => {
    const parts =
      /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/.exec(
        value
      );
    if (parts === null) return "Expected an ISO timestamp with a timezone.";
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
    return (year > 0 && day > 0 && day <= days) || "Expected a valid calendar date.";
  })
);

/** Serializable definitions; no uploaded code is ever executed by the server. */
export const ColumnDefinition = Schema.Union([
  column("text", PostgresText),
  column(
    "integer",
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(-2147483648),
      Schema.isLessThanOrEqualTo(2147483647)
    )
  ),
  column("number", Schema.Number.check(Schema.isFinite())),
  column("boolean", Schema.Boolean),
  column("timestamp", Schema.Union([Schema.Literal("now"), IsoTimestamp])),
  column("json", PostgresJson),
  Schema.Struct({
    kind: Schema.Literal("member"),
    ...modifiers,
    default: Schema.optionalKey(Schema.Never)
  }),
  Schema.Struct({
    kind: Schema.Literal("ref"),
    table: NonEmptyText,
    ...modifiers,
    default: Schema.optionalKey(PostgresText)
  })
]).check(
  Schema.makeFilter(
    (column) =>
      !(column.optional === true && Object.hasOwn(column, "default")) ||
      "A defaulted column cannot be optional."
  ),
  Schema.makeFilter(
    (column) => column.default !== null || "A defaulted column cannot default to null."
  )
);
export const IndexDefinition = Schema.Struct({
  columns: Schema.Array(NonEmptyText).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  unique: Schema.optionalKey(Schema.Boolean)
});
const PrimitiveDescription = PostgresText.check(
  Schema.makeFilter(
    (value) => value.trim().length > 0 || "A primitive description must not be blank."
  )
);
export const TableDefinition = Schema.Struct({
  description: PrimitiveDescription,
  columns: definitions(ColumnDefinition).check(
    Schema.makeFilter(
      (columns) =>
        !["id", "createdAt", "updatedAt"].some((name) => Object.hasOwn(columns, name)) ||
        "System columns are reserved."
    ),
    Schema.makeFilter(
      (columns) =>
        Object.keys(columns).length <= 1597 || "A table supports at most 1597 defined columns."
    )
  ),
  indexes: definitions(IndexDefinition),
  shared: Schema.optionalKey(Schema.Boolean)
}).check(
  Schema.makeFilter(
    (table) =>
      Object.values(table.indexes).every((index) =>
        index.columns.every(
          (name) =>
            Object.hasOwn(table.columns, name) || ["id", "createdAt", "updatedAt"].includes(name)
        )
      ) || "An index names an unknown column."
  )
);
export const FileStoreDefinition = Schema.Struct({
  description: PrimitiveDescription,
  shared: Schema.optionalKey(Schema.Boolean)
});

export const FileContentType = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+\/[a-zA-Z0-9!#$%&'*+.^_`|~-]+(?:;[\x20-\x7e]+)?$/.test(value) ||
      "Content-Type must be a media type without control characters."
  )
);
/** Opaque staged authority; the host resolves metadata before invoking an action. */
export const Upload = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(1)),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentType: FileContentType
});
export type Upload = typeof Upload.Type;

const handlerScalars = {
  text: PostgresText,
  integer: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(-2147483648),
    Schema.isLessThanOrEqualTo(2147483647)
  ),
  number: Schema.Number.check(Schema.isFinite()),
  boolean: Schema.Boolean,
  timestamp: IsoTimestamp,
  json: Schema.Json
};
type HandlerTables = Readonly<Record<string, typeof TableDefinition.Type>>;

/** Compile descriptors before invocation; no handler code is loaded or called here. */
export const handlerValueSchema = (
  descriptor: HandlerSchema,
  tables: HandlerTables
): Schema.Codec<unknown> => {
  switch (descriptor.kind) {
    case "text":
    case "integer":
    case "number":
    case "boolean":
    case "timestamp":
    case "json":
      return handlerScalars[descriptor.kind];
    case "object":
      return handlerArgsSchema(descriptor.fields, tables);
    case "array":
      return Schema.Array(handlerValueSchema(descriptor.element, tables));
    case "enum":
      return Schema.Literals(descriptor.values);
    case "nullable":
      return Schema.NullOr(handlerValueSchema(descriptor.value, tables));
    case "fileHandle":
      return Schema.String.check(
        Schema.isBetweenLength(
          registry["files.handle.length"].default,
          registry["files.handle.length"].default
        )
      );
    case "upload":
      return Upload;
    case "row": {
      const table = Object.hasOwn(tables, descriptor.table) ? tables[descriptor.table] : undefined;
      if (table === undefined) throw new TypeError(`Unknown row table "${descriptor.table}".`);
      const fields: Record<string, Schema.Codec<unknown>> = {
        id: PostgresText.check(Schema.isMinLength(1)),
        createdAt: IsoTimestamp,
        updatedAt: IsoTimestamp,
        ...Object.fromEntries(
          Object.entries(table.columns).map(([name, column]) => {
            const value =
              column.kind === "ref" || column.kind === "member"
                ? PostgresText
                : column.kind === "json"
                  ? PostgresJson.check(
                      Schema.makeFilter((value) => value !== null || "Column is not nullable.")
                    )
                  : handlerScalars[column.kind];
            return [name, column.optional === true ? Schema.NullOr(value) : value];
          })
        )
      };
      return Schema.Struct(fields);
    }
  }
};

/** Argument optionality omits a key; table optionality permits a null value. */
export const handlerArgsSchema = (
  fields: Readonly<Record<string, HandlerSchema>>,
  tables: HandlerTables
) =>
  Schema.Struct(
    Object.fromEntries(
      Object.entries(fields).map(([name, descriptor]) => {
        const value = handlerValueSchema(descriptor, tables);
        return [name, descriptor.optional === true ? Schema.optionalKey(value) : value];
      })
    )
  );
export const PostgresDeclaration = Schema.Struct({
  kind: Schema.Literal("postgres"),
  handle: NonEmptyText,
  id: NonEmptyText,
  revision: Revision
});
export const PostHogDeclaration = Schema.Struct({
  ...PostgresDeclaration.fields,
  kind: Schema.Literal("posthog")
});
/** One company email address on Pidgeon. */
export const PidgeonDeclaration = Schema.Struct({
  ...PostgresDeclaration.fields,
  kind: Schema.Literal("pidgeon")
});
/** One Attio workspace, read-only. */
export const AttioDeclaration = Schema.Struct({
  ...PostgresDeclaration.fields,
  kind: Schema.Literal("attio")
});
/** A company connection a version declares, bound to its identity and metadata revision. */
export const ConnectionDeclaration = Schema.Union([
  PostgresDeclaration,
  PostHogDeclaration,
  PidgeonDeclaration,
  AttioDeclaration
]);
export type ConnectionDeclaration = typeof ConnectionDeclaration.Type;
/** Stable shared-table identity; a patch name never participates in resolution. */
export const sharedTableId = (patchId: string, table: string): string => `${patchId}/${table}`;

export const SharedTableDeclaration = Schema.Struct({
  kind: Schema.Literal("sharedTable"),
  patchId: PatchId,
  table: DefinitionName,
  id: NonEmptyText,
  revision: Revision
});

/** Stable shared-store identity; a patch name never participates in resolution. */
export const sharedStoreId = (patchId: string, store: string): string => `${patchId}/${store}`;
export const SharedStoreDeclaration = Schema.Struct({
  kind: Schema.Literal("sharedStore"),
  patchId: PatchId,
  store: DefinitionName,
  id: NonEmptyText,
  revision: Revision
});
export const MembersDeclaration = Schema.Struct({ kind: Schema.Literal("members") });
const memberColumnsValid = Schema.makeFilter(
  (manifest: {
    readonly tables: Readonly<Record<string, typeof TableDefinition.Type>>;
    readonly uses: Readonly<Record<string, { readonly kind: string }>>;
  }) => {
    if (
      Object.entries(manifest.uses).some(
        ([alias, use]) => use.kind === "members" && alias !== "members"
      )
    )
      return 'The members declaration must use the name "members".';
    return (
      manifest.uses.members?.kind === "members" ||
      !Object.values(manifest.tables).some((table) =>
        Object.values(table.columns).some((column) => column.kind === "member")
      ) ||
      "Member columns require the members declaration."
    );
  }
);
const distinctPrimitiveNames = Schema.makeFilter(
  (manifest: {
    readonly tables: Readonly<Record<string, unknown>>;
    readonly files: Readonly<Record<string, unknown>>;
  }) => {
    const name = Object.keys(manifest.tables).find((name) => Object.hasOwn(manifest.files, name));
    return (
      name === undefined || `Table "${name}" and file store "${name}" must have different names.`
    );
  }
);

/**
 * The SDK's entry points, by the code that may import them. The CLI builds
 * only from these and records the ones a patch imports as the manifest's
 * `sdkImports`; publish events report only listed entries, since the
 * manifest is client supplied.
 */
export const SDK_ENTRY_POINTS: {
  readonly [Graph in "page" | "server" | "generated"]: ReadonlyArray<string>;
} = {
  page: [
    "patchy/preact",
    "patchy/preact/jsx-runtime",
    "patchy/preact/jsx-dev-runtime",
    "patchy/csv",
    "patchy/hotkeys"
  ],
  server: ["patchy/server", "patchy/csv"],
  /** Imported only by the generated client under `patchy/_generated`. */
  generated: ["patchy/client"]
};

export const Manifest = Schema.Struct({
  manifestVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  release: NonEmptyText,
  name: Schema.optionalKey(PatchName),
  description: Schema.optionalKey(Schema.String),
  tier: Schema.Literals([1, 2, 3]),
  tables: definitions(TableDefinition),
  files: definitions(FileStoreDefinition),
  uses: definitions(
    Schema.Union([
      PostgresDeclaration,
      PostHogDeclaration,
      PidgeonDeclaration,
      AttioDeclaration,
      SharedTableDeclaration,
      SharedStoreDeclaration,
      MembersDeclaration
    ])
  ),
  handlers: Schema.optionalKey(HandlerDescriptors),
  sdkImports: Schema.optionalKey(Schema.Array(NonEmptyText))
}).check(distinctPrimitiveNames, memberColumnsValid, Schema.makeFilter(handlerTablesValid));

/**
 * Below tier 2 a patch reaches only its own tables and files, so it declares no `uses`:
 * connections, other patches' shared tables and stores, and the member directory are reached
 * through tier 2 handlers. Publish, generation and the CLI refuse with this message.
 */
export const usesRefusal = (tier: number, aliases: readonly string[]): string | undefined =>
  tier >= 2 || aliases.length === 0
    ? undefined
    : `uses requires tier 2: tier ${tier} reaches only its own tables and files, so it cannot declare ${aliases.map((alias) => JSON.stringify(alias)).join(", ")}. Set tier 2 and reach them from server handlers, or delete them all from uses in patchy.config.ts; then run \`patchy refresh\`.`;

/** Generation resolves declarations; existing stamps are hints, never authority. */
export const GenerationManifest = Schema.Struct({
  ...Manifest.fields,
  uses: definitions(
    Schema.Union([
      MembersDeclaration,
      Schema.Struct({
        ...PostgresDeclaration.fields,
        id: Schema.optionalKey(NonEmptyText),
        revision: Schema.optionalKey(Revision)
      }),
      Schema.Struct({
        ...PostHogDeclaration.fields,
        id: Schema.optionalKey(NonEmptyText),
        revision: Schema.optionalKey(Revision)
      }),
      Schema.Struct({
        ...PidgeonDeclaration.fields,
        id: Schema.optionalKey(NonEmptyText),
        revision: Schema.optionalKey(Revision)
      }),
      Schema.Struct({
        ...AttioDeclaration.fields,
        id: Schema.optionalKey(NonEmptyText),
        revision: Schema.optionalKey(Revision)
      }),
      Schema.Struct({
        ...SharedTableDeclaration.fields,
        id: Schema.optionalKey(NonEmptyText),
        revision: Schema.optionalKey(Revision)
      }),
      Schema.Struct({
        ...SharedStoreDeclaration.fields,
        id: Schema.optionalKey(NonEmptyText),
        revision: Schema.optionalKey(Revision)
      })
    ])
  )
}).check(distinctPrimitiveNames, memberColumnsValid, Schema.makeFilter(handlerTablesValid));

/** Every integration Patchy ships; a connection's handle is unique within its integration. */
export const integrations = ["postgres", "posthog", "pidgeon", "attio"] as const;
export const Integration = Schema.Literals(integrations);
export type Integration = typeof Integration.Type;

export const ConnectionSummary = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  integration: Integration,
  description: Schema.String,
  status: Schema.Literals(["connected", "disconnected"]),
  hint: Schema.String,
  reason: Schema.optionalKey(Schema.Literal("not_connected")),
  /** A Pidgeon connection made with a test key: its mail stays in Pidgeon. Absent otherwise. */
  test: Schema.optionalKey(Schema.Literal(true))
});

export const Connections = Schema.Struct({
  connections: Schema.Array(ConnectionSummary),
  offered: Schema.optionalKey(
    Schema.Array(Schema.Struct({ integration: Integration, connected: Schema.Boolean }))
  )
});

const detail = <const I extends Integration, F extends Schema.Struct.Fields>(
  integration: I,
  snapshot: F
) =>
  Schema.Struct({
    integration: Schema.Literal(integration),
    handle: ConnectionSummary.fields.handle,
    description: ConnectionSummary.fields.description,
    status: ConnectionSummary.fields.status,
    snapshot: Schema.NullOr(
      Schema.Struct({ ...snapshot, revision: Revision, takenAt: Schema.String })
    )
  });
/** What the legacy `/connections/:handle` route answers, as CLIs from before PostHog decode it. */
export const PostgresConnectionDetail = detail("postgres", Snapshot.fields);
export const PostHogConnectionDetail = detail("posthog", PostHogSnapshot.fields);
export const PidgeonConnectionDetail = detail("pidgeon", PidgeonSnapshot.fields);
export const AttioConnectionDetail = detail("attio", AttioSnapshot.fields);
/** One connection and its current metadata, in its integration's shape. */
export const ConnectionDetail = Schema.Union([
  PostgresConnectionDetail,
  PostHogConnectionDetail,
  PidgeonConnectionDetail,
  AttioConnectionDetail
]);
export type ConnectionDetail = typeof ConnectionDetail.Type;

export const ConnectionUnavailable = failure(503, {
  code: Schema.Literal("connection_storage_failed")
});

export const GenerateRequest = Schema.Struct({
  release: NonEmptyText,
  manifest: GenerationManifest,
  serverModules: Schema.Array(HandlerModuleName).annotate({
    description:
      "One-level server/*.ts filename stems discovered locally for tier 2; empty for tier 1. Used only for type-only imports, independently of manifest.handlers."
  }),
  patchId: Schema.optionalKey(PatchId),
  skills: Schema.Array(NonEmptyText)
});

/** Portable relative paths only; the CLI additionally rejects filesystem symlinks. */
export const isManagedOutputPath = (path: string): boolean => {
  if (!/^[a-zA-Z0-9_./-]+$/.test(path)) return false;
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  if (path === "patchy/_generated/manifest.json") return false;
  return (
    path.startsWith("patchy/_generated/") ||
    /^\.agents\/skills\/patchy-[a-z0-9-]+\/SKILL\.md$/.test(path) ||
    /^fixtures\/(?:postgres-[a-z0-9-]+|shared-[a-z][a-zA-Z0-9]*)\.sql$/.test(path) ||
    /^fixtures\/shared-[a-z][a-zA-Z0-9]*\/README\.md$/.test(path)
  );
};
export const DeclarationMetadata = Schema.Struct({
  postgres: Schema.Record(
    Schema.String,
    Schema.Struct({ declaration: PostgresDeclaration, snapshot: Snapshot })
  ),
  posthog: Schema.Record(
    Schema.String,
    Schema.Struct({ declaration: PostHogDeclaration, snapshot: PostHogSnapshot })
  ),
  // A release before Pidgeon generates none, which reads as no Pidgeon declarations: after a
  // rollback, this CLI still reads that release's generation.
  pidgeon: Schema.Record(
    Schema.String,
    Schema.Struct({ declaration: PidgeonDeclaration, snapshot: PidgeonSnapshot })
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  // As for Pidgeon: a release before Attio generates none.
  attio: Schema.Record(
    Schema.String,
    Schema.Struct({ declaration: AttioDeclaration, snapshot: AttioSnapshot })
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  shared: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.Struct({
        declaration: SharedTableDeclaration,
        tables: Schema.Record(Schema.String, TableDefinition),
        uses: Schema.Record(Schema.String, SharedTableDeclaration)
      }),
      Schema.Struct({
        declaration: SharedStoreDeclaration,
        definition: FileStoreDefinition
      })
    ])
  )
});

export const Generated = Schema.Struct({
  ok: Schema.Literal(true),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.makeFilter(isManagedOutputPath)),
      contents: Schema.String
    })
  ),
  metadata: DeclarationMetadata,
  uses: Schema.Array(Schema.Struct({ alias: DefinitionName, id: NonEmptyText, revision: Revision }))
});

/** Cumulative definitions, independent of the currently served version. */
export class PatchInventory extends Schema.Class<PatchInventory>("PatchInventory")({
  schemaRevision: Revision,
  tables: definitions(TableDefinition),
  files: definitions(FileStoreDefinition)
}) {}

/** Discovery uses the cumulative inventory, not just the served manifest. */
export const PatchStateFilter = Schema.Literals(["live", "retired", "all"]);
export class PatchSummary extends Schema.Class<PatchSummary>("PatchSummary")({
  id: PatchId,
  name: Schema.String,
  address: Schema.String,
  owner: Schema.Struct({ ...PatchOwner.fields, deactivated: Schema.Boolean }),
  mine: Schema.Boolean,
  tier: Schema.Int,
  scope: SharingScope,
  description: Schema.String,
  state: PatchState,
  retiredAt: Schema.NullOr(IsoTimestamp),
  deletedAt: Schema.NullOr(IsoTimestamp),
  purgeAt: Schema.NullOr(IsoTimestamp),
  currentVersion: Schema.Int,
  publishedAt: IsoTimestamp
}) {}

export const PatchTableSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  shared: Schema.Boolean,
  declarable: Schema.Boolean,
  reason: Schema.optionalKey(Schema.Literals(["not_shared", "source_off"])),
  hint: Schema.optionalKey(Schema.String)
});
export const PatchStoreSummary = Schema.Struct({ ...PatchTableSummary.fields });
export const PatchRead = Schema.Union([
  Schema.Struct({
    alias: Schema.String,
    patchId: PatchId,
    name: Schema.optionalKey(Schema.String),
    table: Schema.String,
    state: PatchSourceState
  }),
  Schema.Struct({
    alias: Schema.String,
    patchId: PatchId,
    name: Schema.optionalKey(Schema.String),
    store: Schema.String,
    state: PatchSourceState
  })
]);
export class PatchDetail extends Schema.Class<PatchDetail>("PatchDetail")({
  ...PatchSummary.fields,
  title: Schema.String,
  descriptionUpdatedAt: Schema.NullOr(IsoTimestamp),
  inventory: Schema.NullOr(
    Schema.Struct({
      tables: Schema.Array(PatchTableSummary),
      stores: Schema.Array(PatchStoreSummary)
    })
  ),
  reads: Schema.Array(PatchRead),
  /**
   * What `patchy pull` would get for the current version, or null when it has nothing. Absent
   * from an instance older than repo snapshots.
   */
  repo: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ versionNumber: Schema.Int, kind: RepoKind, ...RepoSummary.fields })
    )
  )
}) {}

/** One version's repo snapshot, or a file-born page's one file, for `patchy pull`. */
export class PatchRepo extends Schema.Class<PatchRepo>("PatchRepo")({
  ok: Schema.Literal(true),
  patchId: PatchId,
  name: Schema.String,
  state: PatchState,
  versionNumber: Schema.Int,
  tier: Schema.Int,
  owner: PatchOwner,
  description: Schema.String,
  descriptionUpdatedAt: Schema.NullOr(IsoTimestamp),
  kind: RepoKind,
  files: RepoSnapshot
}) {}

/** A version published without a snapshot: before Patchy kept them, or by a hand-made request. */
export const NoRepo = failure(404, {
  code: Schema.Literal("no_repo"),
  versionNumber: Schema.Int,
  owner: PatchOwner
});

/** A missing default differs from an explicit JSON null. Stores have no columns or indexes. */
export class PrimitiveDetail extends Schema.Class<PrimitiveDetail>("PrimitiveDetail")({
  kind: Schema.Literals(["table", "store"]),
  name: Schema.String,
  description: Schema.String,
  shared: Schema.Boolean,
  declarable: Schema.Boolean,
  reason: Schema.optionalKey(Schema.Literals(["not_shared", "source_off"])),
  hint: Schema.optionalKey(Schema.String),
  schemaRevision: Revision,
  columns: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      kind: Schema.Literals([
        "text",
        "integer",
        "number",
        "boolean",
        "timestamp",
        "json",
        "ref",
        "member"
      ]),
      optional: Schema.Boolean,
      default: Schema.optionalKey(Schema.Json),
      ref: Schema.optionalKey(Schema.String)
    })
  ),
  indexes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      columns: Schema.Array(Schema.String),
      unique: Schema.Boolean
    })
  )
}) {}

const ToolchainVersion = Schema.Struct({
  testedAgainst: NonEmptyText,
  accepted: NonEmptyText
});

export const ReleaseToolchain = Schema.Struct({
  vite: ToolchainVersion,
  "vite-plugin-singlefile": ToolchainVersion,
  typescript: ToolchainVersion,
  "@types/node": ToolchainVersion
});

/** The package integrity is the sha512 SRI of the bytes at the immutable tarball URL. */
export class Release extends Schema.Class<Release>("Release")({
  release: NonEmptyText,
  package: Schema.Struct({
    tarball: Schema.String,
    integrity: Schema.String.check(Schema.isPattern(/^sha512-[A-Za-z0-9+/]{86}==$/))
  }),
  manifestVersion: Schema.Int,
  wireVersion: Schema.Int,
  toolchain: ReleaseToolchain
}) {}

/**
 * A look revision as a repo names it. Revision numbers restart in every company, so a revision is
 * its number and its time.
 */
export const LookStamp = Schema.Struct({ revision: Schema.Int, createdAt: IsoTimestamp });

/** What the CLI knows about where a document came from. Every field is optional. */
export class PublishMetadata extends Schema.Class<PublishMetadata>("PublishMetadata")({
  filename: OptionalText,
  repoOrg: OptionalText,
  repoName: OptionalText,
  gitBranch: OptionalText,
  gitCommitSha: OptionalText,
  cliVersion: OptionalText,
  fileSha256: OptionalText,
  description: Schema.optionalKey(Schema.String),
  /**
   * The look a repo's page builds in: null for the Patchy look, or a company revision. Absent
   * means no check: a page without the look, a file publish, or an attempt from an older CLI.
   */
  look: Schema.optionalKey(Schema.NullOr(LookStamp))
}) {}

/** One durable attempt, resent unchanged after a lost acknowledgement. */
export class PublishRequest extends Schema.Class<PublishRequest>("PublishRequest")({
  manifest: Manifest,
  html: Schema.String,
  server: Schema.optionalKey(Schema.String),
  /**
   * The repo the bundle was built from, kept with the version for `patchy pull`. The CLI sends it
   * on every repo publish; a file publish has none.
   */
  repo: Schema.optionalKey(RepoSnapshot),
  /**
   * The version the publishing copy was pulled from or last published as. When the patch has a
   * newer one, publish refuses with `behind`; leave it out to publish over it.
   */
  baseVersion: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  patchId: Schema.optionalKey(PatchId),
  scope: Schema.optionalKey(SharingScope),
  force: Schema.optionalKey(Schema.Boolean),
  publishKey: NonEmptyText,
  metadata: PublishMetadata
}) {}

export const ProvisioningReport = Schema.Struct({
  tables: Schema.Array(Schema.String),
  columns: Schema.Array(Schema.String),
  indexes: Schema.Array(Schema.String),
  stores: Schema.Array(Schema.String)
});
export const ArtifactMetadata = Schema.Struct({
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
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
  tier: Manifest.fields.tier,
  schemaRevision: Schema.Int,
  provisioned: ProvisioningReport,
  unused: ProvisioningReport,
  artifacts: Schema.Struct({
    html: ArtifactMetadata,
    server: Schema.optionalKey(ArtifactMetadata),
    repo: Schema.optionalKey(RepoSummary)
  }),
  handlers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: HandlerName, kind: HandlerKind }))
  ),
  warnings: Schema.Array(Schema.String),
  description: Schema.String,
  descriptionUpdatedAt: Schema.NullOr(Schema.String)
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

export class ForceRequest extends Schema.Class<ForceRequest>("ForceRequest")({
  force: Schema.optionalKey(Schema.Boolean)
}) {}

export class Retired extends Schema.Class<Retired>("Retired")({
  ok: Schema.Literal(true),
  patchId: PatchId,
  state: Schema.Literal("retired"),
  retiredAt: Schema.String
}) {}

export class Deleted extends Schema.Class<Deleted>("Deleted")({
  ok: Schema.Literal(true),
  patchId: PatchId,
  state: Schema.Literal("deleted"),
  deletedAt: Schema.String,
  purgeAt: Schema.String
}) {}

export class Restored extends Schema.Class<Restored>("Restored")({
  ok: Schema.Literal(true),
  patchId: PatchId,
  state: Schema.Literal("live")
}) {}

export class RollbackRequest extends Schema.Class<RollbackRequest>("RollbackRequest")({
  versionNumber: Schema.Int.check(Schema.isGreaterThan(0))
}) {}

export class RolledBack extends Schema.Class<RolledBack>("RolledBack")({
  ok: Schema.Literal(true),
  patchId: PatchId,
  currentVersion: Schema.Int,
  address: Schema.String
}) {}

export class DescriptionRequest extends Schema.Class<DescriptionRequest>("DescriptionRequest")({
  description: Schema.String
}) {}

export class Described extends Schema.Class<Described>("Described")({
  ok: Schema.Literal(true),
  patchId: PatchId,
  description: Schema.String,
  descriptionUpdatedAt: Schema.NullOr(Schema.String)
}) {}

/** How a logged handler or call settled; `unknown_outcome` once its deadline passed unrecorded. */
export const LogOutcome = Schema.Literals([
  "pending",
  "success",
  "handler_error",
  "failure",
  "handler_timeout",
  "unknown_outcome"
]);

/** A step inside a log entry: a nested handler, or an operation a handler made. */
export const LogStep = Schema.Struct({
  type: Schema.Literals(["invocation", "call"]),
  id: Schema.String,
  /** The entry or nested handler that made this step. */
  parentId: Schema.String,
  at: IsoTimestamp,
  /** The handler's name for a nested handler; an operation such as `tables.insert` for a call. */
  name: Schema.String,
  kind: Schema.NullOr(HandlerKind),
  resource: Schema.NullOr(Schema.String),
  /** The company connection a call went to as `integration/handle`, or its id once deleted. */
  connection: Schema.NullOr(Schema.String),
  /** `patch`, or the user id a call acted as. */
  effectivePrincipal: Schema.String,
  outcome: LogOutcome,
  code: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Int),
  attempts: Schema.Int,
  rowCount: Schema.NullOr(Schema.Int),
  logLines: Schema.Array(Schema.Json)
});

/** One top-level handler call in a patch's log, with the steps it made. */
export const LogEntry = Schema.Struct({
  id: Schema.String,
  /** The id a browser's failure reports, to find the entry a person saw fail. */
  correlationId: Schema.String,
  startedAt: IsoTimestamp,
  settledAt: Schema.NullOr(IsoTimestamp),
  /** The version number the call ran; null only for a version no longer retained. */
  version: Schema.NullOr(Schema.Int),
  handler: Schema.String,
  kind: HandlerKind,
  /**
   * Who made the call, from their page or through their agent; `name` is null for someone no
   * longer in the company.
   */
  viewer: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  /**
   * The agent the viewer called through, by the client name they approved at consent, so the
   * call reads "Jordan Lee via Claude"; null for their page's call. An instance from before
   * agents sends none, which reads as null.
   */
  agent: Schema.NullOr(Schema.Struct({ name: Schema.String })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  outcome: LogOutcome,
  code: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Int),
  guestMs: Schema.Int,
  dbMs: Schema.Int,
  callbacks: Schema.Int,
  attempts: Schema.Int,
  /** False when the page never received the reply; the outcome is still the real one. */
  replyDelivered: Schema.Boolean,
  /** `ctx.log` lines, and a thrown error's message and stack. */
  logLines: Schema.Array(Schema.Json),
  /** The retained steps, outermost first, each after its parent. */
  steps: Schema.Array(LogStep),
  /** The entry made more steps than `steps` holds. */
  stepsTruncated: Schema.Boolean
});
export type LogEntry = typeof LogEntry.Type;

/** At most this many entries per page; the default is `LOG_PAGE_DEFAULT`. */
export const LOG_PAGE_MAX = 25;
export const LOG_PAGE_DEFAULT = 10;

/** `GET /api/patches/:patchId/log`: one page of a patch's log, newest first. */
export class PatchLog extends Schema.Class<PatchLog>("PatchLog")({
  ok: Schema.Literal(true),
  patchId: PatchId,
  entries: Schema.Array(LogEntry),
  /** Pass as `before` to read older entries; null at the start of the log. */
  next: Schema.NullOr(Schema.String),
  /** A `failed` read stopped at the edge of the entries it searches; `next` carries on past it. */
  windowEnded: Schema.Boolean
}) {}

export class Ok extends Schema.Class<Ok>("Ok")({ ok: Schema.Literal(true) }) {}

// --- look -----------------------------------------------------------------

/** A look revision's files by name, as `@patchy/core/look` checks them. `logo.svg` is optional. */
export const LookFiles = Schema.Struct({
  "look.css": Schema.String,
  "LOOK.md": Schema.String,
  "logo.svg": Schema.optionalKey(Schema.String)
});

/** Why a revision exists, such as "darker green": one line, whitespace runs collapsed. */
export const LookNote = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.makeFilter((note) => note !== "" || "A look note must not be empty."),
      Schema.makeFilter(
        (note) => [...note].length <= 200 || "A look note must be at most 200 characters."
      ),
      Schema.makeFilter(
        (note) =>
          !/[\u0000-\u001f\u007f-\u009f]/u.test(note) ||
          "A look note must not contain control characters."
      )
    ),
    {
      decode: SchemaGetter.transform(normalizeDescriptionText),
      encode: SchemaGetter.transform((note) => note)
    }
  )
);

/** One revision of the company's look: its number, who published it, when and why. */
export class LookRevision extends Schema.Class<LookRevision>("LookRevision")({
  revision: Schema.Int,
  author: Schema.Struct({ id: Schema.String, name: Schema.String }),
  createdAt: IsoTimestamp,
  note: Schema.String
}) {}

/**
 * The company's latest look restore: who moved the pointer, when, and the note they gave, null
 * without one. A later restore replaces it and a publish clears it, so it is never a history.
 */
export const LookRestore = Schema.Struct({
  by: Schema.Struct({ id: Schema.String, name: Schema.String }),
  at: IsoTimestamp,
  note: Schema.NullOr(Schema.String)
});

/** The Patchy look's files as the look read carries them: never a logo, which is Patchy's mark. */
export const PatchyLookFiles = Schema.Struct({
  "look.css": Schema.String,
  "LOOK.md": Schema.String
});

/** Who can change a company's look: its active admins. */
const LookAdmins = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));

/**
 * The current revision with its files, or null for no look, and every revision newest first.
 * `patchyLook` is the Patchy look's `look.css` and `LOOK.md`, without Patchy's logo, when the
 * company has no look and it stands in; null otherwise. `admins` can change the look.
 * `restored` is the latest restore, null after a publish; an instance from before restores were
 * recorded leaves it out.
 */
export class CompanyLook extends Schema.Class<CompanyLook>("CompanyLook")({
  current: Schema.NullOr(Schema.Struct({ ...LookRevision.fields, files: LookFiles })),
  revisions: Schema.Array(LookRevision),
  patchyLook: Schema.NullOr(PatchyLookFiles),
  admins: LookAdmins,
  restored: Schema.optionalKey(Schema.NullOr(LookRestore))
}) {}

export class LookPublishRequest extends Schema.Class<LookPublishRequest>("LookPublishRequest")({
  note: LookNote,
  files: LookFiles
}) {}

export class LookPublished extends Schema.Class<LookPublished>("LookPublished")(
  { ok: Schema.Literal(true), current: LookRevision },
  { httpApiStatus: 201 }
) {}

/**
 * A revision number to make current, or null to leave the company with no look, and optionally
 * why, as the person gave it.
 */
export class LookRestoreRequest extends Schema.Class<LookRestoreRequest>("LookRestoreRequest")({
  revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  note: Schema.optionalKey(LookNote)
}) {}

/** The current revision after a restore, and the restore record as it now stands. */
export class LookRestored extends Schema.Class<LookRestored>("LookRestored")({
  ok: Schema.Literal(true),
  current: Schema.NullOr(LookRevision),
  restored: Schema.optionalKey(Schema.NullOr(LookRestore))
}) {}

/** Only admins change the look; `admins` names who to ask. */
export const AdminRequired = failure(403, {
  code: Schema.Literal("admin_required"),
  admins: LookAdmins
});
/** The look failed its checks; `errors` names each failure, and nothing was stored. */
export const InvalidLook = failure(422, {
  code: Schema.Literal("invalid_look"),
  errors: Schema.Array(Schema.String)
});
export const LookRevisionUnavailable = failure(422, {
  code: Schema.Literal("revision_unavailable")
});
