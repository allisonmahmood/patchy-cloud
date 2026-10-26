// The instance installer on the machine it runs on: Linux, macOS or Windows.
// It serves the built release from a stub instance and runs the platform's own
// install line (the POSIX one through sh and curl, the PowerShell one through
// Windows PowerShell 5.1) on throwaway machines whose home has a space, and a
// `%` on Windows. Each Node gets its own npm prefix, as version managers do,
// and a Node switch is a PATH change. CI runs it on all three; it needs only
// Node, the checkout and `packages/patchy/artifacts` from `pnpm --filter patchy build`.
//
//   node scripts/packed-install-e2e.mjs [--node-a <node>] [--node-b <node>]
//
// Both Nodes default to this one, which still switches the npm prefix.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { installCommand } from "../packages/api/src/install.ts";

const windows = process.platform === "win32";
const repo = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    "node-a": { type: "string", default: process.execPath },
    "node-b": { type: "string", default: process.execPath }
  }
});
const nodes = { a: values["node-a"], b: values["node-b"] };
const log = (/** @type {string} */ message) => console.log(`[packed-install-e2e] ${message}`);

const artifacts = path.join(repo, "packages/patchy/artifacts");
const metadata = JSON.parse(fs.readFileSync(path.join(artifacts, "release.json"), "utf8"));
const filename = `patchy-${metadata.release}-${metadata.digest}.tgz`;
const tarball = fs.readFileSync(path.join(artifacts, filename));

const server = createServer((request, response) => {
  if (request.url === "/api/release") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        release: metadata.release,
        package: { tarball: `/sdk/${filename}`, integrity: metadata.integrity }
      })
    );
  } else if (request.url === `/sdk/${filename}`) {
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(tarball);
  } else if (request.url === "/install.mjs") {
    response.writeHead(200, { "content-type": "text/javascript" }).end(installer);
  } else {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
const address = server.address();
assert.ok(address !== null && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
// Baked the way FrontDoor.ts bakes it, with this stub's address.
const installer = fs
  .readFileSync(path.join(repo, "packages/sdk/front-door/install.mjs"), "utf8")
  .replace('"__PATCHY_PUBLIC_BASE_URL__"', JSON.stringify(base));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "patchy-install-e2e-"));
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
/** What every shell needs besides Node: the system directories, and on Windows cmd and PowerShell. */
const system = windows
  ? [
      path.join(systemRoot, "System32"),
      systemRoot,
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")
    ]
  : ["/usr/bin", "/bin"];
const exe = windows ? "patchy.cmd" : "patchy";

let machines = 0;
/** A machine with nothing Patchy on it: its own home, temp directory, npm cache and one npm prefix per Node. */
const machine = () => {
  const dir = path.join(root, `machine ${++machines}${windows ? " 100%" : ""}`);
  const home = path.join(dir, "home");
  const tmp = path.join(dir, "tmp");
  const appdata = path.join(dir, "appdata");
  const localappdata = path.join(dir, "localappdata");
  for (const each of [home, tmp, appdata, localappdata]) fs.mkdirSync(each, { recursive: true });
  const prefix = (/** @type {"a" | "b"} */ node) => path.join(dir, `npm prefix ${node}`);
  // npm's global bin: the prefix itself on Windows, its bin directory elsewhere.
  const globalBin = (/** @type {"a" | "b"} */ node) =>
    windows ? prefix(node) : path.join(prefix(node), "bin");
  const launcherBin = path.join(home, ".local", "bin");
  /** The environment with `node` current, optionally its global bin first, as a version manager orders it. */
  const env = (
    /** @type {"a" | "b"} */ node,
    /** @type {{ launcher?: boolean, globalFirst?: boolean }} */ {
      launcher = true,
      globalFirst = false
    } = {}
  ) => ({
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    APPDATA: appdata,
    LOCALAPPDATA: localappdata,
    npm_config_prefix: prefix(node),
    npm_config_cache: path.join(dir, "npm cache"),
    npm_config_userconfig: path.join(dir, "npmrc"),
    npm_config_update_notifier: "false",
    ...(windows
      ? Object.fromEntries(
          ["SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "WINDIR"].flatMap((name) =>
            process.env[name] === undefined ? [] : [[name, process.env[name]]]
          )
        )
      : {}),
    PATH: [
      ...(globalFirst ? [globalBin(node)] : []),
      ...(launcher ? [launcherBin] : []),
      ...(globalFirst ? [] : [globalBin(node)]),
      path.dirname(nodes[node]),
      ...system
    ].join(path.delimiter)
  });
  for (const node of /** @type {const} */ (["a", "b"]))
    fs.mkdirSync(prefix(node), { recursive: true });
  return { dir, home, prefix, globalBin, launcherBin, env };
};

/**
 * A command line in the platform's shell; on Windows, `powershell` runs it in
 * Windows PowerShell 5.1. Lines name machine paths relative to `cwd`, so cmd
 * never sees a typed `%`.
 */
const shell = (
  /** @type {string} */ line,
  /** @type {Record<string, string>} */ env,
  /** @type {{ powershell?: boolean, cwd?: string }} */ { powershell = false, cwd = root } = {}
) =>
  // Asynchronous, so this process's stub instance can answer while the line runs.
  new Promise((resolve) => {
    const options = { env, cwd, timeout: 300_000 };
    const child = windows
      ? powershell
        ? spawn(
            path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", line],
            options
          )
        : spawn(line, { ...options, shell: true })
      : spawn("sh", ["-c", line], options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => (stderr += String(error)));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
/** @typedef {{ status: number | null, stdout: string, stderr: string }} Result */
const show = (/** @type {Result} */ result) =>
  `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

/** The install line `/llms.txt` gives this platform, then `patchy --version` in the same shell. */
const installThenVersion = (/** @type {Record<string, string>} */ env) =>
  windows
    ? shell(
        `${installCommand(base, "powershell")}; if ($LASTEXITCODE -eq 0) { patchy.cmd --version }; exit $LASTEXITCODE`,
        env,
        { powershell: true }
      )
    : shell(`${installCommand(base, "posix")} && patchy --version`, env);
const version = (/** @type {Record<string, string>} */ env) => shell(`${exe} --version`, env);
const lines = (/** @type {string} */ text) => text.trim().split(/\r?\n/);

try {
  log(`Node a ${nodes.a}, Node b ${nodes.b}, release ${metadata.release}`);

  {
    log("a fresh install through the install line, then a Node switch");
    const m = machine();
    const launcher = path.join(m.launcherBin, exe);
    const fresh = await installThenVersion(m.env("a"));
    assert.equal(fresh.status, 0, show(fresh));
    assert.ok(lines(fresh.stdout).includes(`Executable: ${launcher}`), show(fresh));
    assert.equal(lines(fresh.stdout).at(-1), metadata.release, show(fresh));
    for (const link of [".agents/skills/patchy", ".claude/skills/patchy"])
      assert.ok(fs.existsSync(path.join(m.home, link, "SKILL.md")), link);
    assert.deepEqual(fs.readdirSync(m.prefix("a")), [], "Node a's npm prefix holds nothing Patchy");

    // Node a leaves PATH entirely, so whatever runs patchy now is Node b.
    const switched = await version(m.env("b"));
    assert.equal(switched.status, 0, show(switched));
    assert.equal(switched.stdout.trim(), metadata.release);

    const page = path.join(m.dir, "page.html");
    fs.writeFileSync(page, "<!doctype html><title>Plan</title><p>Ship it.</p>\n");
    const validated = await shell(`${exe} validate page.html --json`, m.env("b"), { cwd: m.dir });
    assert.equal(validated.status, 0, show(validated));
    assert.equal(JSON.parse(validated.stdout).ok, true);
    const status = await shell(`${exe} status --json`, m.env("b"));
    assert.equal(status.status, 0, show(status));
    assert.equal(JSON.parse(status.stdout).cliVersion, metadata.release);

    log("the executable refuses a Node older than the package needs");
    const preload = path.join(m.dir, "old node.mjs");
    fs.writeFileSync(
      preload,
      'Object.defineProperty(process.versions, "node", { value: "22.21.1" });\n'
    );
    const old = await version({
      ...m.env("b"),
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`
    });
    assert.equal(old.status, 1, show(old));
    assert.match(old.stderr, /Patchy needs Node\.js 22\.22\.0 or newer; this is 22\.21\.1\./);

    log("a rerun under the other Node reinstalls over its own launcher");
    const rerun = await installThenVersion(m.env("b"));
    assert.equal(rerun.status, 0, show(rerun));
    assert.equal(lines(rerun.stdout).at(-1), metadata.release, show(rerun));

    log("setup --remove takes the skill links and copy, and setup puts them back");
    const removed = await shell(`${exe} setup --remove --json`, m.env("b"));
    assert.equal(removed.status, 0, show(removed));
    assert.deepEqual(JSON.parse(removed.stdout).warnings, []);
    for (const link of [".agents/skills/patchy", ".claude/skills/patchy", ".patchy/skills/patchy"])
      assert.equal(fs.existsSync(path.join(m.home, link)), false, link);
    const linked = await shell(`${exe} setup --json`, m.env("b"));
    assert.equal(linked.status, 0, show(linked));
    assert.ok(fs.existsSync(path.join(m.home, ".claude/skills/patchy/SKILL.md")));
  }

  {
    log("an install an earlier installer left in Node a's npm prefix moves");
    const m = machine();
    fs.writeFileSync(path.join(m.dir, "earlier.tgz"), tarball);
    const managed = m.env("a", { globalFirst: true });
    const earlier = await shell(
      "npm install --global --ignore-scripts --no-audit --no-fund --loglevel=error ./earlier.tgz",
      managed,
      { cwd: m.dir }
    );
    assert.equal(earlier.status, 0, show(earlier));
    assert.ok(fs.existsSync(path.join(m.globalBin("a"), exe)), "the earlier install runs first");
    const moved = await installThenVersion(managed);
    assert.equal(moved.status, 0, show(moved));
    assert.match(moved.stdout, /Removed the earlier install from /, show(moved));
    assert.equal(fs.existsSync(path.join(m.globalBin("a"), exe)), false);
    assert.equal(lines(moved.stdout).at(-1), metadata.release, show(moved));
    const switched = await version(m.env("b", { globalFirst: true }));
    assert.equal(switched.status, 0, show(switched));
    assert.equal(switched.stdout.trim(), metadata.release);
  }

  {
    log("without ~/.local/bin on PATH it installs, then names the directory to add");
    const m = machine();
    const off = await installThenVersion(m.env("a", { launcher: false }));
    assert.equal(off.status, 1, show(off));
    assert.ok(off.stderr.includes(`${m.launcherBin} is not on PATH`), show(off));
    const direct = await shell(
      `${windows ? exe : `./${exe}`} --version`,
      m.env("b", { launcher: false }),
      {
        cwd: m.launcherBin
      }
    );
    assert.equal(direct.status, 0, show(direct));
    assert.equal(direct.stdout.trim(), metadata.release);
  }

  log(`PASS on ${process.platform}`);
} finally {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
