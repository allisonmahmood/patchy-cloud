// @effect-diagnostics nodeBuiltinImport:off
// The config entrypoint loads this Node-only process boundary only when execution is requested.
import { fork } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line no-restricted-imports -- Promise code in the child process that runs a config, outside Effect.
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefinitionName,
  GenerationManifest,
  Manifest,
  PatchName,
  MembersDeclaration,
  PostgresDeclaration,
  PostHogDeclaration,
  PidgeonDeclaration,
  AttioDeclaration,
  SharedTableDeclaration,
  SharedStoreDeclaration,
  sharedStoreId,
  sharedTableId,
  usesRefusal
} from "@patchy/api";
import * as Schema from "effect/Schema";
import type {
  ColumnKind,
  Declaration,
  FileStoreDefinition,
  IndexDefinition,
  Json
} from "./config.js";
import type { HandlerDescriptor } from "./server.js";
import { LocalError } from "./CliError.js";
import { MANIFEST_VERSION, RELEASE } from "./release.js";

/** Portable declaration types: bundling Effect's schema types leaks its type dependencies. */
type ManifestColumn = {
  [K in ColumnKind]: {
    readonly kind: K;
    readonly optional?: boolean;
    readonly default?: K extends "member"
      ? never
      : K extends "json"
        ? Json
        : K extends "integer" | "number"
          ? number
          : K extends "boolean"
            ? boolean
            : string;
  } & (K extends "ref" ? { readonly table: string } : unknown);
}[ColumnKind];

/** Dependency-free public data shape; config.types.ts checks equivalence to the API schema. */
export interface ExecutedManifest {
  readonly manifestVersion: number;
  readonly release: string;
  readonly name?: string;
  readonly description?: string;
  readonly tier: 1 | 2 | 3;
  readonly handlers?: Readonly<Record<string, HandlerDescriptor>>;
  readonly sdkImports?: readonly string[];
  readonly tables: Readonly<
    Record<
      string,
      {
        readonly description: string;
        readonly columns: Readonly<Record<string, ManifestColumn>>;
        readonly indexes: Readonly<Record<string, IndexDefinition>>;
        readonly shared?: boolean;
      }
    >
  >;
  readonly files: Readonly<Record<string, FileStoreDefinition>>;
  readonly uses: Readonly<
    Record<
      string,
      | Extract<Declaration, { readonly kind: "members" }>
      | (Exclude<Declaration, { readonly kind: "members" }> & {
          readonly id: string;
          readonly revision: number;
        })
    >
  >;
}

/** Generation resolves declarations on the instance, before there can be local stamps. */
export type UnresolvedManifest = Omit<ExecutedManifest, "uses"> & {
  readonly uses: Readonly<Record<string, Declaration>>;
};

const configSchema = Schema.Struct({
  name: PatchName,
  tier: Manifest.fields.tier,
  tables: Manifest.fields.tables,
  files: Manifest.fields.files,
  uses: Schema.Record(
    Schema.String,
    Schema.Union([
      MembersDeclaration,
      Schema.Struct({
        kind: PostgresDeclaration.fields.kind,
        handle: PostgresDeclaration.fields.handle
      }),
      Schema.Struct({
        kind: PostHogDeclaration.fields.kind,
        handle: PostHogDeclaration.fields.handle
      }),
      Schema.Struct({
        kind: PidgeonDeclaration.fields.kind,
        handle: PidgeonDeclaration.fields.handle
      }),
      Schema.Struct({
        kind: AttioDeclaration.fields.kind,
        handle: AttioDeclaration.fields.handle
      }),
      Schema.Struct({
        kind: SharedStoreDeclaration.fields.kind,
        patchId: SharedStoreDeclaration.fields.patchId,
        store: SharedStoreDeclaration.fields.store
      }),
      Schema.Struct({
        kind: SharedTableDeclaration.fields.kind,
        patchId: SharedTableDeclaration.fields.patchId,
        table: SharedTableDeclaration.fields.table
      })
    ])
  )
});
const generatedIndexSchema = Schema.Struct({
  release: Schema.Literal(RELEASE),
  manifestVersion: Schema.Literal(MANIFEST_VERSION),
  uses: Schema.Array(
    Schema.Struct({
      alias: Schema.String,
      id: PostgresDeclaration.fields.id,
      declaration: Schema.Union([
        PostgresDeclaration,
        PostHogDeclaration,
        PidgeonDeclaration,
        AttioDeclaration,
        SharedTableDeclaration,
        SharedStoreDeclaration
      ]),
      revision: PostgresDeclaration.fields.revision
    })
  )
});
const decodeConfig = Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" });
const decodeIndex = Schema.decodeUnknownSync(Schema.fromJsonString(generatedIndexSchema));
const decodeManifest = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" });
const decodeGenerationManifest = Schema.decodeUnknownSync(GenerationManifest, {
  onExcessProperty: "error"
});
const childMessageSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), config: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String })
]);
const decodeMessage = Schema.decodeUnknownSync(childMessageSchema);

export class StaleGenerated extends Error {
  readonly code = "stale_generated";
  constructor(options?: ErrorOptions) {
    super("declarations changed; run `patchy refresh`", options);
  }
}

/** Tier 0's static pages became tier 1 pages; a config written before then still names tier 0. */
class TierZero extends Error {
  readonly code = "tier_mismatch";
  constructor() {
    super("Tier 0 is now tier 1. Set `tier: 1` and run `patchy refresh`.");
  }
}

class PrimitiveNameCollision extends Schema.TaggedError<PrimitiveNameCollision>()(
  "PrimitiveNameCollision",
  { definitionName: DefinitionName, cause: Schema.Defect() }
) {
  override get message() {
    return `Table "${this.definitionName}" and file store "${this.definitionName}" must have different names.`;
  }
}
const isPrimitiveNameCollision = Schema.is(PrimitiveNameCollision);

class DescribedColumn extends Schema.TaggedError<DescribedColumn>()("DescribedColumn", {
  table: DefinitionName,
  column: DefinitionName
}) {
  override get message() {
    return `Column "${this.column}" of table "${this.table}" has .describe(), but table columns take no description. Remove .describe(), and say what the column holds in the table's description.`;
  }
}
const isDescribedColumn = Schema.is(DescribedColumn);
const isDefinitionName = Schema.is(DefinitionName);
const entries = (value: unknown): ReadonlyArray<readonly [string, unknown]> =>
  typeof value === "object" && value !== null ? Object.entries(value) : [];
const field = (value: unknown, name: string) => entries(value).find(([key]) => key === name)?.[1];

/** `.describe()` makes a handler value, which a column's descriptor would otherwise just carry. */
const describedColumn = (config: unknown) => {
  for (const [table, definition] of entries(field(config, "tables")))
    for (const [column, value] of entries(field(definition, "columns")))
      // Only grammar-checked names reach the diagnostic, as with a name collision.
      if (
        field(value, "description") !== undefined &&
        isDefinitionName(table) &&
        isDefinitionName(column)
      )
        return new DescribedColumn({ table, column });
  return undefined;
};

/** Below tier 2 a config declares no `uses`: publish's refusal, made before building. */
export class LowerTierUses extends Error {
  readonly code = "tier_mismatch";
}

/** Only known config errors supply public diagnostics; arbitrary config exceptions stay in cause. */
export const configFailure = (cause: unknown) =>
  new LocalError({
    message:
      isPrimitiveNameCollision(cause) ||
      isDescribedColumn(cause) ||
      cause instanceof StaleGenerated ||
      cause instanceof LowerTierUses ||
      cause instanceof TierZero
        ? cause.message
        : "Could not execute patchy.config.ts. Check the config, its imports and primitive descriptions.",
    code:
      cause instanceof StaleGenerated || cause instanceof LowerTierUses || cause instanceof TierZero
        ? cause.code
        : "invalid_manifest",
    cause
  });

/**
 * The same refusal for refresh and dev, which execute config unresolved, before they generate.
 * Removing a declaration evaluates the config as it was, so that evaluation never refuses.
 */
export const lowerTierUses = (manifest: {
  readonly tier: number;
  readonly uses: Readonly<Record<string, unknown>>;
}): LocalError | undefined => {
  const message = usesRefusal(manifest.tier, Object.keys(manifest.uses));
  return message === undefined ? undefined : new LocalError({ message, code: "tier_mismatch" });
};

const runConfig = (path: string): Promise<unknown> => {
  const { promise, resolve: accept, reject } = Promise.withResolvers<unknown>();
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const runner = fileURLToPath(new URL(`./executeConfigChild.${extension}`, import.meta.url));
  const child = fork(runner, [path], {
    cwd: dirname(path),
    // Every supported Node strips types by default, so configs must stay erasable-only. An
    // explicit empty list stops the child inheriting its parent's flags, such as the
    // --input-type of a `node --input-type=module -e` parent, which Node 26 rejects here.
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let response: unknown;
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("message", (message) => {
    response = message;
  });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    try {
      const message = decodeMessage(response);
      if (!message.ok) throw new Error(`Config ${path} failed: ${message.message}`);
      if (code !== 0) throw new Error(`Config ${path} exited with ${signal ?? code}.`);
      accept(message.config);
    } catch (cause) {
      reject(
        response === undefined
          ? new Error(
              `Config ${path} exited without a result (${signal ?? code}). ${stderr.trim()}`
            )
          : cause
      );
    }
  });
  return promise;
};

/** A sibling keeps relative imports and package resolution intact without changing the author's file. */
const runEditedConfig = async (path: string, source: string): Promise<unknown> => {
  const staged = resolve(dirname(path), `.patchy-config-${randomUUID()}.ts`);
  await writeFile(staged, source, { flag: "wx", mode: 0o600 });
  try {
    return await runConfig(staged);
  } finally {
    await rm(staged, { force: true });
  }
};

/** Executes local config; publishing requires stamps, while generation requests resolve them remotely. */
export function executeConfig(path: string): Promise<ExecutedManifest>;
export function executeConfig(
  path: string,
  options: { readonly resolve: false; readonly source?: string }
): Promise<UnresolvedManifest>;
export async function executeConfig(
  path: string,
  options?: { readonly resolve: false; readonly source?: string }
): Promise<ExecutedManifest | UnresolvedManifest> {
  const absolutePath = resolve(path);
  const executed =
    options?.source === undefined
      ? await runConfig(absolutePath)
      : await runEditedConfig(absolutePath, options.source);
  const described = describedColumn(executed);
  if (described !== undefined) throw described;
  if (field(executed, "tier") === 0) throw new TierZero();
  const input = decodeConfig(executed);
  let config: typeof GenerationManifest.Type;
  try {
    config = decodeGenerationManifest({
      ...input,
      manifestVersion: MANIFEST_VERSION,
      release: RELEASE
    });
  } catch (cause) {
    // Names passed the definition grammar above, so this diagnostic cannot contain config values.
    const name = Object.keys(input.tables).find((name) => Object.hasOwn(input.files, name));
    if (name !== undefined) throw new PrimitiveNameCollision({ definitionName: name, cause });
    throw cause;
  }
  if (options?.resolve === false) {
    return config;
  }
  const refused = usesRefusal(config.tier, Object.keys(config.uses));
  if (refused !== undefined) throw new LowerTierUses(refused);
  const indexPath = resolve(dirname(absolutePath), "patchy/_generated/index.json");
  const index = await readFile(indexPath, "utf8").catch((cause: unknown) => {
    throw new StaleGenerated({ cause });
  });
  return resolveStamps(config, index);
}

/**
 * Stamps an evaluated config from a generated index's JSON source. Refuses, as
 * StaleGenerated, an index from another release or manifest version, and stamps
 * that no longer match the config's declarations.
 */
export const resolveStamps = (config: UnresolvedManifest, source: string): ExecutedManifest => {
  const declarations = Object.entries(config.uses).filter(
    ([, declaration]) => declaration.kind !== "members"
  );
  const uses: Record<string, (typeof Manifest.Type)["uses"][string]> = {};
  if (config.uses.members?.kind === "members") uses.members = config.uses.members;
  let index: typeof generatedIndexSchema.Type;
  try {
    index = decodeIndex(source);
  } catch (cause) {
    throw new StaleGenerated({ cause });
  }
  const stamps = new Map<string, (typeof generatedIndexSchema.Type)["uses"][number]>();
  for (const stamp of index.uses) {
    if (
      stamps.has(stamp.alias) ||
      stamp.id !== stamp.declaration.id ||
      stamp.revision !== stamp.declaration.revision
    )
      throw new StaleGenerated();
    stamps.set(stamp.alias, stamp);
  }
  if (stamps.size !== declarations.length) throw new StaleGenerated();
  for (const [alias, declaration] of declarations) {
    const stamp = stamps.get(alias);
    if (!stamp) throw new StaleGenerated();
    const generated = stamp.declaration;
    if (
      declaration.kind !== generated.kind ||
      (declaration.kind === "postgres" &&
        (generated.kind !== "postgres" || declaration.handle !== generated.handle)) ||
      (declaration.kind === "posthog" &&
        (generated.kind !== "posthog" || declaration.handle !== generated.handle)) ||
      (declaration.kind === "pidgeon" &&
        (generated.kind !== "pidgeon" || declaration.handle !== generated.handle)) ||
      (declaration.kind === "attio" &&
        (generated.kind !== "attio" || declaration.handle !== generated.handle)) ||
      (declaration.kind === "sharedStore" &&
        (generated.kind !== "sharedStore" ||
          declaration.patchId !== generated.patchId ||
          declaration.store !== generated.store ||
          stamp.id !== sharedStoreId(declaration.patchId, declaration.store))) ||
      (declaration.kind === "sharedTable" &&
        (generated.kind !== "sharedTable" ||
          declaration.patchId !== generated.patchId ||
          declaration.table !== generated.table ||
          stamp.id !== sharedTableId(declaration.patchId, declaration.table)))
    )
      throw new StaleGenerated();
    uses[alias] = { ...declaration, id: stamp.id, revision: stamp.revision };
  }
  return decodeManifest({ ...config, uses, manifestVersion: MANIFEST_VERSION, release: RELEASE });
};
