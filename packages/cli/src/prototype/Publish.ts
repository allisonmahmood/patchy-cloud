/**
 * PROTOTYPE (#176). `patchy publish` from a patch repo: execute the config
 * into its manifest, build the tree to one HTML file, check the tier the
 * tree evidently needs against the one the config claims, and send both to
 * `POST /api/publish`. The first publish creates the patch and writes its id
 * to `patchy.json`; every later one adds a version to that patch.
 *
 * The tier check runs here as well as on the server, because only the CLI
 * sees the whole tree: server code under `server/` never leaves the repo on
 * a tier 1 publish, so its presence is the CLI's to refuse.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  type Manifest,
  PublishCreated,
  PublishRequest,
  PublishUpdated,
  UploadMetadata
} from "@patchy/api";
import { sha256 } from "@patchy/core";
import * as Api from "../Api.js";
import { LocalError, RejectedError } from "../CliError.js";
import * as Git from "../Git.js";
import * as Output from "../Output.js";
import * as Repo from "./Repo.js";

const encodePublished = Schema.encodeSync(Schema.Union([PublishCreated, PublishUpdated]));

/** The tier the tree evidently needs: 2 with server code, 1 with script, 0 otherwise. */
const evidentTier = Effect.fn("Publish.evidentTier")(function* (root: string, html: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* fs.exists(path.join(root, "server")).pipe(Effect.orElseSucceed(() => false))) return 2;
  return /<script[\s>]/i.test(html) ? 1 : 0;
});

const build = Effect.fn("Publish.build")(function* (root: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vite = path.join(root, "node_modules", ".bin", "vite");
  if (!(yield* fs.exists(vite).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new LocalError({
      message: `Vite is not installed in ${root}. Run the package manager's install first (pnpm install).`
    });
  }
  const exit = yield* spawner
    .exitCode(
      ChildProcess.make(vite, ["build", "--logLevel", "warn"], {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit"
      })
    )
    .pipe(Effect.mapError((cause) => new LocalError({ message: "Could not run Vite.", cause })));
  if (exit !== 0) return yield* new LocalError({ message: `vite build exited with ${exit}.` });
  return yield* fs
    .readFileString(path.join(root, "dist", "index.html"))
    .pipe(
      Effect.mapError(
        (cause) => new LocalError({ message: "The build produced no dist/index.html.", cause })
      )
    );
});

export const publish = Effect.fn("Publish.publish")(function* (input: {
  readonly cwd: string;
  readonly token: Parameters<typeof Api.client>[0];
  readonly instanceUrl: string;
  readonly cliVersion: string;
  readonly scope: Option.Option<"company" | "public">;
}) {
  const root = yield* Repo.find(input.cwd);
  const manifest: Manifest = yield* Repo.manifest(root);
  const patchId = yield* Repo.readPatchId(root);
  const html = yield* build(root);

  const needs = yield* evidentTier(root, html);
  if (needs > manifest.tier) {
    return yield* new LocalError({
      message:
        `patchy.config.ts declares tier ${manifest.tier} but the tree needs tier ${needs}` +
        (needs === 2 ? " (it has a server/ directory)." : " (the bundle contains script).") +
        (needs === 2 ? " Tier 2 is not available yet." : " Set tier: 1 in patchy.config.ts.")
    });
  }

  const client = yield* Api.client(input.token);
  const published = yield* client
    .publish({
      payload: new PublishRequest({
        manifest,
        html,
        ...(Option.isSome(patchId) ? { patchId: patchId.value } : {}),
        ...(Option.isSome(input.scope) ? { scope: input.scope.value } : {}),
        metadata: new UploadMetadata({
          ...(yield* Git.metadata(root)),
          cliVersion: input.cliVersion,
          fileSha256: sha256(html)
        })
      })
    })
    .pipe(
      Effect.catch((error) => {
        if (Api.isRefusal(error) && error.error === "Patch not found.") {
          return new RejectedError({
            message: `patchy.json names patch ${Option.getOrElse(patchId, () => "?")}, which is not on ${input.instanceUrl} or is not yours. Remove the id from patchy.json to create a new patch.`
          });
        }
        return Api.classify(error, "Publish failed.");
      })
    );

  if (Option.isNone(patchId)) yield* Repo.writePatchId(root, published.patchId);

  const provisioned = [
    ...published.provisioned.tables.map((t) => `table ${t}`),
    ...published.provisioned.columns.map((c) => `column ${c}`),
    ...published.provisioned.files.map((f) => `file store ${f}`)
  ];
  yield* Output.report(encodePublished(published), [
    Option.isNone(patchId) ? "Published new patch" : "Published version",
    `URL: ${published.publicUrl}`,
    `Tier: ${published.tier}`,
    `Patch ID: ${published.patchId}${Option.isNone(patchId) ? " (written to patchy.json; commit it)" : ""}`,
    `Version: ${published.versionNumber}`,
    provisioned.length > 0 ? `Provisioned: ${provisioned.join(", ")}` : "Provisioned: nothing new"
  ]);
});
