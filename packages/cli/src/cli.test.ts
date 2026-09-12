/**
 * The contract, seen from outside: the bundled CLI as a child process against
 * a stub instance. Exit codes per the ladder, one-line stderr, the `--json`
 * shapes, the token never in argv or output, and the state dir's fail-closed
 * files. What the commands do between those edges is the commands' own tests.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { DEV_SEED } from "@patchy/auth/seed";
import { sha256 } from "@patchy/core";
import { CURRENT_RELEASE, MANIFEST_VERSION, PublishRequest, WIRE_VERSION } from "@patchy/api";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageDir, "dist/index.js");
const tempDirs: string[] = [];
const servers: Server[] = [];

beforeAll(() => {
  execFileSync(process.execPath, [path.resolve(packageDir, "../../scripts/build-cli-bundle.mjs")], {
    cwd: packageDir,
    stdio: "pipe"
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

afterAll(() => {
  for (const server of servers) server.close();
});

const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "patchy-cli-test-"));
  tempDirs.push(dir);
  return dir;
};

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

type Handler = (
  request: Recorded,
  respond: (status: number, body: unknown) => void,
  disconnect: () => void
) => void;

/** A stub instance: every request recorded, answered by `handler`. */
const stubInstance = async (handler: Handler, release = () => CURRENT_RELEASE) => {
  const requests: Recorded[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const recorded: Recorded = {
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined
      };
      requests.push(recorded);
      const respond = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (recorded.url === "/api/release") {
        respond(200, {
          release: release(),
          package: { tarball: "/sdk/patchy.tgz", integrity: null },
          manifestVersion: MANIFEST_VERSION,
          wireVersion: WIRE_VERSION
        });
        return;
      }
      handler(recorded, respond, () => response.destroy());
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
};

const publish = (
  status: 200 | 201,
  patchId: string,
  versionNumber: number,
  scope: "company" | "public" = "company",
  name = "page"
) => ({
  ok: true,
  patchId,
  versionId: `${patchId}-v${versionNumber}`,
  versionNumber,
  title: "Page",
  name,
  address: `http://instance.test/${DEV_SEED.companyHandle}/${name}`,
  publicUrl: `http://instance.test/${DEV_SEED.companyHandle}/${name}`,
  scope,
  tier: 0,
  schemaRevision: 0,
  provisioned: { tables: [], columns: [], indexes: [], stores: [] },
  unused: { tables: [], columns: [], indexes: [], stores: [] },
  warnings: status === 201 ? ["No <title> found."] : []
});

const identity = {
  user: { id: DEV_SEED.userId, email: DEV_SEED.email, name: DEV_SEED.userName },
  company: { id: DEV_SEED.companyId, handle: DEV_SEED.companyHandle, name: DEV_SEED.companyName },
  role: DEV_SEED.role,
  machine: { id: DEV_SEED.tokenId, name: DEV_SEED.tokenName }
};

/** Publish fixtures still dispatch identity refusals explicitly through stubInstance. */
const stubPublishingInstance = (handler: Handler, release = () => CURRENT_RELEASE) =>
  stubInstance((request, respond, disconnect) => {
    if (request.url === "/api/me") return respond(200, identity);
    handler(request, respond, disconnect);
  }, release);

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stateDir: string;
}

/** Asynchronous on purpose: the stub instance answers from this same event loop. */
const runCli = (
  args: ReadonlyArray<string>,
  options: {
    stateDir?: string;
    env?: Record<string, string>;
    input?: string;
    cwd?: string;
    onSpawn?: (child: ChildProcess) => void;
  } = {}
) =>
  new Promise<CliResult>((resolve, reject) => {
    const stateDir = options.stateDir ?? tempDir();
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? stateDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: stateDir,
        PATCHY_STATE_DIR: stateDir,
        ...options.env
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, stateDir }));
    child.stdin.end(options.input ?? "");
    options.onSpawn?.(child);
  });

interface HeldRequest {
  readonly request: Recorded;
  readonly respond: (status: number, body: unknown) => void;
}

/** Hold a real HTTP request until the test explicitly answers it. */
const requestBarrier = () => {
  let entered!: (request: HeldRequest) => void;
  const reached = new Promise<HeldRequest>((resolve) => {
    entered = resolve;
  });
  const handler: Handler = (request, respond) => entered({ request, respond });
  return {
    handler,
    wait: (running: Promise<CliResult>) =>
      Promise.race([
        reached,
        running.then((result) => {
          throw new Error(`CLI exited before request barrier: ${result.stderr}`);
        })
      ])
  };
};

const htmlFile = (dir: string, name: string, html: string) => {
  const file = path.join(dir, name);
  writeFileSync(file, html);
  return file;
};

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

const validHtml =
  "<!doctype html><html><head><title>Ok</title></head><body><p>hi</p></body></html>";

describe("built-ins", async () => {
  it("prints the bare version and help without touching the network", async () => {
    const version = await runCli(["--version"]);
    expect(version).toMatchObject({ status: 0, stdout: "0.0.1\n", stderr: "" });
    expect((await runCli(["--help"])).status).toBe(0);
  });

  it("reports a parse error as one stderr line, exit 1, and as one document under --json", async () => {
    const text = await runCli(["publish"]);
    expect(text.status).toBe(1);
    expect(text.stderr).toBe("Missing required argument: file\n");

    const json = await runCli(["publish", "--json"]);
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stderr)).toEqual({
      ok: false,
      error: "Missing required argument: file",
      kind: "local"
    });
  });

  it("does not retain upload as an alias", async () => {
    const result = await runCli(["upload", "page.html", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
  });
});

describe("the exit-code ladder", async () => {
  it("exits 130 on SIGINT, as Effect's interruption", async () => {
    const instance = await stubInstance(() => undefined);
    const child = spawn(process.execPath, [cliPath, "whoami", "--api-url", instance.url], {
      env: { PATH: process.env.PATH ?? "", PATCHY_STATE_DIR: tempDir(), PATCHY_API_TOKEN: "t" }
    });
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const poll = () => (instance.requests.length > 0 ? resolve() : setTimeout(poll, 20));
      poll();
    });
    child.kill("SIGINT");
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(status).toBe(130);
  });

  it("exits 1 when the caller can fix it: a file that fails validation", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "bad.html", "<!doctype html><title>x</title><script>1</script>");

    const text = await runCli(["validate", file], { stateDir: dir });
    expect(text.status).toBe(1);
    expect(text.stdout).toBe("");
    expect(text.stderr).toMatch(
      /^HTML failed Patchy Cloud validation:\n- Blocked <script> tag found\./
    );

    const json = await runCli(["validate", file, "--json"], { stateDir: dir });
    expect(json.status).toBe(1);
    expect(json.stdout).toBe("");
    expect(JSON.parse(json.stderr)).toMatchObject({ ok: false, kind: "local" });
  });

  it("exits 2 when the instance answered and said no: a rejected token", async () => {
    const instance = await stubInstance((_, respond) =>
      respond(401, { ok: false, error: "Missing or invalid API token." })
    );
    const result = await runCli(["whoami", "--api-url", instance.url, "--json"], {
      env: { PATCHY_API_TOKEN: "bad-token" }
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: "Missing or invalid API token.",
      kind: "rejected"
    });
    expect(result.stderr).not.toContain("bad-token");
  });

  it("exits 3 when there was no usable answer: a 5xx, or nothing listening", async () => {
    const instance = await stubInstance((_, respond) => respond(503, "<html>down</html>"));
    const down = await runCli(["whoami", "--api-url", instance.url], {
      env: { PATCHY_API_TOKEN: "token" }
    });
    expect(down.status).toBe(3);
    expect(down.stderr).toBe(
      `${instance.url} answered 503. Try again later, or tell the operator.\n`
    );

    const nobody = await runCli(["whoami", "--api-url", "http://127.0.0.1:1", "--json"], {
      env: { PATCHY_API_TOKEN: "token" }
    });
    expect(nobody.status).toBe(3);
    expect(JSON.parse(nobody.stderr)).toMatchObject({ ok: false, kind: "unreachable" });
  });
});

const pendingLogin = {
  deviceCode: "private-device-secret",
  userCode: "BCDF-GHJK",
  verificationUrl: "http://instance.test/login/device?code=BCDF-GHJK",
  verificationUrlBare: "http://instance.test/login/device",
  interval: 5,
  expiresAt: "2099-01-01T00:00:00.000Z"
};

describe("patchy login", () => {
  it("hands off without exposing the device secret and resumes the same login", async () => {
    const instance = await stubInstance((request, respond) => {
      if (request.url === "/api/login/device") {
        return respond(201, {
          ok: true,
          deviceCode: "private-device-secret",
          userCode: "BCDF-GHJK",
          verificationUrl: "http://instance.test/login/device?code=BCDF-GHJK",
          verificationUrlBare: "http://instance.test/login/device",
          interval: 5,
          expiresAt: "2099-01-01T00:00:00.000Z"
        });
      }
      respond(200, { ok: true, status: "pending" });
    });
    const options = { stateDir: tempDir(), env: { PATCHY_API_URL: instance.url } };
    const first = await runCli(["login", "--json"], options);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: "awaiting_confirmation",
      userCode: "BCDF-GHJK",
      next: "patchy login --complete BCDF-GHJK",
      notWaitingBecause: "--json"
    });
    expect(first.stdout).not.toContain("private-device-secret");
    const resumed = await runCli(["login", "--json"], options);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ userCode: "BCDF-GHJK" });
    expect(instance.requests.filter((r) => r.url === "/api/login/device")).toHaveLength(1);
    const pending = await runCli(["login", "--complete", "--wait", "0", "--json"], options);
    expect(pending.status).toBe(0);
    expect(JSON.parse(pending.stdout)).toMatchObject({
      status: "pending",
      next: "patchy login --complete BCDF-GHJK"
    });
  });

  it("keeps an explicit instance in next even when a worktree selects another instance", async () => {
    const instance = await stubInstance((request, respond) =>
      request.url === "/api/login/device"
        ? respond(201, { ok: true, ...pendingLogin })
        : respond(200, { ok: true, status: "pending" })
    );
    const worktree = tempDir();
    mkdirSync(path.join(worktree, ".local", "dev"), { recursive: true });
    writeFileSync(
      path.join(worktree, ".local", "dev", "env"),
      "PATCHY_API_URL=http://127.0.0.1:1\nPATCHY_API_TOKEN=seed\n"
    );
    const options = { stateDir: tempDir(), cwd: worktree };
    const first = await runCli(["login", "--api-url", instance.url, "--json"], options);
    expect(first.status).toBe(0);
    const next = JSON.parse(first.stdout).next as string;
    const resumed = await runCli(
      next.slice("patchy ".length).replaceAll("'", "").split(" ").concat("--wait", "0", "--json"),
      options
    );
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      status: "pending",
      userCode: pendingLogin.userCode
    });
    expect(instance.requests.at(-1)?.url).toBe("/api/login/device/token");
    const logout = await runCli(["logout", "--api-url", instance.url, "--json"], options);
    expect(logout.status).toBe(0);
    expect(JSON.parse(logout.stdout)).toMatchObject({
      warnings: ["This worktree's dev instance still publishes with its seeded key"]
    });
  });

  it("refuses a foreign code without polling or losing the live handoff", async () => {
    const instance = await stubInstance((_, respond) => respond(500, {}));
    const dir = tempDir();
    const saved = { hosts: { [instance.url]: pendingLogin } };
    writeFileSync(path.join(dir, "device-login.json"), JSON.stringify(saved));
    const result = await runCli(["login", "--complete", "XXXX-XXXX", "--json"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url }
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      kind: "local",
      error: expect.stringContaining(`has code ${pendingLogin.userCode}, not XXXX-XXXX`)
    });
    expect(instance.requests).toHaveLength(0);
    expect(readJson(path.join(dir, "device-login.json"))).toEqual(saved);
  });

  it.each([
    ["denied", "The login was denied in the browser. Nothing was saved. Run: patchy login"],
    [
      "expired",
      "The login expired before it was confirmed (codes last ten minutes). Run: patchy login"
    ],
    ["unknown", null]
  ])(
    "reports the instance's %s answer even after local expiry, preserving the old key",
    async (code, copy) => {
      const instance = await stubInstance((_, respond) =>
        respond(410, { ok: false, error: "Gone", code })
      );
      const dir = tempDir();
      writeFileSync(
        path.join(dir, "device-login.json"),
        JSON.stringify({
          hosts: { [instance.url]: { ...pendingLogin, expiresAt: "2000-01-01T00:00:00.000Z" } }
        })
      );
      const credential = {
        hosts: { [instance.url]: { token: "previous-key", source: "auth-set" } }
      };
      writeFileSync(path.join(dir, "credentials.json"), JSON.stringify(credential));
      const result = await runCli(["login", "--complete", "--json"], {
        stateDir: dir,
        env: { PATCHY_API_URL: instance.url }
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false,
        kind: "rejected",
        error:
          copy ??
          `No login is pending for code ${pendingLogin.userCode} on ${instance.url}; it may already have been reported. Run: patchy login`
      });
      expect(instance.requests).toHaveLength(1);
      expect(readJson(path.join(dir, "device-login.json"))).toEqual({ hosts: {} });
      expect(readJson(path.join(dir, "credentials.json"))).toEqual(credential);
    }
  );

  it.each([
    { token: undefined, json: true },
    { token: "", json: true },
    { token: "environment-key", json: true },
    { token: "environment-key", json: false }
  ])(
    "reports a saved login and any environment override ($token, json=$json)",
    async ({ token, json }) => {
      const instance = await stubInstance((request, respond) =>
        request.url === "/api/login/device/token"
          ? respond(200, {
              ok: true,
              status: "complete",
              token: "one-time-key",
              machine: identity.machine,
              company: { handle: identity.company.handle, name: identity.company.name },
              user: { email: identity.user.email },
              expiresAt: "2099-01-01T00:00:00.000Z"
            })
          : respond(200, identity)
      );
      const dir = tempDir();
      writeFileSync(
        path.join(dir, "device-login.json"),
        JSON.stringify({ hosts: { [instance.url]: pendingLogin } })
      );
      const options = {
        stateDir: dir,
        env: token === undefined ? {} : { PATCHY_API_TOKEN: token }
      };
      const warnings = token
        ? ["Login saved. PATCHY_API_TOKEN is still set and takes precedence over this login."]
        : [];
      const result = await runCli(
        ["login", "--complete", "--api-url", instance.url, ...(json ? ["--json"] : [])],
        options
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      if (json)
        expect(JSON.parse(result.stdout)).toEqual({
          ok: true,
          status: "logged_in",
          instanceUrl: instance.url,
          company: { handle: identity.company.handle, name: identity.company.name },
          user: { email: identity.user.email },
          machine: identity.machine,
          credentialsPath: path.join(dir, "credentials.json"),
          warnings
        });
      else expect(result.stdout).toContain(warnings[0]);
      expect(instance.requests.map((r) => r.url)).toEqual(["/api/login/device/token"]);
      expect(readJson(path.join(dir, "credentials.json"))).toMatchObject({
        hosts: { [instance.url]: { token: "one-time-key", source: "login" } }
      });
      expect(result.stdout + result.stderr).not.toContain("environment-key");
      expect(result.stdout + result.stderr).not.toContain("one-time-key");
      expect(JSON.parse((await runCli(["status"], options)).stdout)).toMatchObject({
        instanceUrl: instance.url,
        hasToken: true,
        tokenSource: token ? null : "login"
      });
      expect((await runCli(["whoami", "--json"], options)).status).toBe(0);
      expect(instance.requests.at(-1)?.authorization).toBe(`Bearer ${token || "one-time-key"}`);
      expect(readJson(path.join(dir, "device-login.json"))).toEqual({ hosts: {} });
    }
  );
});

describe("patchy logout", () => {
  it("forgets local state before a courtesy refusal and leaves environment and other instances alone", async () => {
    const dir = tempDir();
    const other = { token: "other-key", source: "auth-set" };
    const instance = await stubInstance((request, respond) => {
      expect(request.authorization).toBe("Bearer stored-key");
      expect(readJson(path.join(dir, "credentials.json"))).toEqual({
        hosts: { "http://other.test": other }
      });
      expect(readJson(path.join(dir, "device-login.json"))).toEqual({ hosts: {} });
      respond(401, { ok: false, error: "Missing or invalid API token." });
    });
    writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({
        hosts: {
          [instance.url]: { token: "stored-key", source: "auth-set" },
          "http://other.test": other
        }
      })
    );
    writeFileSync(
      path.join(dir, "device-login.json"),
      JSON.stringify({ hosts: { [instance.url]: pendingLogin } })
    );
    const options = {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "env-key" }
    };
    const result = await runCli(["logout", "--json"], options);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      revoked: true,
      warnings: [expect.stringContaining("PATCHY_API_TOKEN")]
    });
    expect(result.stdout).not.toContain("stored-key");
    expect(JSON.parse((await runCli(["status"], options)).stdout)).toMatchObject({
      hasToken: true,
      tokenSource: null
    });
  });

  it("succeeds locally when revocation is unreachable, and whoami then requires login", async () => {
    const dir = tempDir();
    const url = "http://127.0.0.1:1";
    writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({ hosts: { [url]: { token: "stored-key" } } })
    );
    writeFileSync(
      path.join(dir, "device-login.json"),
      JSON.stringify({ hosts: { [url]: pendingLogin } })
    );
    const options = { stateDir: dir, env: { PATCHY_API_URL: url } };
    const result = await runCli(["logout", "--json"], options);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      instanceUrl: url,
      revoked: false,
      warnings: [
        "Logged out on this machine. The key could not be revoked; it expires on its own after 30 idle days, or revoke it now on Your machines."
      ]
    });
    const whoami = await runCli(["whoami", "--json"], options);
    expect(whoami.status).toBe(1);
    expect(JSON.parse(whoami.stderr)).toMatchObject({
      kind: "local",
      error: expect.stringContaining("Run: patchy login")
    });
    expect(readJson(path.join(dir, "device-login.json"))).toEqual({ hosts: {} });
  });
});

describe("patchy auth set", async () => {
  it("saves keys per resolved instance without echoing them", async () => {
    const instance = await stubInstance((_, respond) => respond(500, {}));
    const result = await runCli(["auth", "set", "--api-url", instance.url, "--token-stdin"], {
      input: "pp_secret_one\n"
    });
    expect(result).toMatchObject({
      status: 0,
      stdout: expect.not.stringContaining("pp_secret_one"),
      stderr: ""
    });
    expect(readJson(path.join(result.stateDir, "credentials.json"))).toMatchObject({
      hosts: { [instance.url]: { token: "pp_secret_one", source: "auth-set" } }
    });
    expect(readJson(path.join(result.stateDir, "config.json"))).toEqual({
      apiUrl: instance.url
    });
    expect(instance.requests).toHaveLength(0);

    // A second instance sits beside the first; neither disturbs the other.
    const second = await runCli(["auth", "set", "--token-stdin", "--json"], {
      stateDir: result.stateDir,
      env: { PATCHY_API_URL: "http://two.test" },
      input: "pp_secret_two"
    });
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({ ok: true, instanceUrl: "http://two.test" });
    const hosts = (
      readJson(path.join(result.stateDir, "credentials.json")) as {
        hosts: Record<string, { token: string }>;
      }
    ).hosts;
    expect(Object.keys(hosts).sort()).toEqual([instance.url, "http://two.test"].sort());
  });

  it("rejects empty and multi-line input, and a prompt with no terminal", async () => {
    for (const [input, message] of [
      ["\n", "API token cannot be empty."],
      ["a\nb\n", "API token must be provided as a single line."],
      [" a \n", "API token cannot begin or end with whitespace."]
    ]) {
      const result = await runCli(["auth", "set", "--token-stdin"], { input });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`${message}\n`);
    }
    const prompt = await runCli(["auth", "set"], { input: "" });
    expect(prompt.status).toBe(1);
    expect(prompt.stderr).toMatch(/^Interactive token entry requires a terminal\./);
  });

  it("fails closed on a credentials file in the retired single-instance format", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ apiToken: "old" }));
    const result = await runCli(["auth", "set", "--token-stdin"], {
      stateDir: dir,
      input: "new\n"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/retired single-instance format/);
    expect(readJson(path.join(dir, "credentials.json"))).toEqual({ apiToken: "old" });
  });
});

describe("patchy whoami", async () => {
  it("prints the identity as text or as the wire document", async () => {
    const instance = await stubInstance((_, respond) => respond(200, identity));
    const dir = tempDir();
    await runCli(["auth", "set", "--token-stdin", "--api-url", instance.url], {
      stateDir: dir,
      input: "pp_stored\n"
    });

    const text = await runCli(["whoami"], { stateDir: dir });
    expect(text).toMatchObject({
      status: 0,
      stdout: `User: ${DEV_SEED.userName} (${DEV_SEED.email})\nCompany: ${DEV_SEED.companyName} (${DEV_SEED.companyHandle})\nRole: ${DEV_SEED.role}\nMachine: ${DEV_SEED.tokenName} (${DEV_SEED.tokenId})\n`,
      stderr: ""
    });
    expect(instance.requests[0]).toMatchObject({
      url: "/api/me",
      authorization: "Bearer pp_stored"
    });

    const json = await runCli(["whoami", "--json"], { stateDir: dir });
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual(identity);
  });
});

describe("commands without a publishing key", () => {
  it.each(["whoami", "publish", "delete", "share"])(
    "refuses %s locally without a request",
    async (command) => {
      const instance = await stubInstance((_, respond) => respond(200, identity));
      const dir = tempDir();
      const target =
        command === "publish"
          ? [htmlFile(dir, "page.html", validHtml)]
          : command === "delete"
            ? ["--patch", "abcdefghijkl"]
            : command === "share"
              ? ["--patch", "abcdefghijkl", "public"]
              : [];
      const result = await runCli([command, ...target, "--api-url", instance.url, "--json"], {
        stateDir: dir
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        kind: "local"
      });
      expect(instance.requests).toHaveLength(0);
    }
  );
});

describe("patchy validate", async () => {
  it("passes a safe document, with warnings on stderr in text mode and in the document under --json", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "untitled.html", "<!doctype html><p>hi</p>");
    const text = await runCli(["validate", file], { stateDir: dir });
    expect(text).toMatchObject({ status: 0, stdout: "HTML passed Patchy Cloud validation.\n" });
    expect(text.stderr).toMatch(/^Warning: /);

    const json = await runCli(["validate", file, "--json"], { stateDir: dir });
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    const document = JSON.parse(json.stdout) as { ok: boolean; warnings: string[] };
    expect(document.ok).toBe(true);
    expect(document.warnings.length).toBeGreaterThan(0);
  });
});

describe("patchy publish", async () => {
  it.each([
    { status: 401, route: "/api/me", body: { ok: false, error: "Missing or invalid API token." } },
    {
      status: 401,
      route: "/api/publish",
      body: { ok: false, error: "Missing or invalid API token." }
    },
    {
      status: 429,
      route: "/api/publish",
      body: { ok: false, code: "rate_limited", error: "Slow down.", retryAfterSeconds: 60 }
    },
    {
      status: 403,
      route: "/api/publish",
      body: { ok: false, code: "live_patch_quota_exceeded", error: "Quota reached.", quota: 1 }
    },
    {
      status: 422,
      route: "/api/publish",
      body: { ok: false, code: "unknown_admission_refusal", error: "Try later." }
    },
    { status: 400, route: "/api/publish", body: "undecodable admission refusal" }
  ])(
    "keeps one lost-success key through $status on $route and same-owner token rotation",
    async ({ status, route, body }) => {
      const dir = tempDir();
      const file = htmlFile(dir, "page.html", validHtml);
      let phase: "lost" | "refused" | "recovered" = "lost";
      const response = publish(201, "abcdefghijkl", 1);
      const instance = await stubInstance((request, respond, disconnect) => {
        if (phase === "refused" && request.url === route) return respond(status, body);
        if (request.url === "/api/me") return respond(200, identity);
        if (phase === "lost") return disconnect();
        respond(201, response);
      });
      const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_original" };
      expect((await runCli(["publish", file, "--json"], { stateDir: dir, env })).status).toBe(3);
      const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt.json");
      const original = readFileSync(attemptPath, "utf8");
      phase = "refused";
      const refused = await runCli(["publish", "missing.html", "--new", "--json"], {
        stateDir: dir,
        env
      });
      expect(refused.status).not.toBe(0);
      expect(readFileSync(attemptPath, "utf8")).toBe(original);
      phase = "recovered";
      const recovered = await runCli(["publish", "missing.html", "--new", "--json"], {
        stateDir: dir,
        env: { ...env, PATCHY_API_TOKEN: "pp_rotated" }
      });
      expect(recovered).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(recovered.stdout)).toEqual(response);
      const sent = instance.requests.filter((request) => request.url === "/api/publish");
      expect(sent.at(-1)).toMatchObject({
        authorization: "Bearer pp_rotated",
        body: sent[0]?.body
      });
      for (const request of sent) expect(request.body).toEqual(sent[0]?.body);
      expect(instance.requests.filter((request) => request.url === "/api/release")).toHaveLength(1);
      expect(existsSync(attemptPath)).toBe(false);
    }
  );

  it("never sends recovered HTML to another owner, but accepts a rotated key for the original owner", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    let first = true;
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/me") {
        return respond(
          200,
          request.authorization === "Bearer pp_other"
            ? { ...identity, user: { ...identity.user, id: "usr_other" } }
            : identity
        );
      }
      if (first) {
        first = false;
        return disconnect();
      }
      respond(201, publish(201, "abcdefghijkl", 1));
    });
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_original" };
    expect((await runCli(["publish", file, "--json"], { stateDir: dir, env })).status).toBe(3);
    const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt.json");
    const original = readFileSync(attemptPath, "utf8");
    expect(JSON.parse(original)).toMatchObject({ ownerUserId: identity.user.id });
    const wrongOwner = await runCli(
      ["publish", "missing.html", "--patch", "ignored", "--new", "--json"],
      {
        stateDir: dir,
        env: { ...env, PATCHY_API_TOKEN: "pp_other" }
      }
    );
    expect(wrongOwner.status).toBe(1);
    expect(JSON.parse(wrongOwner.stderr)).toMatchObject({ kind: "local" });
    expect(readFileSync(attemptPath, "utf8")).toBe(original);
    expect(
      instance.requests.filter((request) => request.authorization === "Bearer pp_other")
    ).toEqual([
      { method: "GET", url: "/api/me", authorization: "Bearer pp_other", body: undefined }
    ]);
    const recovered = await runCli(["publish", "missing.html", "--json"], {
      stateDir: dir,
      env: { ...env, PATCHY_API_TOKEN: "pp_rotated" }
    });
    expect(recovered.status).toBe(0);
    const sent = instance.requests.filter((request) => request.url === "/api/publish");
    expect(sent.map((request) => request.body)).toEqual([sent[0]?.body, sent[0]?.body]);
    expect(existsSync(attemptPath)).toBe(false);
  });

  it("fails closed without guessing the owner of an old pending attempt", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const instance = await stubPublishingInstance((_, __, disconnect) => disconnect());
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    expect((await runCli(["publish", file, "--json"], { stateDir: dir, env })).status).toBe(3);
    const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt.json");
    const legacy = JSON.parse(readFileSync(attemptPath, "utf8"));
    delete legacy.ownerUserId;
    const original = JSON.stringify(legacy);
    writeFileSync(attemptPath, original);
    const before = instance.requests.length;
    const refused = await runCli(["publish", "missing.html", "--json"], { stateDir: dir, env });
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ kind: "local" });
    expect(readFileSync(attemptPath, "utf8")).toBe(original);
    expect(instance.requests).toHaveLength(before);
  });

  it("replays the exclusive-creation winner through a state-dir symlink without letting its delayed response clear a newer attempt", async () => {
    const dir = tempDir();
    const alias = path.join(tempDir(), "state-alias");
    symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const file = htmlFile(dir, "winner.html", validHtml);
    const losingFile = htmlFile(dir, "loser.html", validHtml.replace("hi", "different candidate"));
    const nextFile = htmlFile(dir, "next.html", validHtml.replace("hi", "next attempt"));
    const winnerIdentity = requestBarrier();
    const loserIdentity = requestBarrier();
    const originalPublish = requestBarrier();
    const replayPublish = requestBarrier();
    const nextPublish = requestBarrier();
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/me") {
        if (request.authorization === "Bearer pp_winner") {
          return winnerIdentity.handler(request, respond, disconnect);
        }
        if (request.authorization === "Bearer pp_loser") {
          return loserIdentity.handler(request, respond, disconnect);
        }
        return respond(200, identity);
      }
      if (request.authorization === "Bearer pp_winner") {
        return originalPublish.handler(request, respond, disconnect);
      }
      if (request.authorization === "Bearer pp_loser") {
        return replayPublish.handler(request, respond, disconnect);
      }
      nextPublish.handler(request, respond, disconnect);
    });
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_winner" };
    const children: ChildProcess[] = [];
    const onSpawn = (child: ChildProcess) => {
      children.push(child);
    };
    const winner = runCli(["publish", file, "--json"], { stateDir: dir, env, onSpawn });
    const loser = runCli(["publish", losingFile, "--new", "--share", "public", "--json"], {
      stateDir: alias,
      env: { ...env, PATCHY_API_TOKEN: "pp_loser" },
      onSpawn
    });
    let next: Promise<CliResult> | undefined;
    try {
      const [firstIdentity, secondIdentity] = await Promise.all([
        winnerIdentity.wait(winner),
        loserIdentity.wait(loser)
      ]);
      const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt.json");
      expect(existsSync(attemptPath)).toBe(false);
      firstIdentity.respond(200, identity);
      const firstRequest = await originalPublish.wait(winner);
      const original = readFileSync(attemptPath, "utf8");
      expect(JSON.parse(original)).toMatchObject({
        file,
        ownerUserId: identity.user.id,
        request: firstRequest.request.body
      });
      secondIdentity.respond(200, identity);
      const replay = await replayPublish.wait(loser);
      expect(replay.request.body).toEqual(firstRequest.request.body);
      expect(readFileSync(attemptPath, "utf8")).toBe(original);
      const response = publish(201, "abcdefghijkl", 1);
      replay.respond(201, response);
      expect(await loser).toMatchObject({ status: 0, stderr: "" });
      expect(existsSync(attemptPath)).toBe(false);
      expect(readJson(path.join(dir, "patches.json"))).toMatchObject({
        hosts: {
          [instance.url]: {
            files: { [file]: { patchId: response.patchId, latestVersionNumber: 1 } }
          }
        }
      });
      expect(readJson(path.join(dir, "patches.json"))).not.toMatchObject({
        hosts: { [instance.url]: { files: { [losingFile]: expect.anything() } } }
      });

      next = runCli(["publish", nextFile, "--json"], {
        stateDir: dir,
        env: { ...env, PATCHY_API_TOKEN: "pp_next" },
        onSpawn
      });
      const newerRequest = await nextPublish.wait(next);
      const newer = readFileSync(attemptPath, "utf8");
      expect(JSON.parse(newer).request.publishKey).not.toBe(
        JSON.parse(original).request.publishKey
      );
      expect(JSON.parse(newer)).toMatchObject({
        file: nextFile,
        request: newerRequest.request.body
      });
      firstRequest.respond(201, response);
      expect(await winner).toMatchObject({ status: 0, stderr: "" });
      expect(readFileSync(attemptPath, "utf8")).toBe(newer);
      newerRequest.respond(201, publish(201, "mnopqrstuvwx", 1));
      expect(await next).toMatchObject({ status: 0, stderr: "" });
      expect(existsSync(attemptPath)).toBe(false);
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all([winner, loser, next]);
    }
  });

  it("does not send the winning attempt when a fresh candidate loses exclusive creation to another owner", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "winner.html", validHtml);
    const losingFile = htmlFile(dir, "loser.html", validHtml.replace("hi", "other owner's page"));
    const winnerIdentity = requestBarrier();
    const loserIdentity = requestBarrier();
    const originalPublish = requestBarrier();
    const instance = await stubInstance((request, respond, disconnect) => {
      if (request.url === "/api/me") {
        return (
          request.authorization === "Bearer pp_owner" ? winnerIdentity : loserIdentity
        ).handler(request, respond, disconnect);
      }
      if (request.authorization === "Bearer pp_owner") {
        return originalPublish.handler(request, respond, disconnect);
      }
      respond(201, publish(201, "mnopqrstuvwx", 1));
    });
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    const children: ChildProcess[] = [];
    const onSpawn = (child: ChildProcess) => {
      children.push(child);
    };
    const winner = runCli(["publish", file, "--json"], { stateDir: dir, env, onSpawn });
    const loser = runCli(["publish", losingFile, "--json"], {
      stateDir: dir,
      env: { ...env, PATCHY_API_TOKEN: "pp_other" },
      onSpawn
    });
    try {
      const [firstIdentity, secondIdentity] = await Promise.all([
        winnerIdentity.wait(winner),
        loserIdentity.wait(loser)
      ]);
      const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt.json");
      expect(existsSync(attemptPath)).toBe(false);
      firstIdentity.respond(200, identity);
      const originalRequest = await originalPublish.wait(winner);
      const original = readFileSync(attemptPath, "utf8");
      secondIdentity.respond(200, {
        ...identity,
        user: { ...identity.user, id: "usr_other" }
      });
      const refused = await loser;
      expect(refused.status).toBe(1);
      expect(JSON.parse(refused.stderr)).toMatchObject({ kind: "local" });
      expect(
        instance.requests.filter(
          (request) => request.url === "/api/publish" && request.authorization === "Bearer pp_other"
        )
      ).toEqual([]);
      expect(readFileSync(attemptPath, "utf8")).toBe(original);
      originalRequest.respond(201, publish(201, "abcdefghijkl", 1));
      expect((await winner).status).toBe(0);
      expect(existsSync(attemptPath)).toBe(false);
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all([winner, loser]);
    }
  });

  it("recovers the persisted request through a state-dir symlink after SIGKILL", async () => {
    const dir = tempDir();
    const alias = path.join(tempDir(), "state-alias");
    symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const file = htmlFile(dir, "page.html", validHtml);
    const originalPublish = requestBarrier();
    const response = publish(201, "abcdefghijkl", 1);
    let first = true;
    const instance = await stubPublishingInstance((request, respond, disconnect) => {
      if (first) {
        first = false;
        return originalPublish.handler(request, respond, disconnect);
      }
      respond(201, response);
    });
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    let child: ChildProcess | undefined;
    const killed = runCli(["publish", file, "--json"], {
      stateDir: dir,
      env,
      onSpawn: (process) => {
        child = process;
      }
    });
    try {
      const originalRequest = await originalPublish.wait(killed);
      const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt.json");
      const original = readFileSync(attemptPath, "utf8");
      child?.kill("SIGKILL");
      expect((await killed).status).toBeNull();
      expect(readFileSync(attemptPath, "utf8")).toBe(original);
      const recovered = await runCli(["publish", "missing.html", "--new", "--json"], {
        stateDir: alias,
        env
      });
      expect(recovered).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(recovered.stdout)).toEqual(response);
      const sent = instance.requests.filter((request) => request.url === "/api/publish");
      expect(sent.map((request) => request.body)).toEqual([
        originalRequest.request.body,
        originalRequest.request.body
      ]);
      expect(existsSync(attemptPath)).toBe(false);
      expect(readJson(path.join(dir, "patches.json"))).toMatchObject({
        hosts: {
          [instance.url]: {
            files: { [file]: { patchId: response.patchId, latestVersionNumber: 1 } }
          }
        }
      });
    } finally {
      child?.kill("SIGKILL");
      await killed;
    }
  });

  it("replays a lost reply before file, flags and release checks, applies the original cache target, and stops", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    let currentRelease = CURRENT_RELEASE;
    let first = true;
    let durableAttempt: unknown;
    const response = publish(201, "abcdefghijkl", 1, "public");
    const instance = await stubPublishingInstance(
      (_, respond, disconnect) => {
        const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt.json");
        durableAttempt = readJson(attemptPath);
        if (first) {
          first = false;
          disconnect();
        } else {
          respond(201, response);
        }
      },
      () => currentRelease
    );
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_private_credential" };
    const initial = await runCli(["publish", file, "--share", "public", "--json"], {
      stateDir: dir,
      env
    });
    expect(initial.status).toBe(3);
    expect(JSON.parse(initial.stderr)).toMatchObject({ ok: false, kind: "unreachable" });
    const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt.json");
    expect(durableAttempt).toMatchObject({ request: instance.requests[2]?.body, file });
    expect(readFileSync(attemptPath, "utf8")).not.toContain(env.PATCHY_API_TOKEN);
    expect(statSync(attemptPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(attemptPath)).mode & 0o777).toBe(0o700);

    currentRelease = "9.9.9";
    rmSync(file);
    const replay = await runCli(
      [
        "publish",
        "missing.html",
        "--patch",
        "ignored",
        "--new",
        "--share",
        "company",
        "--name",
        "Invalid",
        "--json"
      ],
      { stateDir: dir, env }
    );
    expect(replay).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(replay.stdout)).toEqual(response);
    expect(instance.requests.map((r) => r.url)).toEqual([
      "/api/me",
      "/api/release",
      "/api/publish",
      "/api/me",
      "/api/publish"
    ]);
    expect(instance.requests[4]?.body).toEqual(instance.requests[2]?.body);
    expect(readJson(path.join(dir, "patches.json"))).toMatchObject({
      hosts: {
        [instance.url]: { files: { [file]: { patchId: response.patchId, latestVersionNumber: 1 } } }
      }
    });
    expect(existsSync(attemptPath)).toBe(false);
  });

  it("recovers the same create after a failed cache write, without reading today's broken cache or HTML first", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const cachePath = path.join(dir, "patches.json");
    let blockCache = true;
    const response = publish(201, "abcdefghijkl", 1);
    const instance = await stubPublishingInstance((_, respond) => {
      if (blockCache) {
        mkdirSync(cachePath);
        blockCache = false;
      }
      respond(201, response);
    });
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    const initial = await runCli(["publish", file, "--json"], { stateDir: dir, env });
    expect(initial.status).toBe(1);
    expect(JSON.parse(initial.stderr)).toMatchObject({ kind: "local" });
    const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt.json");
    expect(existsSync(attemptPath)).toBe(true);

    // Replay is sent even while applying the cache is still impossible.
    const blocked = await runCli(["publish", "missing.html", "--json"], { stateDir: dir, env });
    expect(blocked.status).toBe(1);
    expect(instance.requests[4]?.body).toEqual(instance.requests[2]?.body);
    expect(existsSync(attemptPath)).toBe(true);
    rmSync(cachePath, { recursive: true });
    writeFileSync(file, "<script>unsafe today</script>");
    const recovered = await runCli(["publish", file, "--json"], { stateDir: dir, env });
    expect(recovered).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(recovered.stdout)).toEqual(response);
    expect(instance.requests.map((r) => r.url)).toEqual([
      "/api/me",
      "/api/release",
      "/api/publish",
      "/api/me",
      "/api/publish",
      "/api/me",
      "/api/publish"
    ]);
    expect(instance.requests[6]?.body).toEqual(instance.requests[2]?.body);
    expect(readJson(cachePath)).toMatchObject({
      hosts: {
        [instance.url]: { files: { [file]: { patchId: response.patchId, latestVersionNumber: 1 } } }
      }
    });
    expect(existsSync(attemptPath)).toBe(false);
  });

  it.each([
    { status: 422, code: "release_mismatch" },
    { status: 422, code: "patch_not_openable" },
    { status: 409, code: "publish_key_conflict" },
    { status: 409, code: "name_taken" }
  ])(
    "retains an unknown outcome but clears a definitive $code refusal",
    async ({ status, code }) => {
      const dir = tempDir();
      const file = htmlFile(dir, "page.html", validHtml);
      let calls = 0;
      const instance = await stubPublishingInstance((_, respond) => {
        calls++;
        if (calls === 1) return respond(503, { error: "unknown commit outcome" });
        if (calls === 2)
          return respond(status, {
            ok: false,
            code,
            error: "The publish was refused."
          });
        respond(201, publish(201, "abcdefghijkl", 1, "company", "available-name"));
      });
      const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
      const initial = await runCli(["publish", file, "--name", "taken-name", "--json"], {
        stateDir: dir,
        env
      });
      expect(initial.status).toBe(3);
      const attemptPath = path.join(dir, "publish", sha256(instance.url), "attempt.json");
      expect(existsSync(attemptPath)).toBe(true);
      const refusal = await runCli(["publish", "missing.html", "--json"], { stateDir: dir, env });
      expect(refusal.status).toBe(2);
      expect(JSON.parse(refusal.stderr)).toMatchObject({
        ok: false,
        kind: "rejected",
        code
      });
      expect(instance.requests[4]?.body).toEqual(instance.requests[2]?.body);
      expect(existsSync(attemptPath)).toBe(false);
      const fresh = await runCli(["publish", file, "--name", "available-name", "--json"], {
        stateDir: dir,
        env
      });
      expect(fresh.status).toBe(0);
      expect(instance.requests.map((r) => r.url)).toEqual([
        "/api/me",
        "/api/release",
        "/api/publish",
        "/api/me",
        "/api/publish",
        "/api/me",
        "/api/release",
        "/api/publish"
      ]);
      const firstRequest = Schema.decodeUnknownSync(PublishRequest)(instance.requests[2]?.body);
      const freshRequest = Schema.decodeUnknownSync(PublishRequest)(instance.requests[7]?.body);
      expect(freshRequest.publishKey).not.toBe(firstRequest.publishKey);
      expect(firstRequest.manifest.name).toBe("taken-name");
      expect(freshRequest.manifest.name).toBe("available-name");
      expect(JSON.parse(fresh.stdout)).toMatchObject({
        name: "available-name",
        address: `http://instance.test/${DEV_SEED.companyHandle}/available-name`
      });
    }
  );

  it("reports an exact release mismatch locally before reading the file or persisting an attempt", async () => {
    const instance = await stubPublishingInstance(
      (_, respond) => respond(201, publish(201, "abcdefghijkl", 1)),
      () => "9.9.9"
    );
    const dir = tempDir();
    const result = await runCli(["publish", "missing.html", "--json"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      kind: "local",
      code: "release_mismatch"
    });
    expect(result.stderr).toContain(CURRENT_RELEASE);
    expect(result.stderr).toContain("9.9.9");
    expect(instance.requests.map((r) => r.url)).toEqual(["/api/me", "/api/release"]);
    expect(existsSync(path.join(dir, "publish", sha256(instance.url), "attempt.json"))).toBe(false);
  });

  it("never persists invalid request options, so corrected patch IDs and names can publish next", async () => {
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const response = publish(200, "abcdefghijkl", 2);
    const instance = await stubPublishingInstance((_, respond) => respond(200, response));
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    const invalid = await runCli(["publish", file, "--patch", "invalid", "--json"], {
      stateDir: dir,
      env
    });
    const invalidName = await runCli(["publish", file, "--name", "UpperCase", "--json"], {
      stateDir: dir,
      env
    });
    expect(invalidName.status).toBe(1);
    expect(JSON.parse(invalidName.stderr)).toMatchObject({ kind: "local" });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ kind: "local" });
    expect(existsSync(path.join(dir, "publish", sha256(instance.url), "attempt.json"))).toBe(false);
    expect(instance.requests.filter((request) => request.url === "/api/publish")).toEqual([]);
    const corrected = await runCli(["publish", file, "--patch", "abcdefghijkl", "--json"], {
      stateDir: dir,
      env
    });
    expect(corrected).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(corrected.stdout)).toEqual(response);
    expect(instance.requests.filter((request) => request.url === "/api/publish")).toMatchObject([
      { body: { patchId: "abcdefghijkl", html: validHtml } }
    ]);
  });

  it("publishes with an explicit name, then keeps it when republishing with the cached patch id", async () => {
    const instance = await stubPublishingInstance((request, respond) => {
      const body = request.body as { patchId?: string; manifest: { name?: string } };
      return body.patchId
        ? respond(200, publish(200, body.patchId, 2, "company", "quarterly-plan"))
        : respond(201, publish(201, "abcdefghijkl", 1, "company", body.manifest.name ?? "page"));
    });
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    await runCli(["auth", "set", "--token-stdin", "--api-url", instance.url], {
      stateDir: dir,
      input: `${DEV_SEED.token}\n`
    });

    const first = await runCli(
      ["publish", file, "--name", "quarterly-plan", "--api-url", instance.url],
      { stateDir: dir }
    );
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(
      `URL: http://instance.test/${DEV_SEED.companyHandle}/quarterly-plan`
    );
    expect(first.stdout).toContain("Scope: company (signed-in colleagues in your company)");
    expect(first.stderr).toBe("Warning: No <title> found.\n");
    expect(`${first.stdout}${first.stderr}`).not.toContain(DEV_SEED.token);
    expect(instance.requests.map((r) => r.url)).toEqual([
      "/api/me",
      "/api/release",
      "/api/publish"
    ]);
    expect(instance.requests[2]).toMatchObject({ authorization: `Bearer ${DEV_SEED.token}` });
    expect(instance.requests[2]?.body).toMatchObject({
      html: validHtml,
      manifest: {
        manifestVersion: 1,
        release: CURRENT_RELEASE,
        name: "quarterly-plan",
        tier: 0,
        tables: {},
        files: {},
        uses: {}
      },
      metadata: { cliVersion: "0.0.1", filename: "page.html" }
    });
    expect(instance.requests[2]?.body).not.toHaveProperty("scope");

    // The cache turns the second publish of the same file into an update, and
    // under --json the document is the wire shape alone.
    const second = await runCli(["publish", file, "--json"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url }
    });
    expect(second.status).toBe(0);
    expect(second.stderr).toBe("");
    expect(JSON.parse(second.stdout)).toEqual(
      publish(200, "abcdefghijkl", 2, "company", "quarterly-plan")
    );
    expect(instance.requests[5]?.body).toMatchObject({ patchId: "abcdefghijkl" });
    expect(instance.requests[5]?.body).not.toHaveProperty("scope");
    expect(instance.requests[5]?.body).not.toHaveProperty("manifest.name");
    expect(readJson(path.join(dir, "patches.json"))).toMatchObject({
      hosts: {
        [instance.url]: {
          files: {
            [file]: {
              patchId: "abcdefghijkl",
              publicUrl: `http://instance.test/${DEV_SEED.companyHandle}/quarterly-plan`
            }
          }
        }
      }
    });
    expect(instance.requests[5]).toMatchObject({ authorization: `Bearer ${DEV_SEED.token}` });

    // --new ignores the cache; the environment token beats the stored one.
    const fresh = await runCli(["publish", file, "--new"], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_env" }
    });
    expect(fresh.status).toBe(0);
    expect(instance.requests[8]?.body).not.toHaveProperty("patchId");
    expect(instance.requests[8]?.body).not.toHaveProperty("manifest.name");
    expect(instance.requests[8]).toMatchObject({ authorization: "Bearer pp_env" });
  });

  it("sets sharing explicitly on create and update, reporting the returned audience", async () => {
    let version = 0;
    const instance = await stubPublishingInstance((_, respond) => {
      version++;
      respond(
        version === 1 ? 201 : 200,
        publish(
          version === 1 ? 201 : 200,
          "abcdefghijkl",
          version,
          version === 1 ? "public" : "company"
        )
      );
    });
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };

    const published = await runCli(["publish", file, "--share", "public", "--json"], {
      stateDir: dir,
      env
    });
    expect(published.status).toBe(0);
    expect(published.stderr).toBe("");
    expect(JSON.parse(published.stdout)).toMatchObject({ scope: "public" });
    expect(instance.requests[2]?.body).toMatchObject({ scope: "public" });
    expect(instance.requests[2]?.body).not.toHaveProperty("patchId");

    const restricted = await runCli(["publish", file, "--share", "company"], {
      stateDir: dir,
      env
    });
    expect(restricted.status).toBe(0);
    expect(restricted.stdout).toContain("Scope: company (signed-in colleagues in your company)");
    expect(instance.requests[5]?.body).toMatchObject({ scope: "company", patchId: "abcdefghijkl" });

    const invalid = await runCli(["publish", file, "--share", "private", "--json"], {
      stateDir: dir,
      env
    });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests).toHaveLength(6);
  });

  it("publishes with the worktree seed and leaves stderr empty under --json", async () => {
    const instance = await stubPublishingInstance((_, respond) =>
      respond(201, publish(201, "abcdefghijkl", 1))
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    mkdirSync(path.join(dir, ".local", "dev"), { recursive: true });
    writeFileSync(
      path.join(dir, ".local", "dev", "env"),
      `PATCHY_API_URL=${instance.url}\nPATCHY_API_TOKEN=${DEV_SEED.token}\n`
    );
    const result = await runCli(["publish", file, "--json"], {
      stateDir: dir
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(publish(201, "abcdefghijkl", 1));
    expect(result.stderr).toBe("");
    expect(instance.requests[2]).toMatchObject({ authorization: `Bearer ${DEV_SEED.token}` });

    // A stored key outranks the seed, and an explicit environment key outranks both.
    await runCli(["auth", "set", "--token-stdin"], {
      stateDir: dir,
      input: "pp_saved\n"
    });
    const saved = await runCli(["publish", file, "--new", "--json"], { stateDir: dir });
    expect(saved.status).toBe(0);
    expect(instance.requests[5]).toMatchObject({ authorization: "Bearer pp_saved" });
    const savedStatus = await runCli(["status"], { stateDir: dir });
    expect(JSON.parse(savedStatus.stdout)).toMatchObject({
      hasToken: true,
      tokenSource: "auth-set"
    });

    const env = { PATCHY_API_TOKEN: "pp_environment" };
    const explicit = await runCli(["publish", file, "--new", "--json"], { stateDir: dir, env });
    expect(explicit.status).toBe(0);
    expect(instance.requests[8]).toMatchObject({ authorization: "Bearer pp_environment" });
    const environmentStatus = await runCli(["status"], { stateDir: dir, env });
    expect(JSON.parse(environmentStatus.stdout)).toMatchObject({
      hasToken: true,
      tokenSource: null
    });
  });

  it("checks identity before release and HTML, and does not retry a refused key", async () => {
    const instance = await stubInstance((request, respond) =>
      request.authorization === "Bearer pp_good"
        ? respond(200, identity)
        : respond(401, { ok: false, error: "Missing or invalid API token." })
    );
    const dir = tempDir();
    const bad = htmlFile(dir, "bad.html", "<!doctype html><script>1</script>");
    const env = { PATCHY_API_TOKEN: "pp_bad", PATCHY_API_URL: instance.url };
    const local = await runCli(["publish", bad], {
      stateDir: dir,
      env: { ...env, PATCHY_API_TOKEN: "pp_good" }
    });
    expect(local.status).toBe(1);
    expect(local.stderr).toContain("HTML failed Patchy Cloud validation");
    expect(instance.requests.map((r) => r.url)).toEqual(["/api/me", "/api/release"]);

    const good = htmlFile(dir, "good.html", validHtml);
    const rejected = await runCli(["publish", good], { stateDir: dir, env });
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("Missing or invalid API token.");
    expect(instance.requests.map((r) => r.url)).toEqual(["/api/me", "/api/release", "/api/me"]);
  });

  it("reports an unavailable update target without retrying as a create", async () => {
    const instance = await stubPublishingInstance((_, respond) =>
      respond(404, { ok: false, error: "Patch not found." })
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp" };

    const explicit = await runCli(["publish", file, "--patch", "abcdefghijkl"], {
      stateDir: dir,
      env
    });
    expect(explicit.status).toBe(2);
    expect(explicit.stderr).toBe(
      "Patch is unavailable for update. --patch never creates a new patch.\n"
    );

    writeFileSync(
      path.join(dir, "patches.json"),
      JSON.stringify({
        hosts: {
          [instance.url]: {
            files: {
              [file]: {
                draftId: "mnopqrstuvwx",
                publicUrl: "u",
                latestVersionNumber: 1,
                updatedAt: "t"
              }
            }
          }
        }
      })
    );
    const cached = await runCli(["publish", file], { stateDir: dir, env });
    expect(cached.status).toBe(2);
    expect(cached.stderr).toBe(
      "Cached patch is unavailable for update. Use --new to create a new patch.\n"
    );
    // The pre-rename `draftId` entry was read as the same page.
    expect(instance.requests[5]?.body).toMatchObject({ patchId: "mnopqrstuvwx" });
    expect(instance.requests).toHaveLength(6);
    expect(existsSync(path.join(dir, "publish", sha256(instance.url), "attempt.json"))).toBe(false);

    const conflict = await runCli(["publish", file, "--patch", "abcdefghijkl", "--new"], {
      stateDir: dir,
      env
    });
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toBe("--patch and --new cannot be used together.\n");
  });

  it("refuses to publish past a patch cache still named drafts.json", async () => {
    const instance = await stubPublishingInstance((_, respond) =>
      respond(201, publish(201, "abcdefghijkl", 1))
    );
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    // Refused even beside a patches.json: the CLI never guesses which one is current.
    for (const name of ["drafts.json", "patches.json"]) {
      writeFileSync(path.join(dir, name), JSON.stringify({ hosts: {} }));
    }

    const result = await runCli(["publish", file], {
      stateDir: dir,
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp" }
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `The patch cache is now ${path.join(dir, "patches.json")} but the old file is still here: ${path.join(dir, "drafts.json")}\n` +
        "Rename it to patches.json to keep updating the patches it remembers, or delete it to start a fresh cache.\n"
    );
    expect(instance.requests.map((request) => request.url)).toEqual(["/api/me", "/api/release"]);
  });

  it("fails closed on invalid stored credentials for this instance, and only this instance", async () => {
    const instance = await stubInstance((_, respond) => respond(200, identity));
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({ hosts: { [instance.url]: { token: "" }, "http://other.test": 42 } })
    );
    const file = htmlFile(dir, "page.html", validHtml);
    const broken = await runCli(["publish", file, "--api-url", instance.url], { stateDir: dir });
    expect(broken.status).toBe(1);
    expect(broken.stderr).toBe(
      `Stored credentials for ${instance.url} are invalid. Run: patchy auth set --api-url ${instance.url} to replace them.\n`
    );
    expect(instance.requests).toHaveLength(0);

    // Repairing this instance's entry keeps the neighbour's exactly as it was.
    await runCli(["auth", "set", "--token-stdin", "--api-url", instance.url], {
      stateDir: dir,
      input: "pp_ok\n"
    });
    expect(readJson(path.join(dir, "credentials.json"))).toMatchObject({
      hosts: { [instance.url]: { token: "pp_ok" }, "http://other.test": 42 }
    });
    expect((await runCli(["whoami", "--api-url", instance.url], { stateDir: dir })).status).toBe(0);
  });
});

describe("patchy share", () => {
  it("targets this instance's cached patch or an explicit ID, preserving the cache on success and refusal", async () => {
    const patchId = "abcdefghijkl";
    const publicUrl = `http://instance.test/${DEV_SEED.companyHandle}/page`;
    let responses = 0;
    const instance = await stubInstance((request, respond) => {
      if (
        request.method !== "POST" ||
        request.url !== `/api/patches/${patchId}/share` ||
        request.authorization !== "Bearer pp_owner"
      ) {
        return respond(404, { ok: false, error: "Patch not found." });
      }
      respond(200, {
        ok: true,
        patchId,
        scope: responses++ === 0 ? "public" : "company",
        publicUrl
      });
    });
    const other = await stubInstance((_, respond) =>
      respond(404, { ok: false, error: "Patch not found." })
    );
    const dir = tempDir();
    // Sharing only needs the cached path, not the original file's contents.
    const file = path.join(dir, "page.html");
    const cached = { patchId, publicUrl, latestVersionNumber: 7, updatedAt: "unchanged" };
    const cachePath = path.join(dir, "patches.json");
    const cache = JSON.stringify({
      hosts: {
        [instance.url]: { files: { [file]: cached } },
        "http://other.test": { files: { [file]: { ...cached, patchId: "mnopqrstuvwx" } } }
      }
    });
    writeFileSync(cachePath, cache);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };

    const shared = await runCli(["share", "page.html", "public"], { stateDir: dir, env });
    expect(shared.status).toBe(0);
    expect(shared.stderr).toBe("");
    expect(shared.stdout).toContain(`URL: ${publicUrl}`);
    expect(shared.stdout).toContain("Scope: public (anyone with the link)");
    expect(readFileSync(cachePath, "utf8")).toBe(cache);

    const restricted = await runCli(["share", "--patch", patchId, "company", "--json"], {
      stateDir: dir,
      env
    });
    expect(restricted.status).toBe(0);
    expect(restricted.stderr).toBe("");
    expect(JSON.parse(restricted.stdout)).toEqual({
      ok: true,
      patchId,
      scope: "company",
      publicUrl
    });
    expect(readFileSync(cachePath, "utf8")).toBe(cache);

    const refused = await runCli(["share", "--patch", "mnopqrstuvwx", "public", "--json"], {
      stateDir: dir,
      env
    });
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe("");
    expect(JSON.parse(refused.stderr)).toMatchObject({
      ok: false,
      kind: "rejected",
      error: "Patch not found."
    });
    expect(readFileSync(cachePath, "utf8")).toBe(cache);
    expect(instance.requests).toHaveLength(3);

    const uncached = await runCli(
      ["share", "page.html", "public", "--api-url", other.url, "--json"],
      {
        stateDir: dir,
        env
      }
    );
    expect(uncached.status).toBe(1);
    expect(JSON.parse(uncached.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(other.requests).toHaveLength(0);
    expect(readFileSync(cachePath, "utf8")).toBe(cache);
  });

  it.each([
    { args: [] },
    { args: ["public"] },
    { args: ["page.html"] },
    { args: ["--patch", "abcdefghijkl"] },
    { args: ["page.html", "private"] },
    { args: ["--patch", "abcdefghijkl", "private"] },
    { args: ["page.html", "public", "--patch", "abcdefghijkl"] },
    { args: ["page.html", "public", "extra"] }
  ])("rejects invalid targets or scope locally: $args", async ({ args }) => {
    const instance = await stubInstance((_, respond) => respond(500, {}));
    const result = await runCli(["share", ...args, "--json"], {
      env: { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" }
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, kind: "local" });
    expect(instance.requests).toHaveLength(0);
  });
});

describe("patchy delete", async () => {
  it("takes down the patch a file was published from with the key that published it, then the patch is gone", async () => {
    // The stub remembers what is live, so a delete after a delete is a real 404.
    const live = new Set<string>();
    const instance = await stubPublishingInstance((request, respond) => {
      if (request.url === "/api/publish") {
        const body = request.body as { patchId?: string };
        if (body.patchId !== undefined) {
          return live.has(body.patchId)
            ? respond(200, publish(200, body.patchId, 2))
            : respond(404, { ok: false, error: "Patch not found." });
        }
        live.add("abcdefghijkl");
        return respond(201, publish(201, "abcdefghijkl", 1));
      }
      const patchId = request.url.replace("/api/patches/", "");
      if (request.method === "DELETE" && live.delete(patchId)) return respond(200, { ok: true });
      return respond(404, { ok: false, error: "Patch not found." });
    });
    const dir = tempDir();
    const file = htmlFile(dir, "page.html", validHtml);
    const copy = htmlFile(dir, "copy.html", validHtml);
    const env = { PATCHY_API_URL: instance.url, PATCHY_API_TOKEN: "pp_owner" };
    expect((await runCli(["publish", file], { stateDir: dir, env })).status).toBe(0);
    // A second file pointed at the same patch by hand; the cache now names it twice.
    expect(
      (await runCli(["publish", copy, "--patch", "abcdefghijkl"], { stateDir: dir, env })).status
    ).toBe(0);

    const deleted = await runCli(["delete", file, "--json"], { stateDir: dir, env });
    expect(deleted).toMatchObject({ status: 0, stdout: '{"ok":true}\n', stderr: "" });
    expect(instance.requests[6]).toMatchObject({
      method: "DELETE",
      url: "/api/patches/abcdefghijkl",
      authorization: "Bearer pp_owner"
    });
    // Every file that pointed at the patch is forgotten, not only the one named,
    // so no later publish tries to update a patch that is gone.
    expect(readJson(path.join(dir, "patches.json"))).toEqual({
      hosts: { [instance.url]: { files: {} } }
    });

    const forgotten = await runCli(["delete", file], { stateDir: dir, env });
    expect(forgotten.status).toBe(1);
    expect(forgotten.stderr).toMatch(/^No patch on .* was published from /);
    expect(instance.requests).toHaveLength(7);

    const gone = await runCli(["delete", "--patch", "abcdefghijkl"], { stateDir: dir, env });
    expect(gone.status).toBe(2);
    expect(gone.stderr).toBe(
      `Patch abcdefghijkl is unavailable for deletion: it is not on ${instance.url}, or this publishing key does not own it.\n`
    );

    // Neither target and both targets are told what to pass, in different words.
    const neither = await runCli(["delete"], { stateDir: dir, env });
    expect(neither.status).toBe(1);
    expect(neither.stderr).toBe(
      "Pass the file the patch was published from, or --patch <patch-id>.\n"
    );
    const both = await runCli(["delete", file, "--patch", "abcdefghijkl"], { stateDir: dir, env });
    expect(both.status).toBe(1);
    expect(both.stderr).toBe(
      "Pass the file the patch was published from, or --patch <patch-id>, not both.\n"
    );

    // With no key the deletion is refused locally.
    const keyless = await runCli(["delete", "--patch", "abcdefghijkl", "--api-url", instance.url]);
    expect(keyless.status).toBe(1);
    expect(keyless.stderr).toContain("Run: patchy login");
    expect(instance.requests).toHaveLength(8);
  });
});

describe("patchy status", async () => {
  it("reports local state only, naming which link chose the instance", async () => {
    const dir = tempDir();
    const fresh = JSON.parse((await runCli(["status"], { stateDir: dir })).stdout);
    expect(fresh).toEqual({
      instanceUrl: "http://localhost:3000",
      instanceSource: "default",
      hasToken: false,
      tokenSource: null,
      stateDir: dir,
      hasDefaultStyle: false,
      cliVersion: "0.0.1"
    });

    // A worktree with a running dev instance is found from any directory
    // below it, and its seeded token counts as a token from the environment.
    const worktree = path.join(dir, "worktree");
    mkdirSync(path.join(worktree, ".local", "dev"), { recursive: true });
    mkdirSync(path.join(worktree, "deep", "er"), { recursive: true });
    writeFileSync(
      path.join(worktree, ".local", "dev", "env"),
      `PATCHY_API_URL=http://127.0.0.1:45678\nPATCHY_API_TOKEN=${DEV_SEED.token}\n`
    );
    writeFileSync(path.join(dir, "style.md"), "# style");
    const dev = JSON.parse(
      (
        await runCli(["status", "--json"], {
          stateDir: dir,
          cwd: path.join(worktree, "deep", "er")
        })
      ).stdout
    );
    expect(dev).toMatchObject({
      instanceUrl: "http://127.0.0.1:45678",
      instanceSource: "dev-env",
      hasToken: true,
      tokenSource: null,
      hasDefaultStyle: true
    });

    // Corrupt credentials are "no token we can vouch for", not an error.
    writeFileSync(path.join(dir, "credentials.json"), "not json");
    const unreadable = await runCli(["status"], { stateDir: dir });
    expect(unreadable.status).toBe(0);
    expect(JSON.parse(unreadable.stdout)).toMatchObject({ hasToken: false, tokenSource: null });
  });
});
