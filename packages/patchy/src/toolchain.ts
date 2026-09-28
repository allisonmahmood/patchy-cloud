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

/** Inspect resolved module files, including plugins imported by shared or nested configs. */
export async function loadToolchain(
  root: string,
  versions: typeof ReleaseToolchain.Type = toolchain,
  warnOnly = false
) {
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
    const loaded = await vite.loadConfigFromFile(
      { command: "build", mode: "production", isSsrBuild: false, isPreview: false },
      undefined,
      root,
      "silent"
    );
    for (const file of loaded?.dependencies ?? []) inspect(file);
    // Vite accepts nested promised plugins. Resolve them while version hooks are active.
    const plugins: Vite.Plugin[] = [];
    const appendPlugins = async (option: Vite.PluginOption): Promise<void> => {
      const resolved = await option;
      if (Array.isArray(resolved)) {
        for (const child of resolved) await appendPlugins(child);
      } else if (resolved) {
        plugins.push(resolved);
      }
    };
    await appendPlugins(loaded?.config.plugins);
    return {
      vite,
      config: {
        ...loaded?.config,
        plugins,
        configFile: false,
        root,
        logLevel: "silent"
      } satisfies Vite.InlineConfig,
      warnings: [...warnings]
    };
  } catch (cause) {
    // Refresh owns no builder config and must work while that config is incomplete.
    if (warnOnly) return { warnings: [...warnings] };
    // Config bundlers may wrap a resolution error; retain the CLI's refusal code.
    throw refusal ?? cause;
  } finally {
    hooks.deregister();
  }
}
