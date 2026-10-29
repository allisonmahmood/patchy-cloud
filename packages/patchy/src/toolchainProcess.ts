// @effect-diagnostics nodeBuiltinImport:off -- Locate the bundled subprocess beside this CLI entrypoint.
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import satisfies from "semver/functions/satisfies.js";
import { ReleaseToolchain } from "@patchy/api";
import { LocalError } from "./CliError.js";
import { processResult } from "./processResult.js";
import type { GuestAliases } from "./serverBuild.js";

const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        ok: Schema.Literal(true),
        warnings: Schema.Array(Schema.String),
        sdkImports: Schema.Array(Schema.String),
        agentTools: Schema.Record(Schema.String, Schema.String)
      }),
      Schema.Struct({
        ok: Schema.Literal(false),
        error: Schema.String,
        code: Schema.optionalKey(Schema.String)
      })
    ])
  )
);
const encodeToolchain = Schema.encodeSync(Schema.fromJsonString(ReleaseToolchain));
const encodeModules = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeAliases = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      sharedStores: Schema.Array(Schema.String),
      pidgeon: Schema.Array(Schema.String),
      attio: Schema.Array(Schema.String)
    })
  )
);
const decodeVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
);

/**
 * Why this release won't publish the repo's TypeScript, or nothing when it will. Publish runs the
 * repo's own `node_modules/typescript`; without one, publish's typecheck reports that instead.
 * Patches moved to TypeScript 7, beside which typescript-eslint can't run, hence the lint step.
 */
export const typescriptRefusal = Effect.fn("typescriptRefusal")(function* (
  cwd: string,
  versions: typeof ReleaseToolchain.Type
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* fs
    .readFileString(path.join(cwd, "node_modules/typescript/package.json"))
    .pipe(Effect.option);
  if (Option.isNone(manifest)) return undefined;
  const version = Option.getOrUndefined(decodeVersion(manifest.value))?.version;
  const { accepted, testedAgainst } = versions.typescript;
  if (version !== undefined && satisfies(version, accepted)) return undefined;
  return `This repo has TypeScript ${version ?? "of an unknown version"}; this release publishes only TypeScript ${accepted} (tested against ${testedAgainst}). Run: pnpm add --save-dev 'typescript@${accepted}'. typescript-eslint doesn't run beside TypeScript 7: if the lint script runs ESLint, move it to Oxlint as .agents/skills/patchy-preact/SKILL.md says.`;
});

// The bundled child in a release; its source when this CLI runs from the workspace.
const ownChild = fileURLToPath(
  new URL(`./toolchainChild.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url)
);

/**
 * Run the builder toolchain in its own process, by default the child beside this CLI.
 * A caller may pass another release's `toolchainChild.js`, such as one it just installed.
 * The argv and the stdout reply are a private protocol across releases.
 */
export const runToolchain = Effect.fn("runToolchain")(function* (
  cwd: string,
  operation:
    | { readonly inspect: typeof ReleaseToolchain.Type }
    | {
        readonly build: string;
        readonly toolchain: typeof ReleaseToolchain.Type;
        readonly server?: {
          readonly modules: readonly string[];
          readonly agentFiles: readonly string[];
          readonly aliases: GuestAliases;
        };
      },
  child = ownChild
) {
  const result = yield* processResult(cwd, process.execPath, [
    ...(child.endsWith(".ts")
      ? ["--import", createRequire(import.meta.url).resolve("tsx"), "--conditions=development"]
      : []),
    child,
    ...("inspect" in operation
      ? ["inspect", encodeToolchain(operation.inspect)]
      : [
          "build",
          operation.build,
          encodeToolchain(operation.toolchain),
          ...(operation.server === undefined
            ? []
            : [
                encodeModules(operation.server.modules),
                encodeAliases(operation.server.aliases),
                encodeModules(operation.server.agentFiles)
              ])
        ])
  ]);
  const decoded = yield* Effect.try({
    try: () => decodeResult(result.stdout),
    catch: (cause) =>
      new LocalError({
        message:
          "inspect" in operation
            ? "Could not inspect the repo's installed toolchain."
            : "Could not build the repo with its installed toolchain.",
        cause
      })
  });
  if (!decoded.ok)
    return yield* new LocalError({
      message: decoded.error,
      ...(decoded.code ? { code: decoded.code } : {}),
      cause: result
    });
  return decoded;
});
