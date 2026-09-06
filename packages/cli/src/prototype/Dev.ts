/**
 * PROTOTYPE (#176). `patchy dev`: the dev runtime as the decision on the
 * map describes it — the same `Tables` and `Files` services the server
 * runs, composed over PGlite and a file store under `.patchy/`, bound to
 * the machine token's user as the viewer — plus Vite serving the app with
 * `/_patchy` proxied to that runtime. One URL, one process, Ctrl-C ends both.
 *
 * Metadata comes from the instance (`/api/me` for who the viewer is); rows
 * never do. The manifest last provisioned is kept in `.patchy/manifest.json`
 * so a config change is diffed the way publish will diff it, and refused
 * the same way when it is not additive.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the runtime's Node server is Node's to create.
import { createServer } from "node:http";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodePath from "@effect/platform-node/NodePath";
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { Manifest } from "@patchy/api";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import { Routes, Tables } from "@patchy/primitives";
import { LocalError } from "../CliError.js";
import * as Repo from "./Repo.js";

/** The one namespace a repo's local database holds; the database is the repo's, so the id is fixed. */
const DEV_NAMESPACE = "p_local";

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Manifest));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

/** The runtime's services over the repo's `.patchy/` directory. */
const runtime = (root: string, binding: Routes.Binding["Service"]) => {
  const local = `${root}/${Repo.LOCAL_DIR}`;
  const store = Layer.effect(ContentStore.ContentStore, FilesystemContentStore.make).pipe(
    Layer.provide([
      NodeFileSystem.layer,
      NodePath.layer,
      ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: `${local}/files` }))
    ])
  );
  return Layer.mergeAll(
    PgliteClient.layer({ dataDir: `${local}/pglite` }),
    store,
    Layer.succeed(Routes.Binding, binding)
  );
};

/** Provisions the config into the local database, diffed against the last run's manifest. */
const provision = Effect.fn("Dev.provision")(function* (root: string, next: Manifest) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tables = yield* Tables.Tables;
  const file = path.join(root, Repo.LOCAL_DIR, "manifest.json");
  const previous = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeManifest),
    Effect.orElseSucceed(() => null)
  );
  const provisioned = yield* tables.provision({ namespace: DEV_NAMESPACE, previous, next }).pipe(
    Effect.catchTags({
      NotAdditive: (error) =>
        new LocalError({
          message: `${error.message}\nThe local database still has the previous schema. Delete ${Repo.LOCAL_DIR}/ to start over, or make the change additive.`
        }),
      SqlError: (cause) =>
        new LocalError({ message: "Could not provision the local database.", cause })
    })
  );
  yield* fs.writeFileString(file, encodeManifest(next)).pipe(Effect.orDie);
  return provisioned;
});

export const dev = Effect.fn("Dev.dev")(function* (
  root: string,
  manifest: Manifest,
  viewer: Routes.Viewer
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vite = path.join(root, "node_modules", ".bin", "vite");
  if (!(yield* fs.exists(vite).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new LocalError({
      message: `Vite is not installed in ${root}. Run the package manager's install first (pnpm install).`
    });
  }

  const binding: Routes.Binding["Service"] = { namespace: DEV_NAMESPACE, manifest, viewer };
  const app = HttpRouter.serve(Routes.layerWithServices, {
    disableLogger: true,
    disableListenLog: true
  });

  yield* Effect.gen(function* () {
    const provisioned = yield* provision(root, manifest);
    const created = [
      ...provisioned.tables.map((t) => `table ${t}`),
      ...provisioned.columns.map((c) => `column ${c}`),
      ...provisioned.files.map((f) => `file store ${f}`)
    ];
    yield* Console.log(
      created.length > 0
        ? `Provisioned locally: ${created.join(", ")}.`
        : "Local database matches patchy.config.ts."
    );
    const address = yield* HttpServer.addressFormattedWith(Effect.succeed);
    yield* Console.log(
      `Patchy dev runtime at ${address} as ${viewer.user.name} (${viewer.company.name}).`
    );
    yield* Console.log("Starting Vite; the app URL is printed below. Ctrl-C stops both.");
    const exit = yield* spawner.exitCode(
      ChildProcess.make(vite, ["--strictPort", "--clearScreen", "false"], {
        cwd: root,
        env: { PATCHY_RUNTIME_URL: address },
        extendEnv: true,
        stdout: "inherit",
        stderr: "inherit"
      })
    );
    if (exit !== 0) return yield* new LocalError({ message: `Vite exited with ${exit}.` });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(app, Tables.layer).pipe(
        Layer.provideMerge(runtime(root, binding)),
        Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" }))
      )
    ),
    Effect.scoped,
    Effect.catchTags({
      SqlError: (cause) =>
        new LocalError({ message: "The local database could not start.", cause }),
      PlatformError: (cause) => new LocalError({ message: "Could not start Vite.", cause }),
      ConfigError: (cause) =>
        new LocalError({ message: "The local file store is misconfigured.", cause }),
      ServeError: (cause) => new LocalError({ message: "The dev runtime could not listen.", cause })
    })
  );
});
