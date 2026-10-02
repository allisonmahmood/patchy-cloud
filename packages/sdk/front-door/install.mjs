// @ts-check
// Installs a Patchy Cloud instance's `patchy` CLI and links its skill for agents.
// The instance serves this file at /install.mjs with its own address below.
// Rerunning it is the upgrade path: it always reinstalls the instance's release.
// Dependency-free on purpose: it runs before anything Patchy is installed.
// Default imports and no top-level await keep old Node parsing far enough to
// reach the version check.
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = "__PATCHY_PUBLIC_BASE_URL__";
const windows = process.platform === "win32";

/** A failure whose message already names the fix. */
class Stop extends Error {}

/**
 * npm with fixed arguments only: Windows runs `npm.cmd` through cmd, which
 * would expand `%` and other metacharacters in a path, so paths never appear
 * on this command line. The tarball is named relative to `cwd`.
 */
const npm = (/** @type {string[]} */ args, /** @type {string} */ cwd) =>
  windows
    ? childProcess.spawnSync(["npm", ...args].join(" "), { cwd, shell: true, encoding: "utf8" })
    : childProcess.spawnSync("npm", args, { cwd, encoding: "utf8" });

const output = (/** @type {childProcess.SpawnSyncReturns<string>} */ result) =>
  `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

const fetched = async (/** @type {string} */ url) => {
  const response = await fetch(url).catch((/** @type {Error} */ error) => {
    throw new Stop(
      `Could not reach ${url}: ${error.message}. Check the address and your network, then run this again.`
    );
  });
  if (!response.ok)
    throw new Stop(
      `${url} answered ${response.status}. Run this again; if it keeps failing, tell your Patchy admin.`
    );
  return response;
};

/** PATH as the calling shell sees it: Volta adds its Node image's directories for this process only. */
const callerPath = () => {
  const volta = process.env.VOLTA_HOME;
  const image = volta === undefined ? undefined : path.join(volta, "tools", "image");
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => dir !== "" && (image === undefined || !path.resolve(dir).startsWith(image)));
};

const install = async (/** @type {string} */ work) => {
  const prefixResult = npm(["prefix", "--global"], work);
  if (prefixResult.error !== undefined || prefixResult.status !== 0) {
    throw new Stop(
      "npm is not on PATH. It ships with Node.js: reinstall Node.js 22.22.0 or newer from https://nodejs.org, open a new terminal, then run this again."
    );
  }
  const prefix = prefixResult.stdout.trim();
  const bin = windows ? prefix : path.join(prefix, "bin");
  const executable = path.join(bin, windows ? "patchy.cmd" : "patchy");
  const entry = path.join(prefix, ...(windows ? [] : ["lib"]), "node_modules/patchy/dist/index.js");

  const release = await (await fetched(`${base}/api/release`)).json().catch(() => undefined);
  if (typeof release?.release !== "string" || typeof release.package?.tarball !== "string") {
    throw new Stop(`${base} did not describe a Patchy release. Check the address you were given.`);
  }
  const tarball = new URL(release.package.tarball, `${base}/`).href;
  const bytes = Buffer.from(await (await fetched(tarball)).arrayBuffer());
  const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== release.package.integrity) {
    throw new Stop(
      `The download from ${tarball} does not match the release's integrity, so nothing was installed. Run this again; if it keeps failing, tell your Patchy admin.`
    );
  }
  // Only [A-Za-z0-9.+-], so the name is safe on npm's command line.
  const file = `patchy-${release.release.replace(/[^A-Za-z0-9.+-]/g, "")}.tgz`;
  fs.writeFileSync(path.join(work, file), bytes);

  const installed = npm(
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      `./${file}`
    ],
    work
  );
  if (installed.status !== 0) {
    if (/\b(EACCES|EPERM)\b/.test(output(installed))) {
      const own = path.join(os.homedir(), ".npm-global");
      throw new Stop(
        `npm cannot write to its global prefix ${prefix}. Do not use sudo; give npm a prefix you own:\n  npm config set prefix "${own}"\nthen add ${windows ? own : path.join(own, "bin")} to PATH, open a new terminal and run this again.`
      );
    }
    throw new Stop(`npm could not install patchy:\n${output(installed)}`);
  }
  if (!fs.existsSync(executable) || !fs.existsSync(entry))
    throw new Stop(`npm finished but ${executable} is missing. Run this again.`);

  // The new CLI by absolute path, with no shell between it and its arguments.
  const setup = childProcess.spawnSync(process.execPath, [entry, "setup", "--json"], {
    encoding: "utf8"
  });
  if (setup.status !== 0) {
    // Setup's --json failure document names the fix; anything else is relayed as printed.
    let reason = output(setup);
    try {
      reason = JSON.parse(setup.stderr).error ?? reason;
    } catch {}
    throw new Stop(
      `patchy ${release.release} is installed at ${executable}, but linking its skill failed:\n${reason}`
    );
  }
  const { linked, skill } = JSON.parse(setup.stdout);
  console.log(`Installed patchy ${release.release} from ${base}.`);
  console.log(`Executable: ${executable}`);
  console.log(`Skill: ${skill}`);
  console.log(`Linked for agents: ${linked.join(", ")}`);

  // Version managers put an alias of the prefix on PATH, so compare the files themselves.
  const same = (/** @type {string} */ a, /** @type {string} */ b) =>
    windows
      ? fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase()
      : fs.realpathSync(a) === fs.realpathSync(b);
  const first = callerPath()
    .map((dir) => path.join(path.resolve(dir), path.basename(executable)))
    .find((candidate) => fs.existsSync(candidate));
  if (first === undefined) {
    throw new Stop(
      `${bin} is not on PATH, so the shell cannot find patchy. Add it to PATH${windows ? " in your user environment variables" : ` in your shell profile (export PATH="${bin}:$PATH")`}, open a new terminal, or run ${executable} directly.`
    );
  }
  if (!same(first, executable)) {
    throw new Stop(
      `${first} comes before ${executable} on PATH, so patchy runs another copy. Remove that copy or put ${bin} first on PATH, then open a new terminal.`
    );
  }
  console.log(`Read the skill next: ${skill}`);
};

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 22)) {
  console.error(
    `Patchy needs Node.js 22.22.0 or newer; this is ${process.versions.node}. Install the current Node.js LTS from https://nodejs.org or your version manager, then run this again.`
  );
  process.exitCode = 1;
} else {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "patchy-install-"));
  install(work)
    .catch((error) => {
      console.error(
        error instanceof Stop
          ? error.message
          : `The Patchy installer failed: ${error instanceof Error ? error.stack : String(error)}`
      );
      process.exitCode = 1;
    })
    .finally(() => fs.rmSync(work, { recursive: true, force: true }));
}
