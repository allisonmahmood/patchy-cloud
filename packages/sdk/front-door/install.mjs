// @ts-check
// Installs a Patchy Cloud instance's `patchy` CLI and links its skill for agents.
// The CLI goes to ~/.patchy/cli, beside the skill's copy and outside every
// Node's npm prefix, so a Node version manager switching Node cannot take it;
// ~/.local/bin/patchy (patchy.cmd on Windows) runs it on whichever Node is current.
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
 * A command by name, found on PATH as a shell would. Windows runs `.cmd` files
 * through cmd, which expands `%` and other metacharacters typed on its command
 * line, so `paths` arrive through variables that cmd expands once without rescanning.
 */
const run = (
  /** @type {string} */ name,
  /** @type {string[]} */ args,
  /** @type {{ paths?: string[], timeout?: number }} */ { paths = [], timeout } = {}
) =>
  windows
    ? childProcess.spawnSync(
        [name, ...args, ...paths.map((_, i) => `"%PATCHY_INSTALL_PATH_${i}%"`)].join(" "),
        {
          shell: true,
          encoding: "utf8",
          timeout,
          env: {
            ...process.env,
            ...Object.fromEntries(paths.map((value, i) => [`PATCHY_INSTALL_PATH_${i}`, value]))
          }
        }
      )
    : childProcess.spawnSync(name, [...args, ...paths], { encoding: "utf8", timeout });

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
  const prefixResult = run("npm", ["prefix", "--global"]);
  if (prefixResult.error !== undefined || prefixResult.status !== 0) {
    throw new Stop(
      "npm is not on PATH. It ships with Node.js: reinstall Node.js 22.22.0 or newer from https://nodejs.org, open a new terminal, then run this again."
    );
  }
  // An earlier installer put patchy in this Node's npm prefix, where it would run
  // first and leave with this Node. Its bundled skill tells it from npm's unrelated `patchy`.
  const globalPrefix = prefixResult.stdout.trim();
  const earlier = path.join(globalPrefix, ...(windows ? [] : ["lib"]), "node_modules", "patchy");
  const hasEarlier = () => fs.existsSync(path.join(earlier, "skills", "patchy", "SKILL.md"));
  const home = os.homedir();
  const prefix = path.join(home, ".patchy", "cli");
  const entry = path.join(prefix, "node_modules", "patchy", "dist", "index.js");
  // npm's own link to the package's executable, which a release may move.
  const target = path.join(prefix, "node_modules", ".bin", windows ? "patchy.cmd" : "patchy");
  const bin = path.join(home, ".local", "bin");
  const executable = path.join(bin, windows ? "patchy.cmd" : "patchy");
  const launcher = '@"%~dp0..\\..\\.patchy\\cli\\node_modules\\.bin\\patchy.cmd" %*\r\n';
  /**
   * The launcher at `executable`: absent, this installer's, npm's link to the
   * earlier install (when npm's prefix is `~/.local`), or anything else.
   */
  const launcherState = () => {
    try {
      if (windows) return fs.readFileSync(executable, "utf8") === launcher ? "ours" : "foreign";
      const link = fs.readlinkSync(executable);
      if (link === target) return "ours";
      const into = path.relative(earlier, path.resolve(bin, link));
      return hasEarlier() && !into.startsWith("..") && !path.isAbsolute(into)
        ? "earlier"
        : "foreign";
    } catch (error) {
      return /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT" ? "absent" : "foreign";
    }
  };
  if (launcherState() === "foreign") {
    throw new Stop(
      `${executable} is already there and this installer did not make it. Move it aside, then run this again.`
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

  const installed = run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", "--prefix"],
    { paths: [prefix, file] }
  );
  if (installed.status !== 0) throw new Stop(`npm could not install patchy:\n${output(installed)}`);
  if (!fs.existsSync(target) || !fs.existsSync(entry))
    throw new Stop(`npm finished but ${target} is missing. Run this again.`);
  const removed = hasEarlier()
    ? run("npm", ["uninstall", "--global", "--loglevel=error", "patchy"]).status === 0
    : undefined;
  if (launcherState() !== "ours") {
    fs.mkdirSync(bin, { recursive: true });
    // Only an earlier install's link is left to replace: anything else stopped before the download.
    fs.rmSync(executable, { force: true });
    if (windows) fs.writeFileSync(executable, launcher);
    else fs.symlinkSync(target, executable);
  }

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
  if (removed !== undefined)
    console.log(
      removed
        ? `Removed the earlier install from ${earlier}; open a new terminal if one that ran patchy before still looks for it there.`
        : `Could not remove the earlier install from ${earlier}; remove it with npm uninstall --global patchy.`
    );

  // PATH may name the launcher's directory through a link, so compare the files themselves.
  const same = (/** @type {string} */ a, /** @type {string} */ b) =>
    windows
      ? fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase()
      : fs.realpathSync(a) === fs.realpathSync(b);
  const found = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(path.resolve(dir), path.basename(executable)))
    .filter(runnable);
  const first = found[0];
  if (first === undefined || !found.some((file) => same(file, executable))) {
    throw new Stop(
      `${bin} is not on PATH, so the shell cannot find patchy. Add it to PATH${windows ? " in your user environment variables" : ` in your shell profile (export PATH="${bin}:$PATH")`}, open a new terminal, or run ${executable} directly.`
    );
  }
  // A version manager's shim for an older Node's copy can come first and still hand over to this one.
  const handsOver = () => {
    const probe = run(path.basename(executable), ["--version"], { timeout: 30_000 });
    return probe.status === 0 && probe.stdout.trim() === release.release;
  };
  if (!same(first, executable) && !handsOver()) {
    throw new Stop(
      `${first} comes before ${executable} on PATH and runs another patchy. Put ${bin} first on PATH, or remove that copy (for a version manager's shim, run npm uninstall --global patchy under each Node version that still has one), then open a new terminal.`
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
