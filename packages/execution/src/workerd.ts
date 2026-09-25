// PROTOTYPE for #314: where the real workerd binary is. The npm `workerd` bin is a Node shim,
// so the engine spawns the platform package's binary directly (the spike learned that killing
// the shim leaves workerd running). Resolution starts from a package.json the caller names: the
// server resolves from this package, the CLI from the patch repo, whose scaffold pins `workerd`.
// @effect-diagnostics nodeBuiltinImport:off -- module resolution is a Node concern.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WorkerdMissing extends Schema.TaggedError<WorkerdMissing>()("WorkerdMissing", {
  from: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `Could not find the workerd binary from ${this.from}. Install the pinned workerd package.`;
  }
}

const platformPackage = (): string => {
  const key = `${process.platform} ${process.arch}`;
  const known: Record<string, string> = {
    "linux x64": "@cloudflare/workerd-linux-64",
    "linux arm64": "@cloudflare/workerd-linux-arm64",
    "darwin x64": "@cloudflare/workerd-darwin-64",
    "darwin arm64": "@cloudflare/workerd-darwin-arm64",
    "win32 x64": "@cloudflare/workerd-windows-64"
  };
  const name = known[key];
  if (name === undefined) throw new Error(`Unsupported platform for workerd: ${key}`);
  return name;
};

/** The binary next to the `workerd` package resolvable from `from` (a file path or URL). */
export const workerdBinary = (from: string) =>
  Effect.try({
    try: () => {
      const outer = createRequire(from);
      const workerd = outer.resolve("workerd/package.json");
      const inner = createRequire(workerd);
      const platform = inner.resolve(`${platformPackage()}/package.json`);
      return join(
        dirname(platform),
        "bin",
        process.platform === "win32" ? "workerd.exe" : "workerd"
      );
    },
    catch: (cause) => new WorkerdMissing({ from, cause })
  });

/**
 * The binary resolvable from this module's own location: next to this package in the server,
 * or, once bundled into the CLI's dev runtime, next to the patch repo's pinned `workerd`.
 */
export const bundledWorkerdBinary = workerdBinary(import.meta.url);
