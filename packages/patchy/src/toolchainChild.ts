// @effect-diagnostics nodeBuiltinImport:off -- This is the isolated builder-toolchain process entrypoint.
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as Schema from "effect/Schema";
import { ReleaseToolchain } from "@patchy/api";
import { LocalError } from "./CliError.js";
import { runToolchain } from "./toolchain.js";
import { buildServer } from "./serverBuild.js";

const decodeToolchain = Schema.decodeUnknownSync(Schema.fromJsonString(ReleaseToolchain));
const decodeModules = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const isLocalError = Schema.is(LocalError);
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
          toolchain,
          decodeModules(process.argv[6]!)
        )
      : undefined;
  if (server !== undefined)
    await writeFile(path.join(process.argv[3]!, "server.js"), server.server);
  output(
    JSON.stringify({
      ok: true,
      warnings: loaded.warnings,
      sdkImports: [...new Set([...loaded.sdkImports, ...(server?.sdkImports ?? [])])].sort()
    })
  );
} catch (cause) {
  output(
    JSON.stringify({
      ok: false,
      error: isLocalError(cause)
        ? cause.message
        : "Vite build failed. Run `pnpm exec vite build` and fix the single-file build before publishing.",
      ...(isLocalError(cause) && cause.code ? { code: cause.code } : {})
    })
  );
  process.exitCode = 1;
}
