// @effect-diagnostics nodeBuiltinImport:off -- This is the isolated builder-toolchain process entrypoint.
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as Schema from "effect/Schema";
import { ReleaseToolchain } from "@patchy/api";
import { LocalError } from "./CliError.js";
import { runToolchain } from "./toolchain.js";
import { buildServer } from "./serverBuild.js";
import { crossedPatchChanges } from "./releaseChanges.js";
import { typescriptManifest, typescriptNotice } from "./typescriptNotice.js";

const decodeToolchain = Schema.decodeUnknownSync(Schema.fromJsonString(ReleaseToolchain));
const decodeModules = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAliases = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      sharedStores: Schema.Array(Schema.String),
      pidgeon: Schema.Array(Schema.String),
      attio: Schema.Array(Schema.String)
    })
  )
);
const isLocalError = Schema.is(LocalError);
const isBuildFailure = Schema.is(Schema.Struct({ errors: Schema.Array(Schema.Unknown) }));
const isUnresolvedImport = Schema.is(
  Schema.Struct({ code: Schema.Literal("UNRESOLVED_IMPORT"), message: Schema.String })
);
const buildHint = "Run `pnpm exec vite build` and fix the single-file build before publishing.";

/**
 * The reply's error for a failed build. Unresolved imports are named by their diagnostic's first
 * line, `[UNRESOLVED_IMPORT] Could not resolve '<import>' in <file>`, with the repo's own path
 * removed; any other tool output, a plugin's thrown text included, stays in this process.
 */
const failure = (cause: unknown) => {
  if (isLocalError(cause)) return cause.message;
  const unresolved =
    cause instanceof Error && isBuildFailure(cause)
      ? cause.errors
          .filter(isUnresolvedImport)
          .map((error) =>
            stripVTControlCharacters(error.message)
              .split("\n", 1)[0]!
              .replaceAll(`${process.cwd()}${path.sep}`, "")
          )
      : [];
  if (unresolved.length === 0) return `Vite build failed. ${buildHint}`;
  return [
    "Vite build failed:",
    ...unresolved.slice(0, 3).map((line) => `- ${line}`),
    ...(unresolved.length > 3 ? [`- and ${unresolved.length - 3} more`] : []),
    buildHint
  ].join("\n");
};
const output = process.stdout.write.bind(process.stdout);
// Builder config and plugin progress cannot corrupt the parent's JSON reply.
process.stdout.write = process.stderr.write.bind(process.stderr);
try {
  const inspect = process.argv[2] === "inspect";
  const toolchain = decodeToolchain(process.argv[inspect ? 3 : 4]!);
  const loaded = await runToolchain(
    process.cwd(),
    toolchain,
    inspect
      ? undefined
      : {
          // Native Vite progress bypasses stdout.write; retain only warnings/errors here.
          logLevel: "warn",
          build: { outDir: process.argv[3], emptyOutDir: true }
        }
  );
  const server =
    !inspect && process.argv[5] !== undefined
      ? await buildServer(
          process.cwd(),
          decodeModules(process.argv[5]),
          decodeModules(process.argv[7]!),
          toolchain,
          decodeAliases(process.argv[6]!)
        )
      : undefined;
  if (server !== undefined)
    await writeFile(path.join(process.argv[3]!, "server.js"), server.server);
  // Only refresh inspects: dev and publish check TypeScript before they build, and only refresh
  // moves a repo across releases.
  const refreshNotices = inspect
    ? [
        typescriptNotice(
          await readFile(path.join(process.cwd(), typescriptManifest), "utf8").catch(
            () => undefined
          ),
          toolchain
        ),
        ...(await crossedPatchChanges(process.cwd()))
      ].filter((notice) => notice !== undefined)
    : [];
  output(
    JSON.stringify({
      ok: true,
      warnings: [...loaded.warnings, ...refreshNotices],
      sdkImports: [...new Set([...loaded.sdkImports, ...(server?.sdkImports ?? [])])].sort(),
      agentTools: server?.agentTools ?? {}
    })
  );
} catch (cause) {
  output(
    JSON.stringify({
      ok: false,
      error: failure(cause),
      ...(isLocalError(cause) && cause.code ? { code: cause.code } : {})
    })
  );
  process.exitCode = 1;
}
