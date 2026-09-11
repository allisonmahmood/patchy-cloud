import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Prompt from "effect/unstable/cli/Prompt";
import { Catalog, DefinitionName, Generated, Manifest, PatchName } from "@patchy/api";
import * as Api from "./Api.js";
import { LocalError, RejectedError, UnreachableError } from "./CliError.js";
import * as Instance from "./Instance.js";
import * as Login from "./Login.js";
import * as Output from "./Output.js";
import { executeConfig } from "./executeConfig.js";
import type { Declaration } from "./config.js";
import {
  ConfigEdit,
  ManagedProject,
  isProjectChanged,
  presentSkills,
  safePath
} from "./ManagedProject.js";
import { activateStarter, starterFiles, writeInitialGeneration } from "./initProject.js";
import { RELEASE } from "./release.js";
import { processResult } from "./processResult.js";

const repoSchema = Schema.Struct({
  instance: Schema.String,
  patch: Schema.optionalKey(Schema.String)
});
const packageSchema = Schema.Record(Schema.String, Schema.Unknown);
const dependenciesSchema = Schema.Record(Schema.String, Schema.String);
const changeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("add"),
    alias: Schema.String,
    declaration: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("postgres"), handle: Schema.String }),
      Schema.Struct({
        kind: Schema.Literal("sharedTable"),
        patchId: Schema.String,
        table: Schema.String
      })
    ])
  }),
  Schema.Struct({ kind: Schema.Literal("remove"), alias: Schema.String })
]);
const childSchema = Schema.Struct({
  generated: Generated,
  manifest: Manifest,
  removedSkills: Schema.Array(Schema.String),
  configEdit: Schema.optionalKey(ConfigEdit)
});
const failureSchema = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String,
  kind: Schema.Literals(["local", "rejected", "unreachable"]),
  code: Schema.optionalKey(Schema.String)
});
const decodeRepo = Schema.decodeUnknownSync(Schema.fromJsonString(repoSchema), {
  onExcessProperty: "preserve"
});
const decodePackage = Schema.decodeUnknownSync(Schema.fromJsonString(packageSchema));
const decodeDependencies = Schema.decodeUnknownSync(dependenciesSchema);
const decodeChange = Schema.decodeUnknownSync(Schema.fromJsonString(changeSchema));
const decodeSkills = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeChild = Schema.decodeUnknownSync(Schema.fromJsonString(childSchema));
const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(failureSchema));
const encodeCatalog = Schema.encodeSync(Catalog);
const decodeName = Schema.decodeUnknownSync(PatchName);
const isDefinitionName = Schema.is(DefinitionName);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
type Change = typeof changeSchema.Type;

const connectionAlias = (handle: string): string => {
  const alias = handle.replace(/-+([a-z0-9])/g, (_, char: string) => char.toUpperCase());
  return /^[0-9]/.test(alias) ? `connection${alias}` : alias;
};

const localIO = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new LocalError({
        message: isProjectChanged(cause) ? cause.message : `${operation} failed.`,
        cause
      })
  });
const parse = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new LocalError({ message: `${operation} failed.`, cause })
  });

export const readRepo = Effect.fn("Project.readRepo")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.readFileString(path.join(cwd, "patchy.json")).pipe(
    Effect.mapError(
      (cause) =>
        new LocalError({
          message: "Run this command inside a patch repo created with patchy init.",
          cause
        })
    )
  );
  return yield* parse("Read patchy.json", () => decodeRepo(source));
});

/** Apply a recovered create without replacing a different patch selected by the author. */
export const recordPublish = Effect.fn("Project.recordPublish")(function* (
  cwd: string,
  patchId: string
) {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* readRepo(cwd);
  if (repo.patch === patchId) return;
  if (repo.patch !== undefined)
    return yield* new LocalError({
      message:
        "patchy.json now names a different patch. Restore the original repo identity before recovering this publish; the attempt has been kept."
    });
  const destination = yield* localIO("Resolve patchy.json", () => safePath(cwd, "patchy.json"));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staged = yield* fs.makeTempFileScoped({ directory: cwd, prefix: ".patchy-publish-" });
      yield* fs.writeFileString(staged, json({ ...repo, patch: patchId }));
      yield* fs.rename(staged, destination);
    })
  ).pipe(
    Effect.mapError(
      (cause) =>
        new LocalError({
          message:
            "Could not write patch into patchy.json. Run publish again to recover the saved result.",
          cause
        })
    )
  );
});

const installedFailure = (stderr: string, instanceUrl: string, fallback: string) => {
  const failure = decodeFailure(stderr.trim());
  if (Option.isNone(failure)) return new LocalError({ message: fallback });
  const error = failure.value;
  const fields = { message: error.error, ...(error.code ? { code: error.code } : {}) };
  switch (error.kind) {
    case "rejected":
      return new RejectedError(fields);
    case "unreachable":
      return new UnreachableError({ ...fields, instanceUrl });
    case "local":
      return new LocalError(fields);
  }
};

const install = Effect.fn("Project.install")(function* (cwd: string) {
  const result = yield* processResult(cwd, "pnpm", [
    "install",
    "--ignore-workspace",
    "--ignore-scripts",
    "--no-frozen-lockfile",
    "--reporter=silent"
  ]);
  if (result.code !== 0)
    return yield* new LocalError({
      message: "Dependency installation failed; the previous project set is preserved."
    });
});

/** The installed release owns config execution; keep its private protocol in one place. */
const runInstalledGenerate = Effect.fn("Project.runInstalledGenerate")(function* (
  cwd: string,
  token: Redacted.Redacted,
  release: string,
  skills: readonly string[],
  change?: Change
) {
  const path = yield* Path.Path;
  const instance = yield* Instance.Instance;
  const child = yield* processResult(
    cwd,
    process.execPath,
    [
      path.join(cwd, "node_modules/patchy/dist/index.js"),
      "__generate",
      "--release",
      release,
      "--skills",
      Output.toJson(skills),
      "--api-url",
      instance.apiUrl,
      "--json",
      ...(change ? ["--change", Output.toJson(change)] : [])
    ],
    { PATCHY_API_TOKEN: Redacted.value(token) }
  );
  if (child.code !== 0)
    return yield* installedFailure(
      child.stderr,
      instance.apiUrl,
      "Installed CLI generation failed."
    );
  return yield* parse("Read installed CLI generation", () => decodeChild(child.stdout));
});

const refusal = (error: Api.ClientFailure, fallback: string) =>
  Effect.gen(function* () {
    const instance = yield* Instance.Instance;
    if (
      Api.isRefusal(error) &&
      (error.code === "connection_not_connected" || error.code === "patch_not_openable")
    ) {
      return yield* new RejectedError({
        message: `${Api.refusalMessage(error, fallback)}\nAsk an admin at ${instance.apiUrl}/company${error.code === "connection_not_connected" ? "/connections" : ""}.`,
        code: error.code
      });
    }
    return yield* Api.classify(error, fallback);
  });

export const catalog = Effect.fn("Project.catalog")(function* (
  token: Redacted.Redacted,
  all: boolean
) {
  const client = yield* Api.client(token);
  const result = yield* client
    .catalog({ query: { all } })
    .pipe(Effect.catch((error) => refusal(error, "Could not read the catalog.")));
  const lines: string[] = [];
  for (const connection of result.connections) {
    const alias = connectionAlias(connection.handle);
    lines.push(
      `${connection.integration}/${connection.handle} — ${connection.description} (${connection.status})`,
      `  patchy add ${connection.integration}/${connection.handle}`,
      `  uses: { ${Output.toJson(alias)}: postgres(${Output.toJson(connection.handle)}) }`
    );
  }
  for (const shared of result.sharedTables)
    lines.push(
      `${shared.name}: ${shared.table} (${shared.patchId}, revision ${shared.schemaRevision})`,
      `  patchy add shared-table ${shared.patchId}/${shared.table}`,
      `  uses: { ${Output.toJson(shared.table)}: sharedTable(${Output.toJson(shared.patchId)}, ${Output.toJson(shared.table)}) }`
    );
  for (const offered of result.offered ?? [])
    lines.push(`${offered.integration}: ${offered.connected ? "connected" : "not connected"}`);
  if (!all) lines.push("Run patchy catalog --all to see every offered integration and its state.");
  yield* Output.report(encodeCatalog(result), lines);
});

/** Private subprocess entry: this is executed by the installed release, never the old CLI. */
export const generate = Effect.fn("Project.generate")(function* (
  cwd: string,
  token: Redacted.Redacted,
  release: string,
  skillsText: string,
  changeText: Option.Option<string>
) {
  if (release !== RELEASE)
    return yield* new LocalError({
      message: `Installed CLI release ${RELEASE} does not match ${release}. Run: patchy refresh`,
      code: "release_mismatch"
    });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = yield* localIO("Read config path", () => safePath(cwd, "patchy.config.ts"));
  let skills = yield* parse("Read skill names", () => decodeSkills(skillsText));
  const removedSkills: string[] = [];
  const change = Option.isSome(changeText)
    ? yield* parse("Read declaration edit", () => decodeChange(changeText.value))
    : undefined;
  let removedKind: Declaration["kind"] | undefined;
  let configEdit: typeof ConfigEdit.Type | undefined;
  if (change) {
    const source = yield* fs
      .readFileString(configPath)
      .pipe(
        Effect.mapError(
          (cause) => new LocalError({ message: "Could not read patchy.config.ts.", cause })
        )
      );
    if (change.kind === "remove") {
      const before = yield* localIO("Execute config", () =>
        executeConfig(configPath, { resolve: false, source })
      );
      const declaration = before.uses[change.alias];
      if (!declaration)
        return yield* new LocalError({ message: `No declaration named ${change.alias}.` });
      removedKind = declaration.kind;
    }
    // Static loading makes every lightweight command initialize TypeScript, including delete.
    const { editUses, isUsesEditRefused } = yield* localIO(
      "Load config editor",
      () => import("./editUses.js")
    );
    const edited = yield* Effect.try({
      try: () => editUses(source, change),
      catch: (cause) =>
        new LocalError({
          message: isUsesEditRefused(cause) ? cause.message : "Could not edit patchy.config.ts.",
          cause
        })
    });
    configEdit = { before: source, after: edited };
  }
  const manifest = yield* localIO("Execute config", () =>
    executeConfig(configPath, {
      resolve: false,
      ...(configEdit ? { source: configEdit.after } : {})
    })
  );
  if (
    removedKind &&
    !Object.values(manifest.uses).some((declaration) => declaration.kind === removedKind)
  ) {
    const skill = removedKind === "postgres" ? "patchy-postgres" : "patchy-shared-tables";
    if (skills.includes(skill)) removedSkills.push(skill);
    skills = skills.filter((name) => name !== skill);
  }
  const repoText = yield* fs
    .readFileString(path.join(cwd, "patchy.json"))
    .pipe(
      Effect.mapError((cause) => new LocalError({ message: "Could not read patchy.json.", cause }))
    );
  const repo = yield* parse("Read patchy.json", () => decodeRepo(repoText));
  const client = yield* Api.client(token);
  const generated = yield* client
    .generate({
      payload: {
        release,
        manifest,
        skills,
        ...(repo.patch === undefined ? {} : { patchId: repo.patch })
      }
    })
    .pipe(Effect.catch((error) => refusal(error, "Generation failed.")));
  const uses: Record<string, (typeof Manifest.Type)["uses"][string]> = {};
  const stamps = new Map(generated.uses.map((stamp) => [stamp.alias, stamp]));
  if (stamps.size !== generated.uses.length || stamps.size !== Object.keys(manifest.uses).length)
    return yield* new LocalError({
      message: "Generation returned an inconsistent declaration set."
    });
  for (const [alias, declaration] of Object.entries(manifest.uses)) {
    const stamp = stamps.get(alias);
    if (!stamp)
      return yield* new LocalError({ message: `Generation returned no stamp for ${alias}.` });
    uses[alias] = { ...declaration, id: stamp.id, revision: stamp.revision };
  }
  yield* Output.report(
    {
      generated,
      manifest: { ...manifest, uses },
      removedSkills,
      ...(configEdit ? { configEdit } : {})
    },
    []
  );
});

export const refresh = Effect.fn("Project.refresh")(function* (
  cwd: string,
  token: Redacted.Redacted,
  change?: Change
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instance = yield* Instance.Instance;
  const client = yield* Api.client(token);
  const release = yield* client
    .release()
    .pipe(Effect.catch((error) => Api.classify(error, "Could not read the instance release.")));
  const tarball = new URL(release.package.tarball, `${instance.apiUrl}/`).href;
  const executable = path.join(cwd, "node_modules/patchy/dist/index.js");
  const { changed, from, pinChanged } = yield* Effect.acquireUseRelease(
    localIO("Begin project transaction", () => ManagedProject.begin(cwd)),
    (transaction) =>
      Effect.gen(function* () {
        const packagePath = yield* localIO("Read package path", () =>
          safePath(cwd, "package.json")
        );
        const source = yield* fs.readFileString(packagePath).pipe(
          Effect.mapError(
            (cause) =>
              new LocalError({
                message: "Run this command inside a patch repo created with patchy init.",
                cause
              })
          )
        );
        const pkg = yield* parse("Read package.json", () => decodePackage(source));
        const dependencies = yield* parse("Read package devDependencies", () =>
          decodeDependencies(pkg.devDependencies)
        );
        const previousPin = dependencies.patchy;
        if (!previousPin)
          return yield* new LocalError({
            message: "package.json must pin patchy as a devDependency."
          });
        const pinChanged = previousPin !== tarball;
        const from = /patchy-([^/]+)\.tgz(?:[?#].*)?$/.exec(previousPin)?.[1] ?? previousPin;
        const skills = yield* localIO("Read project skills", () => presentSkills(cwd));
        const needsInstall =
          pinChanged || !(yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false)));
        if (pinChanged) {
          yield* localIO("Update package pin", () => transaction.setPin(previousPin, tarball)).pipe(
            Effect.uninterruptible
          );
        }
        if (needsInstall) {
          yield* localIO("Preserve previous installation", () => transaction.prepareInstall()).pipe(
            Effect.uninterruptible
          );
          yield* install(cwd);
        }
        const result = yield* runInstalledGenerate(cwd, token, release.release, skills, change);
        const changed = yield* localIO("Activate generated files", () =>
          transaction.activate(
            result.generated.files,
            json(result.manifest),
            result.removedSkills,
            result.configEdit
          )
        ).pipe(Effect.uninterruptible);
        return { changed, from, pinChanged };
      }),
    (transaction, exit) =>
      localIO("Restore project transaction", () => transaction.finish(Exit.isSuccess(exit))).pipe(
        Effect.orDie
      )
  );
  if (change?.kind === "add") {
    yield* Output.report(
      {
        ok: true,
        alias: change.alias,
        declaration: change.declaration,
        generated: changed.generated,
        skills: changed.skills
      },
      [`Added ${change.alias}.`, ...changed.generated, ...changed.fixtures]
    );
  } else if (change?.kind === "remove") {
    yield* Output.report({ ok: true, alias: change.alias, removed: [change.alias] }, [
      `Removed ${change.alias} and its generated declaration files. The fixture was left in fixtures/.`
    ]);
  } else
    yield* Output.report(
      {
        ok: true,
        release: { from, to: release.release },
        changed: { pin: pinChanged, ...changed }
      },
      [
        `Refreshed ${from} → ${release.release}.`,
        ...(pinChanged ? ["Updated the patchy pin and installed the new release."] : []),
        ...changed.generated,
        ...changed.skills,
        ...changed.fixtures
      ]
    );
});

export const add = Effect.fn("Project.add")(function* (
  cwd: string,
  token: Redacted.Redacted,
  integration: string,
  target: Option.Option<string>,
  as: Option.Option<string>
) {
  if (Option.isSome(as) && !isDefinitionName(as.value))
    return yield* new LocalError({
      message:
        "--as must be a camelCase alias starting with a lowercase letter, containing only letters and digits, and at most 63 characters. For example: --as salesDb"
    });
  const client = yield* Api.client(token);
  const available = yield* client
    .catalog({ query: { all: false } })
    .pipe(Effect.catch((error) => refusal(error, "Could not read the catalog.")));
  const instance = yield* Instance.Instance;
  let declaration: Declaration;
  let defaultAlias: string;
  if (integration === "postgres" || integration.startsWith("postgres/")) {
    if (Option.isSome(target))
      return yield* new LocalError({ message: "Use patchy add postgres/<handle> [--as <alias>]." });
    const handle = integration === "postgres" ? undefined : integration.slice("postgres/".length);
    const connections = available.connections.filter(
      (connection) =>
        connection.integration === "postgres" &&
        connection.status === "connected" &&
        (handle === undefined || connection.handle === handle)
    );
    if (connections.length === 0)
      return yield* new RejectedError({
        code: "connection_not_connected",
        message: `No connected Postgres connection${handle ? ` named ${handle}` : ""}. Ask an admin at ${instance.apiUrl}/company/connections.`
      });
    if (connections.length > 1)
      return yield* new LocalError({
        message: `Choose a Postgres connection:\n${connections.map((connection) => `  patchy add postgres/${connection.handle} — ${connection.description}`).join("\n")}`
      });
    declaration = { kind: "postgres", handle: connections[0]!.handle };
    defaultAlias = connectionAlias(declaration.handle);
  } else if (integration === "shared-table") {
    const parts = Option.isSome(target) ? target.value.split("/") : [];
    if (parts.length !== 2 || !parts[0] || !parts[1])
      return yield* new LocalError({
        message: "Use patchy add shared-table <patchId>/<table> [--as <alias>]."
      });
    const shared = available.sharedTables.find(
      (table) => table.patchId === parts[0] && table.table === parts[1]
    );
    if (!shared)
      return yield* new RejectedError({
        code: "patch_not_openable",
        message: `That shared table is not available to you. Ask an admin at ${instance.apiUrl}/company.`
      });
    declaration = { kind: "sharedTable", patchId: shared.patchId, table: shared.table };
    defaultAlias = shared.table;
  } else
    return yield* new LocalError({
      message: "Use patchy add postgres/<handle> or patchy add shared-table <patchId>/<table>."
    });
  const alias = Option.getOrElse(as, () => defaultAlias);
  yield* refresh(cwd, token, { kind: "add", alias, declaration });
});

export const init = Effect.fn("Project.init")(function* (
  cwd: string,
  token: Redacted.Redacted,
  directory: Option.Option<string>,
  tier: 0 | 1,
  purposeOption: Option.Option<string>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instance = yield* Instance.Instance;
  const client = yield* Api.client(token);
  // Identity is checked before purpose prompting, directory checks, or any repo writes.
  const identity = yield* client
    .me()
    .pipe(Effect.catch((error) => refusal(error, "Authentication failed.")));
  yield* Output.notice(
    `Instance: ${instance.apiUrl}\nUser: ${identity.user.name} (${identity.user.email})\nCompany: ${identity.company.name} (${identity.company.handle})`
  );
  let purpose = Option.getOrUndefined(purposeOption);
  if (!purpose) {
    if ((yield* Login.notWaitingBecause) !== null)
      return yield* new LocalError({
        message: "Supply --purpose <text> when initializing non-interactively."
      });
    purpose = yield* Prompt.run(Prompt.text({ message: "What is this patch for?" })).pipe(
      Effect.catchTags({ QuitError: () => Effect.interrupt })
    );
  }
  if (!purpose.trim())
    return yield* new LocalError({ message: "The patch's purpose must not be empty." });
  const dir = path.resolve(
    cwd,
    Option.getOrElse(directory, () => ".")
  );
  // realPath on the parent plus safePath refuses a target symlink, including a dangling one.
  const parent = yield* fs
    .realPath(path.dirname(dir))
    .pipe(
      Effect.mapError(
        (cause) => new LocalError({ message: "The parent directory must exist.", cause })
      )
    );
  yield* localIO("Check init directory", () => safePath(parent, path.basename(dir)));
  const exists = yield* fs
    .exists(dir)
    .pipe(
      Effect.mapError(
        (cause) => new LocalError({ message: "Could not inspect the init directory.", cause })
      )
    );
  if (
    exists &&
    (yield* fs
      .readDirectory(dir)
      .pipe(
        Effect.mapError(
          (cause) => new LocalError({ message: "Could not inspect the init directory.", cause })
        )
      )).length > 0
  )
    return yield* new LocalError({ message: `Refusing to initialize an existing tree: ${dir}` });
  const release = yield* client
    .release()
    .pipe(Effect.catch((error) => Api.classify(error, "Could not read the instance release.")));
  const candidate = path
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  const name = yield* parse("Choose a project directory with a valid patch name", () =>
    decodeName(candidate.length >= 3 ? candidate : "my-patch")
  );
  const tarball = new URL(release.package.tarball, `${instance.apiUrl}/`).href;
  const files = starterFiles({ instance: instance.apiUrl, name, tier, purpose, tarball });
  yield* Effect.acquireUseRelease(
    fs
      .makeTempDirectory({ directory: parent, prefix: ".patchy-init-" })
      .pipe(
        Effect.mapError(
          (cause) => new LocalError({ message: "Could not stage the project directory.", cause })
        )
      ),
    (staging) =>
      Effect.gen(function* () {
        for (const [name, contents] of Object.entries(files)) {
          const target = path.join(staging, name);
          yield* fs
            .makeDirectory(path.dirname(target), { recursive: true })
            .pipe(
              Effect.mapError(
                (cause) => new LocalError({ message: `Could not create ${name}.`, cause })
              )
            );
          yield* fs
            .writeFileString(target, contents, { flag: "wx" })
            .pipe(
              Effect.mapError(
                (cause) => new LocalError({ message: `Could not create ${name}.`, cause })
              )
            );
        }
        yield* install(staging);
        const result = yield* runInstalledGenerate(staging, token, release.release, []);
        const changed = yield* localIO("Write initial generation", () =>
          writeInitialGeneration(staging, result.generated.files, json(result.manifest))
        );
        yield* localIO("Activate the completed project", () => activateStarter(staging, dir)).pipe(
          Effect.uninterruptible
        );
        yield* Output.report(
          {
            ok: true,
            dir,
            release: release.release,
            tier,
            generated: changed.generated,
            skills: changed.skills,
            installed: true
          },
          [
            `Initialized ${dir} (tier ${tier}, release ${release.release}).`,
            "Dependencies are installed. AGENTS.md and CLAUDE.md were written once.",
            ...changed.generated,
            ...changed.skills,
            "Test with: pnpm patchy dev"
          ]
        );
      }),
    (staging) => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.orDie)
  );
});
