/**
 * PROTOTYPE (#176). The patch-repo commands: `init`, `dev`, `publish`,
 * `refresh`. They share the CLI's instance resolution, credential precedence
 * and output contract with the tier 0 commands; what is new is the repo.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the SDK's link target is found relative to this source file.
import { fileURLToPath } from "node:url";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { SharingScope } from "@patchy/api";
import * as Api from "../Api.js";
import { LocalError } from "../CliError.js";
import { Cwd, refused, requiredToken, run, VERSION } from "../commands.js";
import * as Instance from "../Instance.js";
import * as Output from "../Output.js";
import * as Dev from "./Dev.js";
import * as Publish from "./Publish.js";
import * as Repo from "./Repo.js";
import type * as Tree from "./Tree.js";

/**
 * Where the repo's `@patchy/sdk` resolves from. The prototype links the
 * workspace package; the real thing pins a published version.
 */
const sdkSpec = Effect.gen(function* () {
  const path = yield* Path.Path;
  const override = yield* Instance.optionalEnv("PATCHY_SDK_SPEC");
  if (Option.isSome(override)) return override.value;
  return `link:${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../sdk")}`;
});

/** The context every laid-down file is written from: who, where, which patch. */
const contextFor = Effect.fn("contextFor")(function* (input: {
  readonly name: string;
  readonly tier: 0 | 1;
  readonly patchId: Option.Option<string>;
}) {
  const instance = yield* Instance.Instance;
  const token = yield* requiredToken();
  const client = yield* Api.client(token);
  const identity = yield* client
    .me()
    .pipe(Effect.catch((error) => refused(error, "Could not read who this key acts as.")));
  const now = yield* DateTime.now;
  return {
    name: input.name,
    tier: input.tier,
    instanceUrl: instance.apiUrl,
    company: identity.company,
    user: identity.user,
    machine: identity.machine,
    patchId: Option.getOrNull(input.patchId),
    sdkSpec: yield* sdkSpec,
    refreshedAt: DateTime.formatIso(now)
  } satisfies Tree.Context;
});

const install = Effect.fn("install")(function* (root: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exit = yield* spawner
    .exitCode(
      ChildProcess.make("pnpm", ["install", "--silent"], {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit"
      })
    )
    .pipe(
      Effect.mapError((cause) => new LocalError({ message: "Could not run pnpm install.", cause }))
    );
  if (exit !== 0) return yield* new LocalError({ message: `pnpm install exited with ${exit}.` });
});

const tierFlag = Flag.choice("tier", ["0", "1"]).pipe(
  Flag.withDescription("Where the patch's code runs: 0 static, 1 in the viewer's browser"),
  Flag.withDefault("1")
);

const init = Command.make(
  "init",
  {
    tier: tierFlag,
    dir: Argument.string("dir").pipe(
      Argument.withDescription(
        "The directory to create the patch repo in (default: the current one)"
      ),
      Argument.optional
    )
  },
  (options) =>
    run(
      Effect.gen(function* () {
        const cwd = yield* Cwd;
        const path = yield* Path.Path;
        const root = path.resolve(
          cwd,
          Option.getOrElse(options.dir, () => ".")
        );
        const tier = options.tier === "0" ? 0 : 1;
        const context = yield* contextFor({
          name: path.basename(root),
          tier,
          patchId: Option.none()
        });
        yield* Repo.layDown(root, context);
        yield* Output.notice(`Laid down a tier ${tier} patch repo in ${root}. Installing…`);
        yield* install(root);
        yield* Output.report(
          {
            ok: true,
            root,
            tier,
            company: context.company,
            devIdentity: { user: context.user, machine: context.machine },
            next: ["patchy dev", "patchy publish"]
          },
          [
            `Patch repo ready in ${root}.`,
            `Company: ${context.company.name} (${context.company.handle})`,
            `Dev identity: ${context.user.name} (${context.user.email}), machine ${context.machine.name}`,
            "Next: read AGENTS.md, then run patchy dev."
          ]
        );
      })
    )
).pipe(
  Command.withDescription(
    "PROTOTYPE. Lay down a patch repo: config, starter app, typed client, context and skill."
  )
);

const refresh = Command.make("refresh", {}, () =>
  run(
    Effect.gen(function* () {
      const cwd = yield* Cwd;
      const path = yield* Path.Path;
      const root = yield* Repo.find(cwd);
      const manifest = yield* Repo.manifest(root);
      const context = yield* contextFor({
        name: path.basename(root),
        tier: manifest.tier,
        patchId: yield* Repo.readPatchId(root)
      });
      yield* Repo.refresh(root, context);
      yield* Output.report({ ok: true, root, refreshedAt: context.refreshedAt }, [
        `Refreshed AGENTS.md, patchy/_generated/ and the skill in ${root}.`
      ]);
    })
  )
).pipe(
  Command.withDescription(
    "PROTOTYPE. Re-fetch the context file, the generated directory and the skill from the instance."
  )
);

const dev = Command.make("dev", {}, () =>
  run(
    Effect.gen(function* () {
      const cwd = yield* Cwd;
      const root = yield* Repo.find(cwd);
      const manifest = yield* Repo.manifest(root);
      const token = yield* requiredToken();
      const client = yield* Api.client(token);
      const identity = yield* client
        .me()
        .pipe(Effect.catch((error) => refused(error, "Could not read who this key acts as.")));
      yield* Console.log(`Repo: ${root}`);
      yield* Dev.dev(root, manifest, { user: identity.user, company: identity.company });
    })
  )
).pipe(
  Command.withDescription(
    "PROTOTYPE. Run the patch locally: the dev runtime over PGlite as the machine key's user, plus Vite."
  )
);

const publish = Command.make(
  "publish",
  {
    share: Flag.choice("share", SharingScope.literals).pipe(
      Flag.withDescription("Who can open the patch: your company or anyone with the link"),
      Flag.optional
    )
  },
  (options) =>
    run(
      Effect.gen(function* () {
        const cwd = yield* Cwd;
        const instance = yield* Instance.Instance;
        const token = yield* requiredToken();
        yield* Output.notice(
          `Publishing to ${instance.apiUrl} (target came from ${Instance.describeSource(instance.source)}).`
        );
        yield* Publish.publish({
          cwd,
          token,
          instanceUrl: instance.apiUrl,
          cliVersion: VERSION,
          scope: options.share
        });
      })
    )
).pipe(
  Command.withDescription(
    "PROTOTYPE. Build the patch repo, check its tier, provision its tables and publish a version."
  )
);

export const commands = [init, dev, publish, refresh];
