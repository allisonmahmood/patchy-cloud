// @effect-diagnostics nodeBuiltinImport:off
// The config entrypoint loads this Node-only process boundary only when execution is requested.
import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Manifest,
  PatchName,
  PostgresDeclaration,
  SharedTableDeclaration,
  sharedTableId
} from "@patchy/api";
import * as Schema from "effect/Schema";
import type { ColumnKind, Declaration, IndexDefinition, Json } from "./config.js";
import { MANIFEST_VERSION, RELEASE } from "./release.js";

/** Portable declaration types: bundling Effect's schema types leaks its type dependencies. */
type ManifestColumn = {
  [K in ColumnKind]: {
    readonly kind: K;
    readonly optional?: boolean;
    readonly default?: K extends "json"
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
  readonly tier: 0 | 1 | 2 | 3;
  readonly tables: Readonly<
    Record<
      string,
      {
        readonly columns: Readonly<Record<string, ManifestColumn>>;
        readonly indexes: Readonly<Record<string, IndexDefinition>>;
        readonly shared?: boolean;
      }
    >
  >;
  readonly files: Readonly<Record<string, Readonly<Record<string, never>>>>;
  readonly uses: Readonly<
    Record<string, Declaration & { readonly id: string; readonly revision: number }>
  >;
}

const configSchema = Schema.Struct({
  name: PatchName,
  tier: Manifest.fields.tier,
  tables: Manifest.fields.tables,
  files: Manifest.fields.files,
  uses: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.Struct({
        kind: PostgresDeclaration.fields.kind,
        handle: PostgresDeclaration.fields.handle
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
  uses: Schema.Array(
    Schema.Struct({
      alias: Schema.String,
      id: PostgresDeclaration.fields.id,
      revision: PostgresDeclaration.fields.revision
    })
  )
});
const decodeConfig = Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" });
const decodeIndex = Schema.decodeUnknownSync(Schema.fromJsonString(generatedIndexSchema));
const decodeManifest = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" });
const childMessageSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), config: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String })
]);
const decodeMessage = Schema.decodeUnknownSync(childMessageSchema);

const runConfig = (path: string): Promise<unknown> => {
  const { promise, resolve: accept, reject } = Promise.withResolvers<unknown>();
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const runner = fileURLToPath(new URL(`./executeConfigChild.${extension}`, import.meta.url));
  const child = fork(runner, [path], {
    cwd: dirname(path),
    execArgv: ["--experimental-transform-types"],
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

/** Executes only local code, then resolves declarations from generated stamps and validates the API manifest. */
export const executeConfig = async (path: string): Promise<ExecutedManifest> => {
  const absolutePath = resolve(path);
  const config = decodeConfig(await runConfig(absolutePath));
  const declarations = Object.entries(config.uses);
  const uses: Record<string, (typeof Manifest.Type)["uses"][string]> = {};
  if (declarations.length > 0) {
    const indexPath = resolve(dirname(absolutePath), "patchy/_generated/index.json");
    let index: typeof generatedIndexSchema.Type;
    try {
      index = decodeIndex(await readFile(indexPath, "utf8"));
    } catch (cause) {
      throw new Error(`Cannot resolve config declarations from ${indexPath}.`, {
        cause
      });
    }
    const stamps = new Map<string, (typeof generatedIndexSchema.Type)["uses"][number]>();
    for (const stamp of index.uses) {
      if (stamps.has(stamp.alias)) throw new Error(`Duplicate generated stamp for ${stamp.alias}.`);
      stamps.set(stamp.alias, stamp);
    }
    for (const [alias, declaration] of declarations) {
      const stamp = stamps.get(alias);
      if (!stamp) throw new Error(`No generated stamp for ${alias}.`);
      if (
        declaration.kind === "sharedTable" &&
        stamp.id !== sharedTableId(declaration.patchId, declaration.table)
      ) {
        throw new Error(`The generated stamp for ${alias} names another shared table.`);
      }
      uses[alias] = { ...declaration, id: stamp.id, revision: stamp.revision };
    }
  }
  return decodeManifest({ ...config, uses, manifestVersion: MANIFEST_VERSION, release: RELEASE });
};
