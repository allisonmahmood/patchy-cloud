// @ts-check
// Installs a Patchy Cloud instance's `patchy` CLI and links its skill for agents.
// The instance serves this file at /install.mjs with its own address below.
// Rerunning it is the upgrade path: it always reinstalls the instance's release.
// Dependency-free on purpose: it runs before anything Patchy is installed.
// Bare default imports and no top-level await let old Node load this far
// enough to reach the version check.
import childProcess from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const base = "__PATCHY_PUBLIC_BASE_URL__";
const windows = process.platform === "win32";

/** A failure whose message already names the fix. */
class Stop extends Error {}

/**
 * npm by name. Windows runs `npm.cmd` through cmd, which expands `%` and other
 * metacharacters typed on its command line, so the one path npm needs, the
 * tarball, arrives through a variable that cmd expands once without rescanning.
 */
const npm = (/** @type {string[]} */ args, /** @type {string | undefined} */ file = undefined) =>
  windows
    ? childProcess.spawnSync(
        ["npm", ...args, ...(file === undefined ? [] : ['"%PATCHY_INSTALL_FILE%"'])].join(" "),
        { shell: true, encoding: "utf8", env: { ...process.env, PATCHY_INSTALL_FILE: file ?? "" } }
      )
    : childProcess.spawnSync("npm", file === undefined ? args : [...args, file], {
        encoding: "utf8"
      });

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

/** The repair for a global prefix npm cannot use: one the user owns, on PATH. */
const ownPrefix = () => {
  const own = path.join(os.homedir(), ".npm-global");
  return `give npm a prefix you own:\n  npm config set prefix "${own}"\nthen add ${windows ? own : path.join(own, "bin")} to PATH, open a new terminal and run this again.`;
};

/** A command the shell would run: an executable file, not a directory or plain file. */
const runnable = (/** @type {string} */ file) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!windows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const install = async (/** @type {string} */ work) => {
  const prefixResult = npm(["prefix", "--global"]);
  if (prefixResult.error !== undefined || prefixResult.status !== 0) {
    throw new Stop(
      "npm is not on PATH. It ships with Node.js: reinstall Node.js 22.22.0 or newer from https://nodejs.org, open a new terminal, then run this again."
    );
  }
  const prefix = prefixResult.stdout.trim();
  const bin = windows ? prefix : path.join(prefix, "bin");
  const executable = path.join(bin, windows ? "patchy.cmd" : "patchy");
  const entry = path.join(prefix, ...(windows ? [] : ["lib"]), "node_modules/patchy/dist/index.js");
  // Volta's own Node image is npm's default prefix there, and no shell puts it on PATH.
  const volta = process.env.VOLTA_HOME;
  const inVolta = volta === undefined ? "" : path.relative(volta, prefix);
  if (volta !== undefined && !inVolta.startsWith("..") && !path.isAbsolute(inVolta)) {
    throw new Stop(
      `Volta manages this Node, so npm's global prefix ${prefix} is inside Volta, where shells never find what npm installs there. ${ownPrefix()}`
    );
  }

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
  const file = path.join(work, "patchy.tgz");
  fs.writeFileSync(file, bytes);

  const installed = npm(
    ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
    file
  );
  if (installed.status !== 0) {
    if (/\b(EACCES|EPERM)\b/.test(output(installed))) {
      throw new Stop(
        `npm cannot write to its global prefix ${prefix}. Do not use sudo; ${ownPrefix()}`
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
  const first = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(path.resolve(dir), path.basename(executable)))
    .find(runnable);
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
