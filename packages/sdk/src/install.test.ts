// The installer as an agent runs it: a child Node process against a stub instance,
// with a clean HOME and a fresh npm prefix under a path with spaces.
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
/** A machine with nothing Patchy on it: its own home, npm prefix, cache and temp directory. */
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
  const bin = path.join(prefix, "bin");
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
      // The new prefix's bin first, then Node's directory with npm, then the shell npm runs under.
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

const installed = (prefix: string) => path.join(prefix, "lib/node_modules/patchy");

describe.skipIf(process.platform === "win32")("the instance installer", () => {
  it("installs the release, links both skill paths, and reinstalls on a second run", async () => {
    const { url } = await instance();
    const { home, prefix, bin, env, run } = machine(url);
    const skill = path.join(installed(prefix), "skills/patchy");
    for (const attempt of ["first", "second"]) {
      const result = await run(env);
      expect(result, attempt).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain(`Installed patchy ${CURRENT_RELEASE} from ${url}.`);
      expect(result.stdout).toContain(`Executable: ${path.join(bin, "patchy")}`);
      expect(result.stdout).toContain(`Read the skill next: ${path.join(skill, "SKILL.md")}`);
      for (const link of [".agents/skills/patchy", ".claude/skills/patchy"])
        expect(readlinkSync(path.join(home, link)), attempt).toBe(skill);
    }
    expect(
      JSON.parse(readFileSync(path.join(installed(prefix), "package.json"), "utf8"))
    ).toMatchObject({
      name: "patchy",
      version: CURRENT_RELEASE
    });
  }, 180_000);

  it("refuses a download that does not match the release's integrity before npm runs", async () => {
    const stub = await instance(`sha512-${Buffer.alloc(64).toString("base64")}`);
    const { prefix, env, run } = machine(stub.url);
    const result = await run(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "does not match the release's integrity, so nothing was installed"
    );
    expect(stub.requests).toEqual(["/api/release", `/sdk/${filename}`]);
    expect(existsSync(installed(prefix))).toBe(false);
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

  it.skipIf(process.getuid?.() === 0)(
    "names a prefix it can write when npm cannot write the global prefix",
    async () => {
      const { url } = await instance();
      const { home, prefix, env, run } = machine(url);
      chmodSync(prefix, 0o555);
      const result = await run(env);
      chmodSync(prefix, 0o755);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`npm cannot write to its global prefix ${prefix}.`);
      expect(result.stderr).toContain(`npm config set prefix "${path.join(home, ".npm-global")}"`);
    },
    180_000
  );

  it("says how to reach patchy when the prefix's bin is not on PATH, after linking the skill", async () => {
    const { url } = await instance();
    const { home, bin, env, run } = machine(url);
    const result = await run({ ...env, PATH: system.join(path.delimiter) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${bin} is not on PATH, so the shell cannot find patchy.`);
    expect(result.stderr).toContain(path.join(bin, "patchy"));
    expect(existsSync(path.join(home, ".agents/skills/patchy/SKILL.md"))).toBe(true);
  }, 180_000);
});
