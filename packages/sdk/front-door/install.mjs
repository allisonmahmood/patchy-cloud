// @ts-check
// Installs a Patchy Cloud instance's `patchy` CLI and links its skill for agents.
// The instance serves this file at /install.mjs with its own address below.
// Rerunning it is the upgrade path: it always reinstalls the instance's release.
// Dependency-free on purpose: it runs before anything Patchy is installed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const base = "__PATCHY_PUBLIC_BASE_URL__";
const windows = process.platform === "win32";

/** A failure whose message already names the fix. */
class Stop extends Error {}

/** npm and its global shims; Windows `.cmd` shims only run through cmd, which needs quoting. */
const run = (/** @type {string} */ command, /** @type {string[]} */ args) =>
  windows
    ? spawnSync(
        [command, ...args].map((arg) => (/[\s&()^]/.test(arg) ? `"${arg}"` : arg)).join(" "),
        {
          shell: true,
          encoding: "utf8"
        }
      )
    : spawnSync(command, args, { encoding: "utf8" });

const output = (/** @type {import("node:child_process").SpawnSyncReturns<string>} */ result) =>
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

const install = async (/** @type {string} */ work) => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 22)) {
    throw new Stop(
      `Patchy needs Node.js 22.22.0 or newer; this is ${process.versions.node}. Install the current Node.js LTS from https://nodejs.org or your version manager, then run this again.`
    );
  }
  const npm = run("npm", ["prefix", "--global"]);
  if (npm.error !== undefined || npm.status !== 0) {
    throw new Stop(
      "npm is not on PATH. It ships with Node.js: reinstall Node.js 22.22.0 or newer from https://nodejs.org, open a new terminal, then run this again."
    );
  }
  const prefix = npm.stdout.trim();
  const bin = windows ? prefix : path.join(prefix, "bin");
  const executable = path.join(bin, windows ? "patchy.cmd" : "patchy");

  const release = await (await fetched(`${base}/api/release`)).json().catch(() => undefined);
  if (typeof release?.release !== "string" || typeof release.package?.tarball !== "string") {
    throw new Stop(`${base} did not describe a Patchy release. Check the address you were given.`);
  }
  const tarball = new URL(release.package.tarball, `${base}/`).href;
  const bytes = Buffer.from(await (await fetched(tarball)).arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== release.package.integrity) {
    throw new Stop(
      `The download from ${tarball} does not match the release's integrity, so nothing was installed. Run this again; if it keeps failing, tell your Patchy admin.`
    );
  }
  const file = path.join(work, `patchy-${release.release}.tgz`);
  writeFileSync(file, bytes);

  const installed = run("npm", [
    "install",
    "--global",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    file
  ]);
  if (installed.status !== 0) {
    if (/\b(EACCES|EPERM)\b/.test(output(installed))) {
      const own = path.join(homedir(), ".npm-global");
      throw new Stop(
        `npm cannot write to its global prefix ${prefix}. Do not use sudo; give npm a prefix you own:\n  npm config set prefix "${own}"\nthen add ${windows ? own : path.join(own, "bin")} to PATH, open a new terminal and run this again.`
      );
    }
    throw new Stop(`npm could not install patchy:\n${output(installed)}`);
  }
  if (!existsSync(executable))
    throw new Stop(`npm finished but ${executable} is missing. Run this again.`);

  const setup = run(executable, ["setup", "--json"]);
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
      ? realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase()
      : realpathSync(a) === realpathSync(b);
  const first = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(path.resolve(dir), path.basename(executable)))
    .find((candidate) => existsSync(candidate));
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

const work = mkdtempSync(path.join(tmpdir(), "patchy-install-"));
try {
  await install(work);
} catch (error) {
  console.error(
    error instanceof Stop
      ? error.message
      : `The Patchy installer failed: ${error instanceof Error ? error.stack : String(error)}`
  );
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
