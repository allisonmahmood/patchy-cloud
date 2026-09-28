// @effect-diagnostics nodeBuiltinImport:off -- Vite's config loader uses Node resolution hooks and synchronous package metadata.
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Schema from "effect/Schema";
import type { ReleaseToolchain } from "@patchy/api";
import type * as Vite from "vite";
import satisfies from "semver/functions/satisfies.js";
import { LocalError } from "./CliError.js";
import toolchain from "./toolchain.json" with { type: "json" };

const decodePackage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      version: Schema.optionalKey(Schema.String)
    })
  )
);
const checkedPackages = ["vite", "vite-plugin-singlefile"] as const;
type CheckedPackage = (typeof checkedPackages)[number];

export function toolchainUpgrade(versions: typeof ReleaseToolchain.Type) {
  return `pnpm add --save-dev ${checkedPackages.map((name) => `'${name}@${versions[name].accepted}'`).join(" ")}`;
}

/** Keep version checks active through Vite's own config and deferred-plugin lifecycle. */
export async function runToolchain(
  root: string,
  versions: typeof ReleaseToolchain.Type = toolchain,
  buildConfig?: Vite.InlineConfig
) {
  const warnOnly = buildConfig === undefined;
  const warnings = new Set<string>();
  const directories = new Map<string, { name?: string; version?: string } | undefined>();
  const seen = new Set<string>();
  let refusal: LocalError | undefined;
  const check = (name: CheckedPackage, version: string) => {
    if (satisfies(version, versions[name].accepted)) return;
    const message = `Loaded ${name} ${version} is unsupported; this release accepts ${versions[name].accepted} (tested against ${versions[name].testedAgainst}). Run: ${toolchainUpgrade(versions)}`;
    if (!warnOnly) {
      refusal = new LocalError({ message, code: "toolchain_unsupported" });
      throw refusal;
    }
    warnings.add(message);
  };
  const inspect = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    let directory = path.dirname(file);
    const visited: string[] = [];
    let pkg: { name?: string; version?: string } | undefined;
    while (true) {
      if (directories.has(directory)) {
        pkg = directories.get(directory);
        break;
      }
      visited.push(directory);
      try {
        pkg = decodePackage(readFileSync(path.join(directory, "package.json"), "utf8"));
        // Nested package scopes can set only `type`; keep looking for the owning package.
        if (pkg.name) break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    for (const entry of visited) directories.set(entry, pkg);
    for (const name of checkedPackages) {
      if (pkg?.name === name) check(name, pkg.version ?? "unknown");
    }
  };
  const require = createRequire(path.join(root, "package.json"));
  let viteEntry: string;
  try {
    viteEntry = require.resolve("vite");
  } catch (cause) {
    if (warnOnly) return { warnings: [] };
    throw new LocalError({
      message: "Could not load the repo's installed Vite. Run `pnpm install`.",
      cause
    });
  }
  inspect(viteEntry);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url.startsWith("file:")) inspect(fileURLToPath(resolved.url));
      return resolved;
    }
  });
  try {
    // The builder's Vite installation is selected at runtime, not bundled into Patchy.
    const vite: typeof Vite = await import(pathToFileURL(viteEntry).href);
    check("vite", vite.version);
    const config: Vite.InlineConfig = {
      ...buildConfig,
      root,
      plugins: [
        buildConfig?.plugins,
        {
          name: "patchy-toolchain-versions",
          enforce: "pre",
          configResolved(resolved) {
            for (const file of resolved.configFileDependencies) inspect(file);
          }
        }
      ]
    };
    // Vite initializes NODE_ENV before loading config and applies .env overrides
    // afterward. Preloading config here would bypass that ordering.
    if (!buildConfig) {
      await vite.resolveConfig(config, "build", "production", "production");
      return { warnings: [...warnings] };
    }
    const result = await vite.build(config);
    return { result, warnings: [...warnings] };
  } catch (cause) {
    // Refresh owns no builder config and must work while that config is incomplete.
    if (warnOnly) return { warnings: [...warnings] };
    // Config bundlers may wrap a resolution error; retain the CLI's refusal code.
    throw refusal ?? cause;
  } finally {
    hooks.deregister();
  }
}
