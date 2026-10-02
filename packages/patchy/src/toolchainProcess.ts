// @effect-diagnostics nodeBuiltinImport:off -- Locate the bundled subprocess beside this CLI entrypoint.
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ReleaseToolchain } from "@patchy/api";
import { LocalError } from "./CliError.js";
import { processResult } from "./processResult.js";

const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        ok: Schema.Literal(true),
        warnings: Schema.Array(Schema.String),
        sdkImports: Schema.Array(Schema.String)
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
          readonly sharedStores: readonly string[];
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
                encodeModules(operation.server.sharedStores)
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
