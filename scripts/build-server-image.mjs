// Shared runtime assembly for Dockerfile and the daemonless CI/export path.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    output: { type: "string", default: ".local/server-image.tar" },
    tag: { type: "string", default: "patchy-server:local" },
    stage: { type: "string" },
    help: { type: "boolean", default: false }
  }
});
if (values.help) {
  console.log(`Usage: node scripts/build-server-image.mjs [--output FILE] [--tag TAG]
       node scripts/build-server-image.mjs --stage DIRECTORY

Requires Linux x64, Node 24.20.0, pnpm from packageManager, GNU tar and crane v0.22.1.
Run pnpm install --frozen-lockfile first. Builds all server source dependencies.
Exports a Docker-loadable image tar and FILE.json without a daemon or registry push.
The default output is .local/server-image.tar; --stage only assembles the runtime.
SOURCE_DATE_EPOCH and REVISION default to the current git commit's time and hash.
VERSION defaults to the server package version. No credentials enter the image.
Host: node dist/start.js (default, user node). Exec: node dist/exec.js.
Fleet operations, such as a deploy's promote: node dist/fleet.js.`);
  process.exit(0);
}
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The server image recipe requires Linux x64 (the ECS X86_64 target).");
}
if (process.version !== "v24.20.0") {
  throw new Error("Use Node 24.20.0, matching the pinned image and CI builder.");
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
const capture = (command, args) =>
  run(command, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).trim();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const serverPackage = JSON.parse(
  await readFile(path.join(root, "apps/server/package.json"), "utf8")
);
const pnpmVersion = rootPackage.packageManager.slice("pnpm@".length);
if (capture("pnpm", ["--version"]) !== pnpmVersion) {
  throw new Error(`Use pnpm ${pnpmVersion}, as pinned in packageManager.`);
}
const dockerfile = await readFile(path.join(root, "apps/server/Dockerfile"), "utf8");
const base = /^FROM (node:24-slim@sha256:[a-f0-9]{64}) AS builder$/m.exec(dockerfile)?.[1];
if (!base) throw new Error("Dockerfile must pin the node:24-slim builder by digest.");
const epoch = Number(
  process.env.SOURCE_DATE_EPOCH ?? capture("git", ["show", "-s", "--format=%ct", "HEAD"])
);
if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 253402300799) {
  throw new Error("SOURCE_DATE_EPOCH must be a nonnegative Unix timestamp before year 10000.");
}
const revision = process.env.REVISION ?? capture("git", ["rev-parse", "HEAD"]);
const created = new Date(epoch * 1000).toISOString();
const metadata = {
  base,
  platform: "linux/amd64",
  sourceDateEpoch: epoch,
  revision,
  version: process.env.VERSION ?? serverPackage.version,
  node: process.version,
  pnpm: pnpmVersion,
  hostCommand: ["node", "dist/start.js"],
  execCommand: ["node", "dist/exec.js"],
  fleetCommand: ["node", "dist/fleet.js"],
  user: "node"
};
const buildEnv = { ...process.env, SOURCE_DATE_EPOCH: String(epoch), TZ: "UTC", LC_ALL: "C" };
const temporary = await mkdtemp(path.join(tmpdir(), "patchy-image-"));

// pnpm's package files allowlists retain SDK archives/skills and native platform
// packages. Never copy the checkout, its .env files or home/config directories.
async function stageRuntime(destination) {
  await mkdir(destination);
  run("pnpm", ["--config.verify-deps-before-run=false", "--filter", "@patchy/server...", "build"], {
    env: buildEnv
  });
  const app = path.join(destination, "app");
  run(
    "pnpm",
    [
      "--filter",
      "@patchy/server",
      "deploy",
      "--prod",
      "--legacy",
      "--ignore-scripts",
      "--config.package-import-method=copy",
      // Workspace patches for test-only dependencies go unused in a production deploy.
      "--config.allow-unused-patches=true",
      app
    ],
    { env: buildEnv }
  );
  await copyFile(path.join(root, "LICENSE"), path.join(app, "LICENSE"));
  await mkdir(path.join(destination, "data"));
  await writeFile(path.join(app, "image-build.json"), JSON.stringify(metadata, null, 2) + "\n");

  // Installation bookkeeping and generated command shims contain timestamps and
  // absolute staging paths. Runtime uses package-resolved binaries, not .bin.
  async function normalize(directory) {
    await chmod(directory, 0o755);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (
        path.basename(directory) === "node_modules" &&
        [".bin", ".modules.yaml", ".pnpm-workspace-state-v1.json"].includes(entry.name)
      ) {
        await rm(file, { recursive: true, force: true });
      } else if (path.basename(directory) === ".pnpm" && entry.name === "lock.yaml") {
        await rm(file);
      } else if (entry.isDirectory()) {
        await normalize(file);
      } else if (entry.isFile()) {
        const stat = await lstat(file);
        await chmod(file, stat.mode & 0o111 ? 0o755 : 0o644);
      }
    }
  }
  await normalize(destination);

  for (const file of ["dist/start.js", "dist/exec.js", "dist/fleet.js"])
    await access(path.join(app, file));
  const executionRoot = path.join(app, "node_modules/@patchy/execution");
  const execution = createRequire(await realpath(path.join(executionRoot, "package.json")));
  await access(path.join(executionRoot, "dist/loader.js"));
  const workerd = createRequire(execution.resolve("workerd/package.json"));
  await access(workerd.resolve("@cloudflare/workerd-linux-64/bin/workerd"));
  const esbuild = createRequire(execution.resolve("esbuild/package.json"));
  await access(esbuild.resolve("@esbuild/linux-x64/bin/esbuild"));
  const sdkRoot = path.join(app, "node_modules/@patchy/sdk");
  const release = JSON.parse(await readFile(path.join(sdkRoot, "artifacts/release.json"), "utf8"));
  const sdkArchive = await readFile(
    path.join(sdkRoot, "artifacts", `patchy-${release.release}-${release.digest}.tgz`)
  );
  if (digest(sdkArchive) !== release.digest) throw new Error("Packed SDK content digest mismatch.");
  await access(path.join(sdkRoot, "front-door/install.mjs"));
  // Generation writes the Patchy look for a company with none; it never ships Patchy's logo.
  for (const file of ["look.css", "LOOK.md"])
    await access(path.join(sdkRoot, "looks/patchy", file));
}

try {
  if (values.stage) {
    await stageRuntime(path.resolve(values.stage));
    console.log(`Staged server runtime at ${path.resolve(values.stage)}`);
  } else {
    if (capture("crane", ["version"]).replace(/^v/, "") !== "0.22.1")
      throw new Error("Use crane v0.22.1.");
    if (!capture("tar", ["--version"]).startsWith("tar (GNU tar)")) {
      throw new Error("GNU tar is required for deterministic archive metadata.");
    }
    const rootfs = path.join(temporary, "rootfs");
    await stageRuntime(rootfs);
    const layer = path.join(temporary, "runtime.tar");
    const tarMetadata = [
      "--sort=name",
      "--format=gnu",
      `--mtime=@${epoch}`,
      "--numeric-owner",
      "--hard-dereference"
    ];
    run(
      "tar",
      [
        ...tarMetadata,
        "--owner=0",
        "--group=0",
        "--create",
        "--file",
        layer,
        "--directory",
        rootfs,
        "app"
      ],
      { env: buildEnv }
    );
    // /app stays root-owned; only the host's local content-store directory is writable.
    run(
      "tar",
      [
        ...tarMetadata,
        "--owner=1000",
        "--group=1000",
        "--append",
        "--file",
        layer,
        "--directory",
        rootfs,
        "data"
      ],
      { env: buildEnv }
    );
    const appended = path.join(temporary, "appended.tar");
    run("crane", [
      "append",
      "--platform",
      metadata.platform,
      "--base",
      base,
      "--new_layer",
      layer,
      "--new_tag",
      values.tag,
      "--output",
      appended
    ]);

    // crane mutate only accepts registry inputs. Change the local Docker archive
    // config directly instead of publishing a temporary image or starting a registry.
    const archive = path.join(temporary, "archive");
    await mkdir(archive);
    run("tar", ["--extract", "--file", appended, "--directory", archive, "--no-same-owner"]);
    const manifestPath = path.join(archive, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.length !== 1) throw new Error("Expected one image in the crane archive.");
    const oldConfig = path.join(archive, manifest[0].Config);
    const config = JSON.parse(await readFile(oldConfig, "utf8"));
    config.created = created;
    config.config = {
      ...config.config,
      User: metadata.user,
      WorkingDir: "/app",
      Cmd: metadata.hostCommand,
      Env: [
        ...config.config.Env,
        "NODE_ENV=production",
        "PORT=3000",
        "PATCHY_STORAGE_DIR=/data/patches"
      ],
      ExposedPorts: { "3000/tcp": {} },
      Volumes: { "/data": {} },
      Labels: {
        ...config.config.Labels,
        "org.opencontainers.image.source": "https://github.com/allisonmahmood/patchy-cloud",
        "org.opencontainers.image.licenses": "UNLICENSED",
        "org.opencontainers.image.version": metadata.version,
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.created": created,
        "org.opencontainers.image.base.name": base,
        "io.patchy.source-date-epoch": String(epoch)
      }
    };
    const configBytes = JSON.stringify(config);
    const configName = `${digest(configBytes)}.json`;
    await rm(oldConfig);
    await writeFile(path.join(archive, configName), configBytes);
    manifest[0].Config = configName;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const output = path.resolve(values.output);
    await mkdir(path.dirname(output), { recursive: true });
    run(
      "tar",
      [
        ...tarMetadata,
        "--owner=0",
        "--group=0",
        "--mode=u+rwX,go+rX,go-w",
        "--create",
        "--file",
        output,
        "--directory",
        archive,
        "."
      ],
      { env: buildEnv }
    );
    const imageDigest = capture("crane", ["digest", "--tarball", output]);
    await writeFile(
      `${output}.json`,
      JSON.stringify(
        { ...metadata, created, crane: "v0.22.1", tag: values.tag, imageDigest },
        null,
        2
      ) + "\n"
    );
    console.log(`Exported ${values.tag} (${imageDigest}) to ${output}`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
