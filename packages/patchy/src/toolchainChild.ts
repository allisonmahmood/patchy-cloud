// @effect-diagnostics nodeBuiltinImport:off -- This is the isolated builder-toolchain process entrypoint.
import * as Schema from "effect/Schema";
import { ReleaseToolchain } from "@patchy/api";
import { LocalError } from "./CliError.js";
import { runToolchain } from "./toolchain.js";

const decodeToolchain = Schema.decodeUnknownSync(Schema.fromJsonString(ReleaseToolchain));
const isLocalError = Schema.is(LocalError);
const output = process.stdout.write.bind(process.stdout);
// Builder config and plugin progress cannot corrupt the parent's JSON reply.
process.stdout.write = process.stderr.write.bind(process.stderr);
try {
  const inspect = process.argv[2] === "inspect";
  const loaded = await runToolchain(
    process.cwd(),
    decodeToolchain(process.argv[inspect ? 3 : 4]!),
    inspect
      ? undefined
      : {
          // Native Vite progress bypasses stdout.write; retain only warnings/errors here.
          logLevel: "warn",
          build: { outDir: process.argv[3], emptyOutDir: true }
        }
  );
  output(JSON.stringify({ ok: true, warnings: loaded.warnings }));
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
