// @effect-diagnostics nodeBuiltinImport:off
// The config process is a Node entrypoint, independent of the CLI's Effect runtime.
import { pathToFileURL } from "node:url";

const send = (message: unknown, exitCode: number) => {
  if (!process.send) process.exit(1);
  process.send(message, () => process.exit(exitCode));
};

try {
  const path = process.argv[2];
  if (!path) throw new Error("Expected a config path.");
  // The user's config path is chosen at runtime, not a module known to this package.
  const loaded: { default?: unknown } = await import(pathToFileURL(path).href);
  if (loaded.default === undefined) throw new Error("The config must have a default export.");
  // Reject values JSON would silently discard, rather than changing a definition.
  const serialized = JSON.stringify(loaded.default, (_key, value: unknown) => {
    if (
      typeof value === "undefined" ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint"
    ) {
      throw new Error("The config contains a value that cannot be represented in a manifest.");
    }
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("The config contains a non-finite number.");
    return value;
  });
  send({ ok: true, config: JSON.parse(serialized) }, 0);
} catch (cause) {
  send({ ok: false, message: cause instanceof Error ? cause.message : String(cause) }, 1);
}
