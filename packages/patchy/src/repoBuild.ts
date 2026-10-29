import { Manifest } from "@patchy/api";
import { workerdVersion } from "@patchy/api/guest";
import * as Inspection from "@patchy/execution/inspection";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Api from "./Api.js";
import * as Instance from "./Instance.js";
import { checkBundle } from "./bundleCheck.js";
import { LocalError, ReleaseMismatch } from "./CliError.js";
import { configFailure, executeConfig } from "./executeConfig.js";
import { safePath } from "./ManagedProject.js";
import { checkRelease } from "./ReleaseCheck.js";
import { RELEASE } from "./release.js";
import { processResult } from "./processResult.js";
import * as Project from "./Project.js";
import { primitiveReminders } from "./primitiveReminders.js";
import { runToolchain, typescriptRefusal } from "./toolchainProcess.js";
import { guestAliases } from "./serverBuild.js";
import { releaseFromPin } from "./packagePin.js";
import {
  agentAreaFailure,
  agentTypecheckWarning,
  descriptionFailure,
  discoverAgentFiles,
  discoverServerModules,
  validateGeneratedServerModules
} from "./serverModules.js";

const decodePackage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      devDependencies: Schema.Struct({ patchy: Schema.String })
    })
  )
);
const decodeRuntime = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
const decodeManifest = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" });
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Manifest));
const isLocalError = Schema.is(LocalError);
const decodeServerPackage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      devDependencies: Schema.Struct({ workerd: Schema.Literal(workerdVersion) })
    })
  )
);
/** New publish and dev sessions must agree with the instance before executing config. */
export const checkRepoRelease = Effect.fn("checkRepoRelease")(function* (
  cwd: string,
  token: Redacted.Redacted
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instance = yield* Instance.Instance;
  const client = yield* Api.client(token);
  const release = yield* client
    .release()
    .pipe(Effect.catch((error) => Api.classify(error, "Could not read the instance release.")));
  const packageText = yield* fs.readFileString(path.join(cwd, "package.json")).pipe(
    Effect.mapError(
      (cause) =>
        new LocalError({
          message: "Run this command inside a patch repo created with `patchy init`.",
          cause
        })
    )
  );
  const pkg = yield* Effect.try({
    try: () => decodePackage(packageText),
    catch: (cause) =>
      new LocalError({
        message: "package.json must pin patchy as a devDependency. Run `patchy refresh`.",
        code: "release_mismatch",
        cause
      })
  });
  const tarball = new URL(release.package.tarball, `${instance.apiUrl}/`).href;
  const pin = pkg.devDependencies.patchy;
  if (pin !== tarball)
    return yield* new ReleaseMismatch({
      component: "pin",
      loaded: releaseFromPin(pin),
      current: release.release
    });
  yield* checkRelease(release.release, { cli: RELEASE });
  const runtime = yield* processResult(cwd, process.execPath, [
    "--input-type=module",
    "--eval",
    'import { RELEASE } from "patchy/dev"; process.stdout.write(JSON.stringify(RELEASE));'
  ]);
  if (runtime.code !== 0)
    return yield* new LocalError({
      message: "Could not load the repo's installed Patchy runtime. Run `patchy refresh`.",
      code: "release_mismatch"
    });
  const loadedRuntime = yield* Effect.try({
    try: () => decodeRuntime(runtime.stdout),
    catch: (cause) =>
      new LocalError({
        message: "The installed Patchy runtime did not report its release. Run `patchy refresh`.",
        code: "release_mismatch",
        cause
      })
  });
  yield* checkRelease(release.release, { cli: RELEASE, runtime: loadedRuntime });
  return release.toolchain;
});

/** Recovery belongs to the caller and must finish before this starts any fresh work. */
export const prepareRepoPublish = Effect.fn("prepareRepoPublish")(function* (
  cwd: string,
  token: Redacted.Redacted
) {
  const toolchain = yield* checkRepoRelease(cwd, token);
  // Before any fresh work, so a refused repo's description and config stay untouched.
  const typescript = yield* typescriptRefusal(cwd, toolchain);
  if (typescript !== undefined)
    return yield* new LocalError({ message: typescript, code: "toolchain_unsupported" });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { repo, warnings: syncWarnings } = yield* Project.syncDescription(cwd, token, true);
  if (repo.description === undefined)
    return yield* new LocalError({
      message: "patchy.json must contain a nonempty description before publishing.",
      code: "invalid_manifest"
    });
  const description = yield* Project.normalizeDescription(
    repo.description,
    "patchy.json description",
    "invalid_manifest"
  );
  const configured = yield* Effect.tryPromise({
    try: async () =>
      decodeManifest({
        ...(await executeConfig(path.join(cwd, "patchy.config.ts"))),
        description
      }),
    catch: configFailure
  });
  const warnings = [...syncWarnings, ...(yield* primitiveReminders(cwd, configured))];
  const serverModules = configured.tier === 2 ? yield* discoverServerModules(cwd) : undefined;
  const agentFiles = configured.tier === 2 ? yield* discoverAgentFiles(cwd) : [];
  const skipped = yield* agentTypecheckWarning(cwd, agentFiles);
  if (skipped !== undefined) warnings.push(skipped);
  if (serverModules !== undefined)
    yield* fs.readFileString(path.join(cwd, "package.json")).pipe(
      Effect.flatMap((source) => Effect.try(() => decodeServerPackage(source))),
      Effect.mapError(
        (cause) =>
          new LocalError({
            code: "release_mismatch",
            message: `Tier 2 must pin workerd ${workerdVersion}. Run \`patchy refresh\`.`,
            cause
          })
      )
    );
  if (serverModules !== undefined) yield* validateGeneratedServerModules(cwd, serverModules);
  // Definitions can change without generation; only index.json owns declaration stamps.
  const destination = yield* Effect.tryPromise({
    try: () => safePath(cwd, "patchy/_generated/manifest.json"),
    catch: (cause) =>
      new LocalError({ message: "Could not resolve the managed manifest path.", cause })
  });
  yield* fs.writeFileString(destination, `${encodeManifest(configured)}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new LocalError({
          message: "Could not update patchy/_generated/manifest.json for the current config.",
          cause
        })
    )
  );
  const built = yield* Effect.scoped(
    Effect.gen(function* () {
      const output = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-publish-" });
      const { sdkImports, agentTools } = yield* runToolchain(cwd, {
        build: output,
        toolchain,
        ...(serverModules === undefined
          ? {}
          : {
              server: {
                modules: serverModules,
                agentFiles,
                aliases: guestAliases(configured.uses)
              }
            })
      });
      const entries = yield* fs.readDirectory(output, { recursive: true });
      const files: string[] = [];
      for (const entry of entries) {
        const info = yield* fs.stat(path.join(output, entry));
        if (info.type !== "Directory") files.push(entry);
      }
      const expected = serverModules === undefined ? ["index.html"] : ["index.html", "server.js"];
      if (files.length !== expected.length || expected.some((file) => !files.includes(file)))
        return yield* new LocalError({
          message: `Vite must emit only ${expected.join(" and ")}; found ${files.length ? files.join(", ") : "no output"}. Inline every page asset with vite-plugin-singlefile; remove public files, sourcemaps and extra entrypoints.`
        });
      return {
        html: yield* fs.readFileString(path.join(output, "index.html")),
        ...(serverModules === undefined
          ? {}
          : { server: yield* fs.readFileString(path.join(output, "server.js")) }),
        sdkImports,
        agentTools
      };
    })
  ).pipe(
    Effect.mapError((cause) =>
      isLocalError(cause)
        ? cause
        : new LocalError({ message: "Could not read the Vite build output.", cause })
    )
  );
  const typecheck = yield* processResult(cwd, process.execPath, [
    path.join(cwd, "node_modules/typescript/bin/tsc"),
    "--noEmit"
  ]);
  if (typecheck.code !== 0)
    return yield* new LocalError({
      message:
        "Typecheck failed. Run `pnpm exec tsc --noEmit` and fix the errors before publishing.",
      cause: typecheck
    });
  const handlers =
    built.server === undefined
      ? undefined
      : // The repo pins workerd, so a CLI installed without one still inspects its server.
        yield* Inspection.inspect(built.server, { workerdFrom: cwd }).pipe(
          Effect.mapError(
            (cause) =>
              new LocalError({
                message:
                  cause.problem ??
                  "Could not inspect the server bundle. Its modules must load and export only valid handlers.",
                code: "invalid_manifest",
                cause
              })
          )
        );
  const refusal =
    handlers === undefined
      ? undefined
      : (descriptionFailure(handlers, built.agentTools) ??
        agentAreaFailure({ tables: configured.tables, handlers }, built.agentTools));
  if (refusal !== undefined)
    return yield* new LocalError({ message: refusal, code: "invalid_manifest" });
  const manifest = decodeManifest({
    ...configured,
    sdkImports: built.sdkImports,
    ...(handlers === undefined ? {} : { handlers })
  });
  if (handlers !== undefined && Object.keys(handlers).length === 0)
    warnings.push("Tier 2 has no handlers. Add query, mutation or action exports under server/.");
  yield* validateRepoBundle(cwd, manifest, built.html);
  return { manifest, html: built.html, server: built.server, warnings };
});

/** Publish and watched dev builds enforce the same artifact and tier contract. */
export const validateRepoBundle = Effect.fn("validateRepoBundle")(function* (
  cwd: string,
  manifest: typeof Manifest.Type,
  html: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* checkBundle(html);
  if (manifest.tier > 2)
    return yield* new LocalError({ message: "Tier 3 is not served yet.", code: "tier_mismatch" });
  // server/ and agent/ are evidence of tier 2 even when empty.
  for (const folder of ["server", "agent"]) {
    const present = yield* fs.stat(path.join(cwd, folder)).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(cause)
      }),
      Effect.mapError(
        (cause) =>
          new LocalError({ message: `Could not inspect ${folder}/ for the evident tier.`, cause })
      )
    );
    if (present && manifest.tier < 2)
      return yield* new LocalError({
        message: `${folder}/ requires tier 2. Change the tier and run \`patchy refresh\`, or remove ${folder}/.`,
        code: "tier_mismatch"
      });
  }
});
