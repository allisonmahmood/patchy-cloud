// The installer as an agent runs it: a child Node process against a stub instance,
// with a clean HOME and a fresh npm prefix under a path with spaces.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CURRENT_RELEASE } from "@patchy/api";

const sdk = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(readFileSync(path.join(sdk, "artifacts/release.json"), "utf8")) as {
  digest: string;
  integrity: string;
};
const filename = `patchy-${CURRENT_RELEASE}-${metadata.digest}.tgz`;
const tarball = readFileSync(path.join(sdk, "artifacts", filename));
const root = mkdtempSync(path.join(os.tmpdir(), "patchy install test "));
afterAll(() => {
  chmodSync(root, 0o755);
  rmSync(root, { recursive: true, force: true });
});

/** The instance's release and tarball; `integrity` can be wrong on purpose. */
const instance = async (integrity = metadata.integrity) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/api/release") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          release: CURRENT_RELEASE,
          package: { tarball: `/sdk/${filename}`, integrity }
        })
      );
    } else if (request.url === `/sdk/${filename}`) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(tarball);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  afterAll(() => void server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
};

/** Node's own directory carries npm; npm's launcher needs a shell from the system directories. */
const system = [path.dirname(process.execPath), "/usr/bin", "/bin"];

let cases = 0;
/** A machine with nothing Patchy on it: its own home, npm prefix (this Node's), cache and temp directory. */
const machine = (url: string) => {
  const dir = path.join(root, `machine ${++cases}`);
  const home = path.join(dir, "home");
  const prefix = path.join(dir, "npm prefix");
  for (const each of [home, prefix, path.join(dir, "tmp")]) mkdirSync(each, { recursive: true });
  const installer = path.join(dir, "install.mjs");
  // The route's own test covers baking; the stub's address replaces the placeholder the same way.
  writeFileSync(
    installer,
    readFileSync(path.join(sdk, "front-door/install.mjs"), "utf8").replace(
      '"__PATCHY_PUBLIC_BASE_URL__"',
      JSON.stringify(url)
    )
  );
  const bin = path.join(home, ".local/bin");
  return {
    home,
    prefix,
    bin,
    env: {
      HOME: home,
      TMPDIR: path.join(dir, "tmp"),
      npm_config_prefix: prefix,
      npm_config_cache: path.join(dir, "npm cache"),
      npm_config_update_notifier: "false",
      // The launcher's directory, then Node's directory with npm, then the shell npm runs under.
      PATH: [bin, ...system].join(path.delimiter)
    },
    run: (env: Record<string, string>, node: ReadonlyArray<string> = []) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [...node, installer], { cwd: dir, env });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      })
  };
};

/** Where npm puts a global `patchy` in this Node's prefix, as installers before ~/.patchy/cli did. */
const installed = (prefix: string) => path.join(prefix, "lib/node_modules/patchy");
const cli = (home: string) => path.join(home, ".patchy/cli/node_modules/patchy");

/** `patchy --version` as the machine's shell would find it. */
const version = (env: Record<string, string>) =>
  spawnSync("patchy", ["--version"], { env, encoding: "utf8" }).stdout.trim();

describe.skipIf(process.platform === "win32")("the instance installer", () => {
  it("installs the release outside Node's prefix, links both skill paths, and reinstalls on a second run", async () => {
    const { url } = await instance();
    const { home, prefix, bin, env, run } = machine(url);
    const skill = path.join(home, ".patchy/skills/patchy");
    for (const attempt of ["first", "second"]) {
      const result = await run(env);
      expect(result, attempt).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain(`Installed patchy ${CURRENT_RELEASE} from ${url}.`);
      expect(result.stdout).toContain(`Executable: ${path.join(bin, "patchy")}`);
      expect(result.stdout).toContain(`Read the skill next: ${path.join(skill, "SKILL.md")}`);
      for (const link of [".agents/skills/patchy", ".claude/skills/patchy"])
        expect(readlinkSync(path.join(home, link)), attempt).toBe(skill);
    }
    expect(JSON.parse(readFileSync(path.join(cli(home), "package.json"), "utf8"))).toMatchObject({
      name: "patchy",
      version: CURRENT_RELEASE
    });
    // A version manager switching or removing this Node takes its prefix, which holds nothing Patchy.
    expect(readdirSync(prefix)).toEqual([]);
    rmSync(prefix, { recursive: true });
    expect(version(env)).toBe(CURRENT_RELEASE);
  }, 180_000);

  // A version manager's per-Node prefix, and `~/.local`, whose bin is where the launcher goes.
  it.each(["this Node's", "~/.local as"])(
    "moves an install an earlier installer left in %s npm prefix",
    async (kind) => {
      const { url } = await instance();
      const machined = machine(url);
      const { home, run } = machined;
      const prefix = kind === "~/.local as" ? path.join(home, ".local") : machined.prefix;
      const env = { ...machined.env, npm_config_prefix: prefix };
      const file = path.join(root, `earlier ${cases}.tgz`);
      writeFileSync(file, tarball);
      const earlier = spawnSync(
        "npm",
        ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", file],
        { env, encoding: "utf8" }
      );
      expect(earlier.status, earlier.stderr).toBe(0);
      // Version managers put this Node's bin first.
      const managed = { ...env, PATH: [path.join(prefix, "bin"), env.PATH].join(path.delimiter) };
      expect(
        spawnSync("sh", ["-c", "command -v patchy"], {
          env: managed,
          encoding: "utf8"
        }).stdout.trim()
      ).toBe(path.join(prefix, "bin/patchy"));
      const result = await run(managed);
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain(`Removed the earlier install from ${installed(prefix)};`);
      expect(existsSync(installed(prefix))).toBe(false);
      expect(existsSync(path.join(cli(home), "package.json"))).toBe(true);
      expect(version(managed)).toBe(CURRENT_RELEASE);
    },
    180_000
  );

  it("refuses a download that does not match the release's integrity before npm runs", async () => {
    const stub = await instance(`sha512-${Buffer.alloc(64).toString("base64")}`);
    const { home, env, run } = machine(stub.url);
    const result = await run(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "does not match the release's integrity, so nothing was installed"
    );
    expect(stub.requests).toEqual(["/api/release", `/sdk/${filename}`]);
    expect(existsSync(path.join(home, ".patchy/cli"))).toBe(false);
  });

  it("names the fix for old Node and for missing npm before asking the instance anything", async () => {
    const stub = await instance();
    const { env, run } = machine(stub.url);
    const preload = path.join(root, "old-node.mjs");
    writeFileSync(
      preload,
      'Object.defineProperty(process.versions, "node", { value: "22.21.1" });\n'
    );
    const old = await run(env, ["--import", preload]);
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("Patchy needs Node.js 22.22.0 or newer; this is 22.21.1.");
    const noNpm = await run({ ...env, PATH: path.join(root, "empty path") });
    expect(noNpm.status).toBe(1);
    expect(noNpm.stderr).toContain("npm is not on PATH.");
    expect(stub.requests).toEqual([]);
  });

  it("says how to reach patchy when ~/.local/bin is not on PATH, after linking the skill", async () => {
    const { url } = await instance();
    const { home, bin, env, run } = machine(url);
    const result = await run({ ...env, PATH: system.join(path.delimiter) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${bin} is not on PATH, so the shell cannot find patchy.`);
    expect(result.stderr).toContain(path.join(bin, "patchy"));
    expect(existsSync(path.join(home, ".agents/skills/patchy/SKILL.md"))).toBe(true);
  }, 180_000);

  it("passes over a patchy the shell cannot run and a shim that hands over, but refuses another copy", async () => {
    const { url } = await instance();
    const { bin, env, run } = machine(url);
    const other = path.join(root, `other patchy ${cases}`);
    mkdirSync(other, { recursive: true });
    const shim = path.join(other, "patchy");
    writeFileSync(shim, "#!/bin/sh\n", { mode: 0o644 });
    const withOther = { ...env, PATH: [other, bin, ...system].join(path.delimiter) };
    expect(await run(withOther)).toMatchObject({ status: 0, stderr: "" });
    // As mise's shim does when the current Node has no patchy of its own.
    writeFileSync(shim, `#!/bin/sh\nexec '${path.join(bin, "patchy")}' "$@"\n`);
    chmodSync(shim, 0o755);
    expect(await run(withOther)).toMatchObject({ status: 0, stderr: "" });
    // Handing over is not enough when the launcher's own directory is off PATH.
    const offPath = await run({ ...env, PATH: [other, ...system].join(path.delimiter) });
    expect(offPath.status).toBe(1);
    expect(offPath.stderr).toContain(`${bin} is not on PATH`);
    writeFileSync(shim, "#!/bin/sh\necho 0.0.1\n");
    const shadowed = await run(withOther);
    expect(shadowed.status).toBe(1);
    expect(shadowed.stderr).toContain(`${shim} comes before ${path.join(bin, "patchy")} on PATH`);
  }, 180_000);

  it("refuses to replace a patchy in ~/.local/bin it did not make, before downloading", async () => {
    const stub = await instance();
    const { home, bin, env, run } = machine(stub.url);
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "patchy"), "#!/bin/sh\n", { mode: 0o755 });
    const result = await run(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${path.join(bin, "patchy")} is already there and this installer did not make it.`
    );
    expect(stub.requests).toEqual([]);
    expect(existsSync(path.join(home, ".patchy"))).toBe(false);
  });
});
