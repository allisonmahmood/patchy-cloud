// @effect-diagnostics nodeBuiltinImport:off -- This source-checkout entrypoint owns the dev process and bundle build.
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { canonicalArgs, CURRENT_RELEASE, Manifest, ReleaseToolchain } from "@patchy/api";
import { migrations as companyMigrations } from "@patchy/companies";
import { sha256 } from "@patchy/core";
import * as Inspection from "@patchy/execution/inspection";
import * as Local from "@patchy/execution/local";
import { Limits, OperatingLimits } from "@patchy/limits";
import { migrations as limitMigrations } from "@patchy/limits/migrations";
import { QuerySnapshot } from "@patchy/primitives";
import {
  CallbackGateway,
  CallbackGatewayApi,
  Executor,
  Invocation,
  InvocationCapabilities,
  InvocationLog,
  Runtime,
  RuntimeLog,
  ServerBundles,
  migrations as runtimeMigrations
} from "@patchy/runtime";
import { migrate } from "@patchy/sql";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LocalError } from "../../../packages/patchy/src/CliError.js";
import * as DevResources from "../../../packages/patchy/src/devResources.js";
import * as DevServer from "../../../packages/patchy/src/devServer.js";
import { Prepared } from "../../../packages/patchy/src/devPreparation.js";
import {
  atomicJson,
  birth,
  directory,
  io,
  lock,
  readRecord,
  sameProcess,
  type Daemon
} from "../../../packages/patchy/src/devState.js";
import { configFailure, executeConfig } from "../../../packages/patchy/src/executeConfig.js";
import { safePath } from "../../../packages/patchy/src/ManagedProject.js";
import { readRepo } from "../../../packages/patchy/src/Project.js";
import { discoverServerModules } from "../../../packages/patchy/src/serverModules.js";

const PreparedServer = Schema.Struct({ ...Prepared.fields, toolchain: ReleaseToolchain });
const decodePrepared = Schema.decodeUnknownEffect(Schema.fromJsonString(PreparedServer));
const decodeManifest = Schema.decodeUnknownEffect(Manifest, { onExcessProperty: "error" });
const developmentOnly = Effect.gen(function* () {
  if ((yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"))) === "production")
    return yield* new LocalError({
      message: "Local server execution is unavailable in production."
    });
});

/** Source inspection and execution share exactly the same retained bundle bytes. */
export const servePrepared = Effect.fn("DevServerExecution.servePrepared")(function* (
  root: string,
  stateDir: string,
  record: Daemon,
  input: typeof PreparedServer.Type
) {
  yield* developmentOnly;
  if (input.manifest.tier !== 2 || input.manifest.release !== CURRENT_RELEASE)
    return yield* new LocalError({
      message:
        "Server dev requires this checkout's release and a tier 2 config. Run patchy dev prepare after changing config."
    });
  const modules = yield* discoverServerModules(root);
  const source = yield* Effect.tryPromise({
    try: async () => {
      const result = await build({
        stdin: {
          contents: `${modules.map((name, i) => `import * as m${i} from ${JSON.stringify(`./server/${name}.ts`)};`).join("\n")}\nimport { createGuest } from "patchy/server";\nexport default createGuest({${modules.map((name, i) => `${JSON.stringify(name)}:m${i}`).join(",")}});`,
          resolveDir: root,
          sourcefile: "patchy-server-entry.ts"
        },
        bundle: true,
        write: false,
        platform: "browser",
        format: "esm",
        target: "es2022",
        conditions: ["development"]
      });
      return result.outputFiles[0]!.text;
    },
    catch: (cause) =>
      new LocalError({ message: "Could not build server/ for the local executor.", cause })
  });
  const handlers = yield* Inspection.inspect(source);
  const manifest = yield* decodeManifest({ ...input.manifest, handlers });
  const prepared = { ...input, manifest };
  const resources = yield* DevResources.prepare(prepared, root, stateDir);
  const path = yield* Path.Path;
  const journalPath = yield* io("Could not resolve the local invocation journal.", () =>
    safePath(stateDir, "invocations")
  );
  const journal = PgliteClient.layer({ dataDir: journalPath });
  const context = yield* Layer.build(
    Layer.mergeAll(
      InvocationLog.layer,
      RuntimeLog.layer,
      OperatingLimits.layer,
      QuerySnapshot.layer,
      Limits.layer
    ).pipe(
      Layer.provideMerge(InvocationCapabilities.layer),
      Layer.provideMerge(Layer.succeedContext(resources.context)),
      Layer.provideMerge(journal)
    )
  );
  yield* Effect.gen(function* () {
    yield* migrate({ ...companyMigrations, ...runtimeMigrations, ...limitMigrations });
    const sql = yield* SqlClient.SqlClient;
    const company = prepared.identity.company;
    yield* sql`INSERT INTO companies (id, handle, name)
      VALUES (${company.id}, ${company.handle}, ${company.name})
      ON CONFLICT (id) DO UPDATE SET handle = EXCLUDED.handle, name = EXCLUDED.name`;
  }).pipe(Effect.provideContext(context));
  return yield* Effect.gen(function* () {
    const gateway = yield* CallbackGateway.make(resources.handlers);
    const listener = yield* CallbackGatewayApi.listen().pipe(
      Effect.provideService(CallbackGateway.CallbackGateway, gateway)
    );
    const executor = yield* Local.make({
      companyId: resources.version.companyId,
      callbackUrls: [listener.url],
      environment: "development"
    });
    const bundle = {
      companyId: resources.version.companyId,
      patchId: resources.version.patchId,
      versionId: resources.version.versionId,
      sha256: sha256(source),
      bundle: source
    };
    const invocation = yield* Invocation.make({ callbackUrl: listener.url }).pipe(
      Effect.provideService(Executor.Executor, executor),
      Effect.provideService(ServerBundles.ServerBundles, {
        load: (version) =>
          version.patchId === bundle.patchId &&
          version.versionId === bundle.versionId &&
          version.companyId === bundle.companyId
            ? Effect.succeed(bundle)
            : Effect.fail(new Runtime.AccessDenied({}))
      })
    );
    // Store only inspected metadata. Callback credentials and the private listener stay in memory.
    yield* io("Could not save inspected server metadata.", () =>
      atomicJson(stateDir, "server.json", {
        patchId: bundle.patchId,
        versionId: bundle.versionId,
        principal: { userId: prepared.identity.user.id },
        handlers,
        journal: path.join(stateDir, "invocations")
      })
    );
    return yield* DevServer.serve(prepared, stateDir, record, prepared.toolchain, {
      resources,
      invocation
    }).pipe(Effect.provide(DevServer.layer));
  }).pipe(Effect.provideContext(context));
});

/** Uses authenticated generation and fixtures prepared by `patchy dev prepare`. */
export const run = Effect.fn("DevServerExecution.run")(function* (cwd: string) {
  yield* developmentOnly;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* readRepo(cwd);
  const { root, stateDir } = yield* directory(cwd, repo.instance);
  const { prepared, record } = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* lock(stateDir);
      const previous = yield* io("Could not read the dev process record.", () =>
        readRecord(stateDir)
      );
      if (
        previous !== undefined &&
        (yield* io("Could not inspect the dev process.", () => sameProcess(previous)))
      )
        return yield* new LocalError({
          message: "The patch runtime is already running. Run patchy dev stop before dev:server."
        });
      const prepared = yield* fs.readFileString(path.join(stateDir, "prepared.json")).pipe(
        Effect.flatMap(decodePrepared),
        Effect.mapError(
          (cause) =>
            new LocalError({
              message:
                "Run patchy dev prepare for this repo's authenticated metadata and fixtures.",
              cause
            })
        )
      );
      const current = yield* Effect.tryPromise({
        try: () => executeConfig(path.join(root, "patchy.config.ts")),
        catch: configFailure
      });
      if (
        canonicalArgs({
          ...current,
          ...(repo.description === undefined ? {} : { description: repo.description })
        }) !== canonicalArgs(prepared.manifest)
      )
        return yield* new LocalError({
          message: "Config changed since preparation. Run patchy dev prepare before dev:server."
        });
      if (
        (previous !== undefined &&
          (previous.root !== root || previous.instance !== repo.instance)) ||
        prepared.patchId !== (repo.patch ?? "localdev0000")
      )
        return yield* new LocalError({
          message: "Dev metadata does not match this repo. Run patchy dev prepare again."
        });
      const stamp = yield* io("Could not identify the dev process.", () => birth(process.pid));
      if (stamp === undefined)
        return yield* new LocalError({ message: "Could not identify the dev process." });
      const record: Daemon = {
        root,
        instance: repo.instance,
        release: prepared.manifest.release,
        identity: prepared.identity,
        nonce: randomUUID(),
        pid: process.pid,
        birth: stamp
      };
      yield* io("Could not record the dev process.", () =>
        atomicJson(stateDir, "daemon.json", record)
      );
      return { prepared, record };
    })
  );
  return yield* servePrepared(root, stateDir, record, prepared);
});
